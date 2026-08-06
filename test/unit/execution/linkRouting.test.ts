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
 * WHAT THE RELAY HOLD IS ACTUALLY FOR (spec 45 leg 1, after two owner
 * corrections on 2026-08-06).
 *
 * v1 reserved CTRL's free space for the cheaper one-hop port fire (hop count,
 * 3% tax). Owner: *"only good if it increases throughput... Energy tax is
 * less important."*
 *
 * v2 claimed the hold protected the core's DRAINAGE - a clamped fire spends
 * the core's whole cooldown, so it cannot drain again for LINK_COOLDOWN x
 * range ticks. Owner: *"No the core link can always be tendered to the
 * storage."* The FEEDER is the core's always-available drain (sole
 * bidirectional operator; leg 2 makes it pre-drain to zero ahead of a
 * volley), so landing room is never the relay's responsibility.
 *
 * What survives is narrow and is the owner's own criterion: the relay's
 * DELIVERED ENERGY PER CORE COOLDOWN. The engine clamps the transfer but
 * charges the cooldown in full, so firing into what a direct volley left buys
 * a sliver at the price of a whole cooldown and blocks the next CTRL feed.
 * Same rule routeSourceVolley step 4 applies to ports. A minor optimization -
 * leg 2 is the fix for the clamping defect - and it should fire rarely.
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

/**
 * FULL-VOLLEY DISCIPLINE AND THE SENDER QUEUE (owner 2026-08-06: *"Generally
 * speaking if the tender is big enough it's always a better idea to hold the
 * volley until you can send a full volley. And even then there may be a queue
 * so n>1 links don't blockade each other."*).
 *
 * Two defects, one principle. The engine clamps a transfer to the target's
 * free capacity but charges `cooldown += LINK_COOLDOWN * range` IN FULL, so
 * partial volleys are the waste mechanism:
 *
 * 1. **The threshold gate was too weak.** Step 2 banked to the core whenever
 *    it had merely `threshold` (100) free - so a link holding 800 fired 100
 *    and spent its ENTIRE cooldown on an eighth of a volley. Holding one beat
 *    costs nothing now that the tender is big enough to clear the core: the
 *    feeder floors at one full volley of CARRY (volleyServiceCarry) and leg 2
 *    pre-drains the core to zero the moment a link stands loaded. The
 *    chicken-and-egg resolves itself - a loaded link IS the signal that
 *    empties the core for it.
 * 2. **n>1 senders blockade each other.** Nothing reserved the target's space
 *    within a tick, so two loaded links both fired at an 800-free core: the
 *    first landed 800, the second was clamped to ~0 and paid full cooldown
 *    for nothing. The queue reserves what each accepted fire consumes.
 *
 * THE RELIEF VALVE stays: a SATURATED sender (at its own capacity) cannot
 * accept its miner's next deposit, so that energy hits the ground and decays.
 * Income protection outranks cooldown efficiency there, and the old
 * threshold rule applies - holding a full link to save a cooldown would be
 * saving the cheaper resource.
 */
describe("routeSourceVolley - full-volley discipline (owner 2026-08-06)", () => {
  const ctx = (over: Partial<VolleyContext> = {}): VolleyContext => ({
    coreFree: 800,
    controllerFree: null,
    controllerUnderPlan: false,
    threshold: 100,
    payload: 800,
    coreRange: 1,
    ...over
  });

  it("HOLDS rather than firing a clamped volley: 800 payload into 600 free", () => {
    // The old rule fired here (600 >= threshold) and spent the whole cooldown
    // moving 600 of 800 - and the remaining 200 then needed a SECOND full
    // cooldown to move.
    expect(routeSourceVolley(ctx({ coreFree: 600 }))).to.equal(null);
  });

  it("fires when the whole volley fits", () => {
    expect(routeSourceVolley(ctx({ coreFree: 800 }))).to.equal("core");
  });

  it("a SMALLER payload still fires into the same space (the queue's second sender)", () => {
    // 300 fits in 600: the space a held 800-link declined is not wasted.
    expect(routeSourceVolley(ctx({ coreFree: 600, payload: 300 }))).to.equal("core");
  });

  it("SCOPE: the discipline is the CORE's only - the controller keeps the throughput rule", () => {
    // We control the core's drain (the tender), so waiting for its room
    // always pays. The controller link drains on the upgraders' schedule, and
    // a PARTIAL volley into a near controller can still beat a full one into
    // a far core because cooldown scales with range: 600 at range 2 moves
    // 300/tick, 800 at range 20 moves 40. That comparison stays the
    // throughput rule's, not the discipline's.
    expect(
      routeSourceVolley(ctx({ controllerFree: 600, controllerUnderPlan: true, controllerRange: 2, coreRange: 20 }))
    ).to.equal("controllerDirect");
  });

  it("RELIEF VALVE: a SATURATED sender fires partial - its miner's deposit would hit the ground", () => {
    // The link is full (payload === its capacity), so holding costs INCOME,
    // which outranks the cooldown it would save.
    expect(routeSourceVolley(ctx({ coreFree: 300, payload: 800, senderFull: true }))).to.equal("core");
  });

  it("...but a saturated sender still needs a WORTHWHILE volley's room", () => {
    expect(routeSourceVolley(ctx({ coreFree: 50, payload: 800, senderFull: true }))).to.equal(null);
  });

  it("legacy callers with no payload behave exactly as before (no arity regression)", () => {
    expect(routeSourceVolley({ coreFree: 800, controllerFree: null, controllerUnderPlan: false, threshold: 100 })).to.equal("core");
  });
});
