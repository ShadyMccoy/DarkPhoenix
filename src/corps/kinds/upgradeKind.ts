/**
 * @fileoverview upgradeKind - UpgradingCorp as a registered CorpKind: the
 * CONSUME solver-backed kind (docs/specs/00-corp-framework.md). Like harvest and
 * carry, its commissions come from the central planner (one per controller sink
 * with energy allocated), so propose() returns [].
 *
 * Consumers are spawn-agnostic in the plan, so the consume commission carries
 * its serving spawn separately (ConsumeAssignment = { sink, spawnId }, attached
 * by commissionsFromPlan). materialize reconstructs the flow-shaped
 * SinkAllocation from the CommissionedSink and binds that spawn.
 *
 * Rungs 1-4 only; the combined solver-backed rung-5 cutover (harvest + carry +
 * upgrade replacing FlowMaterializer at once) is a later commit - see spec 00.
 *
 * @module corps/kinds/upgradeKind
 */

import { Commission } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem, CommissionedSink } from "../../economy/CorpPlanner";
import { ConsumeAssignment } from "../../economy/commissionPlan";
import { SinkAllocation } from "../../flow/FlowTypes";
import { buildUpgraderBody } from "../../spawn/BodyBuilder";
import { SerializedCorp } from "../Corp";
import { SerializedUpgradingCorp, UpgradingCorp } from "../UpgradingCorp";

/**
 * Reconstruct the flow-shaped SinkAllocation from the commission's CommissionedSink,
 * exactly as flowAdapter does when it builds the FlowSolution. sinkType is
 * "controller" for upgrade (the kind is only emitted for controller sinks).
 */
export function sinkAllocationFromCommissioned(k: CommissionedSink): SinkAllocation {
  return {
    sinkId: k.sinkId,
    sinkType: "controller",
    allocated: k.allocated,
    demand: k.demand,
    unmet: Math.max(0, k.demand - k.allocated),
    priority: k.value,
    sourceFlows: k.sources.map(sf => ({ sourceId: sf.sourceId, amount: sf.amount, distance: sf.distance }))
  };
}

/**
 * The UpgradingCorp's legacy runtime nodeId (and id `upgrading-${nodeId}`) is
 * `${roomName}-upgrading` - FlowMaterializer's convention, one per room.
 * Rebuilt from the commission's sink position (produces.at) so live upgraders'
 * memory.corpId still resolves across the migration.
 */
function legacyNodeId(roomName: string): string {
  return `${roomName}-upgrading`;
}

export const upgradeKind: CorpKind<UpgradingCorp> = {
  kind: "upgrade",
  runOrder: 30, // consume, after produce (10) and transport (20)

  // Solver-backed: planColony emits upgrade commissions, so the kind proposes none.
  propose(_problem: ColonyProblem): Commission[] {
    return [];
  },

  materialize(c: Commission, existing: UpgradingCorp | undefined): UpgradingCorp {
    const { sink, spawnId } = c.assignment as ConsumeAssignment;
    const allocation = sinkAllocationFromCommissioned(sink);
    if (existing) {
      existing.setSinkAllocation(allocation);
      // Commission-owned, same stripping as creation below. THE live
      // 0-upgraders incident: the controller sink never churns, so this corp
      // is immortal - a stale spawnId (spawn rebuilt sometime in 72M ticks)
      // made collectDemands drop its demands forever while the plan begged
      // for 117 WORK of upgrading.
      existing.setSpawnId((spawnId ?? "").replace("spawn-", ""));
      return existing;
    }
    const roomName = c.produces.at?.roomName ?? sink.sinkId;
    // The serving spawn is the flow sink id ("spawn-<gameId>"); strip the prefix
    // to the real game id the scheduler matches on (UpgradingCorp does not strip
    // it itself, and FlowMaterializer passes the already-real spawn.id).
    const corp = new UpgradingCorp(legacyNodeId(roomName), (spawnId ?? "").replace("spawn-", ""));
    corp.setSinkAllocation(allocation);
    return corp;
  },

  run(corp: UpgradingCorp, tick: number): void {
    // Replicate the legacy runRealCorps cadence: plan periodically, work every tick.
    if (corp.shouldPlan(tick)) corp.plan(tick);
    corp.work(tick);
  },

  serializeCorp(corp: UpgradingCorp): SerializedUpgradingCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): UpgradingCorp {
    const d = data as SerializedUpgradingCorp;
    const corp = new UpgradingCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // bodyParam caps the WORK parts; the builder sizes to the energy budget.
    return buildUpgraderBody(energyBudget, bodyParam ?? 10).body;
  }
};
