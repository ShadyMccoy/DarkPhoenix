import { expect } from "chai";
import { holdCoreRelay, routeSourceVolley, VolleyContext } from "../../../src/execution/linkRouting";

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

/**
 * THROUGHPUT ROUTING (owner 2026-07-29: "there's times where the link fires
 * towards the controller link, causing it to be backed up because there's very
 * little energy capacity there. it should fire to the core link more so it can
 * fully empty itself, otherwise it becomes a bottleneck").
 *
 * ENGINE GROUND TRUTH (@screeps/engine processor/intents/links/transfer.js):
 * the amount is CLAMPED to the target's free capacity, and then
 *   object.cooldown += LINK_COOLDOWN * range(source, target)
 * is charged IN FULL regardless of how little moved. So the scarce resource is
 * the sending link's COOLDOWN, and the right objective is
 *   throughput = min(payload, free(target)) / range(target)
 * energy per cooldown tick. The v1 rule compared free capacity against a fixed
 * "worth firing" FLOOR (LINK_FIRE_THRESHOLD) and never saw the payload at all,
 * so a controller link with 150 free captured the fire from a source holding
 * 800: 150 delivered, the whole cooldown spent, 650 left stuck - the reported
 * back-up.
 */
describe("routeSourceVolley - throughput per cooldown (owner 2026-07-29)", () => {
  const full = {
    payload: 800,
    coreFree: 800,
    controllerFree: 800,
    controllerUnderPlan: true,
    threshold: 100,
    coreRange: 10,
    controllerRange: 10
  };

  it("sends to the CORE when the controller can only take a sliver of the payload", () => {
    // The owner's case: ctrl 150 free vs a full 800 payload at equal range.
    // Direct would deliver 150 for a full cooldown; the core empties the link.
    expect(routeSourceVolley({ ...full, controllerFree: 150 })).to.equal("core");
  });

  it("still prefers DIRECT when the controller can absorb the whole payload", () => {
    expect(routeSourceVolley(full)).to.equal("controllerDirect");
  });

  it("prefers DIRECT on a partial fill only when its throughput still wins", () => {
    // ctrl takes 600 of 800 but sits 2 tiles away vs the core's 20: direct
    // moves 300/tick of cooldown, the core 40 - direct wins decisively.
    expect(
      routeSourceVolley({ ...full, controllerFree: 600, controllerRange: 2, coreRange: 20 })
    ).to.equal("controllerDirect");
  });

  it("respects the plan cap: over-plan never direct-fires even at equal throughput", () => {
    expect(routeSourceVolley({ ...full, controllerUnderPlan: false })).to.equal("core");
  });

  it("keeps the congestion spill: a FULL core still routes to the controller", () => {
    expect(routeSourceVolley({ ...full, coreFree: 0, controllerUnderPlan: false })).to.equal("controllerDirect");
  });

  it("HOLDS rather than dribbling when neither target can take a threshold volley", () => {
    expect(routeSourceVolley({ ...full, coreFree: 40, controllerFree: 40 })).to.equal(null);
  });

  it("a small payload that FITS the controller is not penalised (throughput is a ratio)", () => {
    // payload 120 into 150 free: the link empties fully, so direct is correct.
    expect(routeSourceVolley({ ...full, payload: 120, controllerFree: 150 })).to.equal("controllerDirect");
  });

  it("treats a missing range as neutral (legacy callers keep working)", () => {
    const { coreRange, controllerRange, ...noRanges } = full;
    expect(routeSourceVolley(noRanges as any)).to.equal("controllerDirect");
  });
});

