/**
 * EconomyAdapter - bridge from the live FlowGraph to the strategic planner.
 *
 * This is where the live world is translated into the planner's vocabulary:
 * sources become supply, sinks get a strategic VALUE and an absorption
 * CAPACITY, and planEconomy turns that into a roster of corp initiatives.
 *
 * The value/capacity choices here ARE the strategy. They encode, in one place:
 *   - spawn overhead is paid first (the planner computes how much),
 *   - construction outranks upgrading and its builders keep pace with supply
 *     (so it is given effectively unbounded capacity), and
 *   - the controller is the low-value, high-capacity sink that mops up whatever
 *     construction leaves - which is how "leftover goes to upgrading" emerges.
 */

import {
  EconomyPlan,
  PlannedFlow,
  PlannerInput,
  PlannerSink,
  PlannerSource,
  SinkKind,
  planEconomy
} from "./EconomyPlanner";
import { HaulerAssignment, SinkType } from "./FlowTypes";
import { CorpRegistry } from "../execution/CorpRunner";
import { CarryCorp } from "../corps/CarryCorp";
import { FlowGraph } from "./FlowGraph";
import { estimateWalkingDistance } from "../nodes/NodeNavigator";

/** Guaranteed controller trickle (energy/tick) so it never downgrades / fully stalls. */
export const ANTI_DOWNGRADE_RESERVE = 2;

/**
 * Energy/tick one active construction site can realistically absorb. In theory
 * builders "keep pace" with any supply, but a real builder's fetch/build duty
 * cycle caps it. Bounding construction here means the surplus the builder cannot
 * consume flows to the controller (where consumption-scaling soaks it up) rather
 * than backing up and decaying. ~5/tick matches one observed builder.
 */
export const CONSTRUCTION_ABSORB_RATE = 5;

/** Strategic value per sink kind (anti-downgrade reserve handled separately). */
export const SINK_VALUE: Record<SinkKind, number> = {
  spawn: 100, // critical: the economy can't run without staffing creeps
  construction: 70, // building supersedes upgrading
  controller: 50 // upgrading absorbs the leftover
};

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
    default:
      return null; // storage/tower/etc. not modelled yet
  }
}

/** Build the planner's input from the live flow graph. */
export function buildPlannerInput(graph: FlowGraph, spawnId: string): PlannerInput {
  const sources: PlannerSource[] = graph.getSources().map(s => ({
    id: s.id,
    supply: s.capacity, // energy/tick (e.g. 10)
    pos: s.position
  }));
  const totalSupply = sources.reduce((sum, s) => sum + s.supply, 0);

  const sinks: PlannerSink[] = [];
  for (const sink of graph.getSinks()) {
    const kind = toSinkKind(sink.type);
    if (!kind) continue;
    sinks.push({
      id: sink.id,
      kind,
      value: SINK_VALUE[kind],
      // spawn: planner computes overhead (capacity ignored). construction: a
      // realistic absorb rate, so on a throughput-limited source the surplus
      // goes to the controller (consumption-scaled) instead of decaying.
      // controller: high - it mops up whatever's left.
      capacity: kind === "spawn" ? 0 : kind === "construction" ? CONSTRUCTION_ABSORB_RATE : Math.max(totalSupply, 1),
      // The controller keeps a guaranteed anti-downgrade trickle even while
      // construction (higher value) would otherwise claim the whole supply.
      reserve: kind === "controller" ? ANTI_DOWNGRADE_RESERVE : undefined,
      pos: sink.position
    });
  }

  return { sources, sinks, spawnId, dist: estimateWalkingDistance };
}

/** Plan the economy directly from the live flow graph. */
export function planFromGraph(graph: FlowGraph, spawnId: string): EconomyPlan {
  return planEconomy(buildPlannerInput(graph, spawnId));
}

