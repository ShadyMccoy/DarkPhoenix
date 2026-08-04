import { expect } from "chai";
import {
  DUTY_BUCKETS,
  DUTY_SUBWINDOW,
  blankDutyHistogram,
  recordDutyTick,
  dutyPercentile,
  dutyBimodal
} from "../../../src/telemetry/dutyHistogram";

/**
 * SPEC 40 PART B - percentile duty, because a MEAN over bimodal data lies.
 *
 * The motivating indictment: the border-bounce 37x defect (1.15 e/t delivered
 * against a 20 e/t allocation) sat inside an [ok] verdict for hours because
 * the duty statistic was a mean over ~2-ticks-idle / 1-tick-full cycling -
 * and the OWNER found it on a replay. The fix is cheap and self-contained:
 * bucket per-sub-window duty fractions into a histogram, publish the
 * percentiles beside the mean, and call the shape BIMODAL when the mass sits
 * at both ends with a hollow middle - the signature no mean can show.
 *
 * Pure accumulation - the corps' existing per-tick duty classification feeds
 * it; no new sampling.
 */
describe("duty histogram (spec 40-B: percentiles over sub-windows)", () => {
  it("accumulates per-tick duty into sub-window buckets", () => {
    const h = blankDutyHistogram();
    // One full sub-window at 100% duty -> the top bucket.
    for (let i = 0; i < DUTY_SUBWINDOW; i++) recordDutyTick(h, true);
    expect(h.buckets[DUTY_BUCKETS - 1]).to.equal(1);
    expect(h.windows).to.equal(1);
    // One at 0% -> the bottom bucket.
    for (let i = 0; i < DUTY_SUBWINDOW; i++) recordDutyTick(h, false);
    expect(h.buckets[0]).to.equal(1);
    expect(h.windows).to.equal(2);
  });

  it("reads percentiles off the buckets", () => {
    const h = blankDutyHistogram();
    // 8 idle sub-windows, 2 full ones: p50 sits idle, p90 sits full.
    for (let w = 0; w < 8; w++) for (let i = 0; i < DUTY_SUBWINDOW; i++) recordDutyTick(h, false);
    for (let w = 0; w < 2; w++) for (let i = 0; i < DUTY_SUBWINDOW; i++) recordDutyTick(h, true);
    expect(dutyPercentile(h, 0.5)).to.be.lessThan(0.2);
    expect(dutyPercentile(h, 0.95)).to.be.greaterThan(0.8);
  });

  it("calls the border-bounce shape BIMODAL - the signature the mean hides", () => {
    const h = blankDutyHistogram();
    // Half the windows near-idle, half near-full: mean ~0.5 looks healthy.
    for (let w = 0; w < 5; w++) for (let i = 0; i < DUTY_SUBWINDOW; i++) recordDutyTick(h, false);
    for (let w = 0; w < 5; w++) for (let i = 0; i < DUTY_SUBWINDOW; i++) recordDutyTick(h, true);
    expect(dutyBimodal(h)).to.equal(true);
  });

  it("does NOT cry bimodal on a healthy steady worker", () => {
    const h = blankDutyHistogram();
    // Sub-windows all ~80% duty: unimodal, high.
    for (let w = 0; w < 10; w++) {
      for (let i = 0; i < DUTY_SUBWINDOW; i++) recordDutyTick(h, i % 5 !== 0);
    }
    expect(dutyBimodal(h)).to.equal(false);
  });

  it("reports nothing before a sub-window closes (no phantom percentiles)", () => {
    const h = blankDutyHistogram();
    recordDutyTick(h, true);
    expect(h.windows).to.equal(0);
    expect(dutyPercentile(h, 0.5)).to.equal(null);
    expect(dutyBimodal(h)).to.equal(false);
  });
});
