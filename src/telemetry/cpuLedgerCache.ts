/**
 * @fileoverview A one-slot cache for the LAST FULLY-COMPLETED corpCpu ledger.
 *
 * The ledger is assembled across the tick in two halves: the corps half
 * (`corpsTotal`/`byKind`/`top`, written during the commission host) and the
 * infra half (`infra`/`wholeTick`, written at loop end by `publishInfraCpu`).
 * Telemetry serializes the core segment BETWEEN those two writes, so embedding
 * `Memory.corpCpu` directly always captured a half-built ledger — the infra +
 * whole-tick reconciliation, the report's headline, never reached a fixture
 * (only the live `global.cpuReport()`, which reads Memory after the loop, saw
 * it whole).
 *
 * The fix is a one-tick handoff: `publishInfraCpu` stashes the COMPLETE ledger
 * here at loop end, and next tick's telemetry ships THAT — a whole, one-tick-old
 * ledger with an honest `wholeTick` (it includes the prior tick's telemetry and
 * persist cost, since it was measured after them). Kept out of Memory on
 * purpose: the persist bucket serializes Memory every tick, and this exists to
 * audit that cost, not add to it. Module state resets on global reset; telemetry
 * simply ships nothing on the first tick after, then resumes.
 */
import { CorpCpuLedger } from "./cpuReport";

let completed: CorpCpuLedger | undefined;

/** Stash a copy of the just-completed ledger (called at loop end). */
export function stashCompletedLedger(ledger: CorpCpuLedger): void {
  completed = { ...ledger };
}

/** The last fully-completed ledger, or undefined before one finishes a tick. */
export function getCompletedLedger(): CorpCpuLedger | undefined {
  return completed;
}
