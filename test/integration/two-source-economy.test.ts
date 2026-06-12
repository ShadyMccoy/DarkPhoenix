/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { readFileSync } from "fs";
import { helper, hookConsole } from "./helper";
import { loadScenario } from "./scenario/Scenario";
import * as scenarios from "./scenario/library";

const MAIN = "dist/main.js";

before(() => hookConsole());
afterEach(async () => helper.afterEach());

/**
 * Two-source owned-room economy probe. Reproduces the user-reported owned-room
 * stall: one source piles energy with no hauler, the other never gets a miner,
 * and the controller starves toward downgrade.
 *
 * Runs twoSourceRcl3 (symmetric sources at (15,30) and (35,30), RCL3 + 5
 * extensions) and samples, per source: miner present? dropped energy piled? plus
 * hauler/upgrader counts and controller progress. The headline guard is that BOTH
 * sources get a miner - a single source monopolising the spawn (the bug) leaves
 * the other at zero.
 */
describe("two-source owned-room economy probe", () => {
  it("mines BOTH sources, hauls them, and upgrades; reports per-source variance", async function () {
    this.timeout(900000);

    const main = readFileSync(MAIN).toString();
    const scenario = scenarios.twoSourceRcl3();
    const room = scenario.bot.room;
    const SRC = [
      { x: 15, y: 30 },
      { x: 35, y: 30 },
    ];
    let bot: any;

    await helper.beforeEach(async () => {
      bot = (await loadScenario(helper.server, scenario, main)).bot;
    });

    const near = (objs: any[], pos: { x: number; y: number }, type: string) =>
      objs.filter((o: any) => o.type === type && Math.abs(o.x - pos.x) <= 1 && Math.abs(o.y - pos.y) <= 1);

    let bothMinedTick = 0;
    const samples: string[] = [];

    for (let t = 1; t <= 1000; t += 1) {
      await helper.server.tick();
      if (t % 100 !== 0 && t !== 1000) continue;

      const mem = JSON.parse((await bot.memory) || "{}");
      const objs = await helper.server.world.roomObjects(room);
      const ctrl = objs.find((o: any) => o.type === "controller");

      const perSrc = SRC.map((s, i) => {
        const miners = near(objs, s, "creep").filter((o: any) => mem.creeps?.[o.name]?.workType === "harvest").length;
        const drop = near(objs, s, "energy").reduce((sum: number, o: any) => sum + (o.energy || 0), 0);
        return `src${i}[min ${miners} drop ${drop}]`;
      });
      const minersBySrc = SRC.map(
        s => near(objs, s, "creep").filter((o: any) => mem.creeps?.[o.name]?.workType === "harvest").length
      );
      if (minersBySrc.every(m => m > 0) && bothMinedTick === 0) bothMinedTick = t;

      let haul = 0, upg = 0, tend = 0;
      for (const o of objs.filter((x: any) => x.type === "creep")) {
        const wt = mem.creeps?.[o.name]?.workType;
        if (wt === "haul") haul++;
        else if (wt === "upgrade") upg++;
        else if (wt === "tank" && (mem.creeps?.[o.name]?.corpId || "").includes("tender")) tend++;
      }
      // Extension fill: how charged the extension set is (the tender's job).
      const exts = objs.filter((o: any) => o.type === "extension");
      const extEnergy = exts.reduce((s: number, e: any) => s + (e.store?.energy ?? e.energy ?? 0), 0);
      const extCap = exts.length * 50;
      const spawnObj = objs.find((o: any) => o.type === "spawn");
      const containers = objs.filter((o: any) => o.type === "container");
      const depot = spawnObj
        ? containers.find((c: any) => Math.max(Math.abs(c.x - spawnObj.x), Math.abs(c.y - spawnObj.y)) <= 1)
        : undefined;
      const variance = (mem.corpVariance || []).map((r: any) => `${r.type} ${r.actual}/${r.budget}`).join(", ");
      samples.push(
        `tick ${t}: ${perSrc.join(" ")} | haul ${haul} tend ${tend} upg ${upg} ctrlP ${ctrl?.progress ?? 0} ` +
          `| ext ${extEnergy}/${extCap} depot ${depot ? (depot.store?.energy ?? 0) : "none"} ` +
          `| [${variance}]`
      );
    }

    console.log("\n=== two-source owned-room economy probe ===");
    for (const line of samples) console.log(line);
    console.log(`both sources mined by ~tick ${bothMinedTick}`);

    assert.isAbove(bothMinedTick, 0, "BOTH sources should have a miner within the horizon (neither monopolised)");
  });
});
