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

import { Commission } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { homeSpawnsByRoom, perRoomAuxiliaryCommission } from "../../economy/proposeHelpers";
import { SerializedCorp } from "../Corp";
import { ControllerFeederCorp, SerializedControllerFeederCorp } from "../ControllerFeederCorp";
import { coreLink } from "../nodeEnergy";
import { buildRatioHaulerBody } from "../../spawn/BodyBuilder";

/** The feeder commission's binding: which home room, which spawn. */
export interface ControllerFeederAssignment {
  roomName: string;
  spawnId: string;
  /**
   * The plan's controller-side flow for this room (summed draft "upgrade"
   * allocations). The feeder relays THIS, not the raw surplus formula - when
   * construction preempts the bank the controller floor is ~2 e/t and a
   * 115 e/t relay into a full stock is 90+ wasted parts (owner t72421124).
   */
  controllerAllocation: number;
}

export const controllerFeederKind: CorpKind<ControllerFeederCorp> = {
  kind: "controllerFeeder",
  roles: { feeder: { workType: "feed" } },
  runOrder: 41, // local mover, right after the extension tender (40)

  propose(problem: ColonyProblem, draft: readonly Commission[]): Commission[] {
    // The plan's controller flow per room, from the draft's upgrade
    // commissions - the same lens the upgraders size from (decision
    // symmetry: the feeder must never relay more than the plan sends).
    const ctrlFlowByRoom = new Map<string, number>();
    for (const c of draft) {
      if (c.kind !== "upgrade") continue;
      const roomName = c.produces.at?.roomName;
      if (!roomName) continue;
      ctrlFlowByRoom.set(roomName, (ctrlFlowByRoom.get(roomName) ?? 0) + (c.consumes.energyRate ?? 0));
    }
    // Off-budget: a feeder MOVES energy already produced (bank -> controller),
    // priced by the SpawnDirector's infrastructure tier, not the planner.
    return [...homeSpawnsByRoom(problem)].map(([roomName, spawnId]) =>
      perRoomAuxiliaryCommission("controllerFeeder", roomName, spawnId, {
        roomName,
        spawnId,
        controllerAllocation: ctrlFlowByRoom.get(roomName) ?? 0
      } as ControllerFeederAssignment)
    );
  },

  materialize(c: Commission, existing: ControllerFeederCorp | undefined): ControllerFeederCorp {
    const a = c.assignment as ControllerFeederAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      existing.setControllerAllocation(a.controllerAllocation);
      return existing;
    }
    const corp = new ControllerFeederCorp(`${a.roomName}-controllerFeeder`, a.spawnId);
    corp.setControllerAllocation(a.controllerAllocation);
    return corp;
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

  spawnTarget(_role: string, spawn: StructureSpawn): RoomPosition | null {
    // The parked relay post: the core link the feeder deposits into (link-fed
    // rooms, where storage + core sit by the spawn so the newborn is born
    // on-post), else the storage depot it shuttles from. Feeds the spawn's
    // `directions` bias (SpawningCorp.executeSpawn) - no walk-in dead time.
    const room = spawn.room;
    return coreLink(room)?.pos ?? (room.storage?.my ? room.storage.pos : null);
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // Balanced 1:1 CARRY:MOVE shuttle (bodyParam = desired CARRY parts) - the
    // shared hauler builder at 1:1 IS the feeder body (bit-identical, pinned
    // by bodyEquivalence's "feeder" case). Floored at 1 CARRY so a zero
    // bodyParam means the minimum shuttle, not "fill the budget".
    return buildRatioHaulerBody(Math.max(1, bodyParam ?? 4), energyBudget, "1:1").body;
  }
};
