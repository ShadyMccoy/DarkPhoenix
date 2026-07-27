import { expect } from "chai";
import "../../../src/types/Memory";
import { upgraderSizing } from "../../../src/corps/UpgradingCorp";
import { BASE_RESERVE, feederRelayRate } from "../../../src/economy/bank";
import { sustainableConsumptionRate } from "../../../src/economy/primitives";

/**
 * WARTIME upgrader-FLEET relegation (spec 33, owner "surplus ... normally for
 * upgrading, but now for building"; falsification t72598913).
 *
 * The plan-side controllerRoutingCapacity cap was a PHYSICAL no-op: the
 * controller is fed by the source->core->controller LINK relay, and the
 * upgrader fleet is sized from ACTUAL controller-side stock (which the link
 * keeps full) - so the upgraders burned the surplus regardless of the plan
 * (post-deploy controller ran P7 9x, ~18.8 e/t vs relegated plan ~2, build
 * inched, storage drained below reserve E4 -4067). The PHYSICAL lever: while a
 * MEANINGFUL construction backlog stands, relegate the FLEET itself to the
 * anti-downgrade sip, so it stops eating what the link delivers and the surplus
 * lands in building instead. Floor inviolable (never zeroed); clean exit the
 * moment the backlog drains.
 */
describe("upgraderSizing wartime relegation: the FLEET drops to the anti-downgrade sip", () => {
  const SIP = 2; // ANTI_DOWNGRADE_RESERVE - the controller-alive floor

  it("wartime + surplus + full controller-side stock -> allocated == the sip (not the surplus-eater)", () => {
    const banked = BASE_RESERVE + 163_513; // a fat warchest, in surplus
    const stock = 1607; // controller-side stock the link keeps full
    // Peacetime (no backlog): the surplus-eater scales UP off the stock.
    const peace = upgraderSizing(banked ? banked : 0, stock, banked, BASE_RESERVE, 0, false);
    expect(peace.allocated, "peacetime surplus-eater scales up").to.be.greaterThan(SIP);
    // Wartime: relegated to the sip so the surplus goes to building.
    const war = upgraderSizing(banked, stock, banked, BASE_RESERVE, 0, true);
    expect(war.allocated, "wartime relegates the fleet to the sip").to.equal(SIP);
    // The fleet is no longer a surplus-eater, so the demand does not hold-to-fund it.
    expect(war.surplus, "relegated: not a surplus-eater").to.equal(false);
  });

  it("wartime + BANK BELOW RESERVE but stock still full (the t72598913 shape) -> still relegated", () => {
    // The falsification: the controller mopped the surplus via the link and
    // drained storage BELOW reserve (E4 -4067) - so surplus was FALSE, yet the
    // stock-grounded upgrader kept eating the link-delivered stock. Relegation
    // must still fire off the backlog, or the drain continues.
    const stock = 1607;
    // A plan allocation above the stock draw so the non-surplus path is
    // genuinely stock-driven (not plan-clamped), matching the live shape where
    // the link keeps the controller-side stock full.
    const peace = upgraderSizing(15, stock, null, BASE_RESERVE, 0, false);
    expect(peace.allocated, "peacetime sizes from the standing stock").to.be.closeTo(
      sustainableConsumptionRate(stock, 2),
      1e-9
    );
    expect(peace.allocated, "peacetime stock draw is above the sip").to.be.greaterThan(SIP);
    const war = upgraderSizing(15, stock, null, BASE_RESERVE, 0, true);
    expect(war.allocated, "wartime relegates even below reserve").to.equal(SIP);
  });

  it("clean exit: backlog drained (wartime false) -> reverts to the surplus-eater, no residual relegation", () => {
    const banked = BASE_RESERVE + 446_493;
    const poolAbsorb = 5;
    const share = feederRelayRate(banked, BASE_RESERVE) - poolAbsorb;
    const reverted = upgraderSizing(2, 1607, banked, BASE_RESERVE, poolAbsorb, false);
    expect(reverted.allocated, "exit restores the surplus-eater").to.be.closeTo(
      sustainableConsumptionRate(1607, share),
      1e-9
    );
    expect(reverted.allocated).to.be.greaterThan(SIP);
  });

  it("controller floor inviolable: relegated allocation is the sip, never below", () => {
    const war = upgraderSizing(999, 50_000, BASE_RESERVE + 200_000, BASE_RESERVE, 0, true);
    expect(war.allocated, "relegated but never below the anti-downgrade sip").to.equal(SIP);
    expect(war.allocated).to.be.at.least(SIP);
  });
});
