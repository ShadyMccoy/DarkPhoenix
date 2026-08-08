import { expect } from "chai";
import { computeDepositSavings, DepositSource, DepositLink } from "../../../src/economy/depositSavings";
import { Position } from "../../../src/types/Position";

/**
 * Deposit-side instrument (spec-26 stage 4): for each remote source, the nearest
 * deposit-capable home-room link and the route a hauler would save by dropping
 * there instead of walking to storage. Read-only measurement; the caller passes
 * ONLY links that fire to the core (never the terminal controller link).
 */
describe("computeDepositSavings (deposit-side link instrument)", () => {
  // Simple global-coordinate Chebyshev so the test geometry is legible.
  const dist = (a: Position, b: Position): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const at = (x: number): Position => ({ x, y: 0, roomName: "W1N1" });

  const src = (id: string, x: number, flowRate: number, haulDist: number): DepositSource => ({
    id,
    pos: at(x),
    flowRate,
    haulDist
  });
  const link = (id: string, x: number): DepositLink => ({ id, pos: at(x) });

  it("flags a source whose nearest deposit link is meaningfully closer than storage", () => {
    // storage is far (haulDist 40); a link at x=25 is 15 tiles from the source at x=10.
    const report = computeDepositSavings([src("remote", 10, 10, 40)], [link("gw", 25)], dist);
    expect(report.candidates).to.have.length(1);
    const c = report.candidates[0];
    expect(c.linkId).to.equal("gw");
    expect(c.linkDist).to.equal(15); // |10-25|
    expect(c.saving, "40 haul - 15 to the link").to.equal(25);
  });

  /**
   * THE INSTRUMENT MUST BE ABLE TO ANSWER ITS OWN QUESTION (audit t72860894).
   *
   * `computeDepositSavings`'s docblock says it aggregates per-link flow *"so an
   * over-subscribed link is visible before we route to it"* - but it published
   * `depositFlow` with no HEADROOM to divide by, so over-subscription was not
   * computable from a capture. That mattered: at t72860894 all 8 port-routed
   * remote sources were backed up (buffers 1930-4623, miners gated, heldFrac up
   * to 1.00) while all 4 non-port sources were clear (<=1017, heldFrac 0.00),
   * and the confound was excluded - the NEAREST port source (d=32) was the worst
   * gated, a far NON-port source (d=77) completely clean. Each link carried
   * exactly 40.0 e/t across 4 routes. Whether that is rho 1.00 (saturation, and
   * the queue is then structural) or rho 0.7 (and the cause is elsewhere) was
   * the one number the capture could not answer.
   *
   * `depositPortHeadroom` is the SAME primitive the planner sizes ports with, so
   * this is one derivation with two readers, never a second book.
   */
  it("publishes each link's HEADROOM and rho, so over-subscription is readable", () => {
    // Two sources at 10 e/t onto one link whose headroom is 15 e/t: rho 1.33.
    const report = computeDepositSavings(
      [src("a", 10, 10, 40), src("b", 12, 10, 40)],
      [{ id: "gw", pos: at(25), headroom: 15 }],
      dist
    );
    const load = report.perLink.find(l => l.linkId === "gw")!;
    expect(load.depositFlow).to.equal(20);
    expect(load.sources).to.equal(2);
    expect(load.headroom, "the port's own fire-rate budget").to.equal(15);
    expect(load.rho, "20 e/t routed into a 15 e/t port is 1.33x over-subscribed").to.be.closeTo(20 / 15, 1e-9);
  });

  it("omits rho when the caller cannot supply a headroom, rather than inventing one", () => {
    // A harness with no geometry must read ABSENT, never a flattering 0.
    const report = computeDepositSavings([src("a", 10, 10, 40)], [link("gw", 25)], dist);
    const load = report.perLink.find(l => l.linkId === "gw")!;
    expect(load.depositFlow).to.equal(10);
    expect(load.headroom).to.equal(undefined);
    expect(load.rho).to.equal(undefined);
  });

  it("picks the NEAREST deposit link when several exist", () => {
    const report = computeDepositSavings([src("remote", 10, 10, 40)], [link("far", 30), link("near", 18)], dist);
    expect(report.candidates[0].linkId).to.equal("near");
    expect(report.candidates[0].saving).to.equal(32); // 40 - 8
  });

  it("does NOT flag a source when no link beats storage by minSaving", () => {
    // link is only 3 tiles closer than storage - below the default minSaving (5).
    const report = computeDepositSavings([src("close", 10, 10, 12)], [link("gw", 19)], dist);
    expect(report.candidates).to.have.length(0);
    expect(report.perLink).to.have.length(0);
  });

  it("aggregates deposit flow per link (the throughput the owner flagged)", () => {
    const report = computeDepositSavings(
      [src("a", 10, 12, 40), src("b", 12, 8, 42), src("c", 60, 6, 40)],
      [link("gw", 25), link("gw2", 55)],
      dist
    );
    const gw = report.perLink.find(l => l.linkId === "gw")!;
    expect(gw.depositFlow, "a(12) + b(8) both nearest gw").to.equal(20);
    expect(gw.sources).to.equal(2);
    const gw2 = report.perLink.find(l => l.linkId === "gw2")!;
    expect(gw2.depositFlow).to.equal(6); // c
  });

  it("returns nothing when there are no links", () => {
    const report = computeDepositSavings([src("remote", 10, 10, 40)], [], dist);
    expect(report.candidates).to.deep.equal([]);
    expect(report.perLink).to.deep.equal([]);
  });
});
