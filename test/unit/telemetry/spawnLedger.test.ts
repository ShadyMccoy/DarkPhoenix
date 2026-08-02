import { expect } from "chai";
import { accrueSpawnSpend, resetSpawnLedger, spawnSpendView } from "../../../src/telemetry/spawnLedger";

/**
 * THE SPAWN LEDGER - the account's LAST short-window side (spec 42, window
 * coherence).
 *
 * Every "measured at the spawn" line in the energy account - extraction,
 * evacuation, reservation, all of overhead - was read off the blackbox ring: a
 * heap ring of ~400 rows whose span is bounded by VM LIFETIME, not by how far
 * apart two captures are. Live t72723000-era closes measured a 1500-tick
 * fiscal month against a 480-tick spawn ring, and the account's own guard
 * printed WINDOW INCOHERENCE 3.1x with "the residual below is NOT trustworthy"
 * on every close that followed a deploy - which is most of them.
 *
 * The loss meter solved the identical defect with cumulative Memory-persisted
 * totals that the ledger DIFFERENCES between two captures (the same shape the
 * account uses for gcl.progress and storage). This module is that pattern
 * applied to spawn spend: monotonic energy+parts by ROLE, accrued at the ONE
 * seam every purchase already crosses (the execution receipt beside the
 * blackbox "spawn" row). The ring stays for incident forensics and per-corp
 * detail; the ACCOUNT reads the difference of two cumulative snapshots.
 */
describe("spawnLedger (cumulative spawn spend, the account's last short window)", () => {
  beforeEach(() => resetSpawnLedger());

  it("accumulates energy and parts by role, monotonically", () => {
    accrueSpawnSpend("miner", 650, 8);
    accrueSpawnSpend("hauler", 300, 6);
    accrueSpawnSpend("miner", 650, 8);
    const v = spawnSpendView();
    expect(v.energyByRole.miner).to.equal(1300);
    expect(v.energyByRole.hauler).to.equal(300);
    expect(v.partsByRole.miner).to.equal(16);
    expect(v.partsByRole.hauler).to.equal(6);
    expect(v.energy).to.equal(1600);
    expect(v.parts).to.equal(22);
  });

  it("survives a global reset - totals are ledger state, not module state", () => {
    // The whole point: a deploy must NOT restart the measured window. Memory
    // survives a global reset; only the heap does not.
    accrueSpawnSpend("miner", 650, 8);
    resetSpawnLedger({ keepTotals: true });
    accrueSpawnSpend("miner", 650, 8);
    expect(spawnSpendView().energyByRole.miner).to.equal(1300);
  });

  it("resets fully for test isolation when keepTotals is not asked for", () => {
    accrueSpawnSpend("miner", 650, 8);
    resetSpawnLedger();
    expect(spawnSpendView().energy).to.equal(0);
  });

  it("hands out a defensive copy, never the ledger itself", () => {
    accrueSpawnSpend("miner", 650, 8);
    const v = spawnSpendView();
    v.energyByRole.miner = 0;
    expect(spawnSpendView().energyByRole.miner).to.equal(650);
  });

  it("ignores a non-positive or non-finite purchase rather than corrupting the total", () => {
    accrueSpawnSpend("miner", 0, 0);
    accrueSpawnSpend("miner", -50, -1);
    accrueSpawnSpend("miner", NaN, NaN);
    expect(spawnSpendView().energy).to.equal(0);
  });
});
