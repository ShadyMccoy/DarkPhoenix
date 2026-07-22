/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, FIND_STRUCTURES, STRUCTURE_CONTAINER } from "../mock";
import { controllerInputSpot, controllerParkingTiles } from "../../../src/corps/nodeEnergy";

/**
 * The controller INPUT SPOT is the one dedicated tile haulers drop at and parked
 * upgraders draw from (the container, or the future-container tile). The PARKING
 * tiles ring it: range 1 of the input (withdraw without moving) AND within
 * upgrade range (3) of the controller (upgrade from there). These pins keep the
 * upgraders consuming the delivered energy without chasing scattered drops or
 * blocking each other.
 */
const STRUCTURE_LINK = "link";

function controllerWith(opts: {
  cx: number;
  cy: number;
  roomName?: string;
  buffers?: { x: number; y: number; type?: string }[]; // containers/links near the controller
  walls?: Set<string>;
  roads?: Set<string>; // road structures on ring tiles ("x,y")
}): any {
  const roomName = opts.roomName ?? "W0N0";
  const buffers = (opts.buffers ?? []).map(b => ({
    structureType: b.type ?? STRUCTURE_CONTAINER,
    pos: { x: b.x, y: b.y, roomName }
  }));
  const within = (px: number, py: number, range: number, arr: any[]) =>
    arr.filter(s => Math.max(Math.abs(s.pos.x - px), Math.abs(s.pos.y - py)) <= range);
  const room = {
    name: roomName,
    getTerrain: () => ({ get: (x: number, y: number) => (opts.walls?.has(`${x},${y}`) ? 1 : 0) }),
    lookForAt: (type: string, x: number, y: number) =>
      type === (global as any).LOOK_STRUCTURES && opts.roads?.has(`${x},${y}`) ? [{ structureType: "road" }] : []
  };
  return {
    pos: {
      x: opts.cx,
      y: opts.cy,
      roomName,
      findInRange: (type: number, range: number, o: any) => {
        const list = type === FIND_STRUCTURES ? buffers : [];
        const filtered = o?.filter ? list.filter(o.filter) : list;
        return within(opts.cx, opts.cy, range, filtered);
      }
    },
    room
  };
}

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

