/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { ROAD_RESURVEY_INTERVAL } from "../../../src/corps/constructionPlacement";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * POTHOLE RE-SURVEY (owner 2026-07-29: "sometimes the roads in remote rooms
 * decayed or got destroyed, and they never get rebuilt").
 *
 * `paved` was an ABSORBING state: once stamped, routeSettled reported the route
 * done, work() never routed to the road path, the trunk completion sweep and
 * both placement loops skipped it with a bare `continue`, and detectPavedSources
 * kept pricing its haulers at 2:1. So a tile whose road decayed to death - or
 * that an invader flattened - was never re-placed. Remote trunks lose them
 * first: their PASS-THROUGH rooms are neither owned nor mined, host no
 * construction corp, and therefore get no repair detail at all.
 *
 * The receipt now has a shelf life. On the ROAD_RESURVEY_INTERVAL beat the corp
 * re-reads the tiles; a VISIBLE tile with no road drops the receipt and
 * re-places the site, and the ordinary in-progress machinery rebuilds and
 * re-stamps. Reopening is deliberately not a re-judge - a 97%-built road must
 * never be abandoned by a fresh verdict (the revocation trap class).
 */
describe("ConstructionCorp re-surveys paved routes and rebuilds lost pavement", () => {
  const HOME = "W1N1";
  const REMOTE = "W2N1";
  /** Three placeable trunk tiles in the remote room, none near the source. */
  const TILES3 = [10, 10, 0, 11, 10, 0, 12, 10, 0];
  const SOURCE_POS = { x: 40, y: 40, roomName: REMOTE };

  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    Game.time = 100000;
    const g = global as any;
    g.LOOK_CONSTRUCTION_SITES = "constructionSite";
    g.FIND_MY_CONSTRUCTION_SITES = 114;
    Game.creeps = {};
    Game.rooms = {};
    (Memory as any).creeps = {};
    // Deliberately NOT stubbing Game.getObjectById: neither the sweep nor the
    // work() gate resolves the spawn, and the mock's Game is shared across
    // files - a stub left behind here breaks whoever runs next.
  });

  /**
   * The remote room, with a built road on every tile of `roads` ("x,y"). Tiles
   * outside that set are bare ground - the potholes. Records every site the
   * sweep places.
   */
  const remoteRoom = (roads: Set<string>): { room: any; placed: string[] } => {
    const placed: string[] = [];
    const room: any = {
      name: REMOTE,
      memory: {},
      lookForAt: (type: string, x: number, y: number) =>
        type === "structure" && roads.has(`${x},${y}`) ? [{ structureType: "road" }] : [],
      createConstructionSite: (x: number, y: number) => {
        placed.push(`${x},${y}`);
        return 0; // OK
      }
    };
    return { room, placed };
  };

  /** The home room the corp works from - it owns no road routes of its own. */
  const homeRoom = (): any => ({ name: HOME, memory: {}, find: () => [] });

  /** A corp whose plan funds the remote trunk (the entry's rebuild eligibility). */
  const corpWithTrunk = (): ConstructionCorp => {
    const corp = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    corp.setRemoteTrunks([{ sourceId: "source-abc", pos: SOURCE_POS, flow: 10 }]);
    return corp;
  };

  const pavedTrunk = (): any => ({
    tiles: [],
    tiles3: [...TILES3],
    rooms: [REMOTE],
    paved: true,
    built: 3,
    total: 3
  });

  it("REBUILDS a lost tile: the receipt drops, the site is re-placed, the fraction tells the truth", () => {
    const { room, placed } = remoteRoom(new Set(["10,10", "12,10"])); // (11,10) decayed away
    Game.rooms[REMOTE] = room;
    const routes: any = { abc: pavedTrunk() };

    (corpWithTrunk() as any).resurveyPavedRoutes(homeRoom(), routes);

    expect(placed, "the missing tile gets a construction site").to.deep.equal(["11,10"]);
    expect(routes.abc.paved, "a route with a hole in it is not paved").to.equal(undefined);
    expect(routes.abc.built, "a FULLY VISIBLE pass is ground truth - it may count down").to.equal(2);
    expect(routes.abc.total).to.equal(3);
    expect(routes.abc.resurveyed).to.equal(Game.time);
    // The tile list survives: reopening hands the entry back to the in-progress
    // machinery, it does NOT re-plan or re-judge the route.
    expect(routes.abc.tiles3).to.deep.equal(TILES3);
    expect(routes.abc.declined).to.equal(undefined);
  });

  it("HOLDS an intact route: nothing placed, receipt kept, beat stamped", () => {
    const { room, placed } = remoteRoom(new Set(["10,10", "11,10", "12,10"]));
    Game.rooms[REMOTE] = room;
    const routes: any = { abc: pavedTrunk() };

    (corpWithTrunk() as any).resurveyPavedRoutes(homeRoom(), routes);

    expect(placed, "every tile still has its road").to.deep.equal([]);
    expect(routes.abc.paved, "the receipt stands").to.equal(true);
    expect(routes.abc.resurveyed, "but the beat is stamped, so the next sweep waits a full interval").to.equal(
      Game.time
    );
  });

  it("keeps the CADENCE: a route re-surveyed recently is not swept again", () => {
    const { room, placed } = remoteRoom(new Set(["10,10"])); // two holes, and they will wait
    Game.rooms[REMOTE] = room;
    const routes: any = { abc: { ...pavedTrunk(), resurveyed: Game.time - ROAD_RESURVEY_INTERVAL + 1 } };

    (corpWithTrunk() as any).resurveyPavedRoutes(homeRoom(), routes);

    expect(placed, "the sweep is on a beat, not every pass").to.deep.equal([]);
    expect(routes.abc.paved).to.equal(true);
  });

  it("never reopens on a GUESS: a blind route room proves nothing", () => {
    Game.rooms = {}; // no vision anywhere on the trunk
    const routes: any = { abc: pavedTrunk() };

    (corpWithTrunk() as any).resurveyPavedRoutes(homeRoom(), routes);

    expect(routes.abc.paved, "we cannot see the road, so we cannot say it is gone").to.equal(true);
    expect(routes.abc.built, "the ratchet still holds on a partial-vision pass").to.equal(3);
  });

  it("leaves an UNFUNDED trunk alone: no rebuild, and no revocation either", () => {
    const { room, placed } = remoteRoom(new Set()); // the whole road is gone
    Game.rooms[REMOTE] = room;
    const routes: any = { abc: pavedTrunk() };
    // A corp whose plan no longer funds that source: rebuilding a road to it
    // would be dead capital, but nothing standing is touched either.
    const corp = new ConstructionCorp(`${HOME}-construction`, "spawn1");

    (corp as any).resurveyPavedRoutes(homeRoom(), routes);

    expect(placed).to.deep.equal([]);
    expect(routes.abc.paved).to.equal(true);
  });

  it("covers IN-ROOM routes too (the feeder lane): a lost tile reopens it", () => {
    const placed: string[] = [];
    const room: any = {
      name: HOME,
      memory: {},
      find: () => [],
      lookForAt: (type: string, x: number, y: number) =>
        type === "structure" && !(x === 6 && y === 5) ? [{ structureType: "road" }] : [],
      createConstructionSite: (x: number, y: number) => {
        placed.push(`${x},${y}`);
        return 0;
      }
    };
    const routes: any = { feeder: { tiles: [5, 5, 6, 5, 7, 5], paved: true } };

    (corpWithTrunk() as any).resurveyPavedRoutes(room, routes);

    expect(placed).to.deep.equal(["6,5"]);
    expect(routes.feeder.paved).to.equal(undefined);
    expect(routes.feeder.resurveyed).to.equal(Game.time);
  });

  it("wantsRoadWork reads the SAME lens: a route DUE for re-survey is outstanding work", () => {
    // The staffsPost-symmetry trap class, and the reason the old receipt could
    // never heal: the sweep lives inside tryPlaceRoadRoute, so if the work()
    // gate called a due route settled, work() would never reach the sweep.
    const corp = corpWithTrunk() as any;
    const room: any = { name: HOME, find: () => [], memory: { roadRoutes: { abc: pavedTrunk() } } };
    expect(corp.wantsRoadWork(room), "due for re-survey -> road work outstanding").to.equal(true);

    room.memory.roadRoutes.abc.resurveyed = Game.time;
    expect(corp.wantsRoadWork(room), "just re-surveyed -> settled, no churn").to.equal(false);
  });
});
