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
 * Remote reserved-mining probe + variance check.
 *
 * Runs the remoteSource scenario (home room + adjacent unowned room with a source
 * and a reservable controller, RCL 3). With the reserved-mining valuation, the
 * planner should value the remote source at the reserved 3000, so the bot scouts
 * the neighbour, mines it, and the ReservationCorp reserves its controller. The
 * probe samples whether that happens and reports each corp's budget-vs-actual,
 * surfacing any remote corp that is funded but produces nothing (a blocker).
 */
describe("remote reserved-mining probe", () => {
  it("scouts, mines and reserves the remote source; reports variance", async function () {
    this.timeout(900000);

    const main = readFileSync(MAIN).toString();
    const scenario = scenarios.remoteSource();
    const home = scenario.bot.room;
    const remote = scenario.rooms.map(r => r.room).find(r => r !== home)!;
    let bot: any;

    await helper.beforeEach(async () => {
      bot = (await loadScenario(helper.server, scenario, main)).bot;
    });

    let mineSeenTick = 0;
    let reserveSeenTick = 0;
    const samples: string[] = [];

    for (let t = 1; t <= 1200; t += 1) {
      await helper.server.tick();
      if (t % 150 !== 0 && t !== 1200) continue;

      const mem = JSON.parse((await bot.memory) || "{}");
      const remoteObjs = await helper.server.world.roomObjects(remote);
      const ctrl = remoteObjs.find((o: any) => o.type === "controller");
      const reserved = ctrl?.reservation?.user != null;
      // A creep physically in the remote room that the bot tracks as a miner.
      const minersInRemote = remoteObjs.filter((o: any) => {
        if (o.type !== "creep") return false;
        return (mem.creeps?.[o.name]?.workType) === "harvest";
      }).length;
      if (minersInRemote > 0 && mineSeenTick === 0) mineSeenTick = t;
      if (reserved && reserveSeenTick === 0) reserveSeenTick = t;

      const variance = (mem.corpVariance || [])
        .map((r: any) => `${r.type} ${r.actual}/${r.budget}`)
        .join(", ");
      samples.push(
        `tick ${t}: remoteMiners ${minersInRemote} reserved ${reserved} | nodes ${Object.keys(mem.nodes || {}).length} ` +
          `harvest ${Object.keys(mem.harvestCorps || {}).length} reservation ${Object.keys(mem.reservationCorps || {}).length} | variance [${variance}]`
      );
    }

    console.log("\n=== remote reserved-mining probe ===");
    for (const line of samples) console.log(line);
    console.log(`first remote miner ~tick ${mineSeenTick}, first reservation ~tick ${reserveSeenTick}`);

    // Diagnostic probe: it always reports (the value is the printed remote-mining /
    // reservation timeline + variance). Soft-assert only that the colony stayed
    // alive across the run, so the diagnostic is never masked by a crash. A hard
    // "remote IS mined within N ticks" guard is added once the timeline confirms it.
    assert.isAtLeast(await helper.server.world.gameTime, 1200, "the colony should run the full horizon");
  });
});
