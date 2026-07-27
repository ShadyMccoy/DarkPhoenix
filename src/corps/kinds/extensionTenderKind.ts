/**
 * @fileoverview extensionTenderKind - ExtensionTenderCorp as a registered
 * CorpKind: the third auxiliary port (docs/specs/00-corp-framework.md), the
 * last before the solver-backed kinds.
 *
 * Auxiliary shape, like scout and reservation. The trigger ("a depot exists,
 * the room has extensions, and a flow miner is producing") lives at RUNTIME
 * inside getSpawnDemand(), which reads live structures and creeps; propose()
 * commissions one tender corp per spawn room unconditionally - a corp with no
 * depot demands nothing and costs nothing.
 *
 * Spawning stays on the value-ranked SpawnDirector path (infrastructure tier),
 * read through the commission store - identical to how reservation works.
 *
 * @module corps/kinds/extensionTenderKind
 */

import { Commission } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { homeSpawnsByRoom, perRoomAuxiliaryCommission } from "../../economy/proposeHelpers";
import { SerializedCorp } from "../Corp";
import { ExtensionTenderCorp, SerializedExtensionTenderCorp } from "../ExtensionTenderCorp";
import { buildTankerBody } from "../../spawn/BodyBuilder";
import { isTenderCreep } from "../censusLens";

/** The tender commission's binding: which home room, which spawn. */
export interface ExtensionTenderAssignment {
  roomName: string;
  spawnId: string;
}

export const extensionTenderKind: CorpKind<ExtensionTenderCorp> = {
  kind: "tender",
  roles: { tanker: { workType: "tank" } },
  runOrder: 40,

  propose(problem: ColonyProblem): Commission[] {
    // Off-budget: a tender MOVES energy already produced (depot -> extensions),
    // priced by the SpawnDirector's infrastructure tier, not the planner.
    return [...homeSpawnsByRoom(problem)].map(([roomName, spawnId]) =>
      perRoomAuxiliaryCommission("tender", roomName, spawnId)
    );
  },

  materialize(c: Commission, existing: ExtensionTenderCorp | undefined): ExtensionTenderCorp {
    const a = c.assignment as ExtensionTenderAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      return existing;
    }
    // Legacy nodeId convention preserves the pre-port runtime corp id, so live
    // tenders' memory.corpId still resolves across the migration.
    return new ExtensionTenderCorp(`${a.roomName}-tender`, a.spawnId);
  },

  serializeCorp(corp: ExtensionTenderCorp): SerializedExtensionTenderCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): ExtensionTenderCorp {
    const d = data as SerializedExtensionTenderCorp;
    const corp = new ExtensionTenderCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // Pure CARRY+MOVE feeder; bodyParam is the desired CARRY parts (default 4).
    return buildTankerBody(bodyParam ?? 4, energyBudget, false).body;
  },

  // OWN ORPHANS ONLY (spec 34 D6): workType "tank" is shared with the
  // construction vector's tankers, so the rescue map routes every tank orphan
  // here - and the default same-room rule used to adopt them all. A released
  // or corp-dead construction tanker must instead ride grace -> recycle
  // refund (its operation is over; a vector's carriers exist for the
  // operation they served), so the claim is gated on the tender census lens.
  // The old cross-kind coverage turned finished operations' vectors into
  // phantom tenders - the "half-useful strays" class D6 retires.
  claimsOrphan(creep: Creep, corps: { [corpId: string]: ExtensionTenderCorp }): string | null {
    if (!isTenderCreep(creep.memory)) return null;
    for (const id in corps) {
      if (corps[id].getPosition().roomName === creep.pos.roomName) return id;
    }
    return null;
  }
};
