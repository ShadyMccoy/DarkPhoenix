import { expect } from "chai";
import { DEPOSIT_PORT_HEADROOM_CAP, depositPortHeadroom, LINK_CAPACITY, SOURCE_RATE } from "../../../src/economy/primitives";

/**
 * A DEPOSIT PORT CANNOT ABSORB MORE THAN IT CAN FIRE (owner 2026-08-06:
 * *"let's build the edge links"*).
 *
 * A port drains by firing to the core, once per `LINK_COOLDOWN * range` ticks,
 * carrying at most `LINK_CAPACITY`. So its physical ceiling is
 * `LINK_CAPACITY / range` e/t — and whatever its OWN adjacent source produces
 * comes off that first, because that energy lands in the same link.
 *
 * The old `DEPOSIT_PORT_HEADROOM = 30` was a flat constant. It happens to be
 * safe for the two ports we have (measured t72811683: PORT A at range 14 fires
 * 57.1 e/t and carries 30 + 10 = 40, rho 0.70; PORT B at range 13 fires 61.5
 * and carries 40, rho 0.65 — both inside the buffer band). It is NOT safe for
 * the edge links the owner wants to add:
 *
 *     edge (47,25)  range 12  fires 66.7   30 routed -> rho 0.45   fine
 *     edge (25,47)  range 22  fires 36.4   30 routed -> rho 0.82   marginal
 *     edge ( 2,25)  range 33  fires 24.2   30 routed -> rho 1.24   SATURATED
 *
 * A port on the far side of the room from the core would be routed 30 e/t into
 * something that can only move 24.2 — a permanent backlog by construction, and
 * the `rho >= 1.0` band where no buffer helps (spec 47's sizing law: a buffer
 * fixes burstiness, never a rate deficit).
 */
describe("depositPortHeadroom (a port cannot absorb more than it can fire)", () => {
  it("is bounded by the link's own fire rate, LINK_CAPACITY / range", () => {
    // range 33: 800/33 = 24.24 e/t of fire, no adjacent source.
    expect(depositPortHeadroom(33, 0)).to.be.closeTo(LINK_CAPACITY / 33, 1e-9);
    expect(depositPortHeadroom(33, 0)).to.be.lessThan(DEPOSIT_PORT_HEADROOM_CAP);
  });

  it("subtracts the port's OWN source first - that energy lands in the same link", () => {
    // range 22: fires 36.36; a 10 e/t source beside it leaves 26.36 for deposits.
    expect(depositPortHeadroom(22, SOURCE_RATE)).to.be.closeTo(LINK_CAPACITY / 22 - SOURCE_RATE, 1e-9);
  });

  it("still honours the conservative v1 CAP when the link is fast enough", () => {
    // range 5 fires 160 e/t - far above the cap, which is the blast-radius
    // bound the spec-26 v1 port was given and this change does not relax.
    expect(depositPortHeadroom(5, 0)).to.equal(DEPOSIT_PORT_HEADROOM_CAP);
    expect(depositPortHeadroom(5, SOURCE_RATE)).to.equal(DEPOSIT_PORT_HEADROOM_CAP);
  });

  it("reproduces the two LIVE ports unchanged - this must not move what works", () => {
    // PORT A range 14 -> 57.1 fire, minus its 10 source = 47.1, capped at 30.
    expect(depositPortHeadroom(14, SOURCE_RATE)).to.equal(DEPOSIT_PORT_HEADROOM_CAP);
    // PORT B range 13 -> 61.5, minus 10 = 51.5, capped at 30.
    expect(depositPortHeadroom(13, SOURCE_RATE)).to.equal(DEPOSIT_PORT_HEADROOM_CAP);
  });

  it("never goes negative: a port whose own source outruns its fire rate takes NOTHING", () => {
    // range 100 fires 8 e/t; a 10 e/t source alone already over-fills it.
    expect(depositPortHeadroom(100, SOURCE_RATE)).to.equal(0);
  });

  it("an unknown range falls back to the cap (harness / no geometry)", () => {
    expect(depositPortHeadroom(undefined, 0)).to.equal(DEPOSIT_PORT_HEADROOM_CAP);
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
