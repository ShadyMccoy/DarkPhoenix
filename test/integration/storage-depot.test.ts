/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain, setRoomLevel, enableMods, FREE_ECONOMY_MOD } from "./loadLayout";

/**
 * Storage probe (RCL 4 logistics).
 *
 * Stands up the proven walled two-chamber room at RCL 4 with the full extension
 * set and a container depot pre-placed, under the free-economy mod. With nothing
 * cheaper left to want, ConstructionCorp's placement queue should reach storage:
 * the colony places a STRUCTURE_STORAGE construction site near the spawn, where
 * it slots into the core-depot role (coreDepot() prefers storage from the moment
 * it is built).
 */
describe("storage depot at RCL 4", () => {
  // Scoped to THIS suite: root-level hooks would run around every test in
  // every loaded file (mocha hoists them to the root suite) and cross-corrupt
  // the shared server helper between files.
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  it("places a storage site near the spawn once extensions are done", async function () {
    this.timeout(1200000);

    // Two chambers split by a vertical wall at x=25 (gap at y=23..27).
    const terrain = Array.from({ length: 50 }, (_v, y) =>
      ".".repeat(25) + (y >= 23 && y <= 27 ? "." : "#") + ".".repeat(24)
    );

    // The full RCL4 extension set (20), pre-placed so placement skips straight
    // past the extension step.
    const extensions: Array<{ x: number; y: number }> = [];
    for (let x = 8; x <= 17; x += 1) extensions.push({ x, y: 21 }, { x, y: 22 });

    await helper.beforeEach(async (world) => {
      await loadLayout(world, {
        room: "W0N0",
        terrain,
        objects: [
          { type: "controller", x: 38, y: 25 },
          { type: "source", x: 10, y: 10 },
          { type: "source", x: 40, y: 40 },
          // Container depot beside the spawn-to-be at (12,25): the pre-storage
          // depot, so the placement queue's depot step is already satisfied.
          {
            type: "container",
            x: 13,
            y: 25,
            attributes: {
              store: { energy: 0 },
              storeCapacityResource: { energy: 2000 },
              hits: 250000,
              hitsMax: 250000
            }
          }
        ]
      });
      await padNeighborTerrain(world, ["W0N0"]);
      await helper.addBot({ room: "W0N0", x: 12, y: 25 });
      await setRoomLevel(world, "W0N0", 4, extensions);
      enableMods(helper.serverPath, [FREE_ECONOMY_MOD]);
    });

    const spawnPos = { x: 12, y: 25 };
    let storageSeen: { x: number; y: number } | null = null;

    for (let t = 1; t <= 900 && !storageSeen; t += 1) {
      await helper.server.tick();
      if (t % 25 !== 0) continue; // checking room objects is db-heavy; sample
      const objs = await helper.server.world.roomObjects("W0N0");
      for (const o of objs) {
        const isStorageSite = o.type === "constructionSite" && o.structureType === "storage";
        const isStorage = o.type === "storage";
        if (isStorageSite || isStorage) {
          storageSeen = { x: o.x, y: o.y };
          break;
        }
      }
    }

    assert.isNotNull(storageSeen, "expected a storage (or storage site) within 900 ticks of RCL4");
    const range = Math.max(Math.abs(storageSeen!.x - spawnPos.x), Math.abs(storageSeen!.y - spawnPos.y));
    assert.isAtMost(range, 2, "storage should sit within 2 of the spawn so it can serve as the core depot");
  });
});
