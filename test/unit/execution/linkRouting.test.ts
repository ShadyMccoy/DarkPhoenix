import { expect } from "chai";
import { routeSourceVolley, VolleyContext } from "../../../src/execution/linkRouting";

/**
 * Stage-2 acceptance: the routing rule that captures the 0%-direct miss the
 * LinkMeter measured. DIRECT to the controller up to its planned rate (1 hop),
 * bank the residual, congestion-spill preserved as a fallback. Pinned before any
 * wiring - spec-26 died on hollow validation, so the decision is proven here.
 */
describe("routeSourceVolley (spec-26 stage 2 - link volley routing)", () => {
  const base: VolleyContext = { coreFree: 800, controllerFree: 800, controllerUnderPlan: true, threshold: 100 };

  it("prefers DIRECT to the controller when it has room AND is under its planned rate (the win)", () => {
    expect(routeSourceVolley(base)).to.equal("controllerDirect");
  });

  it("BANKS via the core once the controller has its planned share (production-first residual)", () => {
    // controllerUnderPlan false = the controller has its allocation this window;
    // the surplus must bank, not over-feed upgrading.
    expect(routeSourceVolley({ ...base, controllerUnderPlan: false })).to.equal("core");
  });

  it("banks via the core when there is no controller link at all", () => {
    expect(routeSourceVolley({ ...base, controllerFree: null })).to.equal("core");
  });

  it("does NOT direct-fire a controller link with no room, even under plan (bank instead)", () => {
    expect(routeSourceVolley({ ...base, controllerFree: 50 })).to.equal("core"); // 50 < threshold
  });

  it("FALLBACK: congestion spill to the controller when the core is full (the old behavior, preserved)", () => {
    // core full, controller NOT under plan - normally we'd bank, but the core
    // can't take it, so spill to the controller rather than strand the income.
    expect(routeSourceVolley({ coreFree: 0, controllerFree: 800, controllerUnderPlan: false, threshold: 100 })).to.equal(
      "controllerDirect"
    );
  });

  it("HOLDS on a sub-threshold core remainder rather than tax-dribbling (owner 2026-07-24)", () => {
    // The core at 760 (40 free), controller full: firing 40 pays the flat 3% tax
    // AND burns the source link's whole cooldown on a fraction of a volley, so the
    // 760 that arrives next can't ship for `range` ticks. The relay drains the core
    // every tick - hold one beat and ship a full >=threshold volley (step 2). Below
    // the minimum-worthwhile volley (threshold) the fire is never worth it.
    expect(routeSourceVolley({ coreFree: 40, controllerFree: 0, controllerUnderPlan: false, threshold: 100 })).to.equal(
      null
    );
  });

  it("does NOT dribble 1 into a 799-full core (the tax-loss loop, owner 2026-07-24)", () => {
    // The exact reported loop: core at 799 (1 free), controller full. The old rule
    // fired 1 e every cooldown, all of it eaten by the 3% tax, forever.
    expect(routeSourceVolley({ coreFree: 1, controllerFree: 0, controllerUnderPlan: false, threshold: 100 })).to.equal(
      null
    );
  });

  it("holds (null) when nothing has room", () => {
    expect(routeSourceVolley({ coreFree: 0, controllerFree: 0, controllerUnderPlan: true, threshold: 100 })).to.equal(
      null
    );
  });
});
