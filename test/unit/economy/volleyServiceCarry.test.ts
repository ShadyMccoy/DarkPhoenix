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
describe("volleyServiceCarry (drain latency scales with inbound senders)", () => {
  const ONE_VOLLEY = LINK_CAPACITY / CARRY_CAPACITY;

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
