/**
 * @fileoverview The colony's FISCAL CALENDAR - the standing periodisation the
 * audit reports against (owner 2026-08-01).
 *
 * A fiscal MONTH is 1500 ticks and a fiscal YEAR is 15000 (ten months). The
 * month is not arbitrary: 1500 is `CREEP_LIFETIME`, the exact horizon over
 * which every body cost is amortized (`minerOverhead`, `haulerOverhead`,
 * `infraSpawnLoad`, `sustainableConsumptionRate` all divide by it). So a
 * fiscal month is precisely the period over which a spawn purchase is
 * expensed - accrual and cash accounting coincide at a month boundary, which
 * is what makes the energy account's balancing identity meaningful over one.
 *
 * The year at ten months is long enough to contain ~1.7 of the measured
 * ~9000-tick bank limit cycle (ledger OSC), so an annual figure averages OVER
 * the oscillation instead of sampling a phase of it. A monthly figure does
 * NOT - months are phase samples by construction and must be read as such.
 *
 * Periods are absolute functions of the tick, so they need no epoch and never
 * drift: FY = floor(tick / 15000), month = floor((tick % 15000) / 1500) + 1.
 *
 * @module scripts/fiscal
 */

/** Ticks in a fiscal month - CREEP_LIFETIME, the body-cost amortization horizon. */
export const FISCAL_MONTH_TICKS = 1500;
/** Ticks in a fiscal year - ten months. */
export const FISCAL_YEAR_TICKS = FISCAL_MONTH_TICKS * 10;

export interface FiscalPeriod {
  year: number;
  month: number;
  /** "FY4847-M07" - sorts lexically in chronological order. */
  label: string;
  /** First and last tick of the month (inclusive start, exclusive end). */
  startTick: number;
  endTick: number;
}

export function periodOf(tick: number): FiscalPeriod {
  const year = Math.floor(tick / FISCAL_YEAR_TICKS);
  const month = Math.floor((tick % FISCAL_YEAR_TICKS) / FISCAL_MONTH_TICKS) + 1;
  const startTick = year * FISCAL_YEAR_TICKS + (month - 1) * FISCAL_MONTH_TICKS;
  return {
    year,
    month,
    label: `FY${year}-M${String(month).padStart(2, "0")}`,
    startTick,
    endTick: startTick + FISCAL_MONTH_TICKS
  };
}

/** Is this the last month of its fiscal year (a YEAR-END close as well)? */
export function isYearEnd(p: FiscalPeriod): boolean {
  return p.month === FISCAL_YEAR_TICKS / FISCAL_MONTH_TICKS;
}

/** Every month boundary strictly between two ticks - the closes a capture pair spans. */
export function boundariesBetween(fromTick: number, toTick: number): number[] {
  const out: number[] = [];
  const first = Math.ceil((fromTick + 1) / FISCAL_MONTH_TICKS) * FISCAL_MONTH_TICKS;
  for (let t = first; t <= toTick; t += FISCAL_MONTH_TICKS) out.push(t);
  return out;
}
