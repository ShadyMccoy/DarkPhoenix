import { expect } from "chai";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";
import { CREEP_LIFETIME, carryPartsFor } from "../../../src/economy/primitives";

/**
 * The BUFFER-DRAIN TERM (owner 2026-07-29, the E6 work item; the fix the
 * 2026-07-26 pileup instrument pre-registered - "staged high, NO link => the
 * fleet is under-sized (the missing drain term is the fix)").
 *
 * haulCarryNeeded sized to SUSTAINED INFLOW only, so a standing pile was
 * invisible to the decision: whatever gap opened (raid embargo, spawn
 * scarcity, a churned hauler) ratcheted the buffer up permanently and the
 * plan never asked for the carry to clear it. Measured live t72654979:
 * cd8e staged 3874 and GROWING, gate held 512t at 100% of window, while its
 * drain route stamped carryNeeded 1 with zero haulers fielded and no source
 * link.
 *
 * The term is the codebase's ONE drain law - sustainableConsumptionRate's
 * stock/CREEP_LIFETIME, the same law the bank surplus (SURPLUS_DRAIN_TICKS)
 * and consumer sizing use: clear the standing buffer over one creep
 * generation, on top of the sustained rate. Gentle by construction (a 3874
 * pile adds 2.6 e/t, not a swarm) and self-extinguishing as the pile drains.
 */
describe("CarryCorp buffer-drain term (haulCarryNeeded reads the standing pile)", () => {
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

  it("adds the standing pile amortized over one creep lifetime", () => {
    const staged = 3874; // the measured cd8e pile
    const sustained = Math.ceil(carryPartsFor(10, 36));
    const withDrain = mkCorp(staged).haulCarryNeeded();
    expect(withDrain).to.be.greaterThan(sustained);
    // rate = 10 + 3874/1500; carry = rate * roundTrip / 50, rounded up
    expect(withDrain).to.equal(Math.ceil(carryPartsFor(10 + staged / CREEP_LIFETIME, 36)));
  });

  it("is GENTLE - a big pile adds a few CARRY, never a swarm", () => {
    // 3874 staged over a lifetime is 2.6 e/t: ~4 CARRY on this route, not 4x.
    const sustained = Math.ceil(carryPartsFor(10, 36));
    expect(mkCorp(3874).haulCarryNeeded()).to.be.lessThan(sustained * 2);
  });

  it("self-extinguishes: a drained buffer asks for exactly the sustained carry", () => {
    expect(mkCorp(0).haulCarryNeeded()).to.equal(Math.ceil(carryPartsFor(10, 36)));
  });

  it("FAILS OPEN on fog (staged null): unmeasurable adds no drain term", () => {
    // A remote source with no vision must not fabricate demand from a stale
    // or absent read - null is a different fact from zero (the stranded-
    // reserver polarity).
    expect(mkCorp(null).haulCarryNeeded()).to.equal(Math.ceil(carryPartsFor(10, 36)));
  });

  it("never drains through a CONSTRUCTION-only route (the tankers own that energy)", () => {
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
