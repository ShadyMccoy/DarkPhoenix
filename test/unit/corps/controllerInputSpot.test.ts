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
    getTerrain: () => ({ get: (x: number, y: number) => (opts.walls?.has(`${x},${y}`) ? 1 : 0) })
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
      expect(cheb(t, input)).to.be.at.most(1); // adjacent to (or on) the input
      expect(cheb(t, { x: 25, y: 10 })).to.be.at.most(3); // can upgrade from here
      expect(t.x === 25 && t.y === 10).to.equal(false); // never the controller tile
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
});
