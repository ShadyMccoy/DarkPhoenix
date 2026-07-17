import { expect } from "chai";
import { scavengeSpot, workSpot, EnergySpot } from "../../../src/corps/nodeEnergy";

// Minimal Screeps globals these functions touch.
(global as any).RESOURCE_ENERGY = "energy";
(global as any).FIND_DROPPED_RESOURCES = 106;
(global as any).FIND_TOMBSTONES = 118;
(global as any).FIND_RUINS = 123;
(global as any).FIND_STRUCTURES = 107;
(global as any).STRUCTURE_CONTAINER = "container";

const cheby = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

interface Stocked {
  pos: { x: number; y: number };
  store?: { energy: number; getFreeCapacity?: (r?: string) => number };
  resourceType?: string;
  amount?: number;
  structureType?: string;
}

/** A mock RoomPosition standing among tombstones / ruins / piles / containers. */
function mockPos(
  x: number,
  y: number,
  world: { tombs?: Stocked[]; ruins?: Stocked[]; piles?: Stocked[]; containers?: Stocked[] }
) {
  const self = { x, y };
  return {
    x,
    y,
    roomName: "W0N0",
    findInRange: (type: number, range: number, opts?: { filter?: (o: Stocked) => boolean }) => {
      const list =
        type === (global as any).FIND_TOMBSTONES
          ? world.tombs
          : type === (global as any).FIND_RUINS
            ? world.ruins
            : type === (global as any).FIND_STRUCTURES
              ? world.containers
              : world.piles;
      return (list ?? []).filter(o => cheby(self, o.pos) <= range && (!opts?.filter || opts.filter(o)));
    }
  } as any;
}

const tomb = (x: number, y: number, energy: number): Stocked => ({ pos: { x, y }, store: { energy } });
const ruin = (x: number, y: number, energy: number): Stocked => ({ pos: { x, y }, store: { energy } });
const pile = (x: number, y: number, amount: number): Stocked => ({ pos: { x, y }, resourceType: "energy", amount });
const container = (x: number, y: number, energy: number, capacity = 2000): Stocked => ({
  structureType: "container",
  pos: { x, y },
  store: { energy, getFreeCapacity: () => capacity - energy }
});

