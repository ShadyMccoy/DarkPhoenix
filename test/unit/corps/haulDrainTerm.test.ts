import { expect } from "chai";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";
import { CREEP_LIFETIME, carryPartsFor } from "../../../src/economy/primitives";

/**
 * THE DRAIN TERM HAS TWO REGIMES (the double-drain fix, t72760734 + the
 * runt-economy plateau, both 2026-08-03).
 *
 * History, because this file has now pinned three generations of the law:
 * - 2026-07-29 (the E6 work item): haulCarryNeeded sized to sustained inflow
 *   only, so a standing pile was invisible (cd8e staged 3874, carryNeeded 1,
 *   t72654979). The corp grew its own bufferDrainCarry(staged, d) add.
 * - 2026-08-02 (phase-1 route repricing): the PLAN began pricing the same
 *   drain law into the routes themselves - staged mining routes inside
 *   carryParts, scavenge routes inside their very rate (scavengeRate =
 *   amount/2 / effectiveLife), the bank via bankSurplusRate. The corp-side
 *   add silently became a double-count.
 * - 2026-08-03 measured BOTH ways: MATURE cbd8 asked 45 CARRY against a
 *   37.5 plan route (the ask-side mechanism of F1's 0.449-vs-0.218 hauler
 *   breach) - and the pure removal then plateaued the BOOTSTRAP
 *   runt-economy world at 300/550 for 900 ticks, the recycled miner's
 *   full-size successor never affording (a cold economy lives
 *   solve-to-solve; the plan's once-per-solve drain repricing is too slow
 *   for its ramp).
 *
 * The regimes genuinely differ, and the discriminator is the SAME
 * storageBacked lens the runt ladder uses (owner doctrine: runts and their
 * cranks are "a colony upstart mechanism"): a MATURE (storage-backed) room
 * asks exactly the plan's routes - ONE VALVE, fix the plan if it
 * under-asks - while BOOTSTRAP keeps the belt-and-suspenders drain because
 * escape velocity beats waiting when nothing guarantees refill.
 */
describe("CarryCorp haulCarryNeeded: plan-only when mature, +drain in bootstrap", () => {
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

  it("MATURE: a standing pile adds NOTHING the plan's routes don't already carry (the t72760734 pin)", () => {
    // The measured cd8e pile. Under the retired re-add this asked
    // carryPartsFor(10 + 3874/1500, 36); the plan already prices that drain
    // into carryParts, so the corp asking it again bought ~20% extra fleet.
    const sustained = Math.ceil(carryPartsFor(10, 36));
    expect(mkCorp(3874).haulCarryNeeded(true)).to.equal(sustained);
  });

  it("BOOTSTRAP: the pile still adds one drain share, amortized over a lifetime (the cold ramp)", () => {
    const staged = 3874;
    const sustained = Math.ceil(carryPartsFor(10, 36));
    const asked = mkCorp(staged).haulCarryNeeded(false);
    expect(asked).to.be.greaterThan(sustained);
    // rate = 10 + 3874/2/1500 (the owner's midpoint law, 2026-08-09 - half
    // the standing pile over one generation, same argument as scavengeRate);
    // carry = rate * roundTrip / 50, rounded up - gentle by construction
    // (a few CARRY), never a swarm.
    expect(asked).to.equal(Math.ceil(carryPartsFor(10 + staged / 2 / CREEP_LIFETIME, 36)));
    expect(asked).to.be.lessThan(sustained * 2);
  });

  it("a drained buffer asks the sustained carry in BOTH regimes (self-extinguishing)", () => {
    expect(mkCorp(0).haulCarryNeeded(false)).to.equal(Math.ceil(carryPartsFor(10, 36)));
    expect(mkCorp(0).haulCarryNeeded(true)).to.equal(Math.ceil(carryPartsFor(10, 36)));
  });

  it("fog (staged null) fabricates nothing in either regime", () => {
    expect(mkCorp(null).haulCarryNeeded(false)).to.equal(Math.ceil(carryPartsFor(10, 36)));
    expect(mkCorp(null).haulCarryNeeded(true)).to.equal(Math.ceil(carryPartsFor(10, 36)));
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
    expect(corp.haulCarryNeeded(false), "yields to the builder, pile or no pile").to.equal(0);
    expect(corp.haulCarryNeeded(true)).to.equal(0);
  });
});
