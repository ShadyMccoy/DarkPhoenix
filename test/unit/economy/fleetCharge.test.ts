import { expect } from "chai";
import { convergeFleetCharge } from "../../../src/economy/flowAdapter";

/**
 * THE SPAWN'S FLEET CHARGE IS A FIXED POINT, NOT A SECOND PASS.
 *
 * Production audit 2026-08-01 (t72717545). `discoverSinks` had modelled the
 * spawn's demand as a hardcoded 10 e/t while the plan's own fleet cost ~42, so
 * the shortfall was handed DOWN the value ladder and the controller absorbed
 * it. The fix charged the spawn what the plan's fleet costs - but priced the
 * charge off PASS 1's fleet, a fleet solved with NO charge at all.
 *
 * Measured live: the plan charged 49.45 e/t for a fleet that, once charged,
 * cost 27.65 - a 1.79x over-charge. The sequence 0 -> 49.45 -> 27.65 is
 * OSCILLATING, not converging, which falsified the "pass 2 is a fixed point"
 * argument in the shipped design: the charge and the fleet are MUTUALLY
 * dependent, because routing haulers is what the fill spends its energy on.
 *
 * The contract these tests pin is SELF-CONSISTENCY: the charge that comes back
 * must be (near) the charge the returned plan actually costs. A charge priced
 * off a plan solved under a DIFFERENT charge is exactly the bug.
 */
describe("Spawn fleet charge fixed point (production audit t72717545)", () => {
  /**
   * The measured live response, as a linear model: charging the spawn takes
   * energy away from the fill, which funds fewer hauler routes, which lowers
   * the fleet cost. Anchored on the two observed points - charge 0 -> fleet
   * 49.45, charge 49.45 -> fleet 27.65.
   */
  const SLOPE = (49.45 - 27.65) / 49.45; // 0.4408 e/t of fleet lost per e/t charged
  const measuredFleet = (charge: number): number => Math.max(0, 49.45 - SLOPE * charge);

  it("returns a SELF-CONSISTENT charge on the measured live response", () => {
    const { charge, solved } = convergeFleetCharge(0, measuredFleet(0), measuredFleet, f => f);

    // The true fixed point: c = 49.45 - 0.4408c  =>  c = 34.32.
    expect(charge).to.be.closeTo(34.32, 0.5);
    // ...and the plan handed back is the one solved AT that charge.
    expect(solved).to.be.closeTo(charge, 0.5);
  });

  it("does NOT return the pass-1 fleet cost (the shipped bug)", () => {
    const { charge } = convergeFleetCharge(0, measuredFleet(0), measuredFleet, f => f);
    // 49.45 was the number the live plan charged. It is a 1.44x over-charge
    // against the fleet it produces, and must not survive the iteration.
    expect(charge).to.be.lessThan(49.45 - 5);
    expect(charge).to.be.greaterThan(27.65); // nor the naive pass-2 under-charge
  });

  it("converges on a response that DIVERGES undamped (slope > 1)", () => {
    // A steeper world - each e/t charged costs 2 e/t of fleet. Undamped,
    // C_{n+1} = 60 - 2*C_n runs away (0, 60, -60, 180, ...). Damping is what
    // turns the oscillation into a contraction.
    const steep = (charge: number): number => Math.max(0, 60 - 2 * charge);
    const { charge } = convergeFleetCharge(0, steep(0), steep, f => f);
    expect(charge).to.be.closeTo(20, 3); // fixed point c = 60 - 2c => 20
    expect(charge).to.be.greaterThan(0); // no runaway, no negative charge
  });

  it("stops early - and re-solves NOTHING - when the fleet already matches the charge", () => {
    let solves = 0;
    const { charge } = convergeFleetCharge(
      0,
      0,
      () => {
        solves += 1;
        return 0;
      },
      f => f
    );
    // A colony with no fleet charges nothing, and never pays for a second solve.
    expect(charge).to.equal(0);
    expect(solves).to.equal(0);
  });

  /**
   * SEEDING, measured live t72718367. Starting from 0 on every replan spent the
   * whole pass budget re-deriving a number that barely moves between solves:
   * the capture came back `passes: 4` (the cap) with charge 23.49/spawn against
   * fleetEnergy 50.21 across 2 spawns - 6.4% short, and out of budget. The
   * charge persists in Memory precisely so the next solve starts there.
   */
  it("converges from a SEED where a cold start runs out of passes", () => {
    const cold = convergeFleetCharge(0, measuredFleet(0), measuredFleet, (f: number) => f);
    const warm = convergeFleetCharge(34.32, measuredFleet(34.32), measuredFleet, (f: number) => f);

    // Warm start is already at the fixed point: nothing to do, nothing spent.
    expect(warm.passes).to.equal(0);
    expect(warm.charge).to.be.closeTo(34.32, 0.01);
    // And it never had to iterate at all, unlike the cold start.
    expect(cold.passes).to.be.greaterThan(warm.passes);
  });

  it("hands back the SEED plan untouched when the seed already converged", () => {
    // `solved` undefined is the signal that no pass ran - the caller's own
    // pass-1 plan was solved AT this charge and is already self-consistent.
    // Returning a stale re-solve here would hand back a plan priced at a
    // different charge, which is the original bug in miniature.
    const { solved, passes } = convergeFleetCharge(34.32, measuredFleet(34.32), measuredFleet, (f: number) => f);
    expect(passes).to.equal(0);
    expect(solved).to.equal(undefined);
  });

  it("still moves when the world genuinely changes under a warm seed", () => {
    // A regime change (say the colony gains rooms): the old charge is stale and
    // the iteration must not sit on it just because it was seeded.
    const shifted = (charge: number): number => Math.max(0, 90 - 0.4408 * charge);
    const { charge, passes } = convergeFleetCharge(34.32, shifted(34.32), shifted, (f: number) => f);
    expect(passes).to.be.greaterThan(0);
    expect(charge).to.be.closeTo(90 / 1.4408, 1.5); // the NEW fixed point, 62.5
  });

  it("is bounded - a pathological response can never run the solver away", () => {
    let solves = 0;
    const flapping = (charge: number): number => {
      solves += 1;
      return charge > 25 ? 0 : 100; // discontinuous: no fixed point at all
    };
    convergeFleetCharge(0, flapping(0), flapping, f => f);
    // seed call + at most MAX_PASSES solves. The solve is per-tick CPU; an
    // unbounded loop here is a colony-wide stall, not a mispriced sink.
    expect(solves).to.be.at.most(1 + 4);
  });
});