/**
 * Drive the corps from the strategic plan. For now this overrides hauling: the
 * planner sizes CARRY to move the full routed flow over each route, which the
 * old allocation chronically under-provisions (a single small hauler trying to
 * feed the whole room). Each source's CarryCorp gets the plan's routes for it.
 */
export function applyPlanToCorps(plan: EconomyPlan, corps: CorpRegistry): void {
  const flowsBySource = new Map<string, PlannedFlow[]>();
  for (const f of plan.flows) {
    const list = flowsBySource.get(f.sourceId);
    if (list) list.push(f);
    else flowsBySource.set(f.sourceId, [f]);
  }

  for (const [sourceId, flows] of flowsBySource) {
    const sourceGameId = sourceId.replace("source-", "");
    const spawnId = haulSpawnId(plan, sourceId);

    // The plan commissions this source's hauling; field it as a real corp even
    // when the flow solver routed no haulers of its own. Without this, a source
    // whose CarryCorp the flow materializer never created (it bails on an empty
    // hauler list) silently drops the plan's CARRY here, so the source is mined
    // but its energy is never carried home - the "mine but don't haul" stall.
    const carryCorp = getOrCreateCarryCorp(corps, sourceGameId, spawnId);
    if (!carryCorp) continue;

    const assignments: HaulerAssignment[] = flows
      .filter(f => f.amount > 0)
      .map(f => ({
        edgeId: `${f.sourceId}|${f.sinkId}`,
        fromId: f.sourceId,
        toId: f.sinkId,
        distance: f.distance,
        carryParts: Math.max(1, Math.ceil((f.amount * (2 * f.distance + 2)) / 50)),
        flowRate: f.amount,
        spawnCostPerTick: 0,
        spawnId
      }));
    if (assignments.length > 0) carryCorp.setHaulerAssignments(assignments);
  }

  // Drive the controller's upgraders: their allocation is the energy the plan
  // routes there, which sizes how many/how-big upgraders get spawned. This is
  // what lets consumption scale with supply (so a second source is not wasted).
  for (const spec of plan.corps) {
    if (spec.kind !== "upgrade") continue;
    const gameId = spec.sinkId.replace("controller-", "");
    const controller = Game.getObjectById(gameId as Id<StructureController>);
    if (!controller?.my) continue;
    const corp = corps.upgradingCorps[controller.room.name];
    if (!corp) continue;
    corp.setSinkAllocation({
      sinkId: spec.sinkId,
      sinkType: "controller",
      allocated: spec.work, // energy/tick == WORK to consume
      demand: spec.work,
      unmet: 0,
      priority: SINK_VALUE.controller,
      sourceFlows: []
    });
  }
}

/** The spawn that staffs this source's haulers, per the plan. */
function haulSpawnId(plan: EconomyPlan, sourceId: string): string {
  const haul = plan.corps.find(c => c.kind === "haul" && c.fromId === sourceId);
  return haul && haul.kind === "haul" ? haul.spawnId : "";
}

/**
 * Find the source's CarryCorp, creating one if the flow materializer never did.
 * Keyed by the source's game id (matching the materializer) so the source's
 * miner and haulers stay a single income unit. Returns undefined only when the
 * commissioned spawn can't be resolved (no live spawn to attach the corp to).
 */
function getOrCreateCarryCorp(corps: CorpRegistry, sourceGameId: string, spawnFlowId: string): CarryCorp | undefined {
  const existing = corps.haulingCorps[sourceGameId];
  if (existing) return existing;

  const spawnGameId = spawnFlowId.replace("spawn-", "");
  const spawn = Game.getObjectById(spawnGameId as Id<StructureSpawn>);
  if (!spawn) return undefined;

  const nodeId = `${spawn.room.name}-hauling-${sourceGameId.slice(-4)}`;
  const carryCorp = new CarryCorp(nodeId, spawn.id);
  carryCorp.createdAt = Game.time;
  corps.haulingCorps[sourceGameId] = carryCorp;
  return carryCorp;
}
