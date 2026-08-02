/**
 * @fileoverview Duty histogram - spec 40 Part B's percentile duty statistic.
 *
 * A MEAN over bimodal data lies: the border-bounce 37x defect (1.15 e/t
 * delivered against a 20 e/t allocation) sat inside an [ok] duty verdict for
 * hours because the fleet alternated ~2 ticks idle / 1 tick full and the mean
 * read ~0.5 - and the OWNER found it on a replay, not the ledger. Percentiles
 * over SUB-WINDOWS show what no mean can: mass at both ends with a hollow
 * middle (the bimodal signature of a fleet that thrashes instead of working).
 *
 * Pure accumulation, fed by the per-tick duty classification the corps
 * already perform (CarryCorp's duty meter, UpgradingCorp's workUtil) - no new
 * sampling. A sub-window of DUTY_SUBWINDOW ticks closes into one bucket
 * increment; percentiles and the bimodal verdict read the buckets. The
 * histogram is plain data so corps can serialize it beside their other
 * meters.
 *
 * @module telemetry/dutyHistogram
 */

/** Buckets across [0,1] duty - 10% resolution, plenty for a shape verdict. */
export const DUTY_BUCKETS = 10;

/**
 * Ticks per sub-window. Long enough that one round trip's natural idle-loaded
 * alternation averages out INSIDE a window (a healthy hauler's sub-window
 * reads its true utilization), short enough that regime flips (the bounce)
 * land in different windows and split the histogram.
 */
export const DUTY_SUBWINDOW = 25;

export interface DutyHistogram {
  /** Closed sub-windows per duty decile. */
  buckets: number[];
  /** Closed sub-window count (= sum of buckets). */
  windows: number;
  /** Ticks accumulated toward the current (open) sub-window. */
  openTicks: number;
  /** Duty ticks inside the open sub-window. */
  openDuty: number;
}

export function blankDutyHistogram(): DutyHistogram {
  return { buckets: new Array<number>(DUTY_BUCKETS).fill(0), windows: 0, openTicks: 0, openDuty: 0 };
}

/** Record one creep-tick (or fleet-tick) of duty; closes sub-windows itself. */
export function recordDutyTick(h: DutyHistogram, onDuty: boolean): void {
  h.openTicks += 1;
  if (onDuty) h.openDuty += 1;
  if (h.openTicks >= DUTY_SUBWINDOW) {
    const frac = h.openDuty / h.openTicks;
    const bucket = Math.min(DUTY_BUCKETS - 1, Math.floor(frac * DUTY_BUCKETS));
    h.buckets[bucket] += 1;
    h.windows += 1;
    h.openTicks = 0;
    h.openDuty = 0;
  }
}

/**
 * The duty fraction at percentile `p` (0..1) - bucket midpoint of the window
 * where the cumulative count crosses. Null before any sub-window closed: an
 * empty histogram has no shape, and a fabricated 0 would read as "always
 * idle".
 */
export function dutyPercentile(h: DutyHistogram, p: number): number | null {
  if (h.windows <= 0) return null;
  const target = p * h.windows;
  let seen = 0;
  for (let i = 0; i < DUTY_BUCKETS; i++) {
    seen += h.buckets[i];
    if (seen >= target) return (i + 0.5) / DUTY_BUCKETS;
  }
  return (DUTY_BUCKETS - 0.5) / DUTY_BUCKETS;
}

/**
 * The bounce signature: significant mass in BOTH outer quintiles with a
 * hollow middle. Thresholds are deliberately blunt - this is a shape verdict
 * ("look at this fleet"), not a measurement; the histogram itself rides
 * beside it for the look.
 */
export function dutyBimodal(h: DutyHistogram): boolean {
  if (h.windows < 4) return false;
  const low = (h.buckets[0] + h.buckets[1]) / h.windows;
  const high = (h.buckets[DUTY_BUCKETS - 2] + h.buckets[DUTY_BUCKETS - 1]) / h.windows;
  const mid = (h.buckets[3] + h.buckets[4] + h.buckets[5] + h.buckets[6]) / h.windows;
  return low >= 0.25 && high >= 0.25 && mid <= 0.2;
}
