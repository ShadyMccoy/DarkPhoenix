import { expect } from "chai";
import {
  FISCAL_MONTH_TICKS,
  FISCAL_YEAR_TICKS,
  boundariesBetween,
  isYearEnd,
  periodOf
} from "../../../scripts/fiscal";
import { closeIsMeasurable } from "../../../scripts/fiscal-close";

/**
 * The fiscal calendar (owner 2026-08-01). 1500 ticks = CREEP_LIFETIME, the
 * horizon every body cost amortizes over, so a fiscal month is exactly the
 * period a spawn purchase is expensed across.
 */
describe("fiscal calendar", () => {
  it("uses CREEP_LIFETIME as the month and ten months as the year", () => {
    expect(FISCAL_MONTH_TICKS).to.equal(1500);
    expect(FISCAL_YEAR_TICKS).to.equal(15000);
  });

  it("derives period from the absolute tick - no epoch, no drift", () => {
    const p = periodOf(72714129);
    expect(p.year).to.equal(Math.floor(72714129 / 15000));
    expect(p.month).to.equal(Math.floor((72714129 % 15000) / 1500) + 1);
    expect(p.label).to.match(/^FY\d+-M\d\d$/);
  });

  it("brackets each period exactly - start inclusive, end exclusive, no gap", () => {
    const p = periodOf(72714129);
    expect(p.endTick - p.startTick).to.equal(FISCAL_MONTH_TICKS);
    expect(periodOf(p.startTick).label).to.equal(p.label);
    expect(periodOf(p.endTick - 1).label).to.equal(p.label);
    expect(periodOf(p.endTick).label, "the next tick is the next month").to.not.equal(p.label);
  });

  it("labels sort chronologically (zero-padded month)", () => {
    const early = periodOf(0 * 15000 + 1 * 1500).label;
    const late = periodOf(0 * 15000 + 9 * 1500).label;
    expect([late, early].sort()).to.deep.equal([early, late]);
  });

  it("flags the tenth month as year-end", () => {
    expect(isYearEnd(periodOf(9 * 1500))).to.equal(true); // month 10
    expect(isYearEnd(periodOf(8 * 1500))).to.equal(false); // month 9
  });

  it("finds every boundary a capture pair spans, and none when it spans none", () => {
    expect(boundariesBetween(1500, 4500)).to.deep.equal([3000, 4500]);
    expect(boundariesBetween(1501, 2999)).to.deep.equal([]);
    // a long window closes every month it crosses - no close is skipped
    expect(boundariesBetween(0, 15000)).to.have.length(10);
  });
});

/**
 * A close is APPEND-ONLY, so anything wrong in one is wrong permanently. The
 * eligibility check is therefore the only place a bad close can be stopped.
 *
 * Incident 2026-08-01: FY4847-M09 was filed with every measured line at 0.00 -
 * miner, hauler, reserver, infra, consumers, the entire operating-cost half of
 * the income statement. The captures bracketing it had been taken with
 * `--segments 0,6` during a deploy cycle, so they carried no blackbox ring. The
 * check required core + flow only, and the plan side alone was enough to pass
 * it. The account did not report the gap; it reported that the colony spends
 * nothing to run itself, and filed that as a month.
 */
describe("fiscal close eligibility (2026-08-01: the all-zeros month)", () => {
  const ring = { rows: [{ corp: "mining-x", role: "miner", cost: 400 }] };
  const full = { core: {}, flow: {}, blackbox: ring };

  it("accepts a capture carrying plan AND measured sides", () => {
    expect(closeIsMeasurable(full)).to.equal(true);
  });

  it("REFUSES a capture with no blackbox ring - the measured columns would read 0.00", () => {
    expect(closeIsMeasurable({ core: {}, flow: {} })).to.equal(false);
  });

  it("REFUSES an EMPTY ring too, not just a missing one", () => {
    // A present-but-empty ring is the more dangerous shape: it looks like data.
    expect(closeIsMeasurable({ core: {}, flow: {}, blackbox: { rows: [] } })).to.equal(false);
  });

  it("still refuses captures missing the plan side", () => {
    expect(closeIsMeasurable({ flow: {}, blackbox: ring })).to.equal(false);
    expect(closeIsMeasurable({ core: {}, blackbox: ring })).to.equal(false);
    expect(closeIsMeasurable(undefined)).to.equal(false);
  });
});
