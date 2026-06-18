import { expect } from "chai";
import { ORPHAN_GRACE_TICKS, orphanAction } from "../../../src/execution/OrphanRescue";

// The safety net for "creeps just standing around until they die": a creep no
// live corp claims is re-adopted into a corp for the same work, or recycled once
// it has been orphaned past the grace window (which rides out the commission
// churn around a flow re-solve so a creep is never recycled for a one-tick gap).
describe("OrphanRescue.orphanAction", () => {
  it("does nothing while a live corp claims the creep", () => {
    expect(orphanAction(true, false, undefined, 1000)).to.equal("none");
    // claimed wins even if it was previously orphaned (its corp came back)
    expect(orphanAction(true, true, 500, 1000)).to.equal("none");
  });

  it("re-adopts an orphan the moment a corp for its work exists", () => {
    expect(orphanAction(false, true, undefined, 1000)).to.equal("readopt");
    // re-adoption beats the grace clock - recover the worker, don't wait it out
    expect(orphanAction(false, true, 0, 1000)).to.equal("readopt");
  });

  it("waits out the grace window before giving up on an orphan", () => {
    // first orphaned tick: start the clock, don't recycle yet
    expect(orphanAction(false, false, undefined, 1000)).to.equal("wait");
    // still within grace
    expect(orphanAction(false, false, 1000, 1000 + ORPHAN_GRACE_TICKS - 1)).to.equal("wait");
  });

  it("recycles an orphan once it is past the grace window", () => {
    expect(orphanAction(false, false, 1000, 1000 + ORPHAN_GRACE_TICKS)).to.equal("recycle");
    expect(orphanAction(false, false, 1000, 5000)).to.equal("recycle");
  });
});
