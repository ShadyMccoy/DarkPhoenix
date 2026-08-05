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
 * ARRIVALS-FIRST SEQUENCING (spec 45 leg 1, owner-directed 2026-08-05).
 *
 * Measured t72805426: **hubClampShare 0.625** (62.5% of port volleys clamped
 * by a full core) against **coreEmptyShare 0.276** (the core sits empty over
 * a quarter of the time). A buffer cannot be both saturated and idle - that
 * is a SEQUENCING failure, not capacity, and it had worsened from the 0.50
 * clamp share spec 45 was written against.
 *
 * One of its two mechanisms is the core->CTRL relay COMPETING with the source
 * ports for the controller link's free space. The relay is the expensive path
 * (two hops, two 3% taxes, and it spends the CORE link's cooldown - a resource
 * every source in the room shares); a port firing DIRECT is one hop and one
 * tax, and PORT B is physically closer to CTRL than to the hub. So when a port
 * stands loaded and ready, CTRL's space belongs to it and the relay must wait
 * one beat.
 *
 * The gate must NOT replace the warchest law (spec 45 trap note): below the
 * reserve, `preferControllerDirect` is false, ports bank at the core by
 * production-first doctrine, and the relay is then the ONLY controller feed -
 * holding it there would starve the controller outright.
 */
describe("holdCoreRelay (spec 45 leg 1: ports outrank the relay for CTRL's space)", () => {
  it("HOLDS the relay while a loaded port can take CTRL's space directly", () => {
    expect(holdCoreRelay({ pendingSenders: 1, preferControllerDirect: true, controllerFree: 800, threshold: 100 })).to.equal(true);
  });

  it("fires the relay when no port is pending (the relay is the FALLBACK, not the competitor)", () => {
    expect(holdCoreRelay({ pendingSenders: 0, preferControllerDirect: true, controllerFree: 800, threshold: 100 })).to.equal(false);
  });

  it("NEVER holds below the warchest - production-first makes the relay the only CTRL feed (spec 26 stage-2 law)", () => {
    // Ports bank at the core here; holding the relay would starve the
    // controller completely. The arrivals-first rule respects the warchest
    // gate rather than replacing it.
    expect(holdCoreRelay({ pendingSenders: 3, preferControllerDirect: false, controllerFree: 800, threshold: 100 })).to.equal(false);
  });

  it("does not hold when CTRL lacks room for a whole volley anyway (holding would buy nothing)", () => {
    // The port could not fire direct either, so reserving the space is pointless
    // and the relay's own clamped fire is no worse.
    expect(holdCoreRelay({ pendingSenders: 2, preferControllerDirect: true, controllerFree: 50, threshold: 100 })).to.equal(false);
  });

  it("does not hold without a controller link at all (no space to reserve)", () => {
    expect(holdCoreRelay({ pendingSenders: 2, preferControllerDirect: true, controllerFree: null, threshold: 100 })).to.equal(false);
  });
});
