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

/**
 * feederRouter.soleOperator (spec 02, owner 2026-07-26): a link-served source's
 * transport belongs to the link network + the feeder (the sole bidirectional
 * core-link operator). sourcePickupSpot must NEVER redirect a hauler to the core
 * link - the old redirect drained the very core the feeder loads, the
 * storage->core->storage thrash (t72595372). RED against the old code, which
 * returned the core link for a link-served source.
 */
describe("sourcePickupSpot (no core-link redirect for a link-served source)", () => {
  const FIND_MY_STRUCTURES = 108;
  beforeEach(() => {
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).FIND_DROPPED_RESOURCES = 106;
    (global as any).FIND_STRUCTURES = 107;
    (global as any).FIND_MY_STRUCTURES = FIND_MY_STRUCTURES;
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).STRUCTURE_LINK = "link";
  });

  /** A link-served source: a room with a storage + adjacent core link (holding
   * energy), and a source link beside the source. Optional source-side pile. */
  function linkServedSource(opts: { corePos: { x: number; y: number }; coreEnergy: number; pilesAt?: Pile[] }) {
    const coreLinkStruct = {
      id: "core",
      structureType: "link",
      pos: { ...opts.corePos, roomName: "W0N0" },
      store: { energy: opts.coreEnergy, getFreeCapacity: () => 800 - opts.coreEnergy }
    };
    const srcLinkStruct = { id: "src-link", structureType: "link", pos: { x: 11, y: 10, roomName: "W0N0" } };
    const room = {
      name: "W0N0",
      storage: {
        my: true,
        pos: {
          x: opts.corePos.x - 1,
          y: opts.corePos.y,
          roomName: "W0N0",
          findInRange: (t: number, _r: number, o?: { filter?: (s: any) => boolean }) => {
            const list = t === FIND_MY_STRUCTURES ? [coreLinkStruct] : [];
            return o?.filter ? list.filter(o.filter) : list;
          }
        }
      }
    };
    (global as any).Game = { rooms: { W0N0: room } };
    const sourcePos = {
      x: 10,
      y: 10,
      roomName: "W0N0",
      findInRange: (type: number, range: number, opts2?: { filter?: (o: any) => boolean }) => {
        let list: any[] = [];
        if (type === FIND_MY_STRUCTURES) list = [srcLinkStruct, coreLinkStruct];
        else if (type === (global as any).FIND_DROPPED_RESOURCES) list = opts.pilesAt ?? [];
        else list = []; // FIND_STRUCTURES (containers)
        return list.filter(o => cheby({ x: 10, y: 10 }, o.pos) <= range && (!opts2?.filter || opts2.filter(o)));
      }
    } as any;
    return { sourcePos, coreLinkStruct };
  }

  it("with a loaded core link and NO source pile: waits clear of the source, NOT the core", () => {
    const { sourcePos, coreLinkStruct } = linkServedSource({ corePos: { x: 40, y: 40 }, coreEnergy: 500 });
    const spot = sourcePickupSpot(sourcePos);
    expect(spot.structure, "must not point the hauler at the core link").to.not.equal(coreLinkStruct);
    expect(spot.structure).to.equal(undefined);
    expect(spot.waitClear).to.equal(true);
  });

  it("with a source-side pile: drains the pile at the source, NOT the core", () => {
    const p = pile(10, 10, 300);
    const { sourcePos, coreLinkStruct } = linkServedSource({ corePos: { x: 40, y: 40 }, coreEnergy: 500, pilesAt: [p] });
    const spot = sourcePickupSpot(sourcePos);
    expect(spot.structure).to.not.equal(coreLinkStruct);
    expect(spot.pos).to.equal(p.pos);
  });
});
