/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { readFileSync } from "fs";
import { helper, hookConsole } from "./helper";
import { enableMods, FREE_ECONOMY_MOD } from "./loadLayout";
import { loadScenario, Scenario } from "./scenario/Scenario";
import * as scenarios from "./scenario/library";

const MAIN = "dist/main.js";

/**
 * Scenario economy-health regression suite (per-geometry coverage).
 *
 * Runs library scenarios end-to-end on the integration harness (the path that
 * reliably persists the bot's Memory) and asserts the income-side invariants
 * that must hold across *any* room geometry, so a planner/scheduler change that
 * quietly breaks one shape is caught here:
 *
 *   - EVERY source is mined (a flow miner producing real energy for each), and
 *   - that energy is hauled home (a hauler producing).
 *
 * The point is breadth: challenge the economy with different room shapes - a
 * symmetric pair of sources, and a near + far-corner pair - and catch the
 * outlier where one source never gets staffed or its energy strands unhauled.
 * The far-corner case is the one that stresses travel-cost / marginal-value
 * accounting (a long haul, a miner that spends much of its life walking out);
 * the symmetric case is the baseline.
 *
 * The downstream mine->haul->UPGRADE->controller chain (controller actually
 * making progress) is guarded separately, unmodded, by `flow-handoff.test.ts` -
 * it is deliberately not re-asserted here, where the free-economy mod (below)
 * speeds the income ramp but distorts the upgrade/controller economics.
 *
 * Each case runs under the free-economy mod (build + upgrade sinks zeroed) so
 * the colony reaches its income steady-state in a few hundred ticks instead of
 * grinding through an energy-starved bootstrap - letting the suite cover several
 * geometries in a reasonable wall-clock budget.
 */
interface EconomyCase {
  /** Library factory name (for the test title). */
  name: string;
  scenario: () => Scenario;
  /** How many sources the room has - each must end up mined. */
  sources: number;
}

const CASES: EconomyCase[] = [
  // Symmetric baseline: two equidistant sources should both be staffed.
  { name: "twoSourceRcl3", scenario: scenarios.twoSourceRcl3, sources: 2 },
  // Distance-stressed: a near source and a far-corner source. The far source's
  // longer haul / lower useful miner TTL must NOT cause the colony to abandon it.
  { name: "asymmetricTwoSource", scenario: scenarios.asymmetricTwoSource, sources: 2 },
];

describe("scenario economy health", () => {
  // Scoped to THIS suite: root-level hooks would run around every test in
  // every loaded file (mocha hoists them to the root suite) and cross-corrupt
  // the shared server helper between files.
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  for (const c of CASES) {
    it(`${c.name}: every source mined, energy hauled home`, async function () {
      this.timeout(600000);

      const main = readFileSync(MAIN).toString();
      const scenario = c.scenario();
      const room = scenario.bot.room;
      let bot: any;

      await helper.beforeEach(async () => {
        bot = (await loadScenario(helper.server, scenario, main)).bot;
        // Zero the build/upgrade energy sinks so the income economy ramps fast
        // enough to cover several geometries per suite run.
        enableMods(helper.serverPath, [FREE_ECONOMY_MOD]);
      });

      for (let t = 1; t <= 600; t += 1) {
        await helper.server.tick();
      }

      const mem = JSON.parse((await bot.memory) || "{}");
      const rows = (mem.corpVariance || []) as Array<{ type: string; actual: number }>;
      const minersProducing = rows.filter(r => r.type === "mining" && r.actual > 0).length;
      const haulersProducing = rows.filter(r => r.type === "hauling" && r.actual > 0).length;

      // One compact diagnostic line, in the style of the flow-handoff probe, so a
      // failure is readable without a re-run.
      const ctrl = (await helper.server.world.roomObjects(room)).find((o: any) => o.type === "controller");
      console.log(
        `[${c.name}] RCL ${ctrl?.level} prog ${ctrl?.progress} | ` +
          `variance ${(mem.corpVariance || []).map((r: any) => `${r.type} ${r.actual}/${r.budget}`).join(", ")}`
      );

      assert.isAtLeast(
        minersProducing,
        c.sources,
        `every source should be mined (saw ${minersProducing} producing of ${c.sources})`
      );
      assert.isAtLeast(haulersProducing, 1, "at least one hauler should be moving energy home");
    });
  }
});
