import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  ARCHIVE_SEGMENTS,
  BYTE_BUDGET,
  MAX_RECORDS,
  getArchive,
  onTick,
  pruneToRecord,
  resetFiscalArchive,
  shard,
  takeIfPending
} from "../../../src/telemetry/fiscalArchive";
import { armSweep, disarmSweep } from "../../../src/telemetry/fiscalArchive";
import { RawMemory as MockRawMemory, setupGlobals } from "../mock";
import { TELEMETRY_SEGMENTS } from "../../../src/telemetry/segmentIds";
import { computeLedger, formatAccounts } from "../../../scripts/waste-ledger";
import { mergeShards, rehydrate } from "../../../scripts/fiscal-archive";

const FIXTURES = path.join(__dirname, "..", "..", "fixtures", "telemetry");
const load = (tick: string): any => JSON.parse(fs.readFileSync(path.join(FIXTURES, `shard1-t${tick}.json`), "utf8"));

/**
 * THE FISCAL ARCHIVE (spec 45). The bot snapshots its own month boundaries so an
 * UNATTENDED fiscal period is still closeable - the precondition for the
 * handicap sweep, which runs 21 months with nobody capturing (owner 2026-08-06:
 * "I want to make sure all those income statements will be recoverable by the
 * end ... I don't want to re-deploy or monitor from here").
 */
