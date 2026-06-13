/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain, setRoomLevel, enableMods, FREE_ECONOMY_MOD } from "./loadLayout";

/**
 * Runt -> upsize probe.
 *
 * Stands up the proven flow-handoff colony (walled two-chamber room - an all-plain
 * room is degenerate for node detection - two sources, RCL 2 with 5 extensions)
 * under the free-economy mod. The first producers necessarily spawn small (a cold
 * spawn affords only a ~2-WORK miner), so the colony starts with runts. It then
 * runs forward and checks that those runts get UPSIZED as the spawn network fills:
 * a flow miner that begins at the cold-start floor grows to a larger body
 * (via the regrow-undersized-miner path and/or the recycle-and-respawn loop).
 *
 * "Upsizing" here is the runts growing, NOT controller progress.
 */
describe("runt economy upsizes its runts", () => {
  // Scoped to THIS suite: root-level hooks would run around every test in
  // every loaded file (mocha hoists them to the root suite) and cross-corrupt
  // the shared server helper between files.
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  it("starts with small miners and grows them to a larger body", async function () {
    this.timeout(1200000);

    // Two chambers split by a vertical wall at x=25 (gap at y=23..27).
    const terrain = Array.from({ length: 50 }, (_v, y) =>
      ".".repeat(25) + (y >= 23 && y <= 27 ? "." : "#") + ".".repeat(24)
    );

    await helper.beforeEach(async (world) => {
      await loadLayout(world, {
        room: "W0N0",
        terrain,
        objects: [
          { type: "controller", x: 38, y: 25 },
          { type: "source", x: 10, y: 10 },
          { type: "source", x: 40, y: 40 }
        ]
      });
      await padNeighborTerrain(world, ["W0N0"]);
      await helper.addBot({ room: "W0N0", x: 12, y: 25 });
      await setRoomLevel(world, "W0N0", 2, [
        { x: 13, y: 24 }, { x: 11, y: 24 }, { x: 13, y: 26 }, { x: 11, y: 26 }, { x: 14, y: 25 }
      ]);
      enableMods(helper.serverPath, [FREE_ECONOMY_MOD]);
    });

    /** WORK on each FLOW miner (corpId "mining-...") right now - excludes bootstrap jacks. */
    const flowMinerWork = async (mem: any): Promise<number[]> => {
      const objs = await helper.server.world.roomObjects("W0N0");
      const out: number[] = [];
      for (const o of objs) {
        if (o.type !== "creep") continue;
        const m = mem.creeps?.[o.name];
        if (m?.workType !== "harvest" || !(m.corpId || "").startsWith("mining-")) continue;
        out.push((o.body || []).filter((p: any) => (p.type ?? p) === "work").length);
      }
      return out;
    };

    let smallestMiner = Infinity; // the runt the colony started with
    let largestMiner = 0; // the biggest body it ever upsized to
    let recyclingSeen = false;
    const samples: string[] = [];

    for (let t = 1; t <= 1200; t += 1) {
      await helper.server.tick();
      const mem = JSON.parse((await helper.player.memory) || "{}");

      if (!recyclingSeen) {
        for (const name in mem.creeps || {}) {
          if ((mem.creeps[name] as any).recycling) { recyclingSeen = true; break; }
        }
      }

      const works = await flowMinerWork(mem);
      for (const w of works) {
        if (w > 0 && w < smallestMiner) smallestMiner = w;
        if (w > largestMiner) largestMiner = w;
      }

      if (t % 150 === 0 || t === 1200) {
        samples.push(
          `tick ${t}: flowMiners [${works.join(",")}] smallest ${smallestMiner === Infinity ? "-" : smallestMiner} largest ${largestMiner} recycledYet ${recyclingSeen}`
        );
      }
    }

    console.log("\n=== runt upsize probe ===");
    for (const line of samples) console.log(line);
    console.log(`smallest flow miner ${smallestMiner === Infinity ? "-" : smallestMiner} WORK, largest ${largestMiner} WORK, recyclingSeen ${recyclingSeen}`);

    assert.notEqual(smallestMiner, Infinity, "the colony should staff at least one flow miner");
    assert.isAbove(
      largestMiner,
      smallestMiner,
      `flow miners should be upsized from their cold-start runt (smallest ${smallestMiner}, largest ${largestMiner}, recycled=${recyclingSeen})`
    );
  });
});
