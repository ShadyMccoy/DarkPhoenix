/**
 * judge - pure per-cell assertion state machine (no server, unit-testable).
 *
 * Verdict semantics (docs/specs/08):
 *   PASS    = every "always" unviolated from its graceTicks through the window,
 *             every "eventually" satisfied at some sample <= window, and every
 *             "atWindow" true at the first sample >= window. A cell with ONLY
 *             "eventually" assertions passes early the moment all are satisfied
 *             (its bot can then be retired to stop paying its tick cost).
 *   FAIL    = any "always" violated (fail fast) or any "atWindow" false.
 *   TIMEOUT = an "eventually" never satisfied by the window. Reported
 *             distinctly from FAIL: it usually means "stuck", which is the
 *             grid's core signal.
 *   ERROR   = staging/harness exception, or the bot's memory unparsable for
 *             more than 5 consecutive samples (tracked by the runner).
 *
 * A check that throws counts as false for that sample (a creep dying mid-window
 * makes `s.creep("x").pos` blow up; that is an observation, not a harness bug).
 */

import { AssertionOutcome, CellAssertion, CellSample, CellStatus, CellVerdict, GridCell } from "./GridCell";

interface AssertionState {
  assertion: CellAssertion;
  satisfiedAt?: number;
  violatedAt?: number;
}

export class CellJudge {
  private readonly states: AssertionState[];
  private decided: CellStatus | null = null;
  private decidedTick = 0;

  constructor(private readonly cell: GridCell) {
    this.states = cell.assertions.map((assertion) => ({ assertion }));
  }

  /** True once a verdict exists; the runner may retire the cell's bot. */
  get isDecided(): boolean {
    return this.decided !== null;
  }

  /**
   * Feed one sample. Returns the verdict status if this sample decided the
   * cell, else null. Samples after decision are ignored.
   */
  observe(sample: CellSample): CellStatus | null {
    if (this.decided) return null;

    for (const st of this.states) {
      const { assertion } = st;
      const ok = safeCheck(assertion, sample);

      if (assertion.mode === "always") {
        if (sample.tick > (assertion.graceTicks ?? 0) && !ok && st.violatedAt === undefined) {
          st.violatedAt = sample.tick;
          return this.decide("fail", sample.tick);
        }
      } else if (assertion.mode === "eventually") {
        if (ok && st.satisfiedAt === undefined) st.satisfiedAt = sample.tick;
      }
      // "atWindow" is only consulted at the window boundary below.
    }

    // Window boundary: settle atWindow + outstanding eventually assertions.
    if (sample.tick >= this.cell.window) {
      for (const st of this.states) {
        if (st.assertion.mode !== "atWindow") continue;
        st.satisfiedAt = sample.tick;
        if (!safeCheck(st.assertion, sample)) {
          st.violatedAt = sample.tick;
          return this.decide("fail", sample.tick);
        }
      }
      const unsatisfied = this.states.some(
        (st) => st.assertion.mode === "eventually" && st.satisfiedAt === undefined
      );
      return this.decide(unsatisfied ? "timeout" : "pass", sample.tick);
    }

    // Early pass: only eventually-mode assertions and all satisfied.
    const onlyEventually = this.states.every((st) => st.assertion.mode === "eventually");
    if (onlyEventually && this.states.every((st) => st.satisfiedAt !== undefined)) {
      return this.decide("pass", sample.tick);
    }

    return null;
  }

  /** Force a verdict from outside the sample loop (harness error). */
  error(tick: number): void {
    if (!this.decided) this.decide("error", tick);
  }

  verdict(errorMessage?: string): CellVerdict {
    const status = this.decided ?? "error";
    return {
      id: this.cell.id,
      tier: this.cell.tier,
      avenue: this.cell.avenue,
      status,
      decidedTick: this.decidedTick,
      window: this.cell.window,
      assertions: this.states.map(toOutcome),
      ...(status === "error" && errorMessage ? { error: errorMessage } : {}),
    };
  }

  private decide(status: CellStatus, tick: number): CellStatus {
    this.decided = status;
    this.decidedTick = tick;
    return status;
  }
}

function safeCheck(assertion: CellAssertion, sample: CellSample): boolean {
  try {
    return assertion.check(sample);
  } catch {
    return false;
  }
}

function toOutcome(st: AssertionState): AssertionOutcome {
  return {
    name: st.assertion.name,
    mode: st.assertion.mode,
    satisfiedAt: st.satisfiedAt,
    violatedAt: st.violatedAt,
    satisfied: st.violatedAt === undefined && (st.assertion.mode !== "eventually" || st.satisfiedAt !== undefined),
  };
}
