import { expect } from "chai";
import "../../../src/types/Memory";
import { upgraderSizing } from "../../../src/corps/UpgradingCorp";
import { BASE_RESERVE } from "../../../src/economy/bank";

/**
 * WARTIME relegation now happens IN THE PLAN, and the fleet follows it.
 *
 * History worth keeping, because it is the whole argument. Spec 33 relegated
 * the controller sink plan-side when a meaningful construction backlog stood
 * (`wartimeRooms`, flowAdapter). Falsification t72598913 recorded that the
 * plan-side cap was "a PHYSICAL no-op": the controller ran P7 9x, ~18.8 e/t
 * against a relegated plan of ~2, building inched, storage drained below
 * reserve. The conclusion drawn at the time was that the plan could not move
 * energy, so a second, physical lever was added inside the corp - relegate the
 * FLEET off the same backlog lens.
 *
 * The diagnosis was half right. The plan-side cap moved no energy BECAUSE the
 * fleet was sized from work-site stock and ignored the plan entirely. It was
 * not that the plan COULDN'T bind - nothing was reading it.
 *
 * With sizing consolidated behind the plan (owner 2026-08-02), the corp-side
 * lever is redundant by construction: the plan relegates its controller sink on
 * `WARTIME_BACKLOG_THRESHOLD`, the fleet is sized from that allocation, so the
 * fleet relegates. One lens, one place, and the plan-side relegation becomes
 * load-bearing for the first time.
 *
 * THE RISK THIS TAKES ON, stated rather than buried: if the plan's controller
 * sink does not actually relegate under a backlog, building now starves with no
 * second lever to catch it. That is the correct place for the risk to sit - it
 * is one number, in the plan, where it can be audited - but it is a prediction
 * until a wartime window is measured live.
 */
describe("upgrader relegation follows the PLAN (no second lever)", () => {
  const SIP = 2; // ANTI_DOWNGRADE_RESERVE - the controller-alive floor

  it("a relegated plan relegates the fleet, whatever the bank is doing", () => {
    const fat = { bankedBehindFeeder: BASE_RESERVE + 163_513, reserveTarget: BASE_RESERVE };
    // The plan has shifted the controller sink down to the anti-downgrade sip.
    expect(upgraderSizing(SIP, fat).allocated, "fleet follows the relegated plan").to.equal(SIP);
    // ...and a fat bank does NOT re-open the throttle, which is exactly what
    // the removed valve did (it sized off feederRelayRate instead).
    expect(upgraderSizing(SIP, fat).allocated).to.equal(upgraderSizing(SIP).allocated);
  });

  it("the t72598913 shape - bank BELOW reserve, controller-side stock full - also follows the plan", () => {
    // Previously the stock-grounded fleet kept eating link-delivered stock even
    // with surplus false, which is why relegation had to fire off the backlog.
    // There is no stock term left to eat it.
    expect(upgraderSizing(SIP, { bankedBehindFeeder: null, reserveTarget: BASE_RESERVE }).allocated).to.equal(SIP);
  });

  it("clean exit: the plan re-opens, the fleet re-opens with it, same tick", () => {
    expect(upgraderSizing(64, { bankedBehindFeeder: null, reserveTarget: BASE_RESERVE }).allocated).to.equal(64);
  });

  it("a zeroed plan fields ZERO - the anti-downgrade response is the PLAN's danger-gated floor, not a runtime clamp (owner 2026-08-04)", () => {
    // The old pin ("a zeroed plan still keeps the sip") encoded the constant
    // trickle the owner retired: "We don't need it UNLESS the controller is
    // in danger of downgrading... Not the constant trickle." The fleet
    // follows the plan exactly (ONE VALVE); when the downgrade timer runs
    // low the PLAN's floor arms (bank.controllerFloorRate(ticks)) and the
    // allocation - and therefore this sizing - rises to the sip through the
    // normal chain.
    expect(upgraderSizing(0).allocated).to.equal(0);
    expect(upgraderSizing(-5).allocated).to.equal(0); // clamped at zero, never negative
    expect(upgraderSizing(SIP).allocated).to.equal(SIP); // a danger-armed plan flows through unchanged
  });
});