describe("controllerInputSpot / controllerParkingTiles", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).STRUCTURE_LINK = STRUCTURE_LINK;
  });

  it("MIGRATES off a clipped-ring legacy container when a full-ring tile exists (spec 24 rung 1)", () => {
    // Open terrain, container at range 3: its ring loses 3 tiles to upgrade
    // range (the x = cx+4 column is range 4) - park ring 5. Every range-2
    // tile scores 8. Live cost measured (t72455711): parking 6 of a possible
    // 8 = 30 e/t of burn ceiling lost to position alone. The picker must
    // return the better FRESH tile (no structure), not the legacy container.
    const ctrl = controllerWith({ cx: 25, cy: 25, buffers: [{ x: 28, y: 25 }] });
    const spot = controllerInputSpot(ctrl);
    expect(spot.structure, "a clipped legacy container is not the input").to.equal(undefined);
    expect(cheb(spot.pos, { x: 25, y: 25 }), "the fresh spot is a range-2 tile").to.be.at.most(2);
  });

  it("KEEPS an existing container whose ring is within 1 of the best (no churn on near-ties)", () => {
    // Container at range 2 in open terrain: full 8-ring, exactly the best -
    // stays. The hysteresis (accept within best-1) prevents migration flap.
    const ctrl = controllerWith({ cx: 25, cy: 25, buffers: [{ x: 27, y: 25 }] });
    const spot = controllerInputSpot(ctrl);
    expect(spot.structure, "a well-placed container is kept").to.not.equal(undefined);
    expect(spot.pos.x).to.equal(27);
  });

  it("prefers the BEST-ringed container while old and new coexist mid-migration", () => {
    // Both the clipped range-3 legacy and the fresh range-2 container stand
    // (the migration window): the picker anchors on the better one, so the
    // fleet re-homes once and the old container decays unmaintained.
    const ctrl = controllerWith({
      cx: 25,
      cy: 25,
      buffers: [
        { x: 28, y: 25 },
        { x: 23, y: 25 }
      ]
    });
    const spot = controllerInputSpot(ctrl);
    expect(spot.pos.x, "the range-2 container wins").to.equal(23);
    expect(spot.structure).to.not.equal(undefined);
  });

  it("uses an existing container within range 3 as the input spot", () => {
    const c = controllerWith({ cx: 25, cy: 10, buffers: [{ x: 25, y: 12 }] });
    const spot = controllerInputSpot(c);
    expect({ x: spot.pos.x, y: spot.pos.y }).to.deep.equal({ x: 25, y: 12 });
    expect(spot.structure).to.not.equal(undefined);
  });

  it("uses an existing link within range 3 as the input spot", () => {
    const c = controllerWith({ cx: 25, cy: 10, buffers: [{ x: 24, y: 11, type: STRUCTURE_LINK }] });
    const spot = controllerInputSpot(c);
    expect({ x: spot.pos.x, y: spot.pos.y }).to.deep.equal({ x: 24, y: 11 });
  });

  it("with no buffer, picks a deterministic walkable tile within range 2 of the controller", () => {
    const c = controllerWith({ cx: 25, cy: 10 });
    const a = controllerInputSpot(c);
    const b = controllerInputSpot(c);
    expect({ x: a.pos.x, y: a.pos.y }).to.deep.equal({ x: b.pos.x, y: b.pos.y }); // deterministic
    expect(cheb(a.pos, { x: 25, y: 10 })).to.be.greaterThan(0).and.at.most(2);
    expect(a.structure).to.equal(undefined); // a bare drop tile, no structure yet
  });

  it("parking tiles ring the input: range 1 of input, within upgrade range of controller, not the controller", () => {
    const c = controllerWith({ cx: 25, cy: 10, buffers: [{ x: 25, y: 12 }] });
    const input = controllerInputSpot(c).pos;
    const tiles = controllerParkingTiles(c, input);
    expect(tiles.length).to.be.greaterThan(0);
    for (const t of tiles) {
      expect(cheb(t, input)).to.equal(1); // strictly adjacent to the input (never on it)
      expect(cheb(t, { x: 25, y: 10 })).to.be.at.most(3); // can upgrade from here
      expect(t.x === 25 && t.y === 10).to.equal(false); // never the controller tile
      expect(t.x === input.x && t.y === input.y).to.equal(false); // never the reserved input tile
    }
    // deterministic order
    const again = controllerParkingTiles(c, input).map(t => `${t.x},${t.y}`);
    expect(tiles.map(t => `${t.x},${t.y}`)).to.deep.equal(again);
  });

  it("excludes walls from the parking ring", () => {
    const input = { x: 25, y: 12 };
    const c = controllerWith({ cx: 25, cy: 10, buffers: [input], walls: new Set(["24,11", "24,12", "24,13"]) });
    const tiles = controllerParkingTiles(c, controllerInputSpot(c).pos);
    for (const t of tiles) expect(["24,11", "24,12", "24,13"]).to.not.include(`${t.x},${t.y}`);
  });

  it("OFF-ROAD FIRST (owner 2026-07-22): plain ring tiles sort ahead of EVERY road tile - parked bodies must not plug the delivery lanes", () => {
    // Controller (25,10), input container (25,12): the ring is the 8 tiles
    // around the input. Roads staged on the y=11 row hugging the controller -
    // under the old closest-first sort those were the FIRST slots taken, so
    // the fleet parked ON the delivery lane (the owner's screenshot). Road
    // avoidance dominates distance: a plain tile a step farther beats a road
    // tile hugging the controller. Road tiles stay in the ring as last-resort
    // slots (capacity unchanged).
    (global as any).STRUCTURE_ROAD = "road";
    const roads = new Set(["24,11", "25,11", "26,11"]);
    const c = controllerWith({ cx: 25, cy: 10, buffers: [{ x: 25, y: 12 }], roads });
    const input = controllerInputSpot(c).pos;
    const tiles = controllerParkingTiles(c, input);
    expect(tiles.length, "road tiles still count as (last-resort) capacity").to.equal(8);
    const isRoad = (t: { x: number; y: number }): boolean => roads.has(`${t.x},${t.y}`);
    const firstRoad = tiles.findIndex(isRoad);
    expect(firstRoad, "roads exist in the ring").to.be.greaterThan(-1);
    for (let i = 0; i < firstRoad; i++) expect(isRoad(tiles[i])).to.equal(false);
    for (let i = firstRoad; i < tiles.length; i++) expect(isRoad(tiles[i]), "all roads sort behind all plains").to.equal(true);
    // Within each class the closest-first order is preserved.
    const dist = (t: { x: number; y: number }) => cheb(t, { x: 25, y: 10 });
    for (let i = 1; i < firstRoad; i++) expect(dist(tiles[i])).to.be.at.least(dist(tiles[i - 1]));
  });

  it("HOP OFF a cached road spot when a free off-road slot exists (one hop, then stable)", () => {
    // Fleet parked in the road-blind era: an upgrader whose cached spot IS a
    // road keeps blocking the lane for its whole 1500t life unless it hops.
    // The hop fires only while a NON-road slot is genuinely free, lands on
    // one (assignment prefers off-road), and never fires again - no shuffle.
    (global as any).STRUCTURE_ROAD = "road";
    (global as any).Game = { creeps: {} };
    const { UpgradingCorp } = require("../../../src/corps/UpgradingCorp");
    const roads = new Set(["24,11", "25,11", "26,11"]);
    const c = controllerWith({ cx: 25, cy: 10, buffers: [{ x: 25, y: 12 }], roads });
    const corp = new UpgradingCorp("W0N0-upgrading", "spawn1");
    const creep: any = {
      name: "u1",
      pos: { x: 25, y: 11, roomName: "W0N0", isEqualTo: () => false },
      memory: { corpId: corp.id, workType: "upgrade", upgradeSpot: { x: 25, y: 11 } }
    };
    (global as any).Game = { creeps: { u1: creep } };
    const park = (corp as any).parkingTileFor(creep, c);
    expect(roads.has(`${park.x},${park.y}`), "hopped OFF the road").to.equal(false);
    expect(creep.memory.upgradeSpot).to.deep.equal({ x: park.x, y: park.y });
    const again = (corp as any).parkingTileFor(creep, c);
    expect({ x: again.x, y: again.y }, "stable after the hop").to.deep.equal({ x: park.x, y: park.y });
  });

  it("orders the parking ring CLOSEST to the controller first (upgraders hug it)", () => {
    // A bare drop tile is placed ~2 off the controller (open side, to maximise
    // parking capacity), so its ring spans range 1..3 of the controller. The FIRST
    // upgrader must take a range-1 tile next to the controller, not a far-corner
    // range-3 tile - the "upgrader doesn't move close enough" regression.
    const c = controllerWith({ cx: 25, cy: 10 });
    const input = controllerInputSpot(c).pos;
    const tiles = controllerParkingTiles(c, input);
    expect(tiles.length).to.be.greaterThan(0);
    const dist = (t: { x: number; y: number }) => cheb(t, { x: 25, y: 10 });
    // Distances are non-decreasing: the ring fills from the controller outward.
    for (let i = 1; i < tiles.length; i++) expect(dist(tiles[i])).to.be.at.least(dist(tiles[i - 1]));
    // The slot the first (RCL2: only) upgrader takes is a minimal-distance tile.
    expect(dist(tiles[0])).to.equal(Math.min(...tiles.map(dist)));
  });
});
