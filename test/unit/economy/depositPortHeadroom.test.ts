import { expect } from "chai";
import { DEPOSIT_PORT_UNKNOWN_RANGE_FALLBACK, depositPortHeadroom, LINK_CAPACITY, SOURCE_RATE } from "../../../src/economy/primitives";

/**
 * A DEPOSIT PORT ABSORBS WHAT IT CAN FIRE - AND THE FLAT CAP WAS BELOW THAT
 * (owner 2026-08-06, measured t72819265).
 *
 * A port drains by firing to the core, once per `LINK_COOLDOWN * range` ticks,
 * carrying at most `LINK_CAPACITY`. So its physical ceiling is
 * `LINK_CAPACITY / range` e/t, less whatever its OWN adjacent source produces,
 * because that energy lands in the same link.
 *
 * `DEPOSIT_PORT_HEADROOM_CAP = 30` was a flat spec-26 v1 blast-radius bound
 * laid OVER that physics as a `min`. Measured, it was the binding constraint on
 * both live ports and it bound them far below what their links can carry:
 *
 *     port (46,11)  range 14   fires 57.14   own source 10   physics 47.14
 *     port (43,38)  range 13   fires 61.54   own source 10   physics 51.54
 *
 * and the plan routed EXACTLY 30.00 e/t to each - three remote routes apiece,
 * the cap to the decimal - while DEP reported 8 sources (80 e/t) wanting in and
 * the links sat at rho 0.70 / 0.65, nowhere near saturated. **38.68 e/t of
 * deposit flow refused by a constant, while five sources under-delivered 23.2
 * e/t and the colony ran spawn-bound at 0.91x the physical ceiling.** The
 * refused sources walk the long way at ~30 CARRY parts per 10 e/t instead of
 * ~11 - which, when parts are the scarce resource, is not a cost difference but
 * a mined-vs-forgone one.
 *
 * CLAUDE.md: *"the planner prices - it doesn't gate."* The fire rate is a
 * price the physics sets; 30 was a gate. The gate goes.
 *
 * The conservative constant survives in ONE role it is actually right for: the
 * fallback when geometry is unknown (harness paths, no `getRangeTo`). There,
 * guessing high would over-route into a link nobody has measured.
 */
describe("depositPortHeadroom (a port absorbs what it can FIRE - no flat cap)", () => {
  it("is the link's own fire rate, LINK_CAPACITY / range, with no constant laid over it", () => {
    expect(depositPortHeadroom(33, 0)).to.be.closeTo(LINK_CAPACITY / 33, 1e-9);
    expect(depositPortHeadroom(5, 0)).to.be.closeTo(LINK_CAPACITY / 5, 1e-9);
  });

  it("a FAST link is no longer clipped to 30 - the regression the live colony was paying", () => {
    // range 5 fires 160 e/t. The old cap returned 30 and threw away 130.
    expect(depositPortHeadroom(5, 0)).to.equal(160);
    expect(depositPortHeadroom(5, SOURCE_RATE)).to.equal(150);
  });

  it("subtracts the port's OWN source first - that energy lands in the same link", () => {
    // range 22: fires 36.36; a 10 e/t source beside it leaves 26.36 for deposits.
    expect(depositPortHeadroom(22, SOURCE_RATE)).to.be.closeTo(LINK_CAPACITY / 22 - SOURCE_RATE, 1e-9);
  });

  it("reproduces THE TWO LIVE PORTS at their physics, not at the cap (t72819265)", () => {
    // Both were pinned at 30.00 by the constant; these are what they can carry.
    expect(depositPortHeadroom(14, SOURCE_RATE)).to.be.closeTo(LINK_CAPACITY / 14 - SOURCE_RATE, 1e-9);
    expect(depositPortHeadroom(13, SOURCE_RATE)).to.be.closeTo(LINK_CAPACITY / 13 - SOURCE_RATE, 1e-9);
    // The unlock: 17.14 + 21.54 = 38.68 e/t of deposit routing the cap refused.
    const unlocked = depositPortHeadroom(14, SOURCE_RATE) - 30 + (depositPortHeadroom(13, SOURCE_RATE) - 30);
    expect(unlocked).to.be.closeTo(38.68, 0.01);
  });

  it("a FAR port is still bounded by its own physics - the far edge is genuinely worse", () => {
    // range 33 fires 24.24: routing the old flat 30 there was a permanent
    // backlog by construction (rho 1.24), and that half of the rule was right.
    expect(depositPortHeadroom(33, 0)).to.be.lessThan(30);
  });

  it("never goes negative: a port whose own source outruns its fire rate takes NOTHING", () => {
    // range 100 fires 8 e/t; a 10 e/t source alone already over-fills it.
    expect(depositPortHeadroom(100, SOURCE_RATE)).to.equal(0);
  });

  it("an UNKNOWN range falls back to the conservative constant, never to the physics", () => {
    // No geometry = no fire rate to compute. Guessing high would over-route
    // into an unmeasured link, which is the one failure the cap did prevent.
    expect(depositPortHeadroom(undefined, 0)).to.equal(DEPOSIT_PORT_UNKNOWN_RANGE_FALLBACK);
    expect(DEPOSIT_PORT_UNKNOWN_RANGE_FALLBACK).to.equal(30);
  });

  it("is monotone decreasing in range - farther is strictly worse, no cliffs", () => {
    let prev = Infinity;
    for (let r = 1; r <= 40; r++) {
      const h = depositPortHeadroom(r, SOURCE_RATE);
      expect(h, `range ${r} must not exceed range ${r - 1}`).to.be.at.most(prev + 1e-9);
      prev = h;
    }
  });
});
