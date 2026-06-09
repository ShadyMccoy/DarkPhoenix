/**
 * @fileoverview ChainPlanner finds viable production chains.
 *
 * A "chain" is a path from free source energy to a value-creating goal (a
 * controller upgrade or a construction project), via the miners, haulers and
 * the spawn that staff them. ChainPlanner used to build these chains with a
 * hardcoded stub (always the first miner + first hauler, fixed 10% margins, and
 * - tellingly - no spawn at all, even though the spawn is what staffs every
 * link). It now delegates to the strategic planner ({@link planEconomy}), the
 * single source of truth for "given this spawn, these sources and these sinks,
 * what is the optimal roster and what does it cost to staff?". The planner's
 * routing IS the set of chains; this module reads them off and expresses each as
 * a {@link Chain} so existing consumers (scenario runner, reports) keep working.
 *
 * @module planning/ChainPlanner
 */

import { chebyshevDistance, Position } from "../types/Position";
import {
  PlannerInput,
  PlannerSink,
  PlannerSource,
  planEconomy,
} from "../flow/EconomyPlanner";
import { MintValues } from "../colony/MintValues";
import { AnyCorpState, SpawningCorpState } from "../corps/CorpState";
import { CorpType } from "../corps/Corp";
import {
  Chain,
  ChainSegment,
  buildSegment,
  createChain,
  createChainId,
  filterViable,
  sortByProfit,
} from "./Chain";
import { OfferCollector } from "./OfferCollector";

/** Ticks for a source to regenerate, turning capacity into energy/tick. */
const SOURCE_REGEN_TICKS = 300;

/** Strategic sink values used when translating corp states into a plan. */
const SINK_VALUES = { spawn: 100, controller: 50, construction: 70 } as const;

/** A goal sink (controller or construction) and the corp state behind it. */
interface Goal {
  sinkId: string;
  corpType: CorpType;
  resource: string;
  /** Mint value per unit of energy delivered to this goal. */
  mintPerEnergy: number;
}

/**
 * ChainPlanner discovers and evaluates production chains by running the
 * strategic planner over the registered corp states.
 */
export class ChainPlanner {
  private collector: OfferCollector;
  private mintValues: MintValues;
  private maxDepth: number;
  private corpStates: AnyCorpState[] = [];

  constructor(
    collector: OfferCollector,
    mintValues: MintValues,
    maxDepth: number = 10
  ) {
    this.collector = collector;
    this.mintValues = mintValues;
    this.maxDepth = maxDepth;
  }

  /**
   * Register corp states for planning.
   */
  registerCorpStates(states: AnyCorpState[], _tick: number): void {
    this.corpStates = states;
  }

  /**
   * Find all viable chains at the given tick: run the planner over the
   * registered corp states and read off one chain per fed goal.
   */
  findViableChains(tick: number): Chain[] {
    const built = this.buildPlannerInput();
    if (!built) return [];

    const plan = planEconomy(built.input);

    // Energy routed to each goal sink (its productive throughput) and the
    // dominant source feeding it (the chain's representative miner).
    const chains: Chain[] = [];
    for (const goal of built.goals) {
      const flows = plan.flows.filter((f) => f.sinkId === goal.sinkId);
      const throughput = flows.reduce((sum, f) => sum + f.amount, 0);
      if (throughput <= 0) continue;

      const dominant = flows.reduce((a, b) => (b.amount > a.amount ? b : a));
      const chain = this.buildChain(goal, dominant.sourceId, throughput, plan.overhead, plan, tick);
      chains.push(chain);
    }

    return filterViable(chains);
  }

  /**
   * Find the best chains within a budget (non-overlapping, highest profit).
   */
  findBestChains(tick: number, budget: number): Chain[] {
    const sorted = sortByProfit(this.findViableChains(tick));

    const selected: Chain[] = [];
    let totalCost = 0;
    for (const chain of sorted) {
      if (totalCost + chain.totalCost > budget) continue;
      if (selected.some((existing) => this.chainsOverlap(chain, existing))) continue;
      selected.push(chain);
      totalCost += chain.totalCost;
    }
    return selected;
  }

