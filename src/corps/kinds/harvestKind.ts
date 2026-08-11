/**
 * @fileoverview harvestKind - HarvestCorp as a registered CorpKind: the first
 * SOLVER-BACKED port (docs/specs/00-corp-framework.md). Unlike the auxiliaries,
 * a producer commission is NOT self-proposed: the central solver (planColony ->
 * commissionsFromPlan) emits it, so propose() returns []. The kind supplies the
 * other four verbs - materialize/run/serialize/body.
 *
 * @module corps/kinds/harvestKind
 */

import { Commission } from "../../economy/Commission";
import { BodyHints, CorpKind, DemandWorld } from "../../economy/CorpKind";
import { ColonyProblem, CommissionedMiner } from "../../economy/CorpPlanner";
import { MinerOperationAssignment } from "../../economy/commissionPlan";
import { stripSourcePrefix } from "../../economy/ids";
import { minerOverhead } from "../../economy/primitives";
import { haulerAssignmentFromCommissioned, MinerAssignment } from "../../flow/FlowTypes";
import { buildMinerBody, buildRatioHaulerBody } from "../../spawn/BodyBuilder";
import { SerializedCorp } from "../Corp";
import { HarvestCorp, SerializedHarvestCorp } from "../HarvestCorp";

/** The real game source id (the flow "source-" prefix stripped, defensively). */
function gameSourceId(corp: HarvestCorp): string {
  return stripSourcePrefix(corp.getSourceId());
}

/**
 * Reconstruct the flow-shaped MinerAssignment from the commission's plan
 * payload. spawnCostPerTick is the one derived field - recomputed here from the
 * canonical primitive (ONTOLOGY: no kind ships its own economics), exactly as
 * flowAdapter does when it builds the FlowSolution.
 */
export function minerAssignmentFromCommissioned(m: CommissionedMiner): MinerAssignment {
  return {
    sourceId: m.sourceId,
    nodeId: m.nodeId,
    spawnId: m.spawnId,
    spawnDistance: m.distance,
    harvestRate: m.rate,
    spawnCostPerTick: minerOverhead(m.distance),
    maxMiners: m.maxMiners,
    efficiency: m.efficiency
  };
}

/**
 * The HarvestCorp's legacy runtime nodeId (and hence its id, `mining-${nodeId}`)
 * is `${roomName}-harvest-${sourceId.slice(-4)}` - the convention the retired
 * createHarvestCorp/FlowMaterializer factories established. Rebuilding it here
 * keeps live miners' memory.corpId resolving across the migration. roomName
 * comes from the commission's source position (produces.at), so no Game lookup
 * is needed.
 */
function legacyNodeId(roomName: string, sourceId: string): string {
  return `${roomName}-harvest-${sourceId.slice(-4)}`;
}

