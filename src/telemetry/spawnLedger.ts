/**
 * @fileoverview spawnLedger - cumulative spawn spend by role, the account's
 * LAST short-window side made capture-bounded (spec 42, window coherence).
 *
 * Every "measured at the spawn" line in the energy account - extraction,
 * evacuation, reservation, the whole overhead block - was read off the
 * blackbox ring: ~400 heap rows whose span is bounded by VM LIFETIME. A
 * 1500-tick fiscal month therefore read its spawn costs from whatever was
 * left after the last deploy (480t live at t72723000), and the account's own
 * guard printed WINDOW INCOHERENCE 3.1x - "the residual below is NOT
 * trustworthy" - on essentially every close, because deploys are routine.
 *
 * The loss meter already solved this exact defect (see LossMeter's header):
 * publish CUMULATIVE totals in Memory, let the ledger DIFFERENCE two captures
 * - the same shape the account uses for gcl.progress and storage - and the
 * measured window equals the capture window by construction, for any length.
 * This module is that pattern applied to spawn spend.
 *
 * Grain: ROLE. The account's chart of accounts maps role -> account class
 * (waste-ledger's ACCOUNT_CLASS_OF_ROLE, ratcheted against the kinds' own
 * `roles` declarations), so role totals are exactly sufficient for every
 * account line, and roles are a small closed set - the ledger cannot grow
 * unboundedly the way a per-corp map would as commissions churn. Per-corp
 * detail (the SOURCE P&L) stays on the ring, which states its own window;
 * per-corp CUMULATIVE accounting is spec 40 Part A's remit and wants spec
 * 39's fleet ownership first.
 *
 * Accrual site: the ONE seam every purchase already crosses - the execution
 * receipt beside SpawnDirector's blackBox("spawn") row. Parts ride along with
 * energy so a full-window F1 decomposition stays possible without a second
 * seam.
 *
 * @module telemetry/spawnLedger
 */

import "../types/Memory"; // Memory.spawnLedger augmentation

/** Cumulative spawn spend, monotonic, surviving global resets. */
export interface SpawnSpendCumulative {
  /** Energy paid for bodies, by the role bought. */
  energyByRole: Record<string, number>;
  /** Body parts bought, by the role bought. */
  partsByRole: Record<string, number>;
  /**
   * THE CURE'S COST, NAMED (owner 2026-08-04, "what if the cure is worse
   * than the illness"): energy/parts spent on RECOVERY-fleet bodies -
   * haulers bought for standalone scavenge corps - accrued BESIDE their
   * role total, never instead of it. One named sub-account of one role, so
   * the ledger's role-grain doctrine holds (no per-corp map, no unbounded
   * growth), and the account can split "evacuation" into route haulage vs
   * recovery and print the RECOVERY P&L against the witnessed-recovered
   * credit. Optional for Memory back-compat: ledgers written before this
   * field read as 0, honestly (nothing was measured, nothing is claimed).
   */
  scavengeEnergy?: number;
  scavengeParts?: number;
}

function zeroLedger(): SpawnSpendCumulative {
  return { energyByRole: {}, partsByRole: {}, scavengeEnergy: 0, scavengeParts: 0 };
}

/**
 * Memory when the game provides it (survives resets), a module-level fallback
 * otherwise so unit tests and Game-free callers work - LossMeter's pattern.
 */
let localLedger: SpawnSpendCumulative = zeroLedger();

function ledger(): SpawnSpendCumulative {
  if (typeof Memory === "undefined") return localLedger;
  const mem = Memory as unknown as { spawnLedger?: SpawnSpendCumulative };
  if (!mem.spawnLedger) mem.spawnLedger = zeroLedger();
  return mem.spawnLedger;
}

/**
 * Accrue one purchase. Call beside the blackbox "spawn" receipt - same tick,
 * same numbers, so the forensic ring and the account can never disagree about
 * what was bought, only about how far back they can see.
 */
export function accrueSpawnSpend(
  role: string,
  cost: number,
  parts: number,
  opts: { scavenge?: boolean } = {}
): void {
  if (!Number.isFinite(cost) || cost <= 0) return;
  const led = ledger();
  led.energyByRole[role] = (led.energyByRole[role] ?? 0) + cost;
  if (Number.isFinite(parts) && parts > 0) {
    led.partsByRole[role] = (led.partsByRole[role] ?? 0) + parts;
  }
  if (opts.scavenge === true) {
    led.scavengeEnergy = (led.scavengeEnergy ?? 0) + cost;
    if (Number.isFinite(parts) && parts > 0) {
      led.scavengeParts = (led.scavengeParts ?? 0) + parts;
    }
  }
}

/** The published shape: per-role maps (copies) plus their totals. */
export function spawnSpendView(): SpawnSpendCumulative & { energy: number; parts: number } {
  const led = ledger();
  const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
  return {
    energyByRole: { ...led.energyByRole },
    partsByRole: { ...led.partsByRole },
    scavengeEnergy: led.scavengeEnergy ?? 0,
    scavengeParts: led.scavengeParts ?? 0,
    energy: sum(led.energyByRole),
    parts: sum(led.partsByRole)
  };
}

/**
 * Test seam. `keepTotals` models a real global reset (Memory survives, the
 * heap does not); the default wipes everything for test isolation.
 */
export function resetSpawnLedger(opts: { keepTotals?: boolean } = {}): void {
  if (!opts.keepTotals) {
    localLedger = zeroLedger();
    if (typeof Memory !== "undefined") {
      (Memory as unknown as { spawnLedger?: SpawnSpendCumulative }).spawnLedger = zeroLedger();
    }
  }
}
