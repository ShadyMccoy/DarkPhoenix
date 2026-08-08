/**
 * @fileoverview portTenderKind - PortTenderCorp as a registered CorpKind.
 *
 * Auxiliary shape, exactly like tender and controllerFeeder: `propose()`
 * commissions one corp per spawn room unconditionally, and the RUNTIME trigger
 * ("this room has a deposit port with a buffer container") lives inside
 * `getSpawnDemand()`, which reads live structures. A room with no port demands
 * nothing and costs nothing.
 *
 * Registration-only (spec 17): this file plus one KINDS entry in CommissionHost
 * plus one line in economy/accountCategory. Demand policy, body building,
 * orphan rescue and the census all derive from the declarations below.
 *
 * @module corps/kinds/portTenderKind
 */

import { Commission } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { homeSpawnsByRoom, perRoomAuxiliaryCommission } from "../../economy/proposeHelpers";
import { portTenderSpawnLoad } from "../../economy/primitives";
import { SerializedCorp } from "../Corp";
import { PortTenderCorp, SerializedPortTenderCorp } from "../PortTenderCorp";
import { buildTankerBody } from "../../spawn/BodyBuilder";

/** The port-tender commission's binding: which home room, which spawn. */
export interface PortTenderAssignment {
  roomName: string;
  spawnId: string;
}

export const portTenderKind: CorpKind<PortTenderCorp> = {
  kind: "portTender",
  // A DISTINCT workType, not the shared "tank". `extensionTenderKind` claims
  // every same-room "tank" orphan through `isTenderCreep`, so reusing it would
  // hand our creeps to the extension tender the moment their corp blinked -
  // the cross-kind adoption spec 34 D6 retired, re-introduced from the other
  // side. One workType, one claimant.
  roles: { porttender: { workType: "porttend" } },
  runOrder: 40,

  propose(problem: ColonyProblem): Commission[] {
    // ON-BUDGET from day one (spec 51 GAP 2 is the debt this program is paying
    // down; a new kind must not add to it). Priced only where the plan says a
    // port exists, because that is exactly how `infraSpawnLoad` charges it -
    // same fact, both sides, so SIGMA(auxiliary corps) still reconciles with
    // the colony's own deduction.
    const ported = new Set(problem.portRooms ?? []);
    return [...homeSpawnsByRoom(problem)].map(([roomName, spawnId]) =>
      perRoomAuxiliaryCommission(
        "portTender",
        roomName,
        spawnId,
        undefined,
        ported.has(roomName) ? portTenderSpawnLoad() : 0
      )
    );
  },

  materialize(c: Commission, existing: PortTenderCorp | undefined): PortTenderCorp {
    const a = c.assignment as PortTenderAssignment;
    if (existing) {
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      return existing;
    }
    return new PortTenderCorp(`${a.roomName}-portTender`, a.spawnId);
  },

  serializeCorp(corp: PortTenderCorp): SerializedPortTenderCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): PortTenderCorp {
    const d = data as SerializedPortTenderCorp;
    const corp = new PortTenderCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // Pure CARRY+MOVE, and PARKED: it walks to its post empty (an empty CARRY
    // is fatigue-free) and then stands between the container and the link, so
    // it is sized for the link's mouth, not for a route.
    return buildTankerBody(bodyParam ?? 6, energyBudget, false).body;
  },

  /** Own orphans only - `porttend` is this kind's alone, so a same-room match
   *  is unambiguous (contrast the shared "tank" workType above). */
  claimsOrphan(creep: Creep, corps: { [corpId: string]: PortTenderCorp }): string | null {
    if (creep.memory.workType !== "porttend") return null;
    for (const id in corps) {
      if (corps[id].getPosition().roomName === creep.pos.roomName) return corps[id].id;
    }
    return null;
  }
};
