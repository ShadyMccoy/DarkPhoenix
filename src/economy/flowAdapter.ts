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

import "../types/Memory"; // RoomMemory.roadRoutes augmentation (paved receipts)
import { FlowGraph } from "../flow/FlowGraph";
import {
  FlowSolution,
  HaulerAssignment,
  MinerAssignment,
  SinkAllocation,
  SinkType,
  createEdgeId
} from "../flow/FlowTypes";
import { pathDistance } from "../nodes/NodeNavigator";
import { Position } from "../types/Position";
import { coreLink, sourceLink } from "../corps/nodeEnergy";
import { haulerOverhead, minerOverhead } from "./primitives";
import { detectRoomStocks, stockToTransientSource } from "./scavenge";
import {
  ColonyProblem,
  DEFAULT_SINK_VALUE,
  PlannerSink,
  PlannerSource,
  PlannerSpawn,
  SinkKind,
  planColony
} from "./CorpPlanner";
import { Commission } from "./Commission";
import { commissionsFromPlan } from "./commissionPlan";

/** Guaranteed controller trickle (energy/tick) so it never downgrades / stalls. */
export const ANTI_DOWNGRADE_RESERVE = 2;

/** Ticks over which the agenda's funding need amortizes into a flow rate. */
export const FUND_HORIZON = 50;

/**
 * The spawn's outstanding must-fund bodies (Memory.spawnAgenda.fundingNeed,
 * spec 11) as an energy/tick rate: bank the queued bodies within roughly one
 * re-solve horizon. Stale agendas (spawn busy/skipped > 100 ticks) decay to
 * zero so a dead table entry cannot siphon flow forever.
 */
export function agendaFundingRate(sinkId: string): number {
  if (typeof Memory === "undefined" || typeof Game === "undefined") return 0;
  const spawnId = sinkId.replace("spawn-", "");
  const entry = Memory.spawnAgenda?.[spawnId];
  if (!entry || Game.time - entry.tick > 100) return 0;
  return entry.fundingNeed / FUND_HORIZON;
}

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
 * Detect link-served sources across visible rooms: a source with its own link
 * within feeding range, in a room whose core link (beside the storage) exists.
 * Such a source's output emerges at the CORE, so the planner prices and routes
 * its hauling from there (haulPos) while the miner keeps the real distance.
 * Live default for buildColonyProblem; injectable for tests.
 */
export function detectLinkHaulPositions(graph: FlowGraph): Map<string, Position> {
  const out = new Map<string, Position>();
  if (typeof Game === "undefined" || !Game.rooms) return out;
  for (const s of graph.getSources()) {
    const room = Game.rooms[s.position.roomName];
    if (!room) continue;
    const core = coreLink(room);
    if (!core) continue;
    const pos = new RoomPosition(s.position.x, s.position.y, s.position.roomName);
    if (sourceLink(pos, core.id)) {
      out.set(s.id, { x: core.pos.x, y: core.pos.y, roomName: core.pos.roomName });
    }
  }
  return out;
}

/**
 * Sources whose haul route ConstructionCorp has fully paved, by GAME id (the
 * `paved` receipt in room memory - see RoomMemory.roadRoutes). Graph source ids
 * carry a "source-" prefix, so callers match with stripFlowId. Live default for
 * buildColonyProblem; injectable for tests.
 */
export function detectPavedSources(): Set<string> {
  const paved = new Set<string>();
  if (typeof Game === "undefined" || !Game.rooms) return paved;
  for (const roomName in Game.rooms) {
    const routes = Game.rooms[roomName].memory?.roadRoutes;
    for (const sourceId in routes ?? {}) {
      if (routes![sourceId].paved) paved.add(sourceId);
    }
  }
  return paved;
}