  /**
   * Translate the registered corp states into a planner problem: miners become
   * sources, the spawn becomes the staffing spawn (and its overhead sink),
   * upgraders/builders become value goals. Returns null when no spawn or no
   * goal exists - there is no economy to plan.
   */
  private buildPlannerInput(): { input: PlannerInput; goals: Goal[] } | null {
    const spawn = this.corpStates.find((s) => s.type === "spawning") as
      | SpawningCorpState
      | undefined;
    if (!spawn) return null;

    // Miners are the worked sources; fall back to passive source states.
    const sources: PlannerSource[] = [];
    for (const s of this.corpStates) {
      if (s.type === "mining") {
        sources.push({ id: s.id, supply: s.sourceCapacity / SOURCE_REGEN_TICKS, pos: s.position });
      }
    }
    if (sources.length === 0) {
      for (const s of this.corpStates) {
        if (s.type === "source") {
          sources.push({ id: s.id, supply: s.energyCapacity / SOURCE_REGEN_TICKS, pos: s.position });
        }
      }
    }
    if (sources.length === 0) return null;

    const sinks: PlannerSink[] = [
      { id: spawn.id, kind: "spawn", value: SINK_VALUES.spawn, capacity: 0, pos: spawn.position },
    ];
    const goals: Goal[] = [];

    for (const s of this.corpStates) {
      if (s.type === "upgrading") {
        sinks.push({
          id: s.id,
          kind: "controller",
          value: SINK_VALUES.controller,
          capacity: Number.POSITIVE_INFINITY,
          reserve: 1,
          pos: s.position,
        });
        goals.push({ sinkId: s.id, corpType: "upgrading", resource: "controller-points", mintPerEnergy: this.mintValues.rcl_upgrade });
      } else if (s.type === "building") {
        sinks.push({
          id: s.id,
          kind: "construction",
          value: SINK_VALUES.construction,
          capacity: 15,
          pos: s.position,
        });
        goals.push({ sinkId: s.id, corpType: "building", resource: "structure", mintPerEnergy: this.mintValues.rcl_upgrade });
      }
    }

    if (goals.length === 0) return null;

    const dist = (a: Position, b: Position): number => chebyshevDistance(a, b);
    return { input: { sources, sinks, spawnId: spawn.id, dist }, goals };
  }

  /**
   * Express one fed goal as a Chain: mine -> haul -> goal, costed by the
   * planner's overhead share for the energy this goal received.
   */
  private buildChain(
    goal: Goal,
    sourceId: string,
    throughput: number,
    overhead: number,
    plan: { flows: { sinkId: string; amount: number }[] },
    tick: number
  ): Chain {
    // Average per-energy staffing cost: the whole roster's overhead spread over
    // all the productive energy it delivers. A goal's cost is its share.
    const productive = plan.flows
      .filter((f) => !this.isSpawnFlow(f.sinkId))
      .reduce((sum, f) => sum + f.amount, 0);
    const costPerEnergy = productive > 0 ? overhead / productive : 0;
    const goalCost = throughput * costPerEnergy;

    // Three segments carrying the planner-derived cost (no synthetic margins):
    // the leaf already holds the staffing cost, so each step passes it through.
    const segments: ChainSegment[] = [
      buildSegment(sourceId, "mining", "harvested-energy", throughput, goalCost, 0),
      buildSegment(`haul-${goal.sinkId}`, "hauling", "delivered-energy", throughput, goalCost, 0),
      buildSegment(goal.sinkId, goal.corpType, goal.resource, throughput, goalCost, 0),
    ];

    const mintValue = throughput * goal.mintPerEnergy;
    return createChain(createChainId(goal.sinkId, tick), segments, mintValue);
  }

  /** Whether a sink id belongs to the (single) spawn sink. */
  private isSpawnFlow(sinkId: string): boolean {
    const spawn = this.corpStates.find((s) => s.type === "spawning");
    return !!spawn && sinkId === spawn.id;
  }

  /**
   * Check if two chains overlap (share corps).
   */
  private chainsOverlap(a: Chain, b: Chain): boolean {
    const aCorps = new Set(a.segments.map((s) => s.corpId));
    return b.segments.some((s) => aCorps.has(s.corpId));
  }
}
