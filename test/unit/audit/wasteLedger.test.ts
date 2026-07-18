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

  it("P4's load table includes every fleet class, producers AND consumers", () => {
    const { lines } = planSpawnLoad(cap);
    const names = lines.map(([n]) => n).join("|");
    for (const cls of ["miners", "source-route haulers", "transient-route", "upgraders", "feeder", "tenders", "reservers"]) {
      expect(names).to.contain(cls);
    }
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
