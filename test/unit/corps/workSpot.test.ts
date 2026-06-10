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
    getRangeTo: (t: { x: number; y: number }) => cheby(self, t),
    findInRange: (_type: number, range: number, opts?: { filter?: (p: Pile) => boolean }) =>
      piles.filter(p => cheby(self, p.pos) <= range && (!opts?.filter || opts.filter(p)))
  };
  const creep = {
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
});
