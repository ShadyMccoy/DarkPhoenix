/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * SPEC 56 - THE DEPOSIT-PORT RUNG ACTUALLY FIRES.
 *
 * `bestPortContainerTile` has been unit-pinned since 2026-08-06 and the rung
 * that calls it has never placed a single container. Two mechanisms, both in
 * this file:
 *
 *   1. THE GATE. `wantsAnyContainer` - the gate's `wantsMore` term - listed the
 *      source, depot and controller rungs but not the port rung. A false
 *      `wantsMore` short-circuits before `tryPlaceNextSite` runs at all, and
 *      the room that HAS deposit ports is exactly the mature room where no
 *      other rung wants anything.
 *   2. THE LENS. The rung asked "is a container within 2?" with a bare scan,
 *      so the CONTROLLER's feed store at (41,36) answered yes for the port at
 *      (43,38) - chebyshev 2 - and the rung skipped that port permanently,
 *      while the tender's own lens refused the same container and left the
 *      port with no post at all.
 *
 * And the fight it caused: nothing stopped the controller-container rung from
 * siting inside a port's buffer range, which `reclaimableContainer` then
 * demolishes - construction paying 5,000e a round to place the container the
 * reclaim rung exists to remove (spec 54 open item 4, measured going BACKWARDS
 * in the t72869702 window).
 */
