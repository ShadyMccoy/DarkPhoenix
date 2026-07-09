/**
 * @fileoverview carryKind - CarryCorp as a registered CorpKind: the TRANSPORT
 * solver-backed kind (docs/specs/00-corp-framework.md). Like harvest, its
 * commissions come from the central planner (commissionsFromPlan emits one
 * carry commission per source, aggregating that source's routes), so propose()
 * returns []. One CarryCorp owns all of its source's routes and distributes the
 * energy across every sink the flow allocated to.
 *
 * Rungs 1-4 only; the combined solver-backed rung-5 cutover (harvest + carry +
 * upgrade replacing FlowMaterializer at once) is a later commit - see spec 00.
 *
 * @module corps/kinds/carryKind
 */

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem, CommissionedHauler } from "../../economy/CorpPlanner";
import { haulerOverhead } from "../../economy/primitives";
import { HaulerAssignment, createEdgeId } from "../../flow/FlowTypes";
import { buildTankerBody } from "../../spawn/BodyBuilder";
import { SerializedCorp } from "../Corp";
import { CarryCorp, SerializedCarryCorp } from "../CarryCorp";

/**
 * Reconstruct a flow-shaped HaulerAssignment from one commissioned route, exactly
 * as flowAdapter does when it builds the FlowSolution. spawnCostPerTick is the
 * one derived field, recomputed from the canonical primitive (no private formula).
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
    spawnId: h.spawnId,
    // A paved route spawns road haulers: CarryCorp forwards this to the spawn
    // demand and SpawningCorp.getPartRatios packs 2 CARRY per MOVE.
    ...(h.paved ? { haulerRatio: "2:1" as const } : {})
  };
}

/**
 * The CarryCorp's legacy runtime nodeId (and id `hauling-${nodeId}`) is
 * `${roomName}-hauling-${sourceId.slice(-4)}` - the convention FlowMaterializer
 * uses. slice(-4) is invariant to the flow "source-" prefix, so the routes'
 * sourceId works directly. Rebuilt here so live haulers' memory.corpId still
 * resolves across the migration; roomName comes from the commission (consumes.at).
 */
function legacyNodeId(roomName: string, sourceId: string): string {
  return `${roomName}-hauling-${sourceId.slice(-4)}`;
}

export const carryKind: CorpKind<CarryCorp> = {
  kind: "carry",
  runOrder: 20, // transport, after produce (10), before consume (30)

  // Solver-backed: planColony emits carry commissions, so the kind proposes none.
  propose(_problem: ColonyProblem): Commission[] {
    return [];
  },

  materialize(c: Commission, existing: CarryCorp | undefined): CarryCorp {
    const routes = c.assignment as CommissionedHauler[];
    const assignments = routes.map(haulerAssignmentFromCommissioned);
    if (existing) {
      existing.setHaulerAssignments(assignments);
      return existing;
    }
    // The flow spawn id is prefixed ("spawn-<gameId>"); strip it so the corp's
    // spawnId is the real game id the scheduler matches on (CarryCorp does not
    // strip it itself, unlike HarvestCorp).
    const spawnId = routes[0].spawnId.replace("spawn-", "");
    const roomName = c.consumes.at?.roomName ?? routes[0].sourceId;
    const corp = new CarryCorp(legacyNodeId(roomName, routes[0].sourceId), spawnId);
    corp.setHaulerAssignments(assignments);
    return corp;
  },

  run(corp: CarryCorp, tick: number): void {
    // Replicate the legacy runRealCorps cadence: plan periodically, work every tick.
    if (corp.shouldPlan(tick)) corp.plan(tick);
    corp.work(tick);
  },

  serializeCorp(corp: CarryCorp): SerializedCarryCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): CarryCorp {
    const d = data as SerializedCarryCorp;
    const corp = new CarryCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // Placeholder CARRY+MOVE body sized by bodyParam carry parts. Real per-route
    // hauler sizing (rate x distance) stays in CarryCorp.getSpawnDemand until the
    // rung-5 cutover routes spawning through the kind.
    return buildTankerBody(bodyParam ?? 4, energyBudget, false).body;
  }
};
