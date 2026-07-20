/**
 * @fileoverview claimKind - ClaimCorp as a registered CorpKind (auxiliary
 * shape, like reservation). propose() commissions ONE claim corp only while an
 * expansion campaign is live (Memory.expansion), bound to the colony spawn
 * nearest the target room - that spawn builds the claimer, and its room's
 * economy underwrites the campaign. The campaign trigger itself lives in
 * economy/expansion.ts on the planning cadence; this kind just fields the
 * body the campaign needs.
 *
 * @module corps/kinds/claimKind
 */

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { SerializedCorp } from "../Corp";
import { ClaimCorp, SerializedClaimCorp } from "../ClaimCorp";
import { buildReserverBody } from "../../spawn/BodyBuilder";

/** The claim commission's binding: which target room, which home spawn. */
export interface ClaimAssignment {
  roomName: string;
  spawnId: string;
}

export const claimKind: CorpKind<ClaimCorp> = {
  kind: "claim",
  roles: { claimer: { workType: "claim" } },
  runOrder: 45,

  propose(problem: ColonyProblem): Commission[] {
    if (typeof Memory === "undefined" || !Memory.expansion) return [];
    const target = Memory.expansion.roomName;
    if (problem.spawns.length === 0) return [];

    let best = problem.spawns[0];
    if (typeof Game !== "undefined" && Game.map?.getRoomLinearDistance) {
      let bestDist = Infinity;
      for (const s of problem.spawns) {
        const d = Game.map.getRoomLinearDistance(s.pos.roomName, target);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
    }

    return [
      {
        corpId: corpIdFor("claim", target),
        kind: "claim",
        shape: "auxiliary",
        // Off-budget: the claimer is CAPEX, priced by the SpawnDirector's
        // value ranking (held-funded 650), not the flow planner.
        consumes: { spawnPartsPerTick: 0 },
        produces: { valuePerTick: 0 },
        assignment: { roomName: target, spawnId: best.id } as ClaimAssignment
      }
    ];
  },

  materialize(c: Commission, existing: ClaimCorp | undefined): ClaimCorp {
    const a = c.assignment as ClaimAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      return existing;
    }
    return new ClaimCorp(`${a.roomName}-claim`, a.spawnId);
  },

  run(corp: ClaimCorp, tick: number): void {
    corp.work(tick);
  },

  serializeCorp(corp: ClaimCorp): SerializedClaimCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): ClaimCorp {
    const d = data as SerializedClaimCorp;
    const corp = new ClaimCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    return buildReserverBody(energyBudget, bodyParam ?? 1).body;
  }
};
