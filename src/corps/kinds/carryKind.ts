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
import { BodyHints, CorpKind, DemandWorld } from "../../economy/CorpKind";
import { ColonyProblem, CommissionedHauler } from "../../economy/CorpPlanner";
import { buildRatioHaulerBody } from "../../spawn/BodyBuilder";
import { SerializedCorp } from "../Corp";
import { CarryCorp, SerializedCarryCorp } from "../CarryCorp";

// The CommissionedHauler -> HaulerAssignment mapper is shared with flowAdapter
// (one source of truth for the solver-bridge pin); re-exported here for the
// existing import sites (carryKind.test, solverBridge.test).
export { haulerAssignmentFromCommissioned } from "../../flow/haulerAssignment";
import { haulerAssignmentFromCommissioned } from "../../flow/haulerAssignment";

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
  roles: { hauler: { workType: "haul", deliversEnergy: true } },

  // Solver-backed: planColony emits carry commissions, so the kind proposes none.
  propose(_problem: ColonyProblem): Commission[] {
    return [];
  },

  materialize(c: Commission, existing: CarryCorp | undefined): CarryCorp {
    const routes = c.assignment as CommissionedHauler[];
    const assignments = routes.map(haulerAssignmentFromCommissioned);
    if (existing) {
      existing.setHaulerAssignments(assignments);
      // Commission-owned, same stripping as creation below: never let it go stale.
      existing.setSpawnId(routes[0].spawnId.replace("spawn-", ""));
      existing.setPickupHint(c.consumes.at);
      return existing;
    }
    // The flow spawn id is prefixed ("spawn-<gameId>"); strip it so the corp's
    // spawnId is the real game id the scheduler matches on (CarryCorp does not
    // strip it itself, unlike HarvestCorp).
    const spawnId = routes[0].spawnId.replace("spawn-", "");
    const roomName = c.consumes.at?.roomName ?? routes[0].sourceId;
    const corp = new CarryCorp(legacyNodeId(roomName, routes[0].sourceId), spawnId);
    corp.setHaulerAssignments(assignments);
    corp.setPickupHint(c.consumes.at);
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

  body(_role: string, bodyParam: number | undefined, energyBudget: number, hints?: BodyHints): BodyPartConstant[] {
    // bodyParam is the desired CARRY parts (sized by CarryCorp.getSpawnDemand
    // from rate x distance); the ratio hint packs road bodies at 2 CARRY : 1 MOVE.
    return buildRatioHaulerBody(bodyParam, energyBudget, hints?.haulerRatio ?? "1:1").body;
  },

  // A hauler funds inside its source's income unit. The unit key is the real
  // game source id (flow "source-" prefix stripped), taken from the first
  // route - matching harvest's key so the miner and its haulers couple - with
  // the commission id as the routeless fallback. A scavenge- stock's energy is
  // already on the ground (no miner to wait for), so its unit is always
  // "started"; otherwise the unit starts when the source's producer fields.
  demandGroup(corp: CarryCorp, corpId: string, world: DemandWorld) {
    const fromId = corp.getHaulerAssignments()[0]?.fromId;
    const sourceId = (fromId ?? corpId.replace(/^carry-/, "")).replace("source-", "");
    const started = sourceId.startsWith("scavenge-") || world.isSourceMined(sourceId);
    return { groupId: sourceId, started };
  },

  // A hauler belongs to the carry corp that routes its assigned source.
  claimsOrphan(creep: Creep, corps: { [corpId: string]: CarryCorp }): string | null {
    const sourceId = creep.memory.assignedSourceId;
    if (!sourceId) return null;
    for (const id in corps) {
      if (corps[id].getAssignmentForSource(sourceId)) return corps[id].id;
    }
    return null;
  }
};
