/**
 * @fileoverview linkKind - LinkCorp as a registered
 * CorpKind: an auxiliary local mover, the controller analogue of the extension
 * tender (docs/specs/00-corp-framework.md).
 *
 * Auxiliary shape, like the extension tender. propose() commissions one feeder
 * corp per spawn room unconditionally; the trigger ("a storage bank exists and the
 * room produces energy") lives at RUNTIME in getSpawnDemand(), which reads live
 * structures and creeps - a corp with no bank demands nothing and costs nothing.
 *
 * @module corps/kinds/linkKind
 */

import { Commission } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { homeSpawnsByRoom, perRoomAuxiliaryCommission } from "../../economy/proposeHelpers";
import { buildTankerBody } from "../../spawn/BodyBuilder";
import {
  HUB_TENDER_CARRY,
  PORT_TENDER_CARRY,
  feederSpawnLoad,
  hubTenderSpawnLoad,
  portTenderSpawnLoad
} from "../../economy/primitives";
import { SerializedCorp } from "../Corp";
import { LinkCorp, SerializedLinkCorp } from "../LinkCorp";
import { HUB_TENDER_WORK_TYPE, PORT_TENDER_WORK_TYPE, coreLink } from "../nodeEnergy";
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

export const linkKind: CorpKind<LinkCorp> = {
  kind: "controllerFeeder",
  // TWO roles, one owner: the feeder walks storage -> controller, the port
  // tender parks between a deposit port's buffer and its link. Distinct
  // workTypes so orphan rescue can tell them apart.
  // `PORT_TENDER_WORK_TYPE` is the string this DECLARATION stamps on the creep,
  // and it is the same one both counting lenses match on (spec 57) - the
  // declaration, the demand side and the delivery side, one spelling.
  roles: {
    feeder: { workType: "feed" },
    porttender: { workType: PORT_TENDER_WORK_TYPE },
    // The storage<->terminal post (spec 58 phase 3) - same one-spelling rule.
    hubmanager: { workType: HUB_TENDER_WORK_TYPE }
  },
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
    // ON-BUDGET since spec 39 phase 4: the feeder declares the same shuttle
    // price the colony's ledger already deducts as standing infra, from the
    // SAME primitive (`feederSpawnLoad`) and the SAME two facts - the relay it
    // is sized to, and whether the depot is link-fed (distance 1 vs 6, ~6x).
    //
    // Priced only where a DEPOT exists, matching infraSpawnLoad's
    // `depotRoomCount > 0` gate: a room with no storage has nothing to shuttle
    // FROM, and charging it would make the corps' sum exceed the deduction.
    const depots = new Set(problem.depotRooms ?? []);
    const ported = new Set(problem.portRooms ?? []);
    const terminals = new Set(problem.terminalRooms ?? []);
    const linkFed = new Set(problem.linkFedRooms ?? []);
    return [...homeSpawnsByRoom(problem)].map(([roomName, spawnId]) => {
      const relay = ctrlFlowByRoom.get(roomName) ?? 0;
      return perRoomAuxiliaryCommission(
        "controllerFeeder",
        roomName,
        spawnId,
        {
          roomName,
          spawnId,
          controllerAllocation: relay
        } as ControllerFeederAssignment,
        // ONE price for the whole link network this corp owns: the feeder's
        // relay body plus one port tender per PORTED room. Both terms are the
        // same primitives `infraSpawnLoad` composes, so SIGMA(auxiliary corps)
        // still reconciles with the colony's own deduction.
        (depots.has(roomName) ? feederSpawnLoad(relay, linkFed.has(roomName)) : 0) +
          (ported.has(roomName) ? portTenderSpawnLoad() : 0) +
          // The hub tender (spec 58 phase 3) - priced from the SAME terminalRooms
          // lens the adapter deducts with, so SIGMA(auxiliary) reconciles.
          (terminals.has(roomName) ? hubTenderSpawnLoad() : 0)
      );
    });
  },

  materialize(c: Commission, existing: LinkCorp | undefined): LinkCorp {
    const a = c.assignment as ControllerFeederAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      existing.setControllerAllocation(a.controllerAllocation);
      return existing;
    }
    const corp = new LinkCorp(`${a.roomName}-controllerFeeder`, a.spawnId);
    corp.setControllerAllocation(a.controllerAllocation);
    return corp;
  },

  serializeCorp(corp: LinkCorp): SerializedLinkCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): LinkCorp {
    const d = data as SerializedLinkCorp;
    const corp = new LinkCorp(d.nodeId, d.spawnId, d.id);
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

  body(role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // TWO SHAPES, because the two roles do opposite things. The feeder WALKS
    // storage -> controller, so it is a balanced 1:1 shuttle. The port tender
    // PARKS between a buffer and its link and never carries a step, so it takes
    // the CARRY-heavy tanker shape - the same one the sweep on
    // TANKER_CARRY_PER_MOVE_PLAIN measured optimal.
    if (role === "porttender") return buildTankerBody(bodyParam ?? PORT_TENDER_CARRY, energyBudget, false).body;
    // The hub tender parks like the port tender - same CARRY-heavy shape.
    if (role === "hubmanager") return buildTankerBody(bodyParam ?? HUB_TENDER_CARRY, energyBudget, false).body;
    // Balanced 1:1 CARRY:MOVE shuttle (bodyParam = desired CARRY parts) - the
    // shared hauler builder at 1:1 IS the feeder body (bit-identical, pinned
    // by bodyEquivalence's "feeder" case). Floored at 1 CARRY so a zero
    // bodyParam means the minimum shuttle, not "fill the budget".
    return buildRatioHaulerBody(Math.max(1, bodyParam ?? 4), energyBudget, "1:1").body;
  }
};
