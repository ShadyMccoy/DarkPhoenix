/**
 * @fileoverview controllerFeederKind - ControllerFeederCorp as a registered
 * CorpKind: an auxiliary local mover, the controller analogue of the extension
 * tender (docs/specs/00-corp-framework.md).
 *
 * Auxiliary shape, like the extension tender. propose() commissions one feeder
 * corp per spawn room unconditionally; the trigger ("a storage bank exists and the
 * room produces energy") lives at RUNTIME in getSpawnDemand(), which reads live
 * structures and creeps - a corp with no bank demands nothing and costs nothing.
 *
 * @module corps/kinds/controllerFeederKind
 */

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { SerializedCorp } from "../Corp";
import { ControllerFeederCorp, SerializedControllerFeederCorp } from "../ControllerFeederCorp";

/** The feeder commission's binding: which home room, which spawn. */
export interface ControllerFeederAssignment {
  roomName: string;
  spawnId: string;
}

export const controllerFeederKind: CorpKind<ControllerFeederCorp> = {
  kind: "controllerFeeder",
  runOrder: 41, // local mover, right after the extension tender (40)

  propose(problem: ColonyProblem): Commission[] {
    const homeSpawnByRoom = new Map<string, string>();
    for (const s of problem.spawns) {
      if (!homeSpawnByRoom.has(s.pos.roomName)) {
        homeSpawnByRoom.set(s.pos.roomName, s.id);
      }
    }
    return [...homeSpawnByRoom].map(([roomName, spawnId]) => ({
      corpId: corpIdFor("controllerFeeder", roomName),
      kind: "controllerFeeder",
      shape: "auxiliary",
      // Off-budget: a feeder MOVES energy already produced (bank -> controller),
      // priced by the SpawnDirector's infrastructure tier, not the planner.
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName, spawnId } as ControllerFeederAssignment
    }));
  },

  materialize(c: Commission, existing: ControllerFeederCorp | undefined): ControllerFeederCorp {
    const a = c.assignment as ControllerFeederAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      return existing;
    }
    return new ControllerFeederCorp(`${a.roomName}-controllerFeeder`, a.spawnId);
  },

  run(corp: ControllerFeederCorp, tick: number): void {
    corp.work(tick);
  },

  serializeCorp(corp: ControllerFeederCorp): SerializedControllerFeederCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): ControllerFeederCorp {
    const d = data as SerializedControllerFeederCorp;
    const corp = new ControllerFeederCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // Balanced 1:1 CARRY:MOVE shuttle (bodyParam = desired CARRY parts). Mirrors
    // SpawningCorp.buildBodyForRole's "feeder" case for the framework spawn path.
    const carry = Math.max(1, Math.min(bodyParam ?? 4, Math.floor(energyBudget / 100), 25));
    const body: BodyPartConstant[] = [];
    for (let i = 0; i < carry; i++) body.push(CARRY);
    for (let i = 0; i < carry; i++) body.push(MOVE);
    return body;
  }
};
