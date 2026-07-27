/**
 * @fileoverview raidGuardKind - RaidGuardCorp as a registered CorpKind
 * (spec 13 phase 3, wired per the spec-00 framework).
 *
 * Auxiliary shape, pattern of reservationKind: propose() commissions one
 * guard corp per spawn room unconditionally - a corp with no targets and no
 * creeps costs nothing - while the economically interesting trigger (the
 * raid meter's ARM floor / a sighted raid) lives at RUNTIME inside the corp,
 * because it reads Memory.roomIntel and live creeps.
 *
 * Spawning stays on the value-ranked SpawnDirector path at value 105: the
 * guard protects an income stream but never outbids the income itself.
 *
 * @module corps/kinds/raidGuardKind
 */

import { Commission } from "../../economy/Commission";
import { CorpKind, startedUnitDemandGroup } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { homeSpawnsByRoom, perRoomAuxiliaryCommission } from "../../economy/proposeHelpers";
import { SerializedCorp } from "../Corp";
import { RaidGuardCorp, SerializedRaidGuardCorp } from "../RaidGuardCorp";
import { buildGuardBody } from "../../spawn/BodyBuilder";

/** The guard commission's binding: which home room, which spawn. */
export interface RaidGuardAssignment {
  roomName: string;
  spawnId: string;
}

export const raidGuardKind: CorpKind<RaidGuardCorp> = {
  kind: "raidGuard",
  roles: { guard: { workType: "guard" } },
  runOrder: 40,

  propose(problem: ColonyProblem): Commission[] {
    // Off-budget: the guard is producer PROTECTION (it keeps a remote's
    // flow alive through a raid), priced by the SpawnDirector's value
    // ranking, not the flow planner.
    return [...homeSpawnsByRoom(problem)].map(([roomName, spawnId]) =>
      perRoomAuxiliaryCommission("raidGuard", roomName, spawnId)
    );
  },

  materialize(c: Commission, existing: RaidGuardCorp | undefined): RaidGuardCorp {
    const a = c.assignment as RaidGuardAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      return existing;
    }
    return new RaidGuardCorp(`${a.roomName}-raidGuard`, a.spawnId);
  },

  serializeCorp(corp: RaidGuardCorp): SerializedRaidGuardCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): RaidGuardCorp {
    const d = data as SerializedRaidGuardCorp;
    const corp = new RaidGuardCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    return buildGuardBody(energyBudget, bodyParam ?? 5).body;
  },

  // Producer protection funds as an already-started income unit (spec 13): the
  // income it preserves is committed (the armed meter says we mined 65k+
  // there). At base tier the guard starved behind income churn through the
  // whole pre-raid window (def-t4) and the remote fleet it protects died.
  demandGroup: startedUnitDemandGroup
};
