/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";

/**
 * PARKED-CONSUMER BURN (spec 34 D1/D2, measured by the builder-buffer-feed
 * cell): a VECTOR-FED builder builds with whatever its buffer holds - build
 * resumes on the FIRST delivered energy, never waiting for a full store. The
 * full-refill toggle (empty -> pickup mode -> build only when full) is
 * fetch-cycle logic: it stops a fetching builder thrashing between one-tick
 * trips, but on the parked path it idled fielded WORK while the tanker
 * dribbled the buffer full - the cell measured 73% of all idle as this
 * "fed-idle" class (holding energy, not building). The discriminator is the
 * corp's OWN fielded tanker squad: the vector is live exactly when the corp
 * fields carriers (the same decision tankerPlan priced - staffsPost
 * symmetry), and fetch worlds (remote pile crews, direct-draw sites) field
 * none and keep the toggle verbatim.
 */
describe("parked builder burn: vector-fed builds on ANY held energy", () => {
  beforeEach(() => {
    setupGlobals();
    const g = global as any;
    g.FIND_MY_CONSTRUCTION_SITES = 114;
    g.FIND_STRUCTURES = 107;
    g.FIND_DROPPED_RESOURCES = 106;
    g.STRUCTURE_CONTAINER = "container";
    g.STRUCTURE_STORAGE = "storage";
    g.RESOURCE_ENERGY = "energy";
    g.ERR_NOT_IN_RANGE = -9;
    g.OK = 0;
    g.FIND_TOMBSTONES = 118;
    g.FIND_RUINS = 122;
    Game.creeps = {};
    Game.getObjectById = () => null;
    (Memory as any).creeps = {};
  });

  function run(opts: { energy: number; range: number; vectorFed: boolean; working?: boolean }) {
    const actions: string[] = [];
    const site = { id: "site1", pos: { x: 30, y: 25, roomName: "W1N1" }, progress: 0, progressTotal: 3000 };
    const room: any = {
      name: "W1N1",
      memory: {},
      find: (t: number) => (t === 114 ? [site] : [])
    };
    const creep: any = {
      name: "b1",
      room: { name: "W1N1" },
      memory: { workType: "build", working: opts.working ?? false },
      store: {
        energy: opts.energy,
        getFreeCapacity: () => 100 - opts.energy
      },
      pos: {
        x: 30 - opts.range,
        y: 25,
        roomName: "W1N1",
        findInRange: () => [],
        findClosestByPath: () => null,
        getRangeTo: (p: any) => Math.max(Math.abs((p.x ?? p.pos?.x) - (30 - opts.range)), Math.abs((p.y ?? p.pos?.y) - 25))
      },
      build: () => {
        actions.push("build");
        return 0;
      },
      moveTo: () => {
        actions.push("move");
        return 0;
      },
      withdraw: () => {
        actions.push("withdraw");
        return 0;
      },
      pickup: () => {
        actions.push("pickup");
        return 0;
      },
      drop: () => 0,
      transfer: () => 0,
      getActiveBodyparts: () => 2,
      say: () => 0
    };
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    (corp as any).runBuilder(creep, room, opts.vectorFed);
    return { actions, creep };
  }

  it("vector-fed, holding a PARTIAL buffer mid-refill: builds this tick (no full-store wait)", () => {
    const { actions } = run({ energy: 40, range: 2, vectorFed: true, working: false });
    expect(actions, "the whole point: partial energy burns immediately").to.include("build");
  });

  it("vector-fed and DRY in range: holds the post - no fetch walk, no wander", () => {
    const { actions } = run({ energy: 0, range: 2, vectorFed: true });
    expect(actions).to.not.include("build");
    expect(actions, "walking to fetch is D1's priced-out counterfactual").to.not.include("move");
  });

  it("vector-fed and DRY off post (a newborn at the spawn): walks out to the site", () => {
    const { actions } = run({ energy: 0, range: 8, vectorFed: true });
    expect(actions, "the delivery lands on a PARKED consumer - take the post").to.include("move");
  });

  it("NOT vector-fed (fetch world): the full-refill toggle is preserved verbatim", () => {
    const { actions } = run({ energy: 40, range: 2, vectorFed: false, working: false });
    expect(actions, "a fetch-cycle builder mid-fill keeps filling, not building").to.not.include("build");
  });
});
