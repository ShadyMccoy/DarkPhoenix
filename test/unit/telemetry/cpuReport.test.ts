import { expect } from "chai";
import { CorpCpuLedger, disjointInfra, formatCpuReport } from "../../../src/telemetry/cpuReport";

/**
 * The "commissions" bulkhead wraps corp execution, so its raw time contains
 * corpsTotal. disjointInfra subtracts it so corps and infra don't overlap and
 * the reconciliation whole = corps + Σinfra + unnamed actually holds (before
 * this, the residual went negative on lean ticks and the parts summed above the
 * whole - the bug that surfaced at ~19 CPU/tick).
 */
describe("disjointInfra (no double-count of corps inside commissions)", () => {
  it("subtracts corpsTotal from the commissions bucket, flooring at zero", () => {
    const infra = { commissions: 8.46, telemetry: 5.46, persist: 1.56 };
    const out = disjointInfra(infra, 7.9);
    expect(out.commissions).to.equal(0.56);
    expect(out.telemetry).to.equal(5.46); // other buckets untouched
    expect(out.persist).to.equal(1.56);
  });

  it("floors at zero when corpsTotal exceeds the raw commissions time (meter noise)", () => {
    const out = disjointInfra({ commissions: 7.5 }, 7.9);
    expect(out.commissions).to.equal(0);
  });

  it("is a no-op when there is no commissions bucket", () => {
    const out = disjointInfra({ telemetry: 5.0 }, 3.0);
    expect(out).to.deep.equal({ telemetry: 5.0 });
  });

  it("restores a non-negative reconciliation on a lean tick", () => {
    // The real numbers: whole 19.09, corps 7.90, raw infra sum 15.89 (of which
    // commissions 8.46). Disjointed, corps + infra no longer exceeds whole.
    const disjoint = disjointInfra({ commissions: 8.46, telemetry: 5.46, persist: 1.56, other: 0.41 }, 7.9);
    const infraSum = Object.values(disjoint).reduce((s, v) => s + v, 0);
    const unnamed = 19.09 - 7.9 - infraSum;
    expect(unnamed).to.be.greaterThan(0); // was negative before the fix
  });
});

/**
 * The CPU report is the human-readable surface over the `Memory.corpCpu`
 * ledger (spec 20). Its whole job is the reconciliation — whole-tick CPU split
 * into corps + named infra + the unnamed residual — plus a sorted breakdown.
 * These assertions pin that math and the ordering; the exact prose is not the
 * contract, the numbers are.
 */
describe("CPU report formatter (spec 20 — the missing surface)", () => {
  const full: CorpCpuLedger = {
    tick: 4242,
    corpsTotal: 6.0,
    byKind: { harvest: 3.0, carry: 2.0, upgrade: 1.0 },
    infra: { commissions: 2.0, "spawning-corps": 1.0, persist: 1.0 },
    wholeTick: 10.0, // corps 6 + infra 4 + unnamed 0
    top: [
      { corpId: "harvest-aaa", kind: "harvest", cpu: 1.5, avg: 1.4 },
      { corpId: "carry-bbb", kind: "carry", cpu: 1.0, avg: 0.9 }
    ]
  };

  it("reconciles whole-tick = corps + infra + unnamed", () => {
    // whole 12, corps 6, infra 4 -> unnamed 2.
    const ledger = { ...full, wholeTick: 12.0 };
    const text = formatCpuReport(ledger).join("\n");
    expect(text).to.match(/whole-tick\s+12\.00/);
    expect(text).to.match(/corps\s+6\.00\s+\(\s*50%\)/);
    expect(text).to.match(/infra\s+4\.00\s+\(\s*33%\)/);
    expect(text).to.match(/unnamed\s+2\.00\s+\(\s*17%\)/);
  });

  it("names a zero residual when corps + infra fully account for the tick", () => {
    const text = formatCpuReport(full).join("\n");
    expect(text).to.match(/unnamed\s+0\.00\s+\(\s*0%\)/);
  });

  it("clamps a negative residual to zero (metering overhead can overshoot)", () => {
    // Parts sum to 10 but wholeTick reads 9.9 — the meter cost a hair itself.
    const text = formatCpuReport({ ...full, wholeTick: 9.9 }).join("\n");
    expect(text).to.match(/unnamed\s+0\.00/);
  });

  it("orders kinds and infra buckets by descending CPU", () => {
    const lines = formatCpuReport(full);
    const kindLines = lines.filter(l => /^\s{2}(harvest|carry|upgrade)\s/.test(l));
    expect(kindLines[0]).to.match(/harvest/);
    expect(kindLines[1]).to.match(/carry/);
    expect(kindLines[2]).to.match(/upgrade/);
    const infraLines = lines.filter(l => /^\s{2}(commissions|spawning-corps|persist)\s/.test(l));
    expect(infraLines[0]).to.match(/commissions/); // 2.0 leads
  });

  it("includes the live bucket and limit when given context", () => {
    const text = formatCpuReport(full, { bucket: 9800, limit: 20 }).join("\n");
    expect(text).to.match(/whole-tick\s+10\.00\/20\s+bucket 9\.8k/);
  });

  it("renders a partial capture (no wholeTick/infra) without crashing", () => {
    const partial: CorpCpuLedger = {
      tick: 1,
      corpsTotal: 3.0,
      byKind: { harvest: 3.0 },
      top: []
    };
    const text = formatCpuReport(partial).join("\n");
    // Denominator falls back to the corp+infra sum (3.0), so corps reads 100%.
    expect(text).to.match(/corps\s+3\.00\s+\(100%\)/);
    expect(text).to.match(/partial capture/);
  });

  it("reports the empty ledger explicitly rather than throwing", () => {
    expect(formatCpuReport(undefined)[0]).to.match(/no ledger yet/);
  });
});
