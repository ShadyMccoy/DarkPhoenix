import { expect } from "chai";
import { CARRY_CAPACITY, LINK_CAPACITY, volleyServiceCarry } from "../../../src/economy/primitives";

/**
 * THE VOLLEY FLOOR MUST SCALE WITH INBOUND SENDERS (A/B confirmed t72819265).
 *
 * `volleyServiceCarry()` floored the feeder at ONE full volley (16 CARRY) on
 * spec 45's own latency doctrine: *"the feeder is a SERVICE creep - its metric
 * is drain LATENCY, not throughput utilization."* That doctrine is right and
 * the floor was still too low, because a room with N inbound senders can land
 * N volleys inside one drain window and a single creep serves them SERIALLY.
 *
 * THE NATURAL EXPERIMENT. A staffing-lens bug double-ordered the feeder, and
 * fixing it let the pair age back to one. Registered prediction at t72811683:
 * *"as `feeders` 2 -> 1, `coreEmptyShare` falls back toward 0.3,
 * `hubClampShare` returns toward 0.28. If it does, the feeder's sizing law is
 * under-stated and that is the fix."*
 *
 *     feeders  CARRY   coreEmptyShare   hubClampShare   window
 *        2       32        0.565            0.091         84t
 *        1       16        0.421            0.268       7223t
 *
 * Confirmed, and `hubClampShare` landed within 0.008 of the predicted 0.28.
 *
 * AND IT IS NOT A RATE PROBLEM, which is what makes the latency reading
 * decisive. The throughput meter shipped for this question says the SINGLE
 * feeder moves MORE per tick than the pair did — `movedPerTick` 187.33 against
 * 131.28, active 0.556 against 0.481 — while the core clamps three times as
 * often. One creep working harder cannot cover two senders arriving at once;
 * it can only serve them one after the other. The stamp already records
 * `inboundSenders: 2` at the decision site, so the input was there all along.
 */
/**
 * RESIZED 2026-08-07 (owner): *"the core link has a feeder tender creep slave.
 * It empties it to ensure incoming links can transfer... I recon it needs 8
 * carry to do its job well in our room. At lower RCL maybe 4 is good."*
 *
 * Our room runs 2 inbound senders, so 4/sender is the owner's 8 and a
 * single-sender room is the owner's 4 - one coefficient, both numbers.
 *
 * This does NOT overturn the t72819265 A/B, it corrects how that A/B was
 * encoded. The A/B varied CARRY and CREEP COUNT together (1 feeder @ 16 vs 2
 * feeders @ 32) and named CONCURRENCY as the mechanism - "one creep cannot
 * cover two senders arriving at once" - with the single feeder measurably
 * moving MORE per tick while clamping three times as often. One-creep-per-
 * sender is kept; only the per-creep body shrinks.
 */
describe("volleyServiceCarry (the core shuttle, one creep per sender)", () => {
  const { CORE_SERVICE_CARRY_PER_SENDER, LINK_PAYLOAD_CARRY, depositRouteCarryCap } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("../../../src/economy/primitives");

  it("is the owner's numbers: 8 CARRY at our 2 senders, 4 at one", () => {
    expect(volleyServiceCarry(2), "our room").to.equal(8);
    expect(volleyServiceCarry(1), "lower RCL, one source link").to.equal(4);
    expect(CORE_SERVICE_CARRY_PER_SENDER).to.equal(4);
  });

  it("no longer scales with the LINK PAYLOAD - the two meanings are split", () => {
    // These used to be one function. "How much fits in a link" (16) and "how
    // big must the core's shuttle be" (4/sender) are not the same quantity.
    expect(LINK_PAYLOAD_CARRY).to.equal(16);
    expect(volleyServiceCarry(1)).to.not.equal(LINK_PAYLOAD_CARRY);
  });

  it("leaves the DEPOSIT-route cap on the landing quantum, untouched", () => {
    // A creep unloading into a link port still places exactly one link's worth
    // per arrival. Shrinking the shuttle must not shrink this.
    expect(depositRouteCarryCap(37, true)).to.equal(16);
    expect(depositRouteCarryCap(99, true)).to.equal(16);
    expect(depositRouteCarryCap(9, true), "under the cap is unchanged").to.equal(9);
  });
});

describe("volleyServiceCarry (drain latency scales with inbound senders)", () => {
  const ONE_VOLLEY = 4; // CORE_SERVICE_CARRY_PER_SENDER - see the resize note above

  it("one sender still floors at exactly one volley - the old contract, unchanged", () => {
    expect(volleyServiceCarry(1)).to.equal(ONE_VOLLEY);
  });

  it("TWO senders floor at two volleys - the measured live case", () => {
    // W43N23 stamps inboundSenders: 2. One feeder at 16 CARRY clamped 0.268;
    // the accidental 32 clamped 0.091.
    expect(volleyServiceCarry(2)).to.equal(2 * ONE_VOLLEY);
  });

  it("scales linearly - N senders can land N volleys in one drain window", () => {
    for (const n of [1, 2, 3, 4]) expect(volleyServiceCarry(n)).to.equal(n * ONE_VOLLEY);
  });

  it("ZERO senders needs no volley floor at all - a room with no ports is not a service post", () => {
    expect(volleyServiceCarry(0)).to.equal(0);
  });

  it("defaults to ONE volley when the caller passes nothing (every legacy call site)", () => {
    expect(volleyServiceCarry()).to.equal(ONE_VOLLEY);
  });

  it("never returns a fractional or negative floor", () => {
    for (const n of [-3, -1, 0, 1, 5]) {
      const v = volleyServiceCarry(n);
      expect(v).to.be.at.least(0);
      expect(Number.isInteger(v), `floor for ${n} must be whole CARRY parts`).to.equal(true);
    }
  });
});
