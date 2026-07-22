/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { UPGRADE_METER_WINDOW, tallyUpgradeAttempt } from "../../../src/corps/UpgradingCorp";

/**
 * The WORK-utilization meter (prod t72482220): 100 WORK stood at both window
 * endpoints with the stock endpoint full, yet burn averaged 48.7 of ~100 e/t
 * - whether the missing half was a supply gap (starved buffers mid-window)
 * or idling was UNMEASURABLE from endpoint reads. The meter tallies at the
 * upgradeController call site: fired on OK, dry on ERR_NOT_ENOUGH_RESOURCES.
 * The sizing stamp's workUtil/dryShare read this window verbatim.
 */
describe("tallyUpgradeAttempt (upgrade WORK-utilization meter)", () => {
  const OK_RC = 0;
  const DRY_RC = -6;

  beforeEach(() => {
    (global as any).OK = OK_RC;
    (global as any).ERR_NOT_ENOUGH_RESOURCES = DRY_RC;
  });

  it("tallies fired vs dry creep-ticks (the incident's invisible half, named)", () => {
    const meter: any = {};
    // 5 upgraders for 2 ticks: half fired, half starved - the t72482220 shape.
    for (let t = 100; t < 102; t++) {
      for (let c = 0; c < 5; c++) tallyUpgradeAttempt(meter, "W43N23", t, c < 2 || t === 100 ? OK_RC : DRY_RC);
    }
    const w = meter.W43N23;
    expect(w.ticks).to.equal(10);
    expect(w.fired + w.dry).to.equal(10);
    expect(w.dry, "starved ticks are named, not hidden").to.be.greaterThan(0);
  });

  it("other errors (out of range mid-walk etc.) count the tick but neither bucket", () => {
    const meter: any = {};
    tallyUpgradeAttempt(meter, "W43N23", 100, -9);
    expect(meter.W43N23).to.deep.include({ ticks: 1, fired: 0, dry: 0 });
  });

  it("rolls the window after UPGRADE_METER_WINDOW ticks (spawn-meter cadence)", () => {
    const meter: any = {};
    tallyUpgradeAttempt(meter, "W43N23", 100, OK_RC);
    tallyUpgradeAttempt(meter, "W43N23", 100 + UPGRADE_METER_WINDOW, DRY_RC);
    expect(meter.W43N23, "fresh window, old counts dropped").to.deep.equal({
      t0: 100 + UPGRADE_METER_WINDOW,
      ticks: 1,
      fired: 0,
      dry: 1
    });
  });

  it("meters rooms independently", () => {
    const meter: any = {};
    tallyUpgradeAttempt(meter, "W43N23", 100, OK_RC);
    tallyUpgradeAttempt(meter, "W1N1", 100, DRY_RC);
    expect(meter.W43N23.fired).to.equal(1);
    expect(meter.W1N1.dry).to.equal(1);
  });
});
