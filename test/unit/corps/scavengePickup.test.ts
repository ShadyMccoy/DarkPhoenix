import { expect } from "chai";
import { scavengeSpot, workSpot, EnergySpot } from "../../../src/corps/nodeEnergy";

// Minimal Screeps globals these functions touch.
(global as any).RESOURCE_ENERGY = "energy";
(global as any).FIND_DROPPED_RESOURCES = 106;
(global as any).FIND_TOMBSTONES = 118;
(global as any).FIND_RUINS = 123;

const cheby = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

interface Stocked {
  pos: { x: number; y: number };
  store?: Record<string, number>;
  resourceType?: string;
  amount?: number;
}

/** A mock RoomPosition standing among tombstones / ruins / piles. */
function mockPos(x: number, y: number, world: { tombs?: Stocked[]; ruins?: Stocked[]; piles?: Stocked[] }) {
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
            : world.piles;
      return (list ?? []).filter(o => cheby(self, o.pos) <= range && (!opts?.filter || opts.filter(o)));
    }
  } as any;
}

const tomb = (x: number, y: number, energy: number): Stocked => ({ pos: { x, y }, store: { energy } });
const ruin = (x: number, y: number, energy: number): Stocked => ({ pos: { x, y }, store: { energy } });
const pile = (x: number, y: number, amount: number): Stocked => ({ pos: { x, y }, resourceType: "energy", amount });

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
