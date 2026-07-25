/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";
import { stashCompletedLedger } from "../../../src/telemetry/cpuLedgerCache";

/**
 * The captured core segment ships the last COMPLETED corpCpu ledger from
 * cpuLedgerCache (not the half-built Memory.corpCpu, which lacks infra +
 * wholeTick until loop end), on a 10-tick ROTATION keyed to the ledger's own
 * tick. The live `global.cpuReport()` reads Memory.corpCpu directly and is
 * unaffected. These pin: complete ledger present on a %10-tick ledger, absent
 * off-rotation, and absent entirely before any tick has completed.
 */
describe("corpCpu ledger rotation (10-tick, captured segment only)", () => {
  const complete = (tick: number) => ({
    tick,
    corpsTotal: 6.0,
    byKind: { harvest: 3.0, carry: 2.0, upgrade: 1.0 },
    infra: { commissions: 2.0, persist: 1.0 },
    wholeTick: 10.0,
    top: [{ corpId: "harvest-aaa", kind: "harvest", cpu: 1.5, avg: 1.4 }]
  });

  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.creeps = {};
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    Game.rooms = {} as any;
    // Fresh module state: stash the completed-ledger cache to a known value.
    stashCompletedLedger(complete(0)); // reset baseline; overwritten per test
  });

  function coreAt(gameTime: number): any {
    Game.time = gameTime;
    new Telemetry().update(undefined, [], undefined);
    return JSON.parse(RawMemory.segments[0]);
  }

  it("ships the complete ledger when its tick is on the %10 rotation", () => {
    stashCompletedLedger(complete(72555190)); // %10 == 0
    const core = coreAt(72555191); // telemetry runs the tick AFTER
    expect(core.corpCpu).to.exist;
    expect(core.corpCpu.tick).to.equal(72555190);
    expect(core.corpCpu.infra).to.exist; // the reconciliation the inline path dropped
    expect(core.corpCpu.wholeTick).to.equal(10.0);
  });

  it("omits the ledger when its tick is off-rotation", () => {
    stashCompletedLedger(complete(72555187)); // %10 == 7
    const core = coreAt(72555188);
    expect(core.corpCpu).to.be.undefined;
  });

  it("gates on the LEDGER's tick, not the current game time", () => {
    // Ledger from a non-%10 tick, current time on a %10 tick: still omitted -
    // the rotation follows the datum, not the wall clock.
    stashCompletedLedger(complete(72555183)); // %10 == 3
    const core = coreAt(72555190); // %10 == 0, but the ledger isn't
    expect(core.corpCpu).to.be.undefined;
  });
});
