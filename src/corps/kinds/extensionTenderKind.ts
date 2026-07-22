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

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { SerializedCorp } from "../Corp";
import { ExtensionTenderCorp, SerializedExtensionTenderCorp } from "../ExtensionTenderCorp";
import { buildTankerBody } from "../../spawn/BodyBuilder";

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
    const homeSpawnByRoom = new Map<string, string>();
    for (const s of problem.spawns) {
      if (!homeSpawnByRoom.has(s.pos.roomName)) {
        homeSpawnByRoom.set(s.pos.roomName, s.id);
      }
    }
    return [...homeSpawnByRoom].map(([roomName, spawnId]) => ({
      corpId: corpIdFor("tender", roomName),
      kind: "tender",
      shape: "auxiliary",
      // Off-budget: a tender MOVES energy already produced (depot -> extensions),
      // priced by the SpawnDirector's infrastructure tier, not the planner.
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName, spawnId } as ExtensionTenderAssignment
    }));
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

  run(corp: ExtensionTenderCorp, tick: number): void {
    corp.work(tick);
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
  }
};
