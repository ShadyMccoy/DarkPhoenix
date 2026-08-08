import { expect } from "chai";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
import { portTenderKind } from "../../../src/corps/kinds/portTenderKind";
import { PORT_TENDER_PARTS, infraSpawnLoad, portTenderSpawnLoad } from "../../../src/economy/primitives";
import { categoryOfKind } from "../../../src/economy/accountCategory";
import { describeCorpKindConformance } from "./conformance";
import { Position } from "../../../src/types/Position";

const HOME = "W1N1";
const at = (x: number, y = 25, roomName = HOME): Position => ({ x, y, roomName });

/**
 * THE PORT TENDER (2026-08-08, owner: *"yes build the port tender"*).
 *
 * A deposit port's buffer container had no drain. Measured t72862894: the port
 * container stood at 2000/2000 while `portFallbacks` was 0 across all eight
 * port-routed routes and `portWaits` ran to 602 - a hauler arriving at a full
 * link found a full buffer too, so both escape hatches were shut and it queued.
 *
 * The gap was named in advance (owner 2026-08-06, quoted in
 * `detectLinkDepositPorts`): *"there's no miner, but we still want a tender."*
 * The adjacent-source requirement was dropped on the reasoning that the feeder
 * "staffs it regardless" - but the feeder operates the CORE and CONTROLLER
 * links, never a port link.
 */
const world = (portRooms: string[] = [HOME]): ColonyProblem => ({
  spawns: [{ id: "spawn1", pos: at(25) }],
  sources: [{ id: "s1", nodeId: "n1", pos: at(15), rate: 10, maxMiners: 1 }],
  sinks: [{ id: "ctrl", kind: "controller", pos: at(30), value: 50, capacity: 1000 }],
  dist: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)),
  portRooms
});

describe("port tender: the deposit port's drain is ON BUDGET from day one", () => {
  it("prices itself where the plan says a port exists", () => {
    const [c] = portTenderKind.propose(world([HOME]), []);
    expect(c.kind).to.equal("portTender");
    expect(c.shape).to.equal("auxiliary");
    expect(c.consumes.spawnPartsPerTick).to.be.closeTo(portTenderSpawnLoad(), 1e-12);
    expect(c.consumes.spawnPartsPerTick).to.be.greaterThan(0);
  });

  /**
   * A room with no port charges NOTHING - the same conditional-member shape
   * raidGuard introduced. A CONSTANT here would tax every colony for a drain it
   * never fields, which is the defect spec 51 phase 2 called out for guards.
   */
  it("charges NOTHING in a room with no deposit port", () => {
    const [c] = portTenderKind.propose(world([]), []);
    expect(c.consumes.spawnPartsPerTick).to.equal(0);
  });

  /**
   * The per-corp price and the colony's own deduction are ONE fact in two
   * shapes - the invariant spec 39 phase 4 established and every kind added
   * since must hold, or SIGMA(auxiliary corps) stops reconciling.
   */
  it("SIGMA(port tenders) === infraSpawnLoad's port term, exactly", () => {
    const withPort = infraSpawnLoad(0, 0, 0, 0, 1, 0, 1);
    const without = infraSpawnLoad(0, 0, 0, 0, 1, 0, 0);
    expect(withPort - without).to.be.closeTo(portTenderSpawnLoad(), 1e-12);
    // ...and N ports sum to N prices (linear, like the reserver).
    expect(infraSpawnLoad(0, 0, 0, 0, 1, 0, 3) - without).to.be.closeTo(3 * portTenderSpawnLoad(), 1e-12);
  });

  it("is a DECLARED price, never the measured fleet (spec 14)", () => {
    expect(portTenderSpawnLoad()).to.be.closeTo(PORT_TENDER_PARTS / 1500, 1e-12);
  });

  it("reports on the infra line - registration-only classification", () => {
    expect(categoryOfKind("portTender")).to.equal("infra");
  });

  /**
   * A DISTINCT workType. `extensionTenderKind` claims every same-room "tank"
   * orphan via `isTenderCreep`, so sharing it would hand port tenders to the
   * extension tender the moment their corp blinked - spec 34 D6's cross-kind
   * adoption, re-entered from the other side.
   */
  it("owns its workType, so the extension tender cannot adopt its creeps", () => {
    expect(Object.values(portTenderKind.roles).map(r => r.workType)).to.deep.equal(["porttend"]);
  });
});

describe("port-tender kind rung 1", () => {
  describeCorpKindConformance(portTenderKind as never, {
    problem: world([HOME]),
    commission: {
      corpId: "portTender-W1N1",
      kind: "portTender",
      shape: "auxiliary",
      consumes: { spawnPartsPerTick: portTenderSpawnLoad() },
      produces: { valuePerTick: 0 },
      assignment: { roomName: HOME, spawnId: "spawn1" }
    },
    expectedSpawnPartsPerTick: portTenderSpawnLoad()
  });
});
