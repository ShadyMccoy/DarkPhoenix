import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { computeLedger, planSpawnLoad } from "../../../scripts/waste-ledger";

const fixture = (name: string): any =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", "telemetry", name), "utf8"));
const cap72411542 = fixture("shard1-t72411542.json");
const cap72404213 = fixture("shard1-t72404213.json");

/**
 * Spec 15 phase 1 acceptance: the ledger reproduces the 2026-07-18 known
 * numbers from the committed fixtures. These pins are the audit auditing
 * itself - the owner findings of that day (plan spawn-infeasibility, reserver
 * duty drift) must be caught by the LEDGER from a capture, never again only
 * by an owner question.
 */
describe("waste ledger (spec 15 phase 1)", () => {
  const cap: any = cap72411542;
  const base: any = cap72404213;
  const rows = computeLedger(cap, base);
  const row = (id: string) => rows.find(r => r.id === id)!;

  it("P4 catches the spawn-infeasible plan (the 2026-07-18 owner finding)", () => {
    const p4 = row("P4");
    expect(p4.verdict).to.equal("FAIL");
    expect(p4.value).to.be.greaterThan(1.2); // measured 1.32x ceiling at t72411542
    expect(p4.detail).to.contain("unbudgeted"); // the transient-route line the mining budget never prices
  });

  it("P4 does NOT fail a budget-dry plan on recompute noise (the fill stops AT the ceiling by design)", () => {
    // t72420007: the P4 fill ran to budget-dry (its components sum to the
    // capacity exactly); the script's independent recompute drifted +0.0002
    // and tripped strict >1.0 - a false red that would persist at every
    // equilibrium. Within 0.5% of the ceiling is arithmetic, not a leak
    // (the smallest real fleet class is ~3% of ceiling).
    const capBoundary = fixture("shard1-t72420007.json");
    const rows2 = computeLedger(capBoundary, fixture("shard1-t72419708.json"));
    const p4 = rows2.find(r => r.id === "P4")!;
    expect(p4.value).to.be.greaterThan(0.99); // the boundary shape, not a slack plan
    expect(p4.verdict).to.equal("WARN"); // hot, worth watching - but not a FAIL
  });

  it("P4's load table includes every fleet class, producers AND consumers", () => {
    const { lines } = planSpawnLoad(cap);
    const names = lines.map(([n]) => n).join("|");
    for (const cls of ["miners", "source-route haulers", "transient-route", "upgraders", "feeder", "tenders", "reservers"]) {
      expect(names).to.contain(cls);
    }
  });

  it("P6 measures per-room reservation PUMP from the bank stamps (reservers not reserving)", () => {
    // t72420978 -> t72421124 (owner marathon directive): stamp-window dt=156,
    // pump_r = bank2 - (bank1 - dt). Two of four needy rooms saw ZERO pump
    // with claim parts fielded - the one-way-violation churn, measurable.
    const rows2 = computeLedger(fixture("shard1-t72421124.json"), fixture("shard1-t72420978.json"));
    const p6 = rows2.find(r => r.id === "P6")!;
    expect(p6.verdict).to.equal("WARN"); // >= half the rooms pumped nothing while staffed
    expect(p6.detail).to.contain("W43N24:0");
    expect(p6.detail).to.contain("W42N23:66");
  });

  it("P7 does not fail a window whose plan legitimately dropped (construction preempt)", () => {
    // Same pair: allocation fell 86.3 -> 2.0 by doctrine; actual 14.35 e/t is
    // the old upgraders burning residual stock - MORE than the surviving
    // plan asks. Compare against the LOWER endpoint plan: ok, not a failure.
    const rows2 = computeLedger(fixture("shard1-t72421124.json"), fixture("shard1-t72420978.json"));
    const p7 = rows2.find(r => r.id === "P7")!;
    expect(p7.verdict).to.equal("ok");
    expect(p7.value).to.be.greaterThan(1); // actual over the (floored) plan
  });

  it("P7 FAILS when a STABLE plan goes undelivered with stock standing (upgraders not upgrading)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    // stable plan 86.3 both ends, stock present both ends, actual ~2 e/t
    capA.data.flow.sinks.find((s: any) => s.type === "controller").allocated = 86.3;
    capA.data.core.rooms[0].rclProgress = capB.data.core.rooms[0].rclProgress + 300; // 300/146t ~ 2 e/t
    const rows2 = computeLedger(capA, capB);
    const p7 = rows2.find(r => r.id === "P7")!;
    expect(p7.verdict).to.equal("FAIL");
    expect(p7.detail).to.contain("stock"); // the discriminator: energy WAS there
  });

  it("P8 skips gracefully when captures predate the site fields (no row)", () => {
    const rows2 = computeLedger(fixture("shard1-t72421124.json"), fixture("shard1-t72420978.json"));
    expect(rows2.find(r => r.id === "P8")).to.equal(undefined);
  });

  it("P8 FAILS a flat-progress window with sites standing and construction funded (builders not building)", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 500, siteTotal: 5000 });
    // fund construction at BOTH endpoints (t72421124 already carries 90.1)
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 90 });
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict).to.equal("FAIL");
    expect(p8.detail).to.contain("CREW IDLE");
  });

  it("P8 treats a completion window as ambiguous, never a failure", () => {
    const capB: any = JSON.parse(JSON.stringify(fixture("shard1-t72420978.json")));
    const capA: any = JSON.parse(JSON.stringify(fixture("shard1-t72421124.json")));
    Object.assign(capB.data.core.rooms[0], { siteCount: 2, siteProgress: 2900, siteTotal: 8000 });
    Object.assign(capA.data.core.rooms[0], { siteCount: 1, siteProgress: 100, siteTotal: 5000 });
    capB.data.flow.sinks.push({ id: "construction-x", type: "construction", allocated: 90 });
    const p8 = computeLedger(capA, capB).find(r => r.id === "P8")!;
    expect(p8.verdict).to.equal("ok");
    expect(p8.detail).to.contain("completion window");
  });

  it("P5 flags the reserver duty price/behavior drift until the corp reads the reservation bank", () => {
    const p5 = row("P5");
    expect(p5.verdict).to.equal("FAIL");
    expect(p5.detail).to.contain("ticksToEnd");
  });

  it("E4 flags idle capital while the bank is not draining", () => {
    const e4 = row("E4");
    expect(e4.verdict).to.equal("FAIL"); // 601k above target, slope +2.21/t
    expect(e4.value).to.be.greaterThan(500_000);
  });

  it("E2 catches stranded haulers serving routes absent from the plan", () => {
    const e2 = row("E2");
    expect(e2.value).to.be.greaterThan(20); // measured 48 parts across 3 scavenge corps at t72411542
    expect(e2.verdict).to.not.equal("ok");
  });

  it("S3 discriminates a funding hold from a stall (idle spawn, UNaffordable head)", () => {
    const s3 = row("S3");
    expect(s3.verdict).to.equal("ok"); // head reserver@1300 vs bank 1250: holding, not stalled
    expect(s3.detail).to.contain("not a stall");
  });

  it("ranks FAIL lines first and names the top line as the cycle's work item", () => {
    expect(rows[0].verdict).to.equal("FAIL");
    const firstOk = rows.findIndex(r => r.verdict === "ok");
    const lastFail = rows.map(r => r.verdict).lastIndexOf("FAIL");
    expect(lastFail).to.be.lessThan(firstOk === -1 ? rows.length : firstOk);
  });
});
