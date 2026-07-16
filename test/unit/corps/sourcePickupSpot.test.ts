import { expect } from "chai";
import { sourcePickupSpot } from "../../../src/corps/nodeEnergy";

// Minimal Screeps globals sourcePickupSpot touches.
(global as any).RESOURCE_ENERGY = "energy";
(global as any).FIND_DROPPED_RESOURCES = 106;
(global as any).FIND_STRUCTURES = 107;
(global as any).STRUCTURE_CONTAINER = "container";

const cheby = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

interface Pile {
  resourceType: string;
  amount: number;
  pos: { x: number; y: number };
}

interface Container {
  structureType: string;
  pos: { x: number; y: number };
  store: { energy: number; getFreeCapacity: (r?: string) => number };
}

/** A mock source position with piles / a container within range 1. */
function mockSourcePos(x: number, y: number, world: { piles?: Pile[]; containers?: Container[] }) {
  const self = { x, y };
  return {
    x,
    y,
    roomName: "W0N0",
    findInRange: (type: number, range: number, opts?: { filter?: (o: any) => boolean }) => {
      const list: any[] =
        type === (global as any).FIND_DROPPED_RESOURCES ? (world.piles ?? []) : (world.containers ?? []);
      return list.filter(o => cheby(self, o.pos) <= range && (!opts?.filter || opts.filter(o)));
    }
  } as any;
}

const pile = (x: number, y: number, amount: number): Pile => ({ resourceType: "energy", amount, pos: { x, y } });
const container = (x: number, y: number, energy: number, capacity = 2000): Container => ({
  structureType: "container",
  pos: { x, y },
  store: { energy, getFreeCapacity: () => capacity - energy }
});

describe("sourcePickupSpot (pile vs container priority)", () => {
  beforeEach(() => {
    // No room vision needed: coreLink resolution is skipped when the room is
    // absent, which keeps these tests on the pile/container branch.
    (global as any).Game = { rooms: {} };
  });

  it("withdraws from a FULL container instead of chasing the per-tick overflow trickle", () => {
    // The live bug: a full container makes the miner's harvest spill to the
    // ground EVERY tick, so an unconditional pile-first rule locks the hauler
    // into ~10-energy pickups forever while 2000 sits in the container.
    const c = container(9, 10, 2000); // 2000/2000 - no free capacity
    const trickle = pile(9, 10, 24); // this tick's overflow
    const spot = sourcePickupSpot(mockSourcePos(10, 10, { piles: [trickle], containers: [c] }));

    expect(spot.structure).to.equal(c);
    expect(spot.pos).to.equal(c.pos);
  });

  it("drains a pile before a NON-full container (decay-first doctrine)", () => {
    // A pile beside a container with headroom is stale stock (drops are being
    // absorbed, the pile only decays) - drain the depreciating stock first.
    const c = container(9, 10, 1200); // 800 free
    const p = pile(9, 10, 300);
    const spot = sourcePickupSpot(mockSourcePos(10, 10, { piles: [p], containers: [c] }));

    expect(spot.structure).to.equal(undefined);
    expect(spot.pos).to.equal(p.pos);
  });

  it("withdraws from a stocked container when there is no pile", () => {
    const c = container(9, 10, 500);
    const spot = sourcePickupSpot(mockSourcePos(10, 10, { containers: [c] }));

    expect(spot.structure).to.equal(c);
  });

  it("resolves the drop pile when there is no container", () => {
    const p = pile(11, 10, 300);
    const spot = sourcePickupSpot(mockSourcePos(10, 10, { piles: [p] }));

    expect(spot.structure).to.equal(undefined);
    expect(spot.pos).to.equal(p.pos);
  });

  it("ignores an EMPTY container and waits clear of the bare source", () => {
    const c = container(9, 10, 0);
    const spot = sourcePickupSpot(mockSourcePos(10, 10, { containers: [c] }));

    expect(spot.structure).to.equal(undefined);
    expect(spot.waitClear).to.equal(true);
  });
});