describe("the deposit-port container rung (spec 56)", () => {
  const FIND_SOURCES = 105;
  const FIND_STRUCTURES = 107;
  const FIND_MY_STRUCTURES = 108;
  const FIND_MY_CONSTRUCTION_SITES = 114;
  const FIND_MY_SPAWNS = 112;
  const ROOM = "W43N23";

  // Live W43N23 geometry, to the tile: the deposit port at (43,38) and the
  // superseded controller container at (41,36) - chebyshev 2 apart, which is
  // exactly the range every buffer reader searches. The controller sits at
  // (39,34): within CONTROLLER_CONTAINER_RANGE of that container (so it IS the
  // feed store) and outside it from the port (so the port is a port, not the
  // controller's own link).
  const CORE_LINK = { x: 26, y: 25 };
  const PORT_LINK = { x: 43, y: 38 };
  const CONTROLLER = { x: 39, y: 34 };
  const CONTROLLER_LINK = { x: 38, y: 33 };

  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    Game.time = 100;
    const g = global as any;
    g.OK = 0;
    g.FIND_SOURCES = FIND_SOURCES;
    g.FIND_STRUCTURES = FIND_STRUCTURES;
    g.FIND_MY_STRUCTURES = FIND_MY_STRUCTURES;
    g.FIND_MY_CONSTRUCTION_SITES = FIND_MY_CONSTRUCTION_SITES;
    g.FIND_MY_SPAWNS = FIND_MY_SPAWNS;
    g.LOOK_STRUCTURES = "structure";
    g.LOOK_CONSTRUCTION_SITES = "site";
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_LINK = "link";
    g.STRUCTURE_ROAD = "road";
    g.RESOURCE_ENERGY = "energy";
    g.TERRAIN_MASK_WALL = 1;
    g.RoomPosition = function (this: any, x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
    };
    Game.creeps = {};
    (Memory as any).creeps = {};
    (Memory as any).fundedRemoteRooms = [];
  });

  const cheb = (a: any, b: any): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  const posOf = (x: number, y: number): any => ({
    x,
    y,
    roomName: ROOM,
    getRangeTo(o: any) {
      return cheb(this, o);
    },
    inRangeTo(o: any, r: number) {
      return cheb(this, o) <= r;
    }
  });

  /**
   * A MATURE home room: storage + core link, a controller with its own
   * controller link, two sources, and a deposit port link out at (43,38).
   * `containers` are the built container tiles; nothing else is missing, which
   * is the whole point - it is the room where no other rung wants anything.
   */
  const roomWith = (
    containers: { x: number; y: number }[],
    opts: { controllerLink?: boolean; open?: Set<string> } = {}
  ): any => {
    const hasCtrlLink = opts.controllerLink !== false;
    const linkPositions = [CORE_LINK, PORT_LINK, ...(hasCtrlLink ? [CONTROLLER_LINK] : [])];
    const structures: any[] = [
      ...linkPositions.map((p, i) => ({ structureType: "link", id: `link${i}`, my: true, pos: posOf(p.x, p.y) })),
      ...containers.map((c, i) => ({ structureType: "container", id: `cont${i}`, pos: posOf(c.x, c.y) }))
    ];
    const sources: any[] = [
      { id: "s1", pos: posOf(10, 10) },
      { id: "s2", pos: posOf(20, 40) }
    ];
    const nearScan =
      (self: any) =>
      (_t: number, range: number, o?: any): any[] => {
        const near = structures.filter(x => cheb(x.pos, self.pos) <= range);
        return o?.filter ? near.filter(o.filter) : near;
      };
    for (const s of sources) s.pos.findInRange = nearScan(s);
    const room: any = {
      name: ROOM,
      memory: {},
      getTerrain: () => ({ get: (x: number, y: number) => (!opts.open || opts.open.has(`${x},${y}`) ? 0 : 1) }),
      find: (type: number, o?: any) => {
        if (type === FIND_SOURCES) return sources;
        if (type === FIND_MY_SPAWNS) return [{ id: "spawn1", pos: posOf(24, 24) }];
        if (type === FIND_MY_CONSTRUCTION_SITES) return [];
        const list = type === FIND_MY_STRUCTURES ? structures.filter(s => s.my) : structures;
        return o?.filter ? list.filter(o.filter) : list;
      },
      lookForAt: (what: string, x: number, y: number) =>
        what === "structure" ? structures.filter(s => s.pos.x === x && s.pos.y === y) : [],
      storage: { my: true, pos: posOf(25, 25), store: { energy: 200000, [("energy" as any)]: 200000 } },
      controller: {
        my: true,
        level: 7,
        pos: posOf(CONTROLLER.x, CONTROLLER.y),
        room: undefined as any
      }
    };
    room.controller.room = room;
    // `coreLink` resolves through storage.pos.findInRange; the port and
    // controller links must NOT answer that scan.
    room.storage.pos.findInRange = (_t: number, range: number, o?: any) => {
      const near = structures.filter(s => cheb(s.pos, room.storage.pos) <= range);
      return o?.filter ? near.filter(o.filter) : near;
    };
    for (const s of structures) {
      s.room = room;
      s.pos.findInRange = (_t: number, range: number, o?: any) => {
        const near = structures.filter(x => cheb(x.pos, s.pos) <= range);
        return o?.filter ? near.filter(o.filter) : near;
      };
    }
    room.controller.pos.findInRange = (_t: number, range: number, o?: any) => {
      const near = structures.filter(x => cheb(x.pos, room.controller.pos) <= range);
      return o?.filter ? near.filter(o.filter) : near;
    };
    Game.rooms = { [ROOM]: room } as any;
    return room;
  };

  const corp = (): any => new ConstructionCorp(`${ROOM}-construction`, `${ROOM}-spawn1`) as any;

  it("wants a buffer for a BARE deposit port", () => {
    const room = roomWith([]);
    const tile = corp().findMissingPortContainer(room);
    expect(tile, "a port with no container of its own must get one").to.not.equal(null);
    expect(cheb(tile, PORT_LINK), "sited within a parked tender's reach").to.be.at.most(2);
  });

  it("STILL wants one when the controller's feed store sits inside the port's range", () => {
    // (41,36): chebyshev 2 from the port link, chebyshev 1 from the controller.
    // The bare range-2 scan called this port served and skipped it forever.
    expect(cheb({ x: 41, y: 36 }, PORT_LINK)).to.equal(2);
    const room = roomWith([{ x: 41, y: 36 }]);
    const tile = corp().findMissingPortContainer(room);
    expect(tile, "the controller's container is not this port's buffer").to.not.equal(null);
    expect(cheb(tile, PORT_LINK)).to.be.at.most(2);
  });

  it("is SATISFIED by a real buffer - it does not re-place one every cooldown", () => {
    const room = roomWith([{ x: 44, y: 39 }]);
    expect(corp().findMissingPortContainer(room)).to.equal(null);
  });

  it("the GATE knows it wants one: a mature room with a bare port opens `wantsAnyContainer`", () => {
    // Every other container rung is satisfied: both sources, the core depot and
    // the controller (which has a LINK, so its rung is closed) are served. The
    // only thing missing in the whole room is the port's buffer.
    const room = roomWith([
      { x: 11, y: 10 },
      { x: 21, y: 40 },
      { x: 24, y: 25 }
    ]);
    const c = corp();
    expect(c.findMissingSourceContainer(room), "sources served").to.equal(null);
    expect(c.findMissingCoreDepot(room), "depot served").to.equal(null);
    expect(c.findMissingControllerContainer(room), "controller has a link").to.equal(null);
    expect(
      c.wantsAnyContainer(room, 7, true),
      "the port rung is the ONLY one wanting a slot - the gate must still open"
    ).to.equal(true);
  });

  it("the controller rung REFUSES a tile inside a port's buffer range (the fight loop)", () => {
    // No controller link, so the controller genuinely wants a container, and
    // the terrain leaves (41,36) as the only viable input tile - the live dead
    // container's own tile, chebyshev 2 from the port link. Placing it there is
    // a 5,000e site `reclaimableContainer` immediately demolishes, and each
    // round costs a builder.
    const open = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) open.add(`${41 + dx},${36 + dy}`);
    const room = roomWith([], { controllerLink: false, open });
    const tile = corp().findMissingControllerContainer(room);
    expect(
      tile === null || cheb(tile, PORT_LINK) > 2,
      `controller container at ${JSON.stringify(tile)} lands inside the port's buffer range`
    ).to.equal(true);
  });

  it("...but the controller rung is unaffected where no port is near", () => {
    const open = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) open.add(`${38 + dx},${33 + dy}`);
    const room = roomWith([], { controllerLink: false, open });
    const tile = corp().findMissingControllerContainer(room);
    expect(tile, "a controller with no port nearby still gets its container").to.not.equal(null);
    expect(cheb(tile, PORT_LINK)).to.be.greaterThan(2);
  });
});
