/**
 * @fileoverview coreBusterKind - CoreBusterCorp as a registered CorpKind
 * (spec 13 phase 4, superseding spec 12 phase 2; wired per spec 00).
 *
 * Auxiliary shape, pattern of reservationKind/raidGuardKind: propose() one
 * corp per spawn room unconditionally; the commissioning gate (an active
 * invader-reservation mark with >= CORE_BUSTER_MIN_REMAINING ticks left on a
 * sourced room in range) lives at RUNTIME in the corp, off Memory.roomIntel.
 *
 * @module corps/kinds/coreBusterKind
 */

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { SerializedCorp } from "../Corp";
import { CoreBusterCorp, SerializedCoreBusterCorp } from "../CoreBusterCorp";
import { buildGuardBody, buildReserverBody } from "../../spawn/BodyBuilder";

/** The buster commission's binding: which home room, which spawn. */
export interface CoreBusterAssignment {
  roomName: string;
  spawnId: string;
}

export const coreBusterKind: CorpKind<CoreBusterCorp> = {
  kind: "coreBuster",
  roles: { buster: { workType: "buster" }, striker: { workType: "strike" } },
  runOrder: 40,

  propose(problem: ColonyProblem): Commission[] {
    const homeSpawnByRoom = new Map<string, string>();
    for (const s of problem.spawns) {
      if (!homeSpawnByRoom.has(s.pos.roomName)) {
        homeSpawnByRoom.set(s.pos.roomName, s.id);
      }
    }
    return [...homeSpawnByRoom].map(([roomName, spawnId]) => ({
      corpId: corpIdFor("coreBuster", roomName),
      kind: "coreBuster",
      shape: "auxiliary",
      // Off-budget: the mission restores a zeroed income stream, priced by
      // the SpawnDirector's value ranking, not the flow planner.
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName, spawnId } as CoreBusterAssignment
    }));
  },

  materialize(c: Commission, existing: CoreBusterCorp | undefined): CoreBusterCorp {
    const a = c.assignment as CoreBusterAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      return existing;
    }
    return new CoreBusterCorp(`${a.roomName}-coreBuster`, a.spawnId);
  },

  run(corp: CoreBusterCorp, tick: number): void {
    corp.work(tick);
  },

  serializeCorp(corp: CoreBusterCorp): SerializedCoreBusterCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): CoreBusterCorp {
    const d = data as SerializedCoreBusterCorp;
    const corp = new CoreBusterCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    if (role === "striker") {
      return buildReserverBody(energyBudget, bodyParam ?? 2).body;
    }
    return buildGuardBody(energyBudget, bodyParam ?? 10).body;
  },

  // The kill+strip mission RESTORES zeroed income (spec 13 ph4): same
  // started-income-unit treatment as the guard, never blocking (an occupation
  // is a long siege, not a kill window).
  demandGroup(corp: CoreBusterCorp) {
    return { groupId: corp.id, started: true };
  }
};