describe("scavengeSpot (stock pickup resolution)", () => {
  it("withdraws from a tombstone when one holds energy", () => {
    const t = tomb(25, 25, 800);
    const spot = scavengeSpot(mockPos(25, 25, { tombs: [t] }));
    expect(spot).to.not.equal(null);
    expect(spot!.withdrawFrom).to.equal(t);
  });

  it("prefers a tombstone over a ruin over a bare pile", () => {
    const t = tomb(25, 25, 100);
    const r = ruin(25, 25, 900);
    const p = pile(25, 25, 2000);
    const spot = scavengeSpot(mockPos(25, 25, { tombs: [t], ruins: [r], piles: [p] }));
    expect(spot!.withdrawFrom).to.equal(t); // tombstone wins even though the pile is bigger
  });

  it("falls back to a dropped pile (pickup, no withdraw target)", () => {
    const p = pile(25, 25, 2000);
    const spot = scavengeSpot(mockPos(25, 25, { piles: [p] }));
    expect(spot).to.not.equal(null);
    expect(spot!.withdrawFrom).to.equal(undefined);
    expect(spot!.pos).to.equal(p.pos);
  });

  it("returns null when the stock is gone (scavenger can stand down)", () => {
    expect(scavengeSpot(mockPos(25, 25, {}))).to.equal(null);
  });

  // A stock detected ON a container tile includes the container's contents
  // (detectRoomStocks' one-summed-stock rule), so the scavenger must be able to
  // withdraw from that container - not just chase the ground portion. This is
  // the live 2026-07-17 incident: a full source container's overflow pile was
  // promoted to a 2000+ stock, and the scavenger stood beside the container
  // inching along on the ~10-energy per-tick trickle it could see.
  describe("container-backed stocks (the summed container is reachable)", () => {
    it("withdraws from a FULL container instead of chasing the overflow trickle", () => {
      const c = container(25, 25, 2000); // 2000/2000 - no free capacity
      const trickle = pile(25, 25, 12); // this tick's spill
      const spot = scavengeSpot(mockPos(25, 25, { piles: [trickle], containers: [c] }));

      expect(spot).to.not.equal(null);
      expect(spot!.structure).to.equal(c);
      expect(spot!.pos).to.equal(c.pos);
    });

    it("drains the pile before a NON-full container (decay-first doctrine)", () => {
      const c = container(25, 25, 1200); // 800 free - drops are being absorbed
      const p = pile(25, 25, 300);
      const spot = scavengeSpot(mockPos(25, 25, { piles: [p], containers: [c] }));

      expect(spot!.structure).to.equal(undefined);
      expect(spot!.pos).to.equal(p.pos);
    });

    it("withdraws the stock's container remainder once the pile is gone", () => {
      const c = container(25, 25, 1500);
      const spot = scavengeSpot(mockPos(25, 25, { containers: [c] }));

      expect(spot).to.not.equal(null);
      expect(spot!.structure).to.equal(c);
    });

    it("still prefers a tombstone over the container (decays fastest)", () => {
      const t = tomb(25, 25, 100);
      const c = container(25, 25, 2000);
      const spot = scavengeSpot(mockPos(25, 25, { tombs: [t], containers: [c] }));

      expect(spot!.withdrawFrom).to.equal(t);
    });

    it("ignores a container on an ADJACENT tile (not part of the summed stock)", () => {
      // Detection only sums a container at range 0 of the find; a neighbouring
      // container belongs to some other route (e.g. a commissioned source's) and
      // drawing from it would steal off-route energy.
      const c = container(26, 25, 2000);
      expect(scavengeSpot(mockPos(25, 25, { containers: [c] }))).to.equal(null);
    });

    it("ignores an EMPTY container (stock gone, scavenger stands down)", () => {
      const c = container(25, 25, 0);
      expect(scavengeSpot(mockPos(25, 25, { containers: [c] }))).to.equal(null);
    });
  });
});

describe("workSpot scavenging (withdraw from a tombstone/ruin)", () => {
  function makeCreep(x: number, y: number) {
    const calls = { moveTo: 0, withdraw: 0, lastMoveRange: undefined as number | undefined };
    const self = { x, y };
    return {
      name: "scav",
      pos: {
        roomName: "W0N0",
        getRangeTo: (t: { x: number; y: number }) => cheby(self, t),
        findInRange: () => []
      },
      store: { energy: 0 } as Record<string, number>,
      moveTo: (_t: unknown, o?: { range?: number }) => {
        calls.moveTo += 1;
        calls.lastMoveRange = o?.range;
      },
      withdraw: (_t: unknown, _r: string) => {
        calls.withdraw += 1;
        return 0;
      },
      calls
    };
  }

  it("withdraws from the stock once adjacent (range 1)", () => {
    const t = tomb(25, 25, 800);
    const creep = makeCreep(25, 26); // range 1
    const spot: EnergySpot = { pos: t.pos as any, withdrawFrom: t as any };
    workSpot(creep as any, spot, "collect");
    expect(creep.calls.withdraw).to.equal(1);
    expect(creep.calls.moveTo).to.equal(0);
  });

  it("approaches the stock to range 1 when farther away (does not withdraw yet)", () => {
    const t = tomb(25, 25, 800);
    const creep = makeCreep(25, 28); // range 3
    const spot: EnergySpot = { pos: t.pos as any, withdrawFrom: t as any };
    workSpot(creep as any, spot, "collect");
    expect(creep.calls.withdraw).to.equal(0);
    expect(creep.calls.moveTo).to.equal(1);
    expect(creep.calls.lastMoveRange).to.equal(1);
  });
});
