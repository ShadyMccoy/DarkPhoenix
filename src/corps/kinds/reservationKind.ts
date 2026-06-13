/**
 * @fileoverview reservationKind - ReservationCorp as a registered CorpKind:
 * the second port onto the corp framework (docs/specs/00-corp-framework.md).
 *
 * Auxiliary shape, like scout. The economically interesting trigger ("one of
 * our miners works an unowned, controllered room") lives at RUNTIME inside the
 * corp (targetRooms gates both work() and getSpawnDemand()), because it reads
 * live creeps; propose() commissions one reservation corp per spawn room
 * unconditionally - a corp with no targets and no creeps costs nothing.
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

/** The reservation commission's binding: which home room, which spawn. */
export interface ReservationAssignment {
  roomName: string;
  spawnId: string;
}

export const reservationKind: CorpKind<ReservationCorp> = {
  kind: "reservation",
  runOrder: 40,

  propose(problem: ColonyProblem): Commission[] {
    const homeSpawnByRoom = new Map<string, string>();
    for (const s of problem.spawns) {
      if (!homeSpawnByRoom.has(s.pos.roomName)) {
        homeSpawnByRoom.set(s.pos.roomName, s.id);
      }
    }
    return [...homeSpawnByRoom].map(([roomName, spawnId]) => ({
      corpId: corpIdFor("reservation", roomName),
      kind: "reservation",
      shape: "auxiliary",
      // Off-budget: reservers are an income MULTIPLIER (1500 -> 3000 on remote
      // sources), priced by the SpawnDirector's value ranking, not the planner.
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName, spawnId } as ReservationAssignment
    }));
  },

  materialize(c: Commission, existing: ReservationCorp | undefined): ReservationCorp {
    if (existing) return existing;
    const a = c.assignment as ReservationAssignment;
    // Legacy nodeId convention preserves the pre-port runtime corp id, so live
    // reservers' memory.corpId still resolves across the migration.
    return new ReservationCorp(`${a.roomName}-reservation`, a.spawnId);
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
  }
};
