import { expect } from "chai";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";
import { carryPartsFor } from "../../../src/economy/primitives";

/**
 * THE DRAIN LIVES IN THE PLAN, ONCE (the double-drain fix, t72760734).
 *
 * History, because this file has now pinned BOTH sides of the law:
 * - 2026-07-29 (the E6 work item): haulCarryNeeded sized to sustained inflow
 *   only, so a standing pile was invisible (cd8e staged 3874, carryNeeded 1,
 *   t72654979). The corp grew its own bufferDrainCarry(staged, d) re-add and
 *   this file pinned it.
 * - 2026-08-02 (phase-1 route repricing): the PLAN began pricing the same
 *   drain law into the routes themselves - staged mining routes inside
 *   carryParts (CorpPlanner `h.carryParts += drainCarry`), scavenge routes
 *   inside their very rate (scavengeRate = amount/2 / effectiveLife), the
 *   bank via bankSurplusRate.
 * - 2026-08-03 (measured t72760734): both sides applying one law = twice.
 *   cbd8's plan route said 37.5 CARRY (inflow ~30 + drain ~7.5); the corp
 *   asked 45 = 37.5 + its own ~7.5 again. Every staged route over-asked by
 *   exactly its drain term - the ask-side mechanism of F1's hauler breach
 *   (built 0.449 p/t vs planned 0.218).
 *
 * ONE VALVE (owner doctrine, the upgrader-valve lesson): the corp sizes to
 * its plan-priced assignments and nothing else. If a pile grows between
 * solves the replan reprices the routes (spec 36); if the plan under-asks,
 * fix the plan. The pile read survives as the sizing STAMP (an instrument),
 * never a sizing term.
 */
describe("CarryCorp haulCarryNeeded: the ask IS the plan's routes (double-drain retired)", () => {
  const G: any = global;

  const container = (x: number, y: number, energy: number) => ({
    structureType: "container",
    pos: { x, y },
    store: { [G.RESOURCE_ENERGY]: energy }
  });

  const roomWith = (structures: any[], owned: any[] = []) => ({
    find: (type: number) => {
      if (type === G.FIND_STRUCTURES) return structures;
      if (type === G.FIND_DROPPED_RESOURCES) return [];
      if (type === G.FIND_MY_STRUCTURES) return owned;
      return [];
    }
  });

  /** A corp on one 10 e/t route at distance 36 (the live cd8e geometry). */
  const mkCorp = (staged: number | null): any => {
    const corp = new CarryCorp("W43N24-hauling-cd8e", "spawn-1") as any;
    corp.pickupPos = { x: 37, y: 38, roomName: "W43N24" };
    corp.setHaulerAssignments([
      {
        fromId: "source-cd8e",
        toId: "storage-home",
        carryParts: carryPartsFor(10, 36),
        distance: 36,
        spawnId: "spawn-1",
        haulerRatio: "1:1"
      } as HaulerAssignment
    ]);
    G.Game.rooms = {};
    if (staged !== null) G.Game.rooms.W43N24 = roomWith([container(37, 38, staged)]);
    return corp;
  };

  beforeEach(() => {
    G.RESOURCE_ENERGY = "energy";
    G.STRUCTURE_CONTAINER = "container";
    G.STRUCTURE_LINK = "link";
    G.FIND_STRUCTURES = 107;
    G.FIND_DROPPED_RESOURCES = 106;
    G.FIND_MY_STRUCTURES = 108;
    G.Game = { rooms: {} as any, getObjectById: () => null };
  });

  it("a standing pile adds NOTHING the plan's routes don't already carry (the t72760734 pin)", () => {
    // The measured cd8e pile. Under the retired re-add this asked
    // carryPartsFor(10 + 3874/1500, 36); the plan already prices that drain
    // into carryParts, so the corp asking it again bought ~20% extra fleet.
    const sustained = Math.ceil(carryPartsFor(10, 36));
    expect(mkCorp(3874).haulCarryNeeded()).to.equal(sustained);
  });

  it("a drained buffer asks the same (the ask never depended on the pile)", () => {
    expect(mkCorp(0).haulCarryNeeded()).to.equal(Math.ceil(carryPartsFor(10, 36)));
  });

  it("fog (staged null) asks the same - no read, no term, nothing fabricated", () => {
    expect(mkCorp(null).haulCarryNeeded()).to.equal(Math.ceil(carryPartsFor(10, 36)));
  });

  it("never hauls a CONSTRUCTION-only route (the tankers own that energy)", () => {
    const corp = new CarryCorp("W43N24-hauling-build", "spawn-1") as any;
    corp.pickupPos = { x: 37, y: 38, roomName: "W43N24" };
    corp.setHaulerAssignments([
      {
        fromId: "source-cd8e",
        toId: "construction-site1",
        carryParts: carryPartsFor(10, 36),
        distance: 36,
        spawnId: "spawn-1",
        haulerRatio: "1:1"
      } as HaulerAssignment
    ]);
    G.Game.rooms = { W43N24: roomWith([container(37, 38, 5000)]) };
    expect(corp.haulCarryNeeded(), "yields to the builder, pile or no pile").to.equal(0);
  });
});
