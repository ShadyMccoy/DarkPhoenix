/**
 * @fileoverview The ONE CommissionedHauler -> HaulerAssignment mapper.
 *
 * The planner emits CommissionedHaulers; two runtime paths reconstruct the
 * flow-shaped HaulerAssignment from them - the live adapter (flowAdapter.
 * solveColony, building the FlowSolution) and the framework materialization
 * (carryKind.materialize). They MUST stay identical, so both call this: a new
 * hauler field (paved, depositPos, ...) is a one-place change and the
 * solver-bridge pin can never drift. spawnCostPerTick is the one derived field,
 * recomputed from the canonical primitive (no private formula).
 *
 * Cycle-free: imports only the CommissionedHauler TYPE (from the pure planner,
 * which never imports flow/), FlowTypes, and primitives. Deliberately NOT in
 * FlowTypes - primitives already imports FlowTypes, so a haulerOverhead call
 * there would close a cycle.
 *
 * @module flow/haulerAssignment
 */

import type { CommissionedHauler } from "../economy/CorpPlanner";
import { haulerOverhead } from "../economy/primitives";
import { HaulerAssignment, createEdgeId } from "./FlowTypes";

/**
 * Reconstruct a flow-shaped HaulerAssignment from one commissioned route.
 * spawnId is carried verbatim (the flow "spawn-" prefix is stripped separately,
 * when the CORP's spawnId is set - not here).
 */
export function haulerAssignmentFromCommissioned(h: CommissionedHauler): HaulerAssignment {
  return {
    edgeId: createEdgeId(h.sourceId, h.sinkId),
    fromId: h.sourceId,
    toId: h.sinkId,
    distance: h.distance,
    carryParts: h.carryParts,
    flowRate: h.flowRate,
    spawnCostPerTick: haulerOverhead(h.carryParts, h.distance),
    // Carry the planner's paved-aware parts/tick verbatim (P4 ledger echoes it).
    spawnParts: h.spawnParts,
    spawnId: h.spawnId,
    // A paved route spawns road haulers: 2 CARRY per MOVE (SpawningCorp.getPartRatios).
    ...(h.paved ? { haulerRatio: "2:1" as const } : {}),
    // The deposit port the plan chose (spec 26): CarryCorp delivers here first.
    ...(h.depositPos ? { depositPos: h.depositPos } : {})
  };
}
