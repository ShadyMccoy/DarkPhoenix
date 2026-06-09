/**
 * ChainEvaluator - score a spawn site by standing up the corps it would run.
 *
 * This is deliberately thin: it owns NO economics. It instantiates the real
 * corps a spawn here would staff - a miner and a hauler per reachable source,
 * an upgrader on the controller - asks each to {@link Corp.project} its own
 * per-tick cost and throughput, and returns the net energy the chain delivers
 * to the controller (gross harvest minus the whole roster's staffing overhead,
 * each corp's overhead already discounted for the walk from this spawn).
 *
 * Because every number comes from a corp, the score tracks the corps: improve a
 * corp's body logic and the score shifts; add a new corp type to the chain and
 * it counts. There is no separate spawn-scoring model to keep in step.
 */

import "../types/Memory"; // pull in the CreepMemory augmentation the corps rely on
import { Position, chebyshevDistance } from "../types/Position";
import { HaulerAssignment, SinkAllocation } from "../flow/FlowTypes";
import { SceneResource, ChainScene } from "./economics";
import { HarvestCorp } from "./HarvestCorp";
import { CarryCorp } from "./CarryCorp";
import { UpgradingCorp } from "./UpgradingCorp";

/** A source reachable from a spawn (local territory or an adjacent node). */
export interface ChainSource {
  id: string;
  /** Energy per regeneration cycle (e.g. 3000). */
  capacity: number;
  pos: Position;
}

/** A source in an adjacent node, known only by its range across the boundary. */
export interface ReachableChainSource {
  capacity: number;
  /** Walking distance from the spawn to that source. */
  distance: number;
}

/** Everything needed to score a spawn at `spawnPos`. */
export interface SpawnChainFacts {
  spawnPos: Position;
  /** Sources inside this spawn's own territory. */
  sources: ChainSource[];
  /** The controller the chain upgrades; no controller means no value. */
  controllerPos?: Position;
  /** Sources in adjacent nodes, folded in at their true range. */
  reachableSources?: ReachableChainSource[];
  /** Energy a creep body may cost (defaults to an RCL-1 spawn). */
  energyCapacity?: number;
  /** Distance function (defaults to Chebyshev). */
  dist?: (a: Position, b: Position) => number;
}

const DEFAULT_ENERGY_CAPACITY = 300;
const VIRTUAL = "virtual";

/**
 * Net energy/tick the chain a spawn here would run delivers to the controller.
 * Zero when there is nothing to mine or no controller to upgrade.
 */
export function evaluateSpawnChain(facts: SpawnChainFacts): number {
  const dist = facts.dist ?? chebyshevDistance;
  const energyCapacity = facts.energyCapacity ?? DEFAULT_ENERGY_CAPACITY;
  if (!facts.controllerPos) return 0;

  // Reachable adjacent-node sources are placed at their true range from the
  // spawn, so their miners/haulers carry the real inter-node travel penalty.
  const sources: ChainSource[] = [...facts.sources];
  (facts.reachableSources ?? []).forEach((rs, i) => {
    sources.push({
      id: `reach-${i}`,
      capacity: rs.capacity,
      pos: { x: facts.spawnPos.x + rs.distance, y: facts.spawnPos.y, roomName: facts.spawnPos.roomName },
    });
  });
  if (sources.length === 0) return 0;

  const resources = new Map<string, SceneResource>();
  for (const s of sources) resources.set(s.id, { pos: s.pos, capacity: s.capacity });
  const scene: ChainScene = {
    spawnPos: facts.spawnPos,
    energyCapacity,
    controllerPos: facts.controllerPos,
    dist,
    resource: (id) => resources.get(id),
  };

  let harvest = 0;
  let cost = 0;

  for (const s of sources) {
    const miner = new HarvestCorp(VIRTUAL, VIRTUAL, s.id);
    const mined = miner.project(scene);
    if (mined.throughput <= 0) continue;
    harvest += mined.throughput;
    cost += mined.costPerTick;

    const hauler = new CarryCorp(VIRTUAL, VIRTUAL);
    hauler.setHaulerAssignments([
      route(s.id, mined.throughput, dist(s.pos, facts.controllerPos)),
    ]);
    cost += hauler.project(scene).costPerTick;
  }
  if (harvest <= 0) return 0;

  // Energy left for the controller after miners and haulers are staffed; the
  // upgrader is sized to that, then it too charges its overhead.
  const netToController = Math.max(0, harvest - cost);
  const upgrader = new UpgradingCorp(VIRTUAL, VIRTUAL);
  upgrader.setSinkAllocation(controllerAllocation(netToController));
  cost += upgrader.project(scene).costPerTick;

  return Math.max(0, harvest - cost);
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
    spawnId: VIRTUAL,
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
    sourceFlows: [],
  };
}
