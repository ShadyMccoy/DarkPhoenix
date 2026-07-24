import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";
import { Game as MockGame, MockRoomPosition } from "../mock";

/**
 * The live 2026-07-17 incident, driven end to end through CarryCorp.pickupEnergy:
 * a full source container's overflow pile was promoted to a scavenge stock
 * (detectRoomStocks sums a container's contents into a find ON its tile), and the
 * commissioned scavenger - hauler-g-7-38-..., 744/800 aboard - stood beside the
 * 2000-energy container for good. Two distinct failures compound:
 *
 *   1. scavengeSpot never resolved containers, so the scavenger could only see
 *      the ~10-energy per-tick overflow trickle of a stock whose bulk sat in the
 *      container (the same trickle-lock #104 fixed for source haulers).
 *   2. When the visible ground stock ran dry, the scavenger froze: the clean-bus
 *      state machine only departs on a FULL load, and a drained stock can never
 *      top it up - the promised "carries home what it has" had no code behind it.
 */

// Minimal Screeps globals the pickup path touches.
(global as any).RESOURCE_ENERGY = "energy";
(global as any).FIND_SOURCES = 105;
(global as any).FIND_DROPPED_RESOURCES = 106;
(global as any).FIND_STRUCTURES = 107;
(global as any).FIND_TOMBSTONES = 118;
(global as any).FIND_RUINS = 123;
(global as any).STRUCTURE_CONTAINER = "container";

const cheby = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** The stuff standing in the room around the stock, consulted by findInRange. */
const world: { tombs: any[]; ruins: any[]; piles: any[]; structures: any[] } = {
  tombs: [],
  ruins: [],
  piles: [],
  structures: []
};

/** A RoomPosition whose findInRange sees the mock world above. pickupEnergy
 * constructs the stock position itself (new RoomPosition(...)), so the WORLD
 * has to live behind the global class rather than in a hand-built object. */
class StockRoomPosition extends MockRoomPosition {
  public findInRange(type: number, range: number, opts?: { filter?: (o: any) => boolean }): any[] {
    const list =
      type === (global as any).FIND_TOMBSTONES
        ? world.tombs
        : type === (global as any).FIND_RUINS
          ? world.ruins
          : type === (global as any).FIND_DROPPED_RESOURCES
            ? world.piles
            : type === (global as any).FIND_STRUCTURES
              ? world.structures
              : [];
    return list.filter(o => cheby(this, o.pos) <= range && (!opts?.filter || opts.filter(o)));
  }
}

function fullContainer(x: number, y: number, energy: number, capacity = 2000): any {
  return {
    structureType: "container",
    pos: { x, y },
    store: { energy, getFreeCapacity: () => capacity - energy }
  };
}

/** The commissioned scavenge route for the stock at W1N1 (37,38). */
function scavCorp(): CarryCorp {
  const corp = new CarryCorp("W1N1-hauling-7-38", "spawn1");
  corp.setHaulerAssignments([
    {
      edgeId: "scavenge-W1N1-37-38|spawn-spawn1",
      fromId: "scavenge-W1N1-37-38", // CommissionedHauler.sourceId: the raw stock id
      toId: "spawn-spawn1",
      distance: 20,
      carryParts: 16,
      flowRate: 5,
      spawnCostPerTick: 0,
      spawnId: "spawn-spawn1"
    } as HaulerAssignment
  ]);
  return corp;
}

/** A scavenger standing beside the stock tile, partway through filling up. */
function scavenger(energy: number, capacity = 800): any {
  const calls = { withdrawTarget: undefined as any, pickups: 0, said: [] as string[] };
  return {
    name: "scav1",
    room: { name: "W1N1" },
    pos: new StockRoomPosition(37, 39, "W1N1"),
    store: { energy, getFreeCapacity: () => capacity - energy },
    memory: { corpId: "W1N1-hauling-7-38", workType: "haul" },
    say: (m: string) => calls.said.push(m),
    withdraw: (t: any) => {
      calls.withdrawTarget = t;
      return 0;
    },
    pickup: () => {
      calls.pickups += 1;
      return 0;
    },
    calls
  };
}

/** A room whose spawn network is topped up (so no degraded-mode depot refill). */
const room: any = {
  name: "W1N1",
  memory: {},
  energyAvailable: 300,
  energyCapacityAvailable: 300,
  find: () => []
};

describe("scavenger at a container-backed stock (live incident 2026-07-17)", () => {
  let prevRoomPosition: any;

  beforeEach(() => {
    prevRoomPosition = (global as any).RoomPosition;
    (global as any).RoomPosition = StockRoomPosition;
    (global as any).Game = { ...MockGame, creeps: {}, time: 100, getObjectById: () => null };
    world.tombs = [];
    world.ruins = [];
    world.piles = [];
    world.structures = [];
  });

  afterEach(() => {
    (global as any).RoomPosition = prevRoomPosition;
    (global as any).Game = { ...MockGame, creeps: {}, time: 100 };
  });

  it("withdraws from the FULL container instead of chasing the overflow trickle", () => {
    const container = fullContainer(37, 38, 2000); // the stock's summed bulk
    world.structures = [container];
    world.piles = [{ resourceType: "energy", amount: 12, pos: { x: 37, y: 38 } }]; // this tick's spill

    const creep = scavenger(744);
    (scavCorp() as any).pickupEnergy(creep, room);

    expect(creep.calls.withdrawTarget, "one withdraw fills the hauler AND reopens container capacity").to.equal(
      container
    );
    expect(creep.calls.pickups, "must not peck at the per-tick trickle").to.equal(0);
  });

  it("departs with its partial load once the stock is gone, instead of freezing", () => {
    // Nothing left at the stock: no pile, no tombstone, no container energy.
    const creep = scavenger(744);
    (scavCorp() as any).pickupEnergy(creep, room);

    expect(creep.memory.working, "carries home what it has (the stand-down promise)").to.equal(true);
    expect(creep.memory.deliverSinkId, "runs its normal delivery circuit").to.equal("spawn");
  });

  it("RECYCLES when the stock is gone and it has nothing aboard (no lingering runt)", () => {
    // Corrected 2026-07-23 (investigation): the old assumption was that an
    // empty-handed scavenger "waits for OrphanRescue to collect it" - but the
    // retiring corp is RETAINED (!hasLiveCreeps keeps it), so it is never
    // orphaned and OrphanRescue never fires. Left alone the creep idles beside
    // the dead stock for the rest of its ~1500-tick life. It has nothing left to
    // scavenge (re-detection dropped the stock, demand already cut), so it must
    // recycle NOW - the direct "fewer creeps" fix.
    const creep = scavenger(0);
    (scavCorp() as any).pickupEnergy(creep, room);

    expect(creep.memory.recycling, "empty + drained stock -> recycle now, not idle").to.equal(true);
    expect(creep.memory.working, "not starting a delivery - nothing aboard").to.not.equal(true);
  });
});
