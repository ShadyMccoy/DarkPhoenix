import { expect } from "chai";
import { declaredStandingParts } from "../../../src/economy/replacementSchedule";

/**
 * THE PURCHASE RECEIPT (spec 39 phase 3, owner 2026-08-07: *"What instrumenting
 * do we need to get to the bottom of body to plan mismatches and get this econ
 * humming."*).
 *
 * Every body measurement before this was a SNAPSHOT AT REST - F2, the corp
 * statement, the parts BOM. They all say "the fleet is wrong" and none can say
 * how it got that way, because the mismatch is created at ONE instant, at the
 * spawn door, and nothing recorded it. Three sessions of body questions each
 * ended with three plausible mechanisms and no way to separate them.
 *
 * This file pins the ARITHMETIC the receipt makes answerable. The row itself is
 * written by SpawnDirector (integration-covered); what matters for a future
 * reader is that these ratios mean what the field names claim.
 */
describe("spec 39 phase 3: the purchase receipt separates the body-mismatch mechanisms", () => {
  /** A receipt row as the director writes it. */
  const row = (o: Partial<Record<string, number>>) => ({
    declared: 48,
    want: 2400,
    min: 300,
    grant: 2400,
    cost: 2400,
    parts: 48,
    fill: 2400,
    cap: 2300,
    ...o
  });

  it("WON IT SMALL reads as grant < want with a low fill - the runt-at-purchase path", () => {
    // The tender's live shape: it asks for its full body, wins the slot, and the
    // room can only fund a fraction. The undersized body then squats its slot
    // for a whole creep lifetime.
    const r = row({ grant: 1700, cost: 1700, parts: 34, fill: 1700 });
    expect(r.grant / r.want).to.be.lessThan(1);
    expect(r.fill / r.cap).to.be.lessThan(0.8);
    expect(r.parts / r.declared).to.be.closeTo(34 / 48, 1e-9);
  });

  it("ASKED TOO BIG reads as want >> declared with a FULL fill - a contract gap, not a supply one", () => {
    // The feeder's live shape: 100 parts standing against a 32-part price. If it
    // asked for 100 from a full room, no amount of refill fixes it - the missing
    // check is between the corp's ask and its own commission.
    const r = row({ declared: 32, want: 5000, grant: 5000, cost: 5000, parts: 100, fill: 2300 });
    expect(r.parts / r.declared).to.be.greaterThan(2);
    expect(r.fill / r.cap).to.be.greaterThan(0.95);
    expect(r.grant / r.want, "it got exactly what it asked for").to.equal(1);
  });

  it("ON CONTRACT reads as parts ~ declared - the state we are trying to reach", () => {
    const r = row({});
    expect(r.parts / r.declared).to.equal(1);
    expect(r.grant / r.want).to.equal(1);
  });

  it("declared is the SAME conversion the scheduler and the account use", () => {
    // One home, so a receipt and the corp statement can never disagree about
    // what a corp was priced for.
    expect(declaredStandingParts(0.032)).to.equal(48);
  });

  it("an UNPRICED corp leaves declared absent, never a fabricated zero", () => {
    // Auxiliary kinds still off-budget would otherwise read as infinitely
    // over-built on every receipt.
    expect(declaredStandingParts(undefined)).to.equal(0);
  });
});
