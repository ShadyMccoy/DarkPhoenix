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
import { roomGuardSpawnLoad } from "../../economy/primitives";
import { roomLinearDistance } from "../../utils/RoomDiscovery";
import { MAX_SCOUT_DISTANCE } from "../CorpConstants";

/** The guard commission's binding: which home room, which spawn. */
export interface RaidGuardAssignment {
  roomName: string;
  spawnId: string;
}

export const raidGuardKind: CorpKind<RaidGuardCorp> = {
  kind: "raidGuard",
  account: "defense", // bought on threat, operating overhead (spec 60 B)
  roles: { guard: { workType: "guard" } },
  runOrder: 40,

  propose(problem: ColonyProblem): Commission[] {
    // ON-BUDGET since spec 51 phase 2. The commission shape is unchanged - one
    // corp per SPAWN room, unconditionally, because a corp with no targets and
    // no creeps costs nothing and the arming trigger stays at runtime - but its
    // PRICE now follows the armed-room lens: one standing guard body per room
    // this home guards, zero when the colony is quiet.
    //
    // Declaring 0 did not make guards free. The colony's parts ledger deducts
    // the same fleet as `infraPartsPerTick`, so a 0 here was a cost the colony
    // paid and no row owned - the statement's `defense (guards)` line
    // reconstructed it from measured bodies against a "-" budget (0.020 p/t
    // live at t72847768, 3 guards). The SpawnDirector's value ranking still
    // decides WHEN to buy a body; this is what the plan BUDGETS for it.
    //
    // Rooms bind to their NEAREST home (reservationKind's rule, same tiebreak),
    // so a room two homes can both see is charged ONCE and the corps' sum stays
    // equal to `infraSpawnLoad`'s guard term. The runtime would field two guards
    // there today - a multi-home coverage gap that predates this pricing and is
    // invisible in a single-colony world; when it is fixed, this stays correct.
    const homes = [...homeSpawnsByRoom(problem)].map(([room, spawnId]) => ({ room, spawnId }));
    const count = new Map<string, number>(); // home room -> rooms it pays to guard
    for (const target of [...new Set(problem.guardedRooms ?? [])].sort()) {
      const home = homes
        .map(h => ({ ...h, d: roomLinearDistance(h.room, target) }))
        .filter(h => h.d <= MAX_SCOUT_DISTANCE)
        .sort((a, b) => a.d - b.d || a.room.localeCompare(b.room))[0];
      if (!home) continue;
      count.set(home.room, (count.get(home.room) ?? 0) + 1);
    }
    return homes.map(({ room, spawnId }) =>
      perRoomAuxiliaryCommission(
        "raidGuard",
        room,
        spawnId,
        undefined,
        (count.get(room) ?? 0) * roomGuardSpawnLoad()
      )
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