export function buildColonyProblem(
  graph: FlowGraph,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  linkHaulPos: Map<string, Position> = detectLinkHaulPositions(graph),
  pavedSources: Set<string> = detectPavedSources()
): ColonyProblem {
  const spawns: PlannerSpawn[] = graph.getSinks("spawn").map(s => ({ id: s.id, pos: s.position }));

  const sources: PlannerSource[] = graph.getSources().map(s => ({
    id: s.id,
    nodeId: s.nodeId,
    pos: s.position,
    rate: s.capacity,
    maxMiners: s.maxMiners,
    haulPos: linkHaulPos.get(s.id),
    ...(pavedSources.has(s.id.replace("source-", "")) ? { paved: true } : {})
  }));
  // Sustained income only: what mined sources yield per tick. Transient
  // stocks are real energy but ONE-OFF - sizing standing fleets or the
  // construction absorb rate to them publishes fantasy plans (measured on
  // the shard1 stress fixture: unhauled piles grew, inflating supply until
  // the plan wanted build 140 e/t / 316 CARRY against 20 e/t of mining).
  const minedSupply = sources.reduce((sum, s) => sum + s.rate, 0);
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
          ? // Overhead need PLUS the agenda's funding need (spec 11 phase 2,
            // owner doctrine "production over consumption"): while the spawn's
            // published queue holds must-fund bodies (blocking, replacement,
            // holdToFund), the solver routes their financing here instead of
            // spilling it to build/controller - the energy arrives exactly
            // while production has something to buy, and reverts to surplus
            // consumption when the queue drains. Measured absence: the
            // reserver waited 1800+ ticks behind chained holds because its
            // 650 never banked (task #30).
            Math.max(sink.demand, 1) + agendaFundingRate(sink.id)
          : kind === "construction"
          ? // Build-out is an INVESTMENT: extensions raise energyCapacity, which
            // raises every body size and the whole colony's energy-per-spawn-part
            // shadow price - worth more than the upgrade it displaces. While
            // sites exist, construction (value 70 > controller 50) may absorb the
            // full surplus and upgrading pauses at its anti-downgrade reserve
            // (the reserve pre-pass guarantees the floor); with no sites there is
            // no construction sink and the controller resumes mopping up. The old
            // flat 5 e/t cap was the measured RCL2->3 bottleneck: a 1-WORK
            // builder against 15k of extensions kept rooms at 300 capacity for
            // thousands of ticks (spec 10 G6, owner directive 2026-07-09).
            // Bounded by MINED supply ("within reason"): transient stocks may
            // still be routed here by the fill pass, but the standing builder
            // fleet is never sized to one-off piles.
            Math.max(minedSupply, 1)
          : kind === "storage"
          ? Math.max(totalSupply, 1) // soak excess
          : Math.max(totalSupply, 1), // controller mops up the remainder
      reserve: kind === "controller" ? ANTI_DOWNGRADE_RESERVE : undefined
    });
  }

  return { spawns, sources, sinks, dist };
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
    corps.push({
      kind: "haul",
      carry: Math.max(1, Math.ceil(h.carryParts)),
      fromId: h.sourceId,
      toId: h.sinkId,
      spawnId: h.spawnId
    });
  }
  for (const k of plan.sinks) {
    if (k.allocated <= 1e-9) continue;
    if (k.kind === "controller") {
      corps.push({
        kind: "upgrade",
        work: Math.max(1, Math.ceil(k.allocated / ENERGY_PER_WORK.upgrade)),
        sinkId: k.sinkId
      });
    } else if (k.kind === "construction") {
      corps.push({
        kind: "build",
        work: Math.max(1, Math.ceil(k.allocated / ENERGY_PER_WORK.build)),
        sinkId: k.sinkId
      });
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
  transientSources: PlannerSource[] = detectTransientSources()
): FlowSolution {
  return solveColony(graph, tick, dist, transientSources).solution;
}

/**
 * Solve the colony ONCE and return both representations of the result:
 *  - solution: the FlowSolution the live materializer/telemetry consume today;
 *  - commissions: the same plan wrapped as Commission envelopes (the framework
 *    seam - what the corp kinds materialize from).
 * Both come from a single planColony() call, so surfacing commissions for the
 * rung-5 cutover costs no extra solve. commissionsFromPlan is used (not
 * planCommissions) so the adapter stays free of kind-registry side effects -
 * auxiliary kinds propose() in the host, not here.
 */
export function solveColony(
  graph: FlowGraph,
  tick = 0,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources()
): { solution: FlowSolution; commissions: Commission[] } {
  const problem = buildColonyProblem(graph, dist, transientSources, detectLinkHaulPositions(graph));
  const plan = planColony(problem);
  publishRoster(plan);
  const commissions = commissionsFromPlan(problem, plan);

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

  const solution: FlowSolution = {
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
  return { solution, commissions };
}

/** Re-export for the integration site. */
export type { Position };
