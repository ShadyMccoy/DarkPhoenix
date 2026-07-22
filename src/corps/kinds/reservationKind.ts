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

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { SerializedCorp } from "../Corp";
import { ReservationCorp, SerializedReservationCorp } from "../ReservationCorp";
import { buildReserverBody } from "../../spawn/BodyBuilder";
import { roomLinearDistance } from "../../utils/RoomDiscovery";
import { MAX_SCOUT_DISTANCE } from "../CorpConstants";

/**
 * The reservation commission's binding: which home room, which spawn, and
 * which remote rooms the draft plan mines from there (the reserve-worthy set).
 */
export interface ReservationAssignment {
  roomName: string;
  spawnId: string;
  targetRooms: string[];
}

export const reservationKind: CorpKind<ReservationCorp> = {
  kind: "reservation",
  runOrder: 40,
  roles: { reserver: { workType: "reserve" } },

  propose(problem: ColonyProblem, draft: readonly Commission[] = []): Commission[] {
    const homeSpawnByRoom = new Map<string, string>();
    for (const s of problem.spawns) {
      if (!homeSpawnByRoom.has(s.pos.roomName)) {
        homeSpawnByRoom.set(s.pos.roomName, s.id);
      }
    }
    // The trigger, on the DURABLE signal: rooms the draft plan MINES that are
    // not our own spawn rooms. Solver harvest commissions carry the source
    // position in produces.at, so no Game/vision/creep lookup is needed here.
    const minedRemotes = new Set<string>();
    for (const c of draft) {
      if (c.kind !== "harvest") continue;
      const room = c.produces.at?.roomName;
      if (room && !homeSpawnByRoom.has(room)) minedRemotes.add(room);
    }
    return [...homeSpawnByRoom].map(([roomName, spawnId]) => ({
      corpId: corpIdFor("reservation", roomName),
      kind: "reservation",
      shape: "auxiliary",
      // Off-budget: reservers are an income MULTIPLIER (1500 -> 3000 on remote
      // sources), priced by the SpawnDirector's value ranking, not the planner.
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: {
        roomName,
        spawnId,
        targetRooms: [...minedRemotes].filter(r => roomLinearDistance(roomName, r) <= MAX_SCOUT_DISTANCE).sort()
      } as ReservationAssignment
    }));
  },

  materialize(c: Commission, existing: ReservationCorp | undefined): ReservationCorp {
    const a = c.assignment as ReservationAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      existing.setTargetRooms(a.targetRooms ?? []); // ditto - targets follow the PLAN
      return existing;
    }
    // Legacy nodeId convention preserves the pre-port runtime corp id, so live
    // reservers' memory.corpId still resolves across the migration.
    const corp = new ReservationCorp(`${a.roomName}-reservation`, a.spawnId);
    corp.setTargetRooms(a.targetRooms ?? []);
    return corp;
  },

  run(corp: ReservationCorp, tick: number): void {
    corp.work(tick);
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
  demandGroup(corp: ReservationCorp) {
    return { groupId: corp.id, started: true };
  }
};
