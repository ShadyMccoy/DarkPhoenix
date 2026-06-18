import { expect } from "chai";
import { workSpot, EnergySpot } from "../../../src/corps/nodeEnergy";

// Minimal Screeps globals workSpot touches.
(global as any).RESOURCE_ENERGY = "energy";
(global as any).FIND_DROPPED_RESOURCES = 106;

interface Pile {
  resourceType: string;
  amount: number;
  pos: { x: number; y: number };
}

const cheby = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A mock hauler at (x,y) standing in a field of dropped energy piles. */
function makeCreep(x: number, y: number, piles: Pile[]) {
  const calls = { moveTo: 0, pickup: 0, lastMoveRange: undefined as number | undefined };
  const self = { x, y };
  const pos = {
    roomName: "W0N0",
    getRangeTo: (t: { x: number; y: number }) => cheby(self, t),
    findInRange: (_type: number, range: number, opts?: { filter?: (p: Pile) => boolean }) =>
      piles.filter(p => cheby(self, p.pos) <= range && (!opts?.filter || opts.filter(p)))
  };
  const creep = {
    name: "hauler",
    pos,
    store: { energy: 0 } as Record<string, number>,
    moveTo: (_t: unknown, o?: { range?: number }) => {
      calls.moveTo += 1;
      calls.lastMoveRange = o?.range;
    },
    pickup: (_p: Pile) => {
      calls.pickup += 1;
      return 0;
    },
    calls
  };
  return creep;
}

const pile = (x: number, y: number): Pile => ({ resourceType: "energy", amount: 200, pos: { x, y } });

describe("workSpot (hauler energy access)", () => {
  it("moves closer when collecting from a bare pile two tiles away (does not pick up)", () => {
    const p = pile(25, 25);
    const creep = makeCreep(25, 27, [p]); // range 2 from the pile
    const spot: EnergySpot = { pos: p.pos as any };

    workSpot(creep as any, spot, "collect");

    expect(creep.calls.pickup).to.equal(0);
    expect(creep.calls.moveTo).to.equal(1);
    // It must close to range 1 - the bug was approaching only to range 2.
    expect(creep.calls.lastMoveRange).to.equal(1);
  });

  it("picks up the pile once adjacent (range 1)", () => {
    const p = pile(25, 25);
    const creep = makeCreep(25, 26, [p]); // range 1 from the pile
    const spot: EnergySpot = { pos: p.pos as any };

    workSpot(creep as any, spot, "collect");

    expect(creep.calls.moveTo).to.equal(0);
    expect(creep.calls.pickup).to.equal(1);
  });

  it("keeps clear of a bare source (waitClear): approaches only to range 2", () => {
    // No pile yet - the spot is the source tile, flagged waitClear so the hauler
    // idles nearby instead of camping the miner's harvest tile.
    const spot: EnergySpot = { pos: { x: 25, y: 25 } as any, waitClear: true };

    const far = makeCreep(25, 28, []); // range 3 - should move, but only to range 2
    workSpot(far as any, spot, "collect");
    expect(far.calls.moveTo).to.equal(1);
    expect(far.calls.lastMoveRange).to.equal(2);

    const near = makeCreep(25, 27, []); // range 2 - close enough; wait (no pile, no move)
    workSpot(near as any, spot, "collect");
    expect(near.calls.moveTo).to.equal(0);
    expect(near.calls.pickup).to.equal(0);
  });
});
