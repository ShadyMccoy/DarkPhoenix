/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * `sourceMouth` - the CONTAINER at a source's mouth, as a fact rather than an
 * inference (core v37).
 *
 * v36 split each mouth into container-held and ground-held energy
 * (`sourceBuffers` - `sourceDropped`), which localised the waste ledger's top
 * line to "five of seven rotting sources hold exactly 2000, the container cap"
 * (spec 59). It left two sources undiagnosed and, in the very next window,
 * produced a reading it cannot explain at all:
 *
 * ```
 *   cd8d   t72873814   buffer 4316   dropped 2316   container 2000  (at cap)
 *   cd8d   t72874433   buffer 2588   dropped 2588   container    0
 * ```
 *
 * The container went from full to zero while the ground pile GREW. Three
 * mechanisms produce that reading and the capture cannot separate them:
 *
 *  1. haulers withdrew the container and left the pile (a pickup-priority
 *     defect - `sourcePickupSpot` is pile-first EXCEPT while the container is
 *     full, so a container-first run should stop after one withdraw);
 *  2. the container DIED of decay and dropped its contents on the ground (a
 *     remote container decays 5x an owned one and nothing in any capture
 *     carries its hits);
 *  3. there was never a container and `sourceBuffers - sourceDropped` was
 *     reading a neighbouring structure.
 *
 * Container ENERGY of zero is the same reading under all three. Spec 59 says
 * naming a cause from the stock alone would be "a hypothesis dressed as a
 * finding", and spec 14's rule for an invisible cause is to ship the stamp
 * first. So this field publishes the three facts the stock cannot imply:
 * whether a container is THERE (`n`), whether it is AT CAP (`free`), and
 * whether it is DYING (`hp`).
 *
 * `n: 0` is emitted deliberately - "this source has no container" is the
 * positive claim spec 54 open item 8 wanted about the home sources, and it is
 * unrepresentable as an absent key.
 */
describe("core segment: sourceMouth - the container as a fact, not an inference (v37)", () => {
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
      public constructor(
        public x: number,
        public y: number,
        public roomName: string
      ) {}
      public findInRange(): any[] {
        return [];
      }
    };
  });

  /** A container at a source's mouth: `energy` of `cap`, at `hits` of `hitsMax`. */
  const mkContainer = (energy: number, hits = 250000, hitsMax = 250000, cap = 2000): any => ({
    structureType: "container",
    store: { energy, getFreeCapacity: () => cap - energy },
    hits,
    hitsMax
  });

  /** A source mouth holding `containers` and `dropped` energy on the ground. */
  const mkSource = (id: string, containers: any[], dropped: number): any => ({
    id,
    pos: {
      x: 10,
      y: 10,
      findInRange: (find: number) =>
        find === FIND_DROPPED_RESOURCES
          ? dropped > 0
            ? [{ resourceType: "energy", amount: dropped }]
            : []
          : containers
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

  it("separates NO CONTAINER from an EMPTY container - the reading cd8d could not distinguish", () => {
    // Both mouths report container energy 0 (buffer === dropped). Only the
    // mouth census says one has a container standing and the other has none.
    Game.rooms = roomWith([
      mkSource("aaaaaa111111", [mkContainer(0)], 2588), // empty container, big pile
      mkSource("aaaaaa222222", [], 2588) // no container at all, same pile
    ]) as any;
    const c = core();
    expect(c.version, "core segment version").to.equal(38);
    expect(c.sourceBuffers["111111"] - (c.sourceDropped["111111"] ?? 0), "container energy").to.equal(0);
    expect(c.sourceBuffers["222222"] - (c.sourceDropped["222222"] ?? 0), "container energy").to.equal(0);
    expect(c.sourceMouth["111111"].n, "a container IS standing here").to.equal(1);
    expect(c.sourceMouth["222222"].n, "no container - the pile has nowhere to go").to.equal(0);
  });

  it("names the CAP: free capacity is what makes overflow-to-ground inevitable", () => {
    // Spec 59's finding was "five of seven hold exactly 2000". That is only
    // the cap because the cap is 2000 - `free` states it directly instead of
    // asking the reader to recognise a magic number.
    Game.rooms = roomWith([mkSource("aaaaaa333333", [mkContainer(2000)], 4561)]) as any;
    const c = core();
    expect(c.sourceMouth["333333"].free, "AT CAP: everything mined after this rots").to.equal(0);
  });

  it("names the DEATH: hp is the decay reading no capture has ever carried for a remote mouth", () => {
    // A remote container decays 5x an owned one. The account's depreciation
    // memo prices that accrual and has no inventory to price it against.
    Game.rooms = roomWith([mkSource("aaaaaa444444", [mkContainer(1500, 25000, 250000)], 0)]) as any;
    const c = core();
    expect(c.sourceMouth["444444"].hp, "10% of hits left - this container is about to drop its load").to.equal(0.1);
  });

  it("reports the WORST container when a mouth has more than one", () => {
    // sourceBufferStock sums every container within range 1, so a two-container
    // mouth must not report only the healthy one.
    Game.rooms = roomWith([
      mkSource("aaaaaa555555", [mkContainer(2000, 250000, 250000), mkContainer(500, 50000, 250000)], 0)
    ]) as any;
    const c = core();
    expect(c.sourceMouth["555555"].n).to.equal(2);
    expect(c.sourceMouth["555555"].hp, "the weakest link is the one that drops its load").to.equal(0.2);
    expect(c.sourceMouth["555555"].free, "free capacity is the mouth's, summed").to.equal(1500);
  });

  it("omits hp/free where there is no container, but still states n: 0", () => {
    Game.rooms = roomWith([mkSource("aaaaaa666666", [], 900)]) as any;
    const c = core();
    expect(c.sourceMouth["666666"]).to.deep.equal({ n: 0 });
  });

  it("does not fabricate a mouth for a room with no vision", () => {
    Game.rooms = {} as any;
    const c = core();
    expect(c.sourceMouth).to.equal(undefined);
  });
});