describe("fiscal archive", () => {
  beforeEach(() => {
    setupGlobals();
    // setupGlobals does not publish RawMemory (no segment writer needed one
    // before now) - the archive both writes and reads segments, so wire it.
    (global as any).RawMemory = MockRawMemory;
    MockRawMemory.segments = {};
    resetFiscalArchive();
    disarmSweep();
  });
  afterEach(() => disarmSweep());

  describe("the boundary hook", () => {
    it("marks a snapshot owed on a month boundary and ignores every other tick", () => {
      onTick(72_823_437, {});
      expect(getArchive().pending).to.equal(undefined);
      onTick(72_823_500, {});
      expect(getArchive().pending).to.equal(72_823_500);
    });

    it("advances the sweep at the boundary - one hook drives both", () => {
      armSweep(3);
      onTick(1500, {});
      expect((Memory as any).spawnSweep.pct).to.equal(4);
    });

    it("a record's pct is the month AHEAD of it, and the close reads the OPENING one", () => {
      // The hook steps the sweep BEFORE snapshotting, so the month [B, B+1500)
      // runs at the pct stamped on B's record - not on B+1500's. A close that
      // read the closing record would label every income statement with the
      // NEXT month's handicap, and the sweep would measure a shifted curve
      // that still looked entirely plausible.
      MockRawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify({ tick: 0, gcl: { level: 1, progress: 1 } });
      armSweep(7);
      onTick(1500, {});
      takeIfPending();
      onTick(3000, {});
      takeIfPending();
      const [open, close] = getArchive().recs;
      expect(open.pct, "the month starting at 1500 runs at 8%").to.equal(8);
      expect(close.pct, "the NEXT month runs at 9%").to.equal(9);
      // What a close for period [1500,3000) must report:
      expect(open.pct).to.not.equal(close.pct);
    });

    it("does not re-mark a boundary already snapshotted", () => {
      MockRawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify({ tick: 1500, gcl: { level: 1, progress: 5 } });
      onTick(1500, {});
      takeIfPending();
      expect(getArchive().recs).to.have.length(1);
      onTick(1500, {});
      expect(getArchive().pending).to.equal(undefined);
      expect(getArchive().recs).to.have.length(1);
    });

    it("STAYS PENDING when the segments are not written yet, instead of losing the month", () => {
      // The CPU governor sheds telemetry under load (bucket < 8000), so the
      // segments a boundary wants to copy may not exist on the boundary tick.
      // A month delayed by a tick is fine; a month dropped is not.
      onTick(1500, {});
      takeIfPending();
      expect(getArchive().recs).to.have.length(0);
      expect(getArchive().pending).to.equal(1500);
      MockRawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify({ tick: 1501, gcl: { level: 1, progress: 5 } });
      takeIfPending();
      expect(getArchive().recs).to.have.length(1);
      expect(getArchive().pending).to.equal(undefined);
    });
  });

  describe("the ring", () => {
    it("evicts oldest-first past MAX_RECORDS and COUNTS what it dropped", () => {
      const arc = getArchive();
      MockRawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify({ tick: 0, gcl: { level: 1, progress: 1 } });
      for (let i = 1; i <= MAX_RECORDS + 3; i++) {
        onTick(i * 1500, {});
        takeIfPending();
      }
      expect(arc.recs).to.have.length(MAX_RECORDS);
      expect(arc.dropped).to.equal(3);
      // A gap is never silent - the oldest surviving month is stated.
      expect(arc.recs[0].t).to.equal(4 * 1500);
    });

    it("shards by BYTE COUNT so a widening record rebalances instead of overflowing", () => {
      const big = { t: 0, pad: "x".repeat(BYTE_BUDGET / 2) };
      const shards = shard([
        { ...big, t: 1 },
        { ...big, t: 2 },
        { ...big, t: 3 },
        { ...big, t: 4 }
      ] as any);
      expect(shards.length).to.be.greaterThan(1);
      for (const s of shards) expect(JSON.stringify(s).length).to.be.at.most(BYTE_BUDGET);
    });

    it("publishes every archive segment, writing EMPTY ones rather than leaving them stale", () => {
      MockRawMemory.segments[ARCHIVE_SEGMENTS[1]] = JSON.stringify({ recs: [{ t: 999, stale: true }] });
      MockRawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify({ tick: 1500, gcl: { level: 1, progress: 5 } });
      onTick(1500, {});
      takeIfPending();
      for (const id of ARCHIVE_SEGMENTS) expect(MockRawMemory.segments[id], `segment ${id}`).to.be.a("string");
      // The stale shard must be gone: merging it back would resurrect a month
      // the ring has already dropped.
      const merged = mergeShards({
        data: {
          fiscal: JSON.parse(MockRawMemory.segments[ARCHIVE_SEGMENTS[0]]),
          fiscal2: JSON.parse(MockRawMemory.segments[ARCHIVE_SEGMENTS[1]])
        }
      });
      expect(merged!.recs.map(r => r.t)).to.deep.equal([1500]);
    });
  });

  describe("ROUND TRIP: an archived pair reproduces the real income statement", () => {
    /**
     * The acceptance criterion for the whole mechanism. "Recoverable" is not a
     * claim about bytes surviving - it is the claim that the ENERGY ACCOUNT
     * computed from two archived snapshots equals the one computed from the two
     * full captures they were pruned from. Anything the prune drops that an
     * account line reads shows up here as a changed number.
     *
     * This test is how four real gaps were found and fixed: the plan's hauler
     * rows (the whole evacuation budget), core.links + the hauler `port` flag
     * (the link-transfer budget line), the non-harvest corps the budget prices
     * its infra/defense/consumer lines from, and source `nodeId` (which splits
     * remote from home for the reservation uplift).
     */
    const captures = ["72821449", "72823437"];
    const haveFixtures = captures.every(t => fs.existsSync(path.join(FIXTURES, `shard1-t${t}.json`)));

    (haveFixtures ? it : it.skip)("every account line matches to within rounding", () => {
      const [A, B] = captures.map(load);
      const real = formatAccounts(B, A, computeLedger(B, A)).split("\n");

      const via = (c: any) =>
        rehydrate(pruneToRecord(c.tick, c.data.core, c.data.flow, c.data.corps, { pct: 10, cycle: 0 }));
      const a2 = via(A);
      const b2 = via(B);
      const arch = formatAccounts(b2, a2, computeLedger(b2, a2)).split("\n");

      // Compare the NUMBERS on each labelled line, not the formatting. Values
      // are rounded into the ring (2dp on rates, 4dp on heldFrac), so a cent of
      // drift on a summed line is expected; a changed LINE is not.
      const numbersOf = (lines: string[]) => {
        const out = new Map<string, number[]>();
        for (const l of lines) {
          const m = /^\s*[=+-]?\s*([A-Za-z][A-Za-z ()/&.,'-]+?)\s{2,}(-?[\d,.]+.*)$/.exec(l);
          if (!m) continue;
          const nums = (m[2].match(/-?\d[\d,]*\.?\d*/g) ?? []).map(s => Number(s.replace(/,/g, "")));
          if (nums.length) out.set(m[1].trim(), nums);
        }
        return out;
      };
      const rn = numbersOf(real);
      const an = numbersOf(arch);

      const missing: string[] = [];
      const drifted: string[] = [];
      for (const [label, vals] of rn) {
        const got = an.get(label);
        if (!got) {
          missing.push(label);
          continue;
        }
        for (let i = 0; i < Math.min(vals.length, got.length); i++) {
          if (Math.abs(vals[i] - got[i]) > 0.02) drifted.push(`${label}[${i}] ${vals[i]} vs ${got[i]}`);
        }
      }
      expect(drifted, `archived account drifted from the real one:\n${drifted.join("\n")}`).to.deep.equal([]);
      // Only the tombstone ATTRIBUTION decorations may go absent - the archive
      // drops the per-room / per-reason maps on purpose (unbounded width).
      const allowed = /killed where|recycled why|by cause|by role/i;
      expect(
        missing.filter(l => !allowed.test(l)),
        `account lines missing from the archived close:\n${missing.join("\n")}`
      ).to.deep.equal([]);
    });

    (haveFixtures ? it : it.skip)("a record fits the sweep inside the published segments", () => {
      const c = load("72823437");
      const rec = pruneToRecord(c.tick, c.data.core, c.data.flow, c.data.corps, { pct: 0, cycle: 0 });
      const bytes = JSON.stringify(rec).length;
      // 22 snapshots bracket the 21-month ramp. They must SHARD into the
      // segments we actually publish, or the tail of the sweep is unreadable.
      const full = Array.from({ length: 22 }, (_, i) => ({ ...rec, t: i * 1500 }));
      expect(shard(full).length, `record is ${bytes}B; 22 months need more segments than published`).to.be.at.most(
        ARCHIVE_SEGMENTS.length
      );
    });

    (haveFixtures ? it : it.skip)("carries the handicap that produced the month", () => {
      const c = load("72823437");
      const rec = pruneToRecord(c.tick, c.data.core, c.data.flow, c.data.corps, { pct: 13, cycle: 2 });
      expect(rec.pct).to.equal(13);
      expect(rec.cyc).to.equal(2);
      // Every adjudicated verdict survives: "2 remotes fell out at 13%" is the
      // sweep's primary observable and lives only in these rows.
      const verdicts = new Set((rec.fc ?? []).map(r => r[3]));
      expect(verdicts.has("funded")).to.equal(true);
      expect(verdicts.size).to.be.greaterThan(1);
    });
  });
});
