/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * `sourceDropped` REACHES THE WIRE (core v36).
 *
 * The field was declared at v19 with a docblock explaining exactly why it
 * matters - "Container energy keeps; dropped energy loses ceil(amount/1000)
 * per tick, so this is the only part that rots" - and then computed into a
 * local that was never added to the returned object. Five references in the
 * file: an import, the interface field, the declaration, a read and a write.
 * No emission.
 *
 * It therefore produced ZERO data points: absent from every capture in
 * `test/fixtures/telemetry/`, and `fiscalArchive` archived `sd: undefined` for
 * every fiscal month it has ever closed. Spec 54 open item 8 recorded the
 * consequence and got the cause wrong - "BLOCKED on the absent `sourceDropped`
 * meter". It was not absent. It was unplugged, and an unplugged meter is
 * indistinguishable from a legitimately empty one at the reading end.
 *
 * Found t72871684 by asking a question the instruments could not answer: of
 * 23,456e standing at source mouths, how much is in containers (which keep it)
 * and how much on the ground (which rots at 17.32 e/t colony-wide)?
 * `sourceBuffers` sums the two and cannot be split.
 *
 * So this test asserts the EMISSION, not the arithmetic - the arithmetic was
 * always right.
 */
describe("core segment: sourceDropped reaches the wire (v36)", () => {
  const FIND_SOURCES = 105;
  const FIND_STRUCTURES = 107;
  const FIND_DROPPED_RESOURCES = 106;

  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.time = 100;
    Game.creeps = {};
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    (Game as any).constructionSites = {};
    (global as any).FIND_SOURCES = FIND_SOURCES;
    (global as any).FIND_STRUCTURES = FIND_STRUCTURES;
    (global as any).FIND_DROPPED_RESOURCES = FIND_DROPPED_RESOURCES;
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).TERRAIN_MASK_WALL = 1;
    (global as any).RoomPosition = class {
      public constructor(public x: number, public y: number, public roomName: string) {}
      public findInRange(): any[] {
        return [];
      }
    };
  });

  /** A source whose mouth holds `container` energy in a container and `dropped` on the ground. */
  const mkSource = (id: string, container: number, dropped: number): any => ({
    id,
    pos: {
      x: 10,
      y: 10,
      findInRange: (find: number) =>
        find === FIND_DROPPED_RESOURCES
          ? dropped > 0
            ? [{ resourceType: "energy", amount: dropped }]
            : []
          : container > 0
            ? [{ structureType: "container", store: { energy: container } }]
            : []
    }
  });

  const roomWith = (sources: any[]): any => ({
    W43N23: {
      name: "W43N23",
      memory: {},
      energyAvailable: 1000,
      energyCapacityAvailable: 1000,
      find: (t: number) => (t === FIND_SOURCES ? sources : [])
    }
  });

  const core = (): any => {
    new Telemetry().update(undefined, [], undefined);
    return JSON.parse(RawMemory.segments[0]);
  };

  it("SPLITS the mouth: sourceBuffers is the total, sourceDropped is the rotting share", () => {
    // 2,000 banked in a container (keeps) + 500 on the ground (rots at 1 e/t).
    Game.rooms = roomWith([mkSource("aaaaaa111111", 2000, 500)]) as any;
    const c = core();
    // The emission was the v36 schema change; the pin tracks the segment's
    // current version so a bump cannot slip past this file unread.
    expect(c.version, "core segment version").to.equal(38);
    expect(c.sourceBuffers["111111"], "buffer = container + ground").to.equal(2500);
    expect(c.sourceDropped, "the rotting share must REACH THE WIRE").to.not.equal(undefined);
    expect(c.sourceDropped["111111"]).to.equal(500);
  });

  it("distinguishes a mouth that is all CONTAINER from one that is all GROUND", () => {
    // The exact question the t72871684 audit could not answer: two sources
    // with identical sourceBuffers, one of which is rotting and one of which
    // is not. Before v36 these were the same reading.
    Game.rooms = roomWith([mkSource("aaaaaa222222", 3000, 0), mkSource("aaaaaa333333", 0, 3000)]) as any;
    const c = core();
    expect(c.sourceBuffers["222222"]).to.equal(3000);
    expect(c.sourceBuffers["333333"]).to.equal(3000);
    expect(c.sourceDropped["222222"], "banked in a container: not rotting, so no key").to.equal(undefined);
    expect(c.sourceDropped["333333"], "all on the ground: the whole buffer rots").to.equal(3000);
  });

  it("omits the key entirely when nothing is dropped - absent and zero stay different facts", () => {
    Game.rooms = roomWith([mkSource("aaaaaa444444", 1200, 0)]) as any;
    const c = core();
    expect(c.sourceBuffers["444444"]).to.equal(1200);
    expect(c.sourceDropped, "no ground energy anywhere: the whole object stays off the wire").to.equal(undefined);
  });

  it("does not fabricate a mouth for a room with no vision", () => {
    Game.rooms = {} as any;
    const c = core();
    expect(c.sourceDropped).to.equal(undefined);
    expect(c.sourceBuffers).to.equal(undefined);
  });
});
