import { expect } from "chai";
import {
  CREEP_LIFETIME,
  PLAN_BUDGET_INTERVAL,
  isPlanBudgetBoundary
} from "../../../src/economy/primitives";

/**
 * SPEC 46 PHASE A - the month IS the budget's term (owner 2026-08-05: "we
 * take the budget/plan and we use that for the next fiscal month... to avoid
 * thrashing and provide clarity in reporting. It's kind of setting the plan
 * solving from 50 to 1500 effectively").
 *
 * The measured thrash this ends: d017 flapped funded -> over-budget ->
 * funded across CONSECUTIVE solves at t72801208/t72801354 - a route exactly
 * at the tranche edge re-decided ~30x per fiscal month on solve-to-solve
 * noise in other candidates' parts estimates. The budget now spans exactly
 * the fiscal month the close measures (1500t = CREEP_LIFETIME, the horizon
 * every body purchase amortizes over - so a budget covers exactly the period
 * its purchases are expensed across).
 *
 * The interval is the FLOOR on scheduled re-planning, never a gate on
 * transitions: execution/planTriggers still forces a replan on any durable
 * world change (hostile flip, expansion step, RCL-up, spawn census), and the
 * anti-downgrade reserve pre-pass is not calendar-gated. This is a CADENCE,
 * not a freeze.
 */
describe("spec 46: the fiscal month is the plan's budget term", () => {
  it("the budget interval IS the fiscal month, derived from CREEP_LIFETIME - never a second constant", () => {
    // The fiscal calendar (spec 41) and the amortization horizon are the same
    // number by design; re-deriving it here would let the two drift.
    expect(PLAN_BUDGET_INTERVAL).to.equal(CREEP_LIFETIME);
    expect(PLAN_BUDGET_INTERVAL).to.equal(1500);
  });

  it("fires on fiscal month boundaries and nowhere else (the close's window is the budget's window)", () => {
    expect(isPlanBudgetBoundary(0)).to.equal(true);
    expect(isPlanBudgetBoundary(1500)).to.equal(true);
    expect(isPlanBudgetBoundary(72_801_000)).to.equal(true); // a live month boundary
    expect(isPlanBudgetBoundary(1)).to.equal(false);
    expect(isPlanBudgetBoundary(1499)).to.equal(false);
    expect(isPlanBudgetBoundary(72_801_354)).to.equal(false); // mid-month capture
  });

  it("is 30x SLOWER than the old 50-tick cadence - the thrash the owner named", () => {
    // The old governor cadence re-decided the funded set ~30 times per
    // fiscal close; every re-decision is a chance for a boundary route to
    // flip (P1's business) and for the close's BUDGET column to describe a
    // different plan than the one that ran.
    expect(PLAN_BUDGET_INTERVAL / 50).to.equal(30);
  });
});
