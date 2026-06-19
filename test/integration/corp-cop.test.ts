/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { hookConsole } from "./helper";
import { runWithCop } from "./diagnostics/runWithCop";

/**
 * The standing-watch regression: run representative scenarios under the CorpCop
 * and fail if ANY creep is left orphaned (alive, corp gone, nothing driving it)
 * for a sustained window. This is the horizontal guard for the "creeps spawn,
 * move a little, then stand idle until they die" class of bug - it rides along
 * the economy run and catches the pathology regardless of what each scenario was
 * originally built to prove.
 *
 * remoteSource is the load-bearing case: with the demobilization hysteresis and
 * the orphan-rescue net both removed, a remote hauler here orphans ~tick 450 and
 * idles to death - which is exactly what this test pins shut.
 */
describe("CorpCop: no creep is orphaned during a run", () => {
  before(() => hookConsole());

  const cases: Array<{ scenario: string; ticks: number }> = [
    { scenario: "twoSourceRcl3", ticks: 300 },
    { scenario: "remoteSource", ticks: 500 }
  ];

  for (const { scenario, ticks } of cases) {
    it(`${scenario}: clean for ${ticks} ticks (no sustained orphans)`, async function () {
      this.timeout(900000);
      const { cop } = await runWithCop({ scenario, ticks });
      const violations = cop.sustained(5);
      assert.deepEqual(violations, [], `\n${cop.report(5)}`);
    });
  }
});
