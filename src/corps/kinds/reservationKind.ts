/**
 * @fileoverview reservationKind - ReservationCorp as a registered CorpKind:
 * the second port onto the corp framework (docs/specs/00-corp-framework.md).
 *
 * Auxiliary shape, like scout - and the poster child for the propose()
 * contract: THE TRIGGER READS THE DRAFT. A room is worth reserving exactly
 * when the draft plan mines it (a remote harvest commission targets one of its
 * sources), so propose() derives each home's targetRooms from the draft and
 * bakes them into the commission assignment. materialize() refreshes them on
 * the live corp every round, exactly like spawnId - commission-owned state.
 *
 * The trigger must NOT read live creep positions ("a miner is standing there
 * this tick") and must NOT require room vision. Both were the stranded-
 * reserver incident (shard1 t72378345): the remote's miner died, taking the
 * trigger and the room's vision with it; the in-flight reserver was revoked
 * mid-route and idled out its CLAIM lifetime while the reservation decayed.
 * Runtime reservability (owned/reserved by others, hostiles) is gated inside
 * the corp by the shared vision-free lenses (isReservableRoom, hostileRooms).
 *
 * Spawning stays on the value-ranked SpawnDirector path: the director reads
 * this corp's getSpawnDemand() through the commission store, so reservers keep
 * competing for spawn time at their income-tier value instead of bypassing the
 * scheduler.
 *
 * @module corps/kinds/reservationKind
 */

import { Commission } from "../../economy/Commission";
import { CorpKind, startedUnitDemandGroup } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { roomReserverSpawnLoad } from "../../economy/primitives";
import { homeSpawnsByRoom, perRoomAuxiliaryCommission } from "../../economy/proposeHelpers";
import { SerializedCorp } from "../Corp";
import { ReservationCorp, SerializedReservationCorp } from "../ReservationCorp";
import { buildReserverBody } from "../../spawn/BodyBuilder";
import { roomLinearDistance } from "../../utils/RoomDiscovery";
import { MAX_SCOUT_DISTANCE } from "../CorpConstants";

/**
 * The reservation commission's binding: ONE corp per NODE (remote controller,
 * owner 2026-07-26 "Reservation Corp should be multiple corps, one per node").
 * `roomName`/`spawnId` are the HOME the reserver spawns from; `targetRoom` is
 * the single remote controller this corp holds. One commission per mined remote
 * (nearest home) replaces the old one-per-home-with-a-targetRooms-list shape -
 * so each remote funds/defunds independently and no corp interleaves N rooms'
 * reserver lifetimes (the multi-slot churn the X5 same-slot fix had to correct).
 */
export interface ReservationAssignment {
  roomName: string;
  spawnId: string;
  targetRoom: string;
}

export const reservationKind: CorpKind<ReservationCorp> = {
  kind: "reservation",
  runOrder: 40,
  roles: { reserver: { workType: "reserve" } },

  propose(problem: ColonyProblem, draft: readonly Commission[] = []): Commission[] {
    const homeSpawnByRoom = homeSpawnsByRoom(problem);
    const homes = [...homeSpawnByRoom].map(([room, spawnId]) => ({ room, spawnId }));
    const seenHome = new Set(homeSpawnByRoom.keys());
    // The trigger, on the DURABLE signal: rooms the draft plan MINES that are
    // not our own spawn rooms. Solver harvest commissions carry the source
    // position in produces.at, so no Game/vision/creep lookup is needed here.
    const minedRemotes = new Set<string>();
    for (const c of draft) {
      if (c.kind !== "harvest") continue;
      const room = c.produces.at?.roomName;
      if (room && !seenHome.has(room)) minedRemotes.add(room);
    }
    // ONE corp per NODE: bind each mined remote to its NEAREST home spawn within
    // scout range (deterministic tiebreak), so a remote reachable from two homes
    // gets exactly ONE reservation corp - never two fighting over one controller.
    //
    // ON-BUDGET since spec 39 phase 4: the corp declares the same per-room
    // reserver price the colony's ledger already deducts as standing infra
    // (`roomReserverSpawnLoad`, linear so N rooms sum to infraSpawnLoad's
    // reserver term EXACTLY). It was 0 before, which did not make reservers
    // free - it made them a cost the colony paid and no corp row owned, the
    // biggest single line the statement had to re-derive (19.52 e/t measured
    // at t72823437). The SpawnDirector's value ranking still decides WHEN to
    // buy the body; this is what the plan BUDGETS for it.
    const commissions: Commission[] = [];
    for (const targetRoom of [...minedRemotes].sort()) {
      const home = homes
        .map(h => ({ ...h, d: roomLinearDistance(h.room, targetRoom) }))
        .filter(h => h.d <= MAX_SCOUT_DISTANCE)
        .sort((a, b) => a.d - b.d || a.room.localeCompare(b.room))[0];
      if (!home) continue;
      commissions.push(
        perRoomAuxiliaryCommission(
          "reservation",
          targetRoom,
          home.spawnId,
          {
            roomName: home.room,
            spawnId: home.spawnId,
            targetRoom
          } as ReservationAssignment,
          roomReserverSpawnLoad()
        )
      );
    }
    return commissions;
  },

  materialize(c: Commission, existing: ReservationCorp | undefined): ReservationCorp {
    const a = c.assignment as ReservationAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      existing.setTargetRooms([a.targetRoom]); // ditto - the node follows the PLAN
      return existing;
    }
    // nodeId keyed to the NODE (the remote controller room) so getPosition() and
    // the default orphan rule resolve to the reserved room; the "-reservation"
    // suffix keeps ids the same shape as before the per-node split. Live reservers
    // from the pre-split per-home corp re-home cleanly: the old corp is retained
    // (retiring) until its creeps die, and claimsOrphan below re-adopts any that
    // outlive it by their targetRoom.
    const corp = new ReservationCorp(`${a.targetRoom}-reservation`, a.spawnId);
    corp.setTargetRooms([a.targetRoom]);
    return corp;
  },

  serializeCorp(corp: ReservationCorp): SerializedReservationCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): ReservationCorp {
    const d = data as SerializedReservationCorp;
    const corp = new ReservationCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    return buildReserverBody(energyBudget, bodyParam ?? 2).body;
  },

  // Income-tier treatment (measured, diag-reserver): the reserver UNLOCKS +5
  // e/tick per remote source, and its demand only exists once a miner already
  // harvests the remote - the op is underway, so the unit is always started.
  // At base value it starved forever behind the income tier while the remote
  // stayed at the unreserved half-rate.
  demandGroup: startedUnitDemandGroup,

  // Re-adopt an orphaned reserver into the per-node corp for the room it is
  // LATCHED to (its one-way targetRoom), not the room it happens to stand in -
  // an in-flight reserver mid-route to its remote is in a transit room, and the
  // default same-physical-room rule would recycle it. Matches on the corp's node
  // (getPosition().roomName == targetRoom). An unassigned wildcard (no
  // targetRoom) has no node to belong to yet - defer to the default rule/recycle.
  claimsOrphan(creep: Creep, corps: { [corpId: string]: ReservationCorp }): string | null {
    const room = creep.memory.targetRoom;
    if (!room) return null;
    for (const id in corps) {
      if (corps[id].getPosition().roomName === room) return corps[id].id;
    }
    return null;
  }
};
