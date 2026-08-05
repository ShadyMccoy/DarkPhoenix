/**
 * DepartMeter — records WHY a hauler left its pickup stop, and how full it
 * was when it did.
 *
 * Born cycle t72786811: the cd94 mouth stood ~3.2k for 1000+ ticks while its
 * 44-CARRY hauler visited every ~100t and left at HALF load (1100/2200, seen
 * live twice) with 2000 banked in the container one tile away — removal per
 * trip barely above inflow, so the pile never drains (the zero-margin
 * equilibrium). The clean-bus state machine flips to delivering on a FULL
 * load only, so a partial departure means one of the explicit depart() calls
 * fired — and which one is invisible from outside (hypothesis #1, a stale
 * dedicatedBuildSourceId, was falsified by a live Memory read). This meter
 * makes the branch a capture read instead of a third theory.
 *
 * In-memory only (zeroed by a global reset): the diagnosis needs a few
 * hundred ticks of counts, not history. `departsSince` stamps when counting
 * started so a reader can normalize.
 */
export type DepartReason = "full" | "yield" | "scavenge-dry" | "spot-dry";

/**
 * Scalar fields on purpose: the stamp spreads into CorpSizingRecord, whose
 * index signature allows scalars or {string: number} maps only — and flat
 * fields grep from a raw capture.
 */
export interface DepartStamp {
  /** Which branch sent the last hauler home. */
  lastDepartReason?: DepartReason;
  /** How full it was when it left (0..1, 3 decimals). */
  lastDepartFrac?: number;
  lastDepartTick?: number;
  /** Departure counts by reason since `departsSince` (zero counts omitted). */
  departs?: Partial<Record<DepartReason, number>>;
  /** Tick of the first recorded departure (normalize the counts over this). */
  departsSince?: number;
}

export class DepartMeter {
  private counts: Partial<Record<DepartReason, number>> = {};
  private last?: { reason: DepartReason; frac: number; tick: number };
  private since?: number;

  record(reason: DepartReason, cargo: number, capacity: number, tick: number): void {
    const frac = capacity > 0 ? Math.round((cargo / capacity) * 1000) / 1000 : 0;
    this.last = { reason, frac, tick };
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
    if (this.since === undefined) this.since = tick;
  }

  /** Spread into the haul sizing stamp; {} until the first departure. */
  stamp(): DepartStamp {
    if (!this.last || this.since === undefined) return {};
    return {
      lastDepartReason: this.last.reason,
      lastDepartFrac: this.last.frac,
      lastDepartTick: this.last.tick,
      departs: { ...this.counts },
      departsSince: this.since
    };
  }
}
