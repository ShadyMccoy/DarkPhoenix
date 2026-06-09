/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import {
  loadLayout,
  terrainMatrixFromPattern,
  layoutFromNodeFixture,
  NodeFixture,
} from "./loadLayout";
import { E75N8_TERRAIN_PATTERN } from "../unit/spatial/fixtures/real-room-terrain";

// test/fixtures/*.json - required (tsconfig.test.json is CommonJS, no resolveJsonModule)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const simpleMining = require("../fixtures/simple-mining.json") as NodeFixture;

before(() => hookConsole());
afterEach(async () => helper.afterEach());

/** Find the first tile in an ASCII pattern matching the given character. */
function findTile(pattern: string[], ch: string): { x: number; y: number } | undefined {
  for (let y = 0; y < pattern.length; y += 1) {
    const x = pattern[y].indexOf(ch);
    if (x !== -1) {
      return { x, y };
    }
  }
  return undefined;
}

/**
 * Find the first interior tile (1..48) matching a character. Edge tiles (row/col
 * 0 or 49) are room exits and are invalid spawn/structure locations.
 */
function findInteriorTile(pattern: string[], ch: string): { x: number; y: number } | undefined {
  for (let y = 1; y <= 48; y += 1) {
    for (let x = 1; x <= 48; x += 1) {
      if (pattern[y] && pattern[y][x] === ch) {
        return { x, y };
      }
    }
  }
  return undefined;
}

describe("world layouts", () => {
  it("converts a real ASCII terrain fixture into a TerrainMatrix", () => {
    const matrix = terrainMatrixFromPattern(E75N8_TERRAIN_PATTERN);

    const wall = findTile(E75N8_TERRAIN_PATTERN, "#");
    const plain = findTile(E75N8_TERRAIN_PATTERN, ".");
    assert.ok(wall, "fixture should contain a wall tile");
    assert.ok(plain, "fixture should contain a plain tile");

    assert.equal(matrix.get(wall!.x, wall!.y), "wall");
    assert.equal(matrix.get(plain!.x, plain!.y), "plain");
  });

  it("derives room layouts and spawn positions from a node-network fixture", () => {
    const { rooms, spawns } = layoutFromNodeFixture(simpleMining);

    const w1n1 = rooms.find((r) => r.room === "W1N1");
    assert.ok(w1n1, "fixture defines room W1N1");
    assert.ok(
      w1n1!.objects!.some((o) => o.type === "source"),
      "W1N1 should have a source"
    );

    // simple-mining.json declares a single spawn; it is surfaced for bot
    // placement rather than placed as a plain room object.
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].room, "W1N1");
  });

  it("loads a real terrain fixture and runs the bot inside it", async () => {
    // Spawn on a guaranteed-plain interior tile from the real fixture.
    const spawnTile = findInteriorTile(E75N8_TERRAIN_PATTERN, ".")!;

    await helper.beforeEach(async (world) => {
      await loadLayout(world, {
        room: "W0N0",
        terrain: E75N8_TERRAIN_PATTERN,
        objects: [
          { type: "source", x: 45, y: 5 },
          { type: "controller", x: 45, y: 45 },
        ],
      });
      // addBot requires a controller in the room (added just above).
      await helper.addBot({ room: "W0N0", x: spawnTile.x, y: spawnTile.y });
    });

    // Terrain round-trips through the running server.
    const wall = findTile(E75N8_TERRAIN_PATTERN, "#")!;
    const terrain = await helper.server.world.getTerrain("W0N0");
    assert.equal(terrain.get(wall.x, wall.y), "wall");

    // Objects are really in the room.
    const objects = await helper.server.world.roomObjects("W0N0");
    assert.equal(objects.filter((o: any) => o.type === "source").length, 1);
    assert.equal(objects.filter((o: any) => o.type === "controller").length, 1);

    const before = await helper.server.world.gameTime;
    await helper.server.tick();
    assert.equal(await helper.server.world.gameTime, before + 1);
  });

  it("runs the real bot against a hand-built room", async () => {
    // All-plain room with a single wall column on the left edge.
    const terrain = Array.from({ length: 50 }, () => "#" + ".".repeat(49));

    await helper.beforeEach(async (world) => {
      await loadLayout(world, {
        room: "W0N0",
        terrain,
        objects: [
          { type: "source", x: 10, y: 25 },
          { type: "controller", x: 40, y: 25 },
        ],
      });
      // addBot requires a controller in the room (added just above).
      await helper.addBot({ room: "W0N0", x: 25, y: 25 });
    });

    // The bot's spawn was placed where we asked, on a plain tile.
    const objects = await helper.server.world.roomObjects("W0N0");
    const spawn = objects.find((o: any) => o.type === "spawn");
    assert.ok(spawn, "bot spawn should exist");
    assert.equal(spawn.x, 25);
    assert.equal(spawn.y, 25);

    const liveTerrain = await helper.server.world.getTerrain("W0N0");
    assert.equal(liveTerrain.get(0, 0), "wall");
    assert.equal(liveTerrain.get(25, 25), "plain");

    // The real bot runs without crashing the tick loop.
    for (let i = 0; i < 5; i += 1) {
      await helper.server.tick();
    }
    assert.isAtLeast(await helper.server.world.gameTime, 5);
  });
});
