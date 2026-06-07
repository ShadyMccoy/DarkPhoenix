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

import { FlowGraph } from "./FlowGraph";
import {
  planEconomy,
  PlannerInput,
  PlannerSource,
  PlannerSink,
  PlannedFlow,
  EconomyPlan,
  SinkKind,
} from "./EconomyPlanner";
import { estimateWalkingDistance } from "../nodes/NodeNavigator";
import { SinkType, HaulerAssignment } from "./FlowTypes";
import { CorpRegistry } from "../execution/CorpRunner";

/** Strategic value per sink kind (anti-downgrade reserve handled separately). */
export const SINK_VALUE: Record<SinkKind, number> = {
  spawn: 100, // critical: the economy can't run without staffing creeps
  construction: 70, // building supersedes upgrading
  controller: 50, // upgrading absorbs the leftover
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
  const sources: PlannerSource[] = graph.getSources().map((s) => ({
    id: s.id,
    supply: s.capacity, // energy/tick (e.g. 10)
    pos: s.position,
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
      // spawn: planner computes overhead (capacity ignored). construction &
      // controller: keep pace with supply, so cap at what the room can produce.
      capacity: kind === "spawn" ? 0 : Math.max(totalSupply, 1),
      pos: sink.position,
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
    const carryCorp = corps.haulingCorps[sourceGameId];
    if (!carryCorp) continue;

    const spawnId = haulSpawnId(plan, sourceId);
    const assignments: HaulerAssignment[] = flows
      .filter((f) => f.amount > 0)
      .map((f) => ({
        edgeId: `${f.sourceId}|${f.sinkId}`,
        fromId: f.sourceId,
        toId: f.sinkId,
        distance: f.distance,
        carryParts: Math.max(1, Math.ceil((f.amount * (2 * f.distance + 2)) / 50)),
        flowRate: f.amount,
        spawnCostPerTick: 0,
        spawnId,
      }));
    if (assignments.length > 0) carryCorp.setHaulerAssignments(assignments);
  }
}

/** The spawn that staffs this source's haulers, per the plan. */
function haulSpawnId(plan: EconomyPlan, sourceId: string): string {
  const haul = plan.corps.find((c) => c.kind === "haul" && c.fromId === sourceId);
  return haul && haul.kind === "haul" ? haul.spawnId : "";
}