export const harvestKind: CorpKind<HarvestCorp> = {
  kind: "harvest",
  // The KIND reports extraction even though its envelope is the all-in MINER
  // OPERATION (node + routed evacuation, spec 34 D5) - the one place a
  // category is coarser than the fleet beneath it. The statement can split
  // the lines from `fleet.miner`/`fleet.hauler`, and the ROLE-grained spend
  // ledger splits them here: the hauler role overrides to evacuation.
  account: "extraction",
  runOrder: 10, // produce before transport (20), consume (30), auxiliary (40)
  // The MINER OPERATION (spec 34 D5): the node's miner AND the evacuation
  // vector's haulers, one kind. The hauler role moved here from the carry
  // kind (which keeps only the minerless scavenge stocks) - haulers deliver
  // income, so the scheduler's is-it-safe-to-wait signal counts them.
  roles: {
    miner: { workType: "harvest" },
    hauler: { workType: "haul", deliversEnergy: true, account: "evacuation" }
  },

  // Solver-backed: planColony emits harvest commissions, so the kind proposes none.
  propose(_problem: ColonyProblem): Commission[] {
    return [];
  },

  materialize(c: Commission, existing: HarvestCorp | undefined): HarvestCorp {
    const op = c.assignment as MinerOperationAssignment;
    const m = op.miner;
    const assignment = minerAssignmentFromCommissioned(m);
    const routes = op.routes.map(haulerAssignmentFromCommissioned);
    if (existing) {
      // setMinerAssignment refreshes the spawn binding itself (with the
      // "spawn-" stripping) - the reason miners never went stale live while
      // the setter-less consumer kinds did. The vector's routes are
      // commission-owned the same way: refreshed every round, and an empty
      // set (haul-of-zero: link-served) clears the standing vector.
      existing.setMinerAssignment(assignment);
      existing.setHaulRoutes(routes, c.produces.at);
      existing.setPostHint(c.produces.at);
      return existing;
    }
    const roomName = c.produces.at?.roomName ?? m.sourceId;
    // HarvestCorp.work() resolves the source via Game.getObjectById(this.sourceId),
    // so the corp's sourceId must be the REAL game id - strip the flow "source-"
    // prefix. The assignment keeps the flow id.
    const corp = new HarvestCorp(legacyNodeId(roomName, m.sourceId), m.spawnId, stripSourcePrefix(m.sourceId));
    corp.setMinerAssignment(assignment);
    corp.setHaulRoutes(routes, c.produces.at);
    corp.setPostHint(c.produces.at);
    return corp;
  },

  serializeCorp(corp: HarvestCorp): SerializedHarvestCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): HarvestCorp {
    const d = data as SerializedHarvestCorp;
    const corp = new HarvestCorp(d.nodeId, d.spawnId, d.sourceId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(role: string, bodyParam: number | undefined, energyBudget: number, hints?: BodyHints): BodyPartConstant[] {
    // Two squads, two shapes: the vector's carriers (bodyParam = CARRY parts,
    // sized by the haul engine's demand; the ratio hint packs road bodies at
    // 2:1) and the miner node (bodyParam = WORK parts; CARRY only for
    // link-fed miners - the corp declares the strategy on its demand).
    if (role === "hauler") return buildRatioHaulerBody(bodyParam, energyBudget, hints?.haulerRatio ?? "1:1").body;
    return buildMinerBody(bodyParam ?? 5, energyBudget, hints?.bodyStrategy === "linkFed").body;
  },

  // A source's miner and haulers fund as ONE income unit keyed by the real
  // game source id; the unit is "started" once a producer creep is fielded.
  demandGroup(corp: HarvestCorp, _corpId: string, world: DemandWorld) {
    const sourceId = gameSourceId(corp);
    return { groupId: sourceId, started: world.isSourceMined(sourceId) };
  },

  sourceOf(corp: HarvestCorp): string | null {
    return gameSourceId(corp);
  },

  // A miner belongs to the harvest corp for the source it stands on (or its
  // remembered source); a HAULER belongs to the operation whose vector routes
  // its assigned source (the rule the standalone carry kind applied, now the
  // operation's own). If that source is no longer commissioned there is no
  // such corp and the orphan falls through (the carry kind still covers
  // scavenge routes) and ultimately recycles.
  claimsOrphan(creep: Creep, corps: { [corpId: string]: HarvestCorp }): string | null {
    if (creep.memory.workType === "haul") {
      const sourceId = creep.memory.assignedSourceId;
      if (!sourceId) return null;
      for (const id in corps) {
        if (corps[id].getHaulAssignmentForSource(sourceId)) return corps[id].id;
      }
      return null;
    }
    const source =
      creep.pos.findInRange(FIND_SOURCES, 1)[0] ??
      (creep.memory.assignedSourceId
        ? Game.getObjectById(creep.memory.assignedSourceId as Id<Source>) ?? undefined
        : undefined);
    if (!source) return null;
    for (const id in corps) {
      if (corps[id].getSourceId() === source.id) return corps[id].id;
    }
    return null;
  }
};
