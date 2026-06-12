/**
 * @fileoverview Adapter: run the GOAP CorpPlanner over a live FlowGraph and emit
 * the FlowSolution shape the materialiser already consumes.
 *
 * This is the drop-in seam. FlowEconomy.solve() can call solveWithCorpPlanner()
 * in place of the old FlowSolver (solveIteratively) and the downstream materialiser,
 * corps and scheduler are untouched - the planner just produces better-reasoned
 * miner/hauler/sink assignments from one model.
 *
 * @module economy/flowAdapter
 */

import { FlowGraph } from "../flow/FlowGraph";
import {
  FlowSolution,
  MinerAssignment,
  HaulerAssignment,
  SinkAllocation,
  SinkType,
  createEdgeId
} from "../flow/FlowTypes";
import { pathDistance } from "../nodes/NodeNavigator";
import { Position } from "../types/Position";
import { minerOverhead, haulerOverhead } from "./primitives";
import { detectRoomStocks, stockToTransientSource } from "./scavenge";
import { storeFill } from "./storeFill";
import {
  planColony,
  ColonyProblem,
  PlannerSink,
  PlannerSource,
  PlannerSpawn,
  SinkKind,
  DEFAULT_SINK_VALUE,
  incomeBudgetScaleForFill,
  INCOME_THROTTLE_LOW,
  INCOME_THROTTLE_HIGH
} from "./CorpPlanner";

/** Guaranteed controller trickle (energy/tick) so it never downgrades / stalls. */
export const ANTI_DOWNGRADE_RESERVE = 2;
/** Base energy/tick construction absorbs while energy is scarce (reservoir low). */
export const CONSTRUCTION_ABSORB_RATE = 5;
/** Energy/tick construction can absorb when the reservoir is full (~2 full builders). */
export const CONSTRUCTION_ABSORB_MAX = 20;

/** Map a FlowGraph sink type to the planner's coarser sink kind. */
function toSinkKind(type: SinkType): SinkKind | null {
  switch (type) {
    case "spawn":
    case "extension":
      return "spawn";
    case "construction":
      return "construction";
    case "controller":
      return "controller";
    case "storage":
      return "storage";
    default:
      return null; // tower/terminal/link/lab/factory not modelled as energy sinks yet
  }
}

/**
 * Build the planner's clean world description from the live flow graph.
 *
 * The spawn sink gets its *demand* as capacity (≈10), not 0: unlike the old shadow
 * planner - which only re-sized haulers while FlowSolver still fed the spawn - the
 * CorpPlanner IS the routing authority, so it must deliver the spawn its overhead
 * energy itself. Capacity = demand keeps the spawn fed without letting it (value
 * 100) starve the controller of the surplus.
 */
/**
 * Detect scavengeable ground stocks across visible rooms and turn them into
 * transient sources. Live default for buildColonyProblem; injectable for tests.
 */
export function detectTransientSources(): PlannerSource[] {
  if (typeof Game === "undefined" || !Game.rooms) return [];
  const out: PlannerSource[] = [];
  for (const roomName in Game.rooms) {
    for (const stock of detectRoomStocks(Game.rooms[roomName])) {
      out.push(stockToTransientSource(stock, `${roomName}-scavenge`));
    }
  }
  return out;
}

/**
 * Energy/tick the construction sink can absorb, scaled by stored-energy fill.
 *
 * The base rate is deliberately modest: while energy is scarce we don't
 * over-invest in building ahead of the spawn/controller. But a full reservoir is
 * surplus the colony is failing to spend, and construction is valued above the
 * controller (DEFAULT_SINK_VALUE 70 > 50), so we lift the cap as stores fill -
 * letting building (not just upgrading) soak the surplus, per the existing
 * weight. Ramps BASE..MAX over the SAME fill band the income throttle uses, so
 * the two levers move together: as income stands down, construction opens up. The
 * controller's anti-downgrade reserve is filled before this absorb in any case,
 * so a hungrier construction sink can never starve the controller below its floor.
 */
export function constructionAbsorbForFill(fill: number): number {
  if (fill <= INCOME_THROTTLE_LOW) return CONSTRUCTION_ABSORB_RATE;
  if (fill >= INCOME_THROTTLE_HIGH) return CONSTRUCTION_ABSORB_MAX;
  const t = (fill - INCOME_THROTTLE_LOW) / (INCOME_THROTTLE_HIGH - INCOME_THROTTLE_LOW);
  return CONSTRUCTION_ABSORB_RATE + t * (CONSTRUCTION_ABSORB_MAX - CONSTRUCTION_ABSORB_RATE);
}

/**
 * Colony stored-energy fill (0..1) for the income-budget thermostat: the fullest
 * owned room's reservoir. Reads Game directly (live default), injectable for
 * tests - mirrors {@link detectTransientSources}. Taking the MAX means any owned
 * room backing up signals income is over-allocated spawn parts somewhere, so we
 * throttle. No owned rooms / no Game → 0 (income unthrottled).
 */
export function colonyStoreFill(): number {
  if (typeof Game === "undefined" || !Game.rooms) return 0;
  let max = 0;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;
    const fill = storeFill(room);
    if (fill > max) max = fill;
  }
  return max;
}

