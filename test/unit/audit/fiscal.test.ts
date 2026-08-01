import { expect } from "chai";
import {
  FISCAL_MONTH_TICKS,
  FISCAL_YEAR_TICKS,
  boundariesBetween,
  isYearEnd,
  periodOf
} from "../../../scripts/fiscal";

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
