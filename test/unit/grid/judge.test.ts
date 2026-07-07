import { expect } from "chai";
import { CellJudge } from "../../grid/judge";
import { CellSample, GridCell, always, atWindow, eventually } from "../../grid/GridCell";

/**
 * The grid judge is the machine every cell verdict flows through - a wrong
 * verdict semantic silently corrupts the whole ladder, so each rule from
 * docs/specs/08 is pinned here: early pass, fail-fast on `always`, grace
 * periods, window-boundary settlement, timeout-vs-fail distinction, and the
 * throwing-check-counts-as-false rule.
 */

const cell = (window: number, assertions: GridCell["assertions"]): GridCell => ({
  id: "test-cell",
  tier: 1,
  avenue: "test",
  window,
  rooms: { home: () => ({ room: "W0N0", terrain: [], objects: [] }) },
  bot: { x: 25, y: 25 },
  assertions,
});

/** A sample where only `tick` and a boolean-bearing memory matter. */
const sample = (tick: number, flags: Record<string, boolean> = {}): CellSample => ({
  tick,
  memory: flags,
  userId: "u1",
  room: () => "W0N0",
  objects: () => [],
  creep: () => undefined,
});

describe("grid CellJudge", () => {
  it("passes early when every assertion is eventually-mode and satisfied", () => {
    const judge = new CellJudge(cell(100, [eventually("a", (s) => s.memory.a)]));
    expect(judge.observe(sample(1))).to.equal(null);
    expect(judge.observe(sample(2, { a: true }))).to.equal("pass");
    expect(judge.verdict().decidedTick).to.equal(2);
    // Satisfaction tick is recorded (the calibration readout).
    expect(judge.verdict().assertions[0].satisfiedAt).to.equal(2);
  });

  it("fails fast the moment an always-assertion is violated", () => {
    const judge = new CellJudge(cell(100, [always("alive", (s) => s.memory.alive)]));
    expect(judge.observe(sample(1, { alive: true }))).to.equal(null);
    expect(judge.observe(sample(2, { alive: false }))).to.equal("fail");
    expect(judge.verdict().assertions[0].violatedAt).to.equal(2);
  });

  it("does not enforce an always-assertion inside its grace window", () => {
    const judge = new CellJudge(cell(50, [always("settled", (s) => s.memory.ok, 10)]));
    // Violations at ticks <= grace are ignored; the first post-grace one fails.
    expect(judge.observe(sample(5, { ok: false }))).to.equal(null);
    expect(judge.observe(sample(10, { ok: false }))).to.equal(null);
    expect(judge.observe(sample(11, { ok: false }))).to.equal("fail");
  });

  it("times out (not fails) when an eventually never satisfies by the window", () => {
    const judge = new CellJudge(cell(3, [eventually("never", () => false)]));
    expect(judge.observe(sample(1))).to.equal(null);
    expect(judge.observe(sample(2))).to.equal(null);
    expect(judge.observe(sample(3))).to.equal("timeout");
  });

  it("holds an eventually-satisfied cell open while an always-assertion still guards it", () => {
    const judge = new CellJudge(
      cell(4, [eventually("a", (s) => s.memory.a), always("alive", () => true)])
    );
    // Eventually satisfied at tick 1, but the always must hold through the window.
    expect(judge.observe(sample(1, { a: true }))).to.equal(null);
    expect(judge.observe(sample(2, { a: true }))).to.equal(null);
    expect(judge.observe(sample(4, { a: true }))).to.equal("pass");
  });

  it("settles atWindow assertions only at the window boundary", () => {
    const judge = new CellJudge(cell(3, [atWindow("final state", (s) => s.memory.done)]));
    // False mid-run must not fail the cell - only the boundary evaluation counts.
    expect(judge.observe(sample(1, { done: false }))).to.equal(null);
    expect(judge.observe(sample(3, { done: true }))).to.equal("pass");

    const failing = new CellJudge(cell(3, [atWindow("final state", (s) => s.memory.done)]));
    failing.observe(sample(1, { done: true }));
    expect(failing.observe(sample(3, { done: false }))).to.equal("fail");
  });

  it("treats a throwing check as false, not as a harness error", () => {
    const judge = new CellJudge(
      cell(2, [
        always("pos readable", (s) => {
          // Typical cell code: dereferencing a dead creep throws.
          return (s.creep("gone") as any).x >= 0;
        }),
      ])
    );
    expect(judge.observe(sample(1))).to.equal("fail");
  });

  it("ignores samples after the verdict and reports error() as terminal", () => {
    const judge = new CellJudge(cell(10, [eventually("a", (s) => s.memory.a)]));
    judge.error(4);
    expect(judge.isDecided).to.equal(true);
    expect(judge.observe(sample(5, { a: true }))).to.equal(null);
    expect(judge.verdict("boom").status).to.equal("error");
    expect(judge.verdict("boom").error).to.equal("boom");
  });
});