export function buildColonyProblem(
  graph: FlowGraph,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  fill: number = colonyStoreFill()
): ColonyProblem {
  const spawns: PlannerSpawn[] = graph
    .getSinks("spawn")
    .map(s => ({ id: s.id, pos: s.position }));

  const sources: PlannerSource[] = graph.getSources().map(s => ({
    id: s.id,
    nodeId: s.nodeId,
    pos: s.position,
    rate: s.capacity,
    maxMiners: s.maxMiners
  }));
  // Ground stocks join as miner-less transient sources (scavenging).
  sources.push(...transientSources);
  const totalSupply = sources.reduce((sum, s) => sum + s.rate, 0);

  const sinks: PlannerSink[] = [];
  for (const sink of graph.getSinks()) {
    const kind = toSinkKind(sink.type);
    if (!kind) continue;
    sinks.push({
      id: sink.id,
      kind,
      pos: sink.position,
      value: DEFAULT_SINK_VALUE[kind],
      capacity:
        kind === "spawn"
          ? Math.max(sink.demand, 1) // feed the spawn its overhead need
          : kind === "construction"
            ? constructionAbsorbForFill(fill)
            : kind === "storage"
              ? Math.max(totalSupply, 1) // soak excess
              : Math.max(totalSupply, 1), // controller mops up the remainder
      reserve: kind === "controller" ? ANTI_DOWNGRADE_RESERVE : undefined
    });
  }

  return { spawns, sources, sinks, dist, incomeBudgetScale: incomeBudgetScaleForFill(fill) };
}

/**
 * Solve the colony economy with the CorpPlanner and return a FlowSolution.
 * Drop-in replacement for FlowSolver.solve / solveIteratively.
 */
/** Energy/tick one WORK part consumes at each consumer (for roster sizing). */
const ENERGY_PER_WORK = { upgrade: 1, build: 5 } as const;

/**
 * Publish the commissioned roster to Memory.economyPlan so tooling (the
 * plan-vs-spawn harness, telemetry) can compare what the single planner asked
 * for against what was actually fielded. Same shape the shadow planner used to
 * write, now sourced from the live CorpPlanner.
 */
function publishRoster(plan: ReturnType<typeof planColony>): void {
  if (typeof Memory === "undefined") return;
  const corps: Record<string, unknown>[] = [];
  for (const m of plan.miners) {
    corps.push({ kind: "mine", work: Math.max(1, Math.ceil(m.rate / 2)), sourceId: m.sourceId, spawnId: m.spawnId });
  }
  for (const h of plan.haulers) {
    corps.push({ kind: "haul", carry: Math.max(1, Math.ceil(h.carryParts)), fromId: h.sourceId, toId: h.sinkId, spawnId: h.spawnId });
  }
  for (const k of plan.sinks) {
    if (k.allocated <= 1e-9) continue;
    if (k.kind === "controller") {
      corps.push({ kind: "upgrade", work: Math.max(1, Math.ceil(k.allocated / ENERGY_PER_WORK.upgrade)), sinkId: k.sinkId });
    } else if (k.kind === "construction") {
      corps.push({ kind: "build", work: Math.max(1, Math.ceil(k.allocated / ENERGY_PER_WORK.build)), sinkId: k.sinkId });
    }
  }
  (Memory as { economyPlan?: unknown }).economyPlan = {
    corps,
    overhead: Number(plan.totalOverhead.toFixed(2)),
    unrouted: Number((plan.totalProduced - plan.totalDelivered).toFixed(2))
  };
}

export function solveWithCorpPlanner(
  graph: FlowGraph,
  tick = 0,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  fill: number = colonyStoreFill()
): FlowSolution {
  const problem = buildColonyProblem(graph, dist, transientSources, fill);
  const plan = planColony(problem);
  publishRoster(plan);

  const miners: MinerAssignment[] = plan.miners.map(m => ({
    sourceId: m.sourceId,
    nodeId: m.nodeId,
    spawnId: m.spawnId,
    spawnDistance: m.distance,
    harvestRate: m.rate,
    spawnCostPerTick: minerOverhead(m.distance),
    maxMiners: m.maxMiners,
    efficiency: m.efficiency
  }));

  const haulers: HaulerAssignment[] = plan.haulers.map(h => ({
    edgeId: createEdgeId(h.sourceId, h.sinkId),
    fromId: h.sourceId,
    toId: h.sinkId,
    distance: h.distance,
    carryParts: h.carryParts,
    flowRate: h.flowRate,
    spawnCostPerTick: haulerOverhead(h.carryParts, h.distance),
    spawnId: h.spawnId
  }));

  const sinkTypeById = new Map(graph.getSinks().map(s => [s.id, s.type]));
  const sinkAllocations: SinkAllocation[] = plan.sinks.map(k => ({
    sinkId: k.sinkId,
    sinkType: sinkTypeById.get(k.sinkId) ?? "controller",
    allocated: k.allocated,
    demand: k.demand,
    unmet: Math.max(0, k.demand - k.allocated),
    priority: k.value,
    sourceFlows: k.sources.map(sf => ({ sourceId: sf.sourceId, amount: sf.amount, distance: sf.distance }))
  }));

  const totalHarvest = plan.totalProduced;
  const miningOverhead = miners.reduce((s, m) => s + m.spawnCostPerTick, 0);
  const haulingOverhead = haulers.reduce((s, h) => s + h.spawnCostPerTick, 0);
  const totalOverhead = miningOverhead + haulingOverhead;
  const netEnergyTotal = totalHarvest - totalOverhead;

  const unmetDemand = new Map<string, number>();
  for (const a of sinkAllocations) if (a.unmet > 0) unmetDemand.set(a.sinkId, a.unmet);

  return {
    miners,
    haulers,
    sinkAllocations,
    totalHarvest,
    miningOverhead,
    haulingOverhead,
    totalOverhead,
    netEnergy: netEnergyTotal,
    efficiency: totalHarvest > 0 ? (netEnergyTotal / totalHarvest) * 100 : 0,
    unmetDemand,
    isSustainable: netEnergyTotal >= 0,
    warnings: [],
    computedAt: tick
  };
}

/** Re-export for the integration site. */
export type { Position };
