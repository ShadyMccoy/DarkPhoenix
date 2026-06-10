/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain } from "./loadLayout";

before(() => hookConsole());
afterEach(async () => helper.afterEach());

/**
 * Flow hand-off / budget-vs-actual probe.
 *
 * Runs a bootstrap room on the reliable integration harness (which persists the
 * bot's Memory, unlike ad-hoc ts-node scripts) and samples, over time:
 *   - the creep population by workType (does it move off bootstrap onto flow
 *     miners/haulers/upgraders?), from Memory.creeps;
 *   - controller progress;
 *   - Memory.corpVariance (each budgeted corp's budget vs measured actual).
 *
 * It prints a per-sample line so we can read trustworthy numbers, and only
 * soft-asserts that the colony stays alive, so the diagnostic always reports.
 */
describe("flow hand-off probe", () => {
  it("reports bootstrap->flow transition and corp budget vs actual over 600 ticks", async function () {
    this.timeout(300000);

    // Two chambers split by a vertical wall at x=25 (gap at y=23..27), so peak
    // detection has distinct open areas to find - unlike an all-plain room.
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
    });

    const samples: string[] = [];
    for (let t = 1; t <= 400; t += 1) {
      await helper.server.tick();
      if (t % 100 !== 0) continue;

      const mem = JSON.parse((await helper.player.memory) || "{}");
      const creeps = mem.creeps || {};
      const byType: Record<string, number> = {};
      for (const name in creeps) {
        const wt = (creeps[name] as any).workType || "bootstrap";
        byType[wt] = (byType[wt] || 0) + 1;
      }
      const objects = await helper.server.world.roomObjects("W0N0");
      const ctrl = objects.find((o: any) => o.type === "controller");
      const variance = (mem.corpVariance || [])
        .map((r: any) => `${r.type} ${r.actual}/${r.budget}`)
        .join(", ");
      const hc = mem.harvestCorps || {};
      const minersWithAssignment = Object.values(hc).filter((c: any) => c.minerAssignment).length;
      const corps =
        `nodes ${Object.keys(mem.nodes || {}).length} ` +
        `harvest ${Object.keys(hc).length}(${minersWithAssignment} assigned) ` +
        `haul ${Object.keys(mem.haulingCorps || {}).length} ` +
        `upgrade ${Object.keys(mem.upgradingCorps || {}).length} ` +
        `bootstrap ${Object.keys(mem.bootstrapCorps || {}).length}`;
      samples.push(
        `tick ${t}: RCL ${ctrl?.level ?? 0} prog ${ctrl?.progress ?? 0} | creeps ${JSON.stringify(byType)} | ${corps} | variance [${variance}]`
      );
    }

    console.log("\n=== flow hand-off probe ===");
    for (const line of samples) console.log(line);

    const lastObjects = await helper.server.world.roomObjects("W0N0");
    const liveCreeps = lastObjects.filter((o: any) => o.type === "creep").length;
    assert.isAbove(liveCreeps, 0, "colony should keep at least one creep alive");
  });
});
