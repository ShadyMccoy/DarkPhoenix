/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, Memory, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";
import { resetLossMeter } from "../../../src/telemetry/LossMeter";

/**
 * THE LOSSES BLOCK PUBLISHES UNCONDITIONALLY (core v26 - the spawnSpend
 * doctrine applied to the loss meter).
 *
 * Measured 2026-08-03: both immediate post-deploy captures (t72743103,
 * t72743470) were taken seconds after their global resets, and the WHOLE
 * losses block - the Memory-backed cumulative side included - was absent,
 * because the publish gated on `windowTicks > 0` (the in-heap meter's
 * arming). The window-side rates ARE meaningless before a window exists,
 * and windowTicks: 0 says so self-describingly - but the cumulative ledger
 * survives resets precisely so capture pairs can difference it, and hiding
 * it for the arming window blinds any pair whose baseline lands right
 * after a deploy (the natural capture moment). Presence = the ledger
 * exists; zero = a real zero; absence is reserved for pre-instrument
 * captures.
 */
describe("core segment losses publish (v26: cumulative survives the arming window)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.time = 100;
    Game.creeps = {};
    Game.rooms = {} as any;
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    resetLossMeter();
  });

  it("a fresh heap (window unarmed) still publishes the persisted cumulative ledger", () => {
    // The persisted ledger from before the reset - what the two blind
    // captures actually had in Memory while publishing nothing.
    (Memory as any).lossLedger = {
      pileDecay: 1000,
      structureDecay: 200,
      repairSpend: 300,
      tombstoneGross: 5000,
      tombstoneRecovered: 400,
      tombstoneByRole: { haul: 4500, harvest: 500 },
      tombstoneExpired: 1000,
      tombstoneKilled: 3600,
      tombstoneCauseUnknown: 400,
      tombstoneTtlSum: 2500,
      tombstoneTtlKnown: 5
    };

    new Telemetry().update(undefined, [], undefined);
    const core = JSON.parse(RawMemory.segments[0]);

    expect(core.losses, "the block publishes on a fresh heap").to.not.equal(undefined);
    expect(core.losses.windowTicks, "window 0 says the rates are unarmed, self-describingly").to.equal(0);
    expect(core.losses.cumulative.tombstoneKilled, "the persisted cumulative rides through").to.equal(3600);
    expect(core.losses.cumulative.tombstoneGross).to.equal(5000);
  });

  it("a cold START (no persisted ledger at all) publishes real zeros, not absence", () => {
    delete (Memory as any).lossLedger;
    new Telemetry().update(undefined, [], undefined);
    const core = JSON.parse(RawMemory.segments[0]);
    expect(core.losses).to.not.equal(undefined);
    expect(core.losses.cumulative.tombstoneKilled, "a cold world genuinely lost nothing").to.equal(0);
  });
});