/**
 * THE RELAY'S COOLDOWN IS THE SCARCE THING (spec 45 leg 1, CORRECTED by the
 * owner 2026-08-06: *"Leg 1 HoldCoreRelay is only good if it increases
 * throughput. Ie if the controller link is closer and empty enough. It might
 * be rare. Energy tax is less important."*).
 *
 * The first implementation held the relay whenever any port stood loaded and
 * CTRL had threshold room, justified on hop count and the 3% tax. That was
 * wrong twice over:
 *
 * 1. **It contradicted leg 2.** The core->CTRL relay is one of the core
 *    link's two DRAIN paths. Holding it keeps the core fuller - exactly when
 *    leg 2 is emptying the core to give inbound volleys somewhere to land.
 *    The measured defect is hubClampShare 0.625 (ports clamped by a FULL
 *    core), so a rule that slows core drainage attacks the wrong side.
 * 2. **The tax is not the argument.** Per the owner, throughput is. And the
 *    two paths do not even compete for the same cooldown - the port spends
 *    its own, the relay spends the core's.
 *
 * What they DO contend for is CTRL's free space WITHIN ONE TICK, and the
 * engine's rule makes that contention expensive in exactly one way: a
 * transfer is CLAMPED to the target's free capacity but
 * `cooldown += LINK_COOLDOWN * range` is charged IN FULL. So if a direct port
 * volley lands in CTRL this tick and the relay fires into what is left, the
 * core pays its whole cooldown to move a sliver - and cannot drain again for
 * LINK_COOLDOWN x range ticks, which is precisely the landing room arrivals
 * need.
 *
 * So the honest rule is the SAME one `routeSourceVolley` step 4 already
 * applies to ports: do not pay a full cooldown for less than a worthwhile
 * volley. No warchest carve-out is needed any more - with no direct fire
 * inbound the rule reduces to the pre-existing behavior exactly, so policy
 * never enters it. And the owner is right that it should be RARE: it fires
 * only when a direct volley genuinely crowds the relay out.
 */
describe("holdCoreRelay (spec 45 leg 1: never spend the core cooldown on a dribble)", () => {
  it("HOLDS when a direct volley leaves the relay less than a worthwhile fire", () => {
    // CTRL has 300 free; a port is landing 250 direct this tick. The relay
    // would move 50 and spend the core's whole cooldown doing it.
    expect(holdCoreRelay({ coreStore: 800, controllerFree: 300, incomingDirect: 250, threshold: 100 })).to.equal(true);
  });

  it("FIRES when the relay still lands a full volley alongside the direct fire", () => {
    // 800 free, 250 arriving direct -> 550 still there for the relay. Both
    // deliver; nothing is wasted; the core drains (which is what the landing
    // zone needs).
    expect(holdCoreRelay({ coreStore: 800, controllerFree: 800, incomingDirect: 250, threshold: 100 })).to.equal(false);
  });

  it("with NO direct fire inbound the rule is the pre-existing behavior, bit for bit", () => {
    // This is the common case, and it must not change: the relay drains the
    // core whenever CTRL can take a worthwhile volley.
    expect(holdCoreRelay({ coreStore: 800, controllerFree: 800, incomingDirect: 0, threshold: 100 })).to.equal(false);
    expect(holdCoreRelay({ coreStore: 800, controllerFree: 100, incomingDirect: 0, threshold: 100 })).to.equal(false);
    // CTRL too full for a worthwhile fire: the existing guard already blocks
    // this, and the rule agrees rather than fighting it.
    expect(holdCoreRelay({ coreStore: 800, controllerFree: 50, incomingDirect: 0, threshold: 100 })).to.equal(true);
  });

  it("is bounded by what the CORE actually holds - a near-empty core is not a dribble problem", () => {
    // The core holds 60: it cannot make a threshold volley regardless, and
    // the pre-existing store guard handles it. The rule must not claim this
    // as its own case.
    expect(holdCoreRelay({ coreStore: 60, controllerFree: 800, incomingDirect: 0, threshold: 100 })).to.equal(true);
  });

  it("never holds without a controller link (nothing to contend over)", () => {
    expect(holdCoreRelay({ coreStore: 800, controllerFree: null, incomingDirect: 0, threshold: 100 })).to.equal(false);
  });
});
