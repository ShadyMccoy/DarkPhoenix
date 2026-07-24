import { expect } from "chai";
import {
  recordLinkFire,
  linkLedger,
  resetLinkMeter,
  LINK_LOSS_RATIO
} from "../../../src/telemetry/LinkMeter";

/**
 * LinkMeter (spec-26 instrument): aggregate every link fire into per-room rates -
 * hub inflow, controller DELIVERY receipt, the cheap-1-hop direct share, and the
 * 3% tax. Rates are counter / (now - sinceTick), the tender-duty-meter pattern.
 */
describe("LinkMeter (link-throughput instrument)", () => {
  beforeEach(resetLinkMeter);
  after(resetLinkMeter);

  it("returns nothing before any fire", () => {
    expect(linkLedger(100)).to.deep.equal([]);
  });

  it("accumulates hub vs controller energy and reports them as rates", () => {
    // window opens at tick 100; 400 to hub + 200 to controller over 100 ticks.
    recordLinkFire("W1N1", "hub", 250, 100);
    recordLinkFire("W1N1", "hub", 150, 120);
    recordLinkFire("W1N1", "controllerRelay", 200, 140);
    const [row] = linkLedger(200);
    expect(row.room).to.equal("W1N1");
    expect(row.windowTicks).to.equal(100);
    expect(row.toHubRate).to.be.closeTo(4, 1e-9); // 400/100
    expect(row.toControllerRate, "the delivery receipt").to.be.closeTo(2, 1e-9); // 200/100
  });

  it("tracks the DIRECT (1-hop) share of controller energy", () => {
    recordLinkFire("W1N1", "controllerDirect", 300, 100); // skipped the hub
    recordLinkFire("W1N1", "controllerRelay", 100, 100); // via the hub
    const [row] = linkLedger(200);
    expect(row.toControllerRate).to.be.closeTo(4, 1e-9); // 400/100
    expect(row.directShare, "300 of 400 controller energy took 1 hop").to.be.closeTo(0.75, 1e-9);
  });

  it("prices the 3% tax across ALL fires (hub + controller)", () => {
    recordLinkFire("W1N1", "hub", 500, 100);
    recordLinkFire("W1N1", "controllerRelay", 500, 100);
    const [row] = linkLedger(200);
    // 1000 total moved * 0.03 / 100 ticks
    expect(row.taxRate).to.be.closeTo((1000 * LINK_LOSS_RATIO) / 100, 1e-9);
    expect(row.directShare).to.equal(0); // none direct
  });

  it("meters rooms independently", () => {
    recordLinkFire("W1N1", "hub", 100, 100);
    recordLinkFire("W2N2", "controllerRelay", 300, 100);
    const rows = linkLedger(200);
    expect(rows).to.have.length(2);
    expect(rows.find(r => r.room === "W1N1")!.toHubRate).to.be.closeTo(1, 1e-9);
    expect(rows.find(r => r.room === "W2N2")!.toControllerRate).to.be.closeTo(3, 1e-9);
  });

  it("ignores non-positive volleys (a blocked/zero fire is not throughput)", () => {
    recordLinkFire("W1N1", "hub", 0, 100);
    recordLinkFire("W1N1", "hub", -5, 100);
    expect(linkLedger(200)).to.deep.equal([]);
  });
});
