/**
 * @fileoverview harvestKind - HarvestCorp as a registered CorpKind: the first
 * SOLVER-BACKED port (docs/specs/00-corp-framework.md). Unlike the auxiliaries,
 * a producer commission is NOT self-proposed: the central solver (planColony ->
 * commissionsFromPlan) emits it, so propose() returns []. The kind supplies the
 * other four verbs - materialize/run/serialize/body.
 *
 * This commit lands rungs 1-4 (the kind proven in isolation, over the planner,
 * on the generic dispatch, and composed). Rung 5 - cutting the live
 * FlowMaterializer's harvest path over to the host - is a separate commit: it
 * must avoid re-solving the colony each tick and unthread harvest from the
 * miner/hauler/sink materialization that is currently interleaved per node.
 *
 * @module corps/kinds/harvestKind
 */

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem, CommissionedMiner } from "../../economy/CorpPlanner";
import { minerOverhead } from "../../economy/primitives";
import { MinerAssignment } from "../../flow/FlowTypes";
import { buildMinerBody } from "../../spawn/BodyBuilder";
import { SerializedCorp } from "../Corp";
import { HarvestCorp, SerializedHarvestCorp } from "../HarvestCorp";

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
 * is `${roomName}-harvest-${sourceId.slice(-4)}` - the convention createHarvestCorp
 * and FlowMaterializer share. Rebuilding it here keeps live miners' memory.corpId
 * resolving across the migration. roomName comes from the commission's source
 * position (produces.at), so no Game lookup is needed.
 */
function legacyNodeId(roomName: string, sourceId: string): string {
  return `${roomName}-harvest-${sourceId.slice(-4)}`;
}

export const harvestKind: CorpKind<HarvestCorp> = {
  kind: "harvest",
  runOrder: 10, // produce before transport (20), consume (30), auxiliary (40)

  // Solver-backed: planColony emits harvest commissions, so the kind proposes none.
  propose(_problem: ColonyProblem): Commission[] {
    return [];
  },

  materialize(c: Commission, existing: HarvestCorp | undefined): HarvestCorp {
    const m = c.assignment as CommissionedMiner;
    const assignment = minerAssignmentFromCommissioned(m);
    if (existing) {
      // setMinerAssignment refreshes the spawn binding itself (with the
      // "spawn-" stripping) - the reason miners never went stale live while
      // the setter-less consumer kinds did.
      existing.setMinerAssignment(assignment);
      existing.setPostHint(c.produces.at);
      return existing;
    }
    const roomName = c.produces.at?.roomName ?? m.sourceId;
    // HarvestCorp.work() resolves the source via Game.getObjectById(this.sourceId),
    // so the corp's sourceId must be the REAL game id - strip the flow "source-"
    // prefix (FlowMaterializer did the same). The assignment keeps the flow id.
    const corp = new HarvestCorp(legacyNodeId(roomName, m.sourceId), m.spawnId, m.sourceId.replace("source-", ""));
    corp.setMinerAssignment(assignment);
    corp.setPostHint(c.produces.at);
    return corp;
  },

  run(corp: HarvestCorp, tick: number): void {
    // Replicate the legacy runRealCorps cadence: plan periodically, work every tick.
    if (corp.shouldPlan(tick)) corp.plan(tick);
    corp.work(tick);
  },

  serializeCorp(corp: HarvestCorp): SerializedHarvestCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): HarvestCorp {
    const d = data as SerializedHarvestCorp;
    const corp = new HarvestCorp(d.nodeId, d.spawnId, d.sourceId, d.desiredWorkParts, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // bodyParam is the desired WORK parts; the scheduler scales to the budget.
    return buildMinerBody(bodyParam ?? 5, energyBudget).body;
  }
};
