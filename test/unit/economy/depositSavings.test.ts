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
