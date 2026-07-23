import { expect } from "chai";
import {
  pickRenewTarget,
  renewTicksGained,
  RenewCandidate
} from "../../../src/execution/SpawnDirector";
import { deliveryLeadTime } from "../../../src/economy/primitives";

/**
 * Spare-spawn-capacity renew (owner 2026-07-23: "the spawn could renewCreep on
 * the feeder adjacent to it when it has spare spawn capacity to help smooth out
 * the schedule"). These pin the PURE decision - which adjacent creep an idle
 * spawn renews - so the Game-touching wrapper stays a thin shell. Renew is
 * energy-parity with respawning (cost/1500 per tick) spent on idle spawn-ticks;
 * the decision is only about WHICH standing post to top up, never whether it is
 * affordable (the wrapper's full-room gate owns that).
 */

/** A body big enough that its staffing band is comfortably below the 1500 cap. */
const SIZE = 16; // e.g. an 8C/8M tender; leadTime(16, 0) = 58, increment = 37

function candidate(overrides: Partial<RenewCandidate>): RenewCandidate {
  return {
    ticksToLive: 800,
    bodySize: SIZE,
    hasClaim: false,
    recycling: false,
    ...overrides
  };
}

describe("renewTicksGained (engine renew increment, floor(600/size))", () => {
  it("matches the engine formula across body sizes", () => {
    expect(renewTicksGained(16)).to.equal(37); // floor(600/16)
    expect(renewTicksGained(50)).to.equal(12); // a maxed body: fine granularity
    expect(renewTicksGained(3)).to.equal(200); // a tiny body: coarse chunks
  });

  it("is zero for a degenerate empty body (never divide by zero)", () => {
    expect(renewTicksGained(0)).to.equal(0);
    expect(renewTicksGained(-5)).to.equal(0);
  });
});

describe("pickRenewTarget (which adjacent creep an idle spawn renews)", () => {
  it("returns null with no adjacent creeps", () => {
    expect(pickRenewTarget([])).to.equal(null);
  });

  it("renews an eligible standing post mid-life", () => {
    expect(pickRenewTarget([candidate({ ticksToLive: 800 })])).to.equal(0);
  });

  it("skips a still-spawning creep (undefined ttl cannot renew)", () => {
    expect(pickRenewTarget([candidate({ ticksToLive: undefined })])).to.equal(null);
  });

  it("never renews a CLAIM body (the engine forbids it)", () => {
    expect(pickRenewTarget([candidate({ hasClaim: true })])).to.equal(null);
  });

  it("never renews a creep flagged for recycling (keep-a-runt-alive trap)", () => {
    // A sub-max runt walking to the spawn to die so a full-size replacement can
    // spawn sits adjacent - exactly the tempting-but-wrong target.
    expect(pickRenewTarget([candidate({ recycling: true, ticksToLive: 50 })])).to.equal(null);
  });

  it("does not renew a near-max creep (no room for a whole increment)", () => {
    // increment = 37; 1500 - 37 = 1463 is the last renewable ttl.
    expect(pickRenewTarget([candidate({ ticksToLive: 1464 })])).to.equal(null);
    expect(pickRenewTarget([candidate({ ticksToLive: 1463 })])).to.equal(0);
  });

  it("lets an incumbent past its staffing band die instead of doubling it", () => {
    // staffsPost symmetry: once ttl <= deliveryLeadTime a successor is being
    // ordered by the demand side; renewing here would field a standing double.
    const lead = deliveryLeadTime(SIZE, 0);
    expect(pickRenewTarget([candidate({ ticksToLive: lead })])).to.equal(null);
    expect(pickRenewTarget([candidate({ ticksToLive: lead + 1 })])).to.equal(0);
  });

  it("renews the MOST URGENT (lowest ttl) eligible creep", () => {
    expect(
      pickRenewTarget([
        candidate({ ticksToLive: 900 }),
        candidate({ ticksToLive: 300 }),
        candidate({ ticksToLive: 1200 })
      ])
    ).to.equal(1);
  });

  it("breaks ttl ties to the lower index (determinism)", () => {
    expect(
      pickRenewTarget([candidate({ ticksToLive: 500 }), candidate({ ticksToLive: 500 })])
    ).to.equal(0);
  });

  it("skips ineligible creeps to renew a lower-priority eligible one", () => {
    // The most urgent is recycling (skip); the healthy tender is renewed.
    expect(
      pickRenewTarget([
        candidate({ ticksToLive: 40, recycling: true }),
        candidate({ ticksToLive: 700 })
      ])
    ).to.equal(1);
  });
});
