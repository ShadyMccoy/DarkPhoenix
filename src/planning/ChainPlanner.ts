/**
 * @fileoverview ChainPlanner finds viable production chains.
 *
 * A "chain" is a path from free source energy to a value-creating goal (a
 * controller upgrade), via the miners, haulers and the spawn that staff them.
 * The economics come entirely from the corps: ChainPlanner stands up the real
 * corps a chain would need (a miner + hauler per source, an upgrader on the
 * controller) and asks each to {@link Corp.project} its own per-tick cost from
 * its own body logic. There is no separate cost model here - improve a corp and
 * the chains it appears in re-price themselves.
 *
 * @module planning/ChainPlanner
 */

import { Position, chebyshevDistance } from "../types/Position";
import { MintValues } from "../colony/MintValues";
import { AnyCorpState, MiningCorpState, SpawningCorpState, UpgradingCorpState } from "../corps/CorpState";
import { ChainScene, SceneResource } from "../corps/economics";
import { HarvestCorp } from "../corps/HarvestCorp";
import { CarryCorp } from "../corps/CarryCorp";
import { UpgradingCorp } from "../corps/UpgradingCorp";
import { HaulerAssignment, SinkAllocation } from "../flow/FlowTypes";
import { Chain, ChainSegment, buildSegment, createChain, createChainId, filterViable, sortByProfit } from "./Chain";
import { OfferCollector } from "./OfferCollector";

const VIRTUAL = "virtual";

/**
 * ChainPlanner discovers and evaluates production chains by standing up the
 * corps each chain would run and reading their projected economics.
 */
export class ChainPlanner {
  private readonly collector: OfferCollector;
  private readonly mintValues: MintValues;
  private readonly maxDepth: number;
  private corpStates: AnyCorpState[] = [];

  public constructor(collector: OfferCollector, mintValues: MintValues, maxDepth = 10) {
    this.collector = collector;
    this.mintValues = mintValues;
    this.maxDepth = maxDepth;
  }

  /** Register corp states for planning. */
  public registerCorpStates(states: AnyCorpState[], _tick: number): void {
    this.corpStates = states;
  }

  /**
   * Find all viable chains at the given tick: one chain per upgrading goal,
   * costed by the corps it would take to feed that goal.
   */
  public findViableChains(tick: number): Chain[] {
    const spawn = this.corpStates.find((s): s is SpawningCorpState => s.type === "spawning");
    const miners = this.corpStates.filter((s): s is MiningCorpState => s.type === "mining");
    const goals = this.corpStates.filter((s): s is UpgradingCorpState => s.type === "upgrading");
    if (!spawn || miners.length === 0 || goals.length === 0) return [];

    const scene = this.buildScene(spawn, miners);

    const chains: Chain[] = [];
    for (const goal of goals) {
      const chain = this.buildChain(goal, miners, scene, tick);
      if (chain) chains.push(chain);
    }
    return filterViable(chains);
  }

  /** Find the best non-overlapping chains within a cost budget. */
  public findBestChains(tick: number, budget: number): Chain[] {
    const sorted = sortByProfit(this.findViableChains(tick));
    const selected: Chain[] = [];
    let totalCost = 0;
    for (const chain of sorted) {
      if (totalCost + chain.totalCost > budget) continue;
      if (selected.some(existing => this.chainsOverlap(chain, existing))) continue;
      selected.push(chain);
      totalCost += chain.totalCost;
    }
    return selected;
  }

  /** A scene the virtual corps reason about: the spawn, its energy, the sources. */
  private buildScene(spawn: SpawningCorpState, miners: MiningCorpState[]): ChainScene {
    const resources = new Map<string, SceneResource>();
    for (const m of miners) resources.set(m.id, { pos: m.position, capacity: m.sourceCapacity });
    return {
      spawnPos: spawn.position,
      energyCapacity: spawn.energyCapacity,
      dist: (a: Position, b: Position) => chebyshevDistance(a, b),
      resource: (id: string) => resources.get(id)
    };
  }

  /**
   * Build a mine -> haul -> upgrade chain feeding one controller, costing each
   * step from the corp that would do it.
   */
  private buildChain(
    goal: UpgradingCorpState,
    miners: MiningCorpState[],
    scene: ChainScene,
    tick: number
  ): Chain | null {
    const sceneToGoal: ChainScene = { ...scene, controllerPos: goal.position };

    let harvest = 0;
    let minerCost = 0;
    let haulerCost = 0;
    for (const m of miners) {
      const miner = new HarvestCorp(VIRTUAL, VIRTUAL, m.id);
      const mined = miner.project(sceneToGoal);
      if (mined.throughput <= 0) continue;
      harvest += mined.throughput;
      minerCost += mined.costPerTick;

      const hauler = new CarryCorp(VIRTUAL, VIRTUAL);
      hauler.setHaulerAssignments([route(m.id, mined.throughput, scene.dist(m.position, goal.position))]);
      haulerCost += hauler.project(sceneToGoal).costPerTick;
    }
    if (harvest <= 0) return null;

    const netToController = Math.max(0, harvest - minerCost - haulerCost);
    const upgrader = new UpgradingCorp(VIRTUAL, VIRTUAL);
    upgrader.setSinkAllocation(controllerAllocation(netToController));
    const upgraderCost = upgrader.project(sceneToGoal).costPerTick;

    // Cost-carrying segments: each step's output price is the running staffing
    // overhead, so the chain's totalCost is the whole roster's cost/tick.
    const dominant = miners[0];
    const segments: ChainSegment[] = [
      buildSegment(dominant.id, "mining", "harvested-energy", harvest, minerCost, 0),
      buildSegment(`haul-${goal.id}`, "hauling", "delivered-energy", harvest, minerCost + haulerCost, 0),
      buildSegment(goal.id, "upgrading", "controller-points", harvest, minerCost + haulerCost + upgraderCost, 0)
    ];

    // The chain mints value for the net energy that actually reaches the controller.
    const net = Math.max(0, harvest - minerCost - haulerCost - upgraderCost);
    const mintValue = net * this.mintValues.rclUpgrade;
    return createChain(createChainId(goal.id, tick), segments, mintValue);
  }

  /** Whether two chains share any corp. */
  private chainsOverlap(a: Chain, b: Chain): boolean {
    const aCorps = new Set(a.segments.map(s => s.corpId));
    return b.segments.some(s => aCorps.has(s.corpId));
  }
}

/** A synthetic source->controller hauling route for a virtual CarryCorp. */
function route(fromId: string, flowRate: number, distance: number): HaulerAssignment {
  return {
    edgeId: `${fromId}|controller`,
    fromId,
    toId: "controller",
    distance,
    carryParts: 0,
    flowRate,
    spawnCostPerTick: 0,
    spawnId: VIRTUAL
  };
}

/** A synthetic controller allocation for a virtual UpgradingCorp. */
function controllerAllocation(allocated: number): SinkAllocation {
  return {
    sinkId: "controller",
    sinkType: "controller",
    allocated,
    demand: allocated,
    unmet: 0,
    priority: 0,
    sourceFlows: []
  };
}
