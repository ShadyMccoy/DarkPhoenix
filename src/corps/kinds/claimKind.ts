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
import { claimerSpawnLoad } from "../../economy/primitives";
import { nearestSpawnTo } from "../../economy/proposeHelpers";

/** The claim commission's binding: which target room, which home spawn. */
export interface ClaimAssignment {
  roomName: string;
  spawnId: string;
}

export const claimKind: CorpKind<ClaimCorp> = {
  kind: "claim",
  account: "expansion", // CAPEX from the reserve - never charged to operating margin (spec 60 B)
  roles: { claimer: { workType: "claim" } },
  runOrder: 45,

  propose(problem: ColonyProblem): Commission[] {
    // The campaign fact arrives ON THE PROBLEM (host reads Memory.expansion):
    // propose is a pure function of its arguments (spec 17 P3).
    if (!problem.expansion) return [];
    const target = problem.expansion.roomName;
    const best = nearestSpawnTo(problem, target);
    if (!best) return [];

    return [
      {
        corpId: corpIdFor("claim", target),
        kind: "claim",
        shape: "auxiliary",
        // ON the books (spec 39 phase 4 tail): the standing claimer's own
        // primitive, the same term infraSpawnLoad deducts for a live campaign
        // - Sigma(auxiliary) === infraSpawnLoad extends to claiming. The
        // campaign's one-shot CAPEX (founding spawn, seed bodies) stays
        // financed by the shouldExpand bank gate; the BODY is standing spend.
        consumes: { spawnPartsPerTick: claimerSpawnLoad() },
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
