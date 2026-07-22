import { expect } from "chai";
import {
  ROAD_SCORE_DECAY_FACTOR,
  ROAD_SCORE_DECAY_INTERVAL,
  _resetRoadTracker,
  roadCandidateTiles,
  trackRoadUsage
} from "../../../src/execution/roadTracker";
import { packTile } from "../../../src/economy/roadScoring";

/**
 * The live sweep that feeds economy/roadScoring. A tile is credited only when a
 * creep MOVED ONTO it (this tick's tile differs from last tick's) while paying
 * move-fatigue on unpaved plain/swamp. This test drives the sweep with fake
 * creeps and asserts what does and doesn't accumulate.
 */
describe("execution/roadTracker", () => {
  const ROOM = "W1N1";

  // Terrain the fake room reports per tile (packed index -> mask). Default plain.
  let terrainMap: { [packed: number]: number };
  // Roads present in the fake room (packed index set).
  let roads: Set<number>;

  function makeRoom(): any {
    const memory: any = {};
    Memory.rooms = { [ROOM]: memory };
    return {
      name: ROOM,
      memory,
      getTerrain: () => ({ get: (x: number, y: number) => terrainMap[packTile(x, y)] ?? 0 }),
      lookForAt: (type: string, x: number, y: number) => {
        if (type === LOOK_STRUCTURES && roads.has(packTile(x, y))) {
          return [{ structureType: STRUCTURE_ROAD }];
        }
        return [];
      }
    };
  }

  function makeCreep(room: any, x: number, y: number, body: { type: string }[], used: number): any {
    return {
      my: true,
      room,
      pos: { x, y, roomName: ROOM },
      body,
      store: { getUsedCapacity: () => used }
    };
  }

  const loadedHauler = [{ type: CARRY }, { type: CARRY }, { type: MOVE }];

  beforeEach(() => {
    (global as any).STRUCTURE_ROAD = "road";
    (global as any).LOOK_CONSTRUCTION_SITES = "constructionSite";
    (global as any).LOOK_STRUCTURES = "structure";
    terrainMap = {};
    roads = new Set();
    Game.time = 100;
    Game.creeps = {};
    _resetRoadTracker();
  });

  it("does not score the first sighting (no known previous tile)", () => {
    const room = makeRoom();
    Game.creeps = { h: makeCreep(room, 11, 10, loadedHauler, 100) };
    trackRoadUsage(Game.time);
    expect(roadCandidateTiles(ROOM)).to.deep.equal([]);
  });

  it("scores the tile a loaded hauler moved onto (plain: 1 per fatigue-part)", () => {
    const room = makeRoom();
    const creep = makeCreep(room, 10, 10, loadedHauler, 100);
    Game.creeps = { h: creep };
    trackRoadUsage(Game.time); // first sighting at (10,10)
    creep.pos = { x: 11, y: 10, roomName: ROOM }; // engine moved it
    trackRoadUsage(Game.time); // scores (11,10)
    // 2 loaded CARRY parts * (2-1) = 2
    expect(roadCandidateTiles(ROOM)).to.deep.equal([{ x: 11, y: 10, score: 2 }]);
  });

  it("scores swamp 9x plain", () => {
    const room = makeRoom();
    terrainMap[packTile(11, 10)] = TERRAIN_MASK_SWAMP;
    const creep = makeCreep(room, 10, 10, loadedHauler, 100);
    Game.creeps = { h: creep };
    trackRoadUsage(Game.time);
    creep.pos = { x: 11, y: 10, roomName: ROOM };
    trackRoadUsage(Game.time);
    expect(roadCandidateTiles(ROOM)).to.deep.equal([{ x: 11, y: 10, score: 18 }]);
  });

  it("does not score a stationary creep", () => {
    const room = makeRoom();
    const creep = makeCreep(room, 10, 10, loadedHauler, 100);
    Game.creeps = { h: creep };
    trackRoadUsage(Game.time);
    trackRoadUsage(Game.time); // same tile - held position
    expect(roadCandidateTiles(ROOM)).to.deep.equal([]);
  });

  it("does not score an empty hauler (no fatigue, a road buys nothing)", () => {
    const room = makeRoom();
    const creep = makeCreep(room, 10, 10, loadedHauler, 0); // empty
    Game.creeps = { h: creep };
    trackRoadUsage(Game.time);
    creep.pos = { x: 11, y: 10, roomName: ROOM };
    trackRoadUsage(Game.time);
    expect(roadCandidateTiles(ROOM)).to.deep.equal([]);
  });

  it("does not score a tile that already has a road", () => {
    const room = makeRoom();
    roads.add(packTile(11, 10));
    const creep = makeCreep(room, 10, 10, loadedHauler, 100);
    Game.creeps = { h: creep };
    trackRoadUsage(Game.time);
    creep.pos = { x: 11, y: 10, roomName: ROOM };
    trackRoadUsage(Game.time);
    expect(roadCandidateTiles(ROOM)).to.deep.equal([]);
  });

  it("skips border/exit tiles (cross-room traffic, unpavable)", () => {
    const room = makeRoom();
    const creep = makeCreep(room, 1, 10, loadedHauler, 100);
    Game.creeps = { h: creep };
    trackRoadUsage(Game.time);
    creep.pos = { x: 0, y: 10, roomName: ROOM }; // stepped onto the exit column
    trackRoadUsage(Game.time);
    expect(roadCandidateTiles(ROOM)).to.deep.equal([]);
  });

  it("accumulates across repeated passes over the same lane (both directions score)", () => {
    const room = makeRoom();
    const creep = makeCreep(room, 10, 10, loadedHauler, 100);
    Game.creeps = { h: creep };
    // Shuttle (10,10)<->(11,10) three round trips. Each STEP onto a tile that
    // differs from last tick's is a scorable arrival, so the outbound tile is
    // credited 3x and the return tile 2x (the very first tick is a sighting).
    for (let i = 0; i < 3; i++) {
      creep.pos = { x: 10, y: 10, roomName: ROOM };
      trackRoadUsage(Game.time);
      creep.pos = { x: 11, y: 10, roomName: ROOM };
      trackRoadUsage(Game.time);
    }
    expect(roadCandidateTiles(ROOM)).to.deep.equal([
      { x: 11, y: 10, score: 6 },
      { x: 10, y: 10, score: 4 }
    ]);
  });

  it("decays room scores on the decay cadence", () => {
    const room = makeRoom();
    const creep = makeCreep(room, 10, 10, loadedHauler, 100);
    Game.creeps = { h: creep };
    trackRoadUsage(Game.time);
    creep.pos = { x: 11, y: 10, roomName: ROOM };
    trackRoadUsage(Game.time); // score 2
    // Land exactly on a decay tick; the creep holds so nothing new is credited.
    Game.time = ROAD_SCORE_DECAY_INTERVAL;
    trackRoadUsage(Game.time);
    const [tile] = roadCandidateTiles(ROOM);
    expect(tile.score).to.equal(2 * ROAD_SCORE_DECAY_FACTOR);
  });
});
