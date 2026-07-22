/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp, buildPool, buildPoolAbsorbRate } from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * THE STRANDED-TRUNK DEADLOCK (prod t72488324, spec 14): buildPool read
 * Game.rooms only, so when W43N22 (4 standing trunk sites, 15/50 tiles
 * unbuilt) went dark, poolWork hit 0, the crew stood down, and nobody was
 * left to ever restore vision - the trunk froze at 35/50 for 1100+ ticks
 * while its stamp read trunk-blind-W43N22. The documented trap class: room
 * state from vision, not the durable signal. The durable signal EXISTS -
 * the HOME room's roadRoutes receipts carry tiles3/rooms/built/total - so
 * the pool charges each BLIND route room its tile-share of the unbuilt
 * remainder. The crew fields, marches (travel IS the vision bootstrap),
 * and ground truth takes over on arrival. Receipts-gated behavior gets its
 * receipts STAGED here (CLAUDE.md sim trap: the trio stages none).
 */
describe("buildPool reads trunk receipts for BLIND rooms (stranded-trunk deadlock)", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    const g = global as any;
    g.FIND_MY_CONSTRUCTION_SITES = 114;
    g.FIND_STRUCTURES = 107;
    g.FIND_MY_STRUCTURES = 108;
    g.FIND_SOURCES = 105;
    g.FIND_DROPPED_RESOURCES = 106;
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_ROAD = "road";
    g.STRUCTURE_LINK = "link";
    g.RESOURCE_ENERGY = "energy";
    g.RoomPosition = function (this: any, x: number, y: number, roomName: string) {
      this.x = x;
      this.y = y;
      this.roomName = roomName;
    };
    Game.creeps = {};
    Game.getObjectById = () => null;
    (Memory as any).creeps = {};
  });

  afterEach(() => {
    Game.rooms = {} as any;
    Game.getObjectById = () => null;
  });

  /** The home room, always visible (its spawn stands there), carrying the
   * route receipts. 35/50 built; tiles3 puts 30 tiles in blind W1N0 and 20
   * at home (already-built stretch). */
  const homeRoom = (routes: any): any => ({
    name: "W1N1",
    controller: { my: true, pos: { x: 40, y: 40, roomName: "W1N1", findInRange: () => [] } },
    storage: {
      my: true,
      store: { energy: 100_000 },
      pos: { x: 20, y: 20, roomName: "W1N1", findInRange: () => [] }
    },
    memory: { roadRoutes: routes },
    find: () => []
  });

  const trunkEntry = (over: any = {}): any => {
    const tiles3: number[] = [];
    for (let i = 0; i < 20; i += 1) tiles3.push(10 + i, 10, 0); // home stretch
    for (let i = 0; i < 30; i += 1) tiles3.push(5 + i, 5, 1); // blind stretch
    return { tiles: [], tiles3, rooms: ["W1N1", "W1N0"], built: 35, total: 50, ...over };
  };

  it("charges a blind route room its tile-share of the unbuilt remainder", () => {
    Game.rooms = { W1N1: homeRoom({ abc: trunkEntry() }) } as any;
    const pool = buildPool("W1N1");
    expect(pool).to.have.length(1);
    expect(pool[0].roomName).to.equal("W1N0");
    expect(pool[0].room, "no vision - no Room object").to.equal(undefined);
    // remainder 15 tiles, blind share 30/50 -> 9 tiles * 300 = 2700 energy.
    expect(pool[0].work).to.be.closeTo(2700, 1e-9);
  });

  it("paved, declined and finished routes charge nothing; visible route rooms use ground truth only", () => {
    Game.rooms = {
      W1N1: homeRoom({
        done: trunkEntry({ paved: true }),
        no: trunkEntry({ declined: true }),
        full: trunkEntry({ built: 50 })
      })
    } as any;
    expect(buildPool("W1N1")).to.have.length(0);

    // Vision of the route room: its STANDING SITES are the truth; the
    // receipt must not double-charge it.
    Game.rooms = {
      W1N1: homeRoom({ abc: trunkEntry() }),
      W1N0: {
        name: "W1N0",
        find: (t: number) => (t === 114 ? [{ progressTotal: 300, progress: 0, pos: { x: 5, y: 5, findInRange: () => [] } }] : [])
      }
    } as any;
    const pool = buildPool("W1N1");
    expect(pool).to.have.length(1);
    expect(pool[0].roomName).to.equal("W1N0");
    expect(pool[0].work, "ground truth (300), not the receipt share").to.equal(300);
  });

  it("buildPoolAbsorbRate prices a blind receipt entry at linear-room-distance travel", () => {
    Game.rooms = { W1N1: homeRoom({ abc: trunkEntry() }) } as any;
    const rate = buildPoolAbsorbRate("W1N1", undefined);
    expect(rate, "a blind remainder still absorbs (the crew can be sized)").to.be.greaterThan(0);
  });

  it("work() MARCHES the pool crew toward a blind receipt head (travel is the vision bootstrap)", () => {
    const spawnStub = {
      id: "spawn1",
      room: { name: "W1N1" },
      pos: { x: 25, y: 25, roomName: "W1N1", findInRange: () => [], getRangeTo: () => 5 }
    };
    Game.getObjectById = (() => spawnStub) as never;
    Game.rooms = { W1N1: homeRoom({ abc: trunkEntry() }) } as any;
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    const moves: unknown[][] = [];
    (Game.creeps as any).b1 = {
      name: "b1",
      spawning: false,
      memory: { corpId: (corp as any).id, workType: "build" },
      pos: { x: 26, y: 25, roomName: "W1N1", isEqualTo: () => false, isNearTo: () => false, getRangeTo: () => 99, inRangeTo: () => false },
      store: { getFreeCapacity: () => 50, getUsedCapacity: () => 0, energy: 0 },
      moveTo: (...a: unknown[]) => {
        moves.push(a);
        return 0;
      },
      move: (...a: unknown[]) => {
        moves.push(a);
        return 0;
      },
      say: () => 0
    };
    corp.work(1000);
    expect(moves.length, "the builder must be ORDERED toward the blind room").to.be.greaterThan(0);
    expect(JSON.stringify(moves[0])).to.contain("W1N0");
  });
});
