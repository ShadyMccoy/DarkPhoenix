import { assert, expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { loop } from "../../src/main";
import { Game, Memory, setupGlobals } from "./mock";
import { resetCommissionHost } from "../../src/execution/CommissionHost";

describe("main", () => {
  afterEach(() => {
    // The loop drives the commission host, which keeps a module-global store;
    // reset it so corps fielded here don't leak into later test files.
    resetCommissionHost();
  });
  beforeEach(() => {
    // Stand up a minimal Screeps global environment for the loop.
    setupGlobals();
    (global as any).Game = {
      ...Game,
      time: 0,
      cpu: { limit: 20, tickLimit: 500, bucket: 10000, getUsed: () => 0 },
    };
    (global as any).Memory = { creeps: {}, rooms: {} };

    // Telemetry writes to RawMemory segments each tick; provide a no-op stand-in.
    (global as any).RawMemory = {
      segments: {} as { [id: number]: string },
      setPublicSegments: () => undefined,
      setActiveSegments: () => undefined,
    };
  });

  it("should export a loop function", () => {
    assert.isTrue(typeof loop === "function");
  });

  it("never throws on an empty world (ErrorMapper contract)", () => {
    // The loop is wrapped in ErrorMapper.wrapLoop, so a hollow world produces
    // caught-and-logged errors rather than crashes. Silence that expected log
    // noise while asserting the wrapper holds. Real end-to-end execution against
    // a populated world is covered by the integration tests.
    const realLog = console.log;
    const realError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      assert.doesNotThrow(() => loop());
    } finally {
      console.log = realLog;
      console.error = realError;
    }
  });
});

/**
 * THE HANDICAP MIRROR IS POPULATED BEFORE ANY SOLVE (spec 50).
 *
 * `economy/spawnSweep` holds the planner's margin in HEAP, which is empty after
 * a global reset; `fiscalArchive.syncSweep()` refreshes it from Memory and the
 * fiscal-month hook is its only caller. Any solve that runs before that hook
 * prices at the fail-safe SPAWN_PLAN_FRACTION instead of the armed handicap.
 *
 * Measured live t72828763: the hook sat at the top of PHASE 2, but
 * `getOrCreateFlowEconomy` solves inside PHASE 0 on the reset tick, so the VM's
 * first plan read margin 0.90 while Memory.spawnSweep said pct 3. Under the
 * fiscal-month plan term that plan then STANDS for the rest of the month, so a
 * single deploy mis-prices a whole month of the sweep.
 *
 * A behavioural test cannot see this - by the end of the tick the mirror is
 * correct either way - so the pin is structural: the hook precedes every solve
 * entry point in the loop. If a new solve site appears, add it here.
 */
describe("main: loop ordering", () => {
  const SOLVE_SITES = [
    // PHASE 0 - runs a full solve on the reset tick ("don't wait for the
    // planning cycle"), which is the one this test was written for.
    "flowEconomy = getOrCreateFlowEconomy(colony)",
    // PHASE 2 - the scheduled/forced re-solve.
    'bulkhead("planning"'
  ];

  it("refreshes the handicap mirror before every solve entry point", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main.ts"), "utf8");
    const hook = src.indexOf('bulkhead("fiscal-month"');
    expect(hook, "the fiscal-month hook is gone from the loop entirely").to.be.greaterThan(-1);
    for (const site of SOLVE_SITES) {
      const at = src.indexOf(site);
      expect(at, `solve site moved or was renamed - update SOLVE_SITES: ${site}`).to.be.greaterThan(-1);
      expect(
        hook,
        `\`${site}\` can solve BEFORE the fiscal-month hook refreshes the handicap mirror, so a plan ` +
          `built there prices at the fail-safe margin instead of the armed sweep handicap (t72828763).`
      ).to.be.lessThan(at);
    }
  });
});
