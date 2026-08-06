#!/usr/bin/env ts-node
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * FISCAL ARCHIVE EXPANDER - turn the bot's own month-boundary snapshots
 * (segments 8-9, telemetry/fiscalArchive) into fiscal closes.
 *
 * `fiscal-close.ts` brackets a month with the committed CAPTURES nearest its
 * ends, which needs somebody capturing on roughly a monthly cadence. This reads
 * the boundary snapshots the BOT took instead, so an unattended run of many
 * months closes from a single capture taken at the end.
 *
 * The two paths write the same report through the same `formatAccounts` /
 * `formatSourcePnL` / `formatLedger` functions at the same METHODOLOGY stamp -
 * only the bracketing differs, and an archived close says so in its header.
 *
 * WHAT AN ARCHIVED CLOSE HAS THAT A CAPTURED ONE DOES NOT: coverage ~100% by
 * construction. The snapshots land ON the boundary (within a tick or two),
 * where captures have never been better than approximate.
 *
 * WHAT IT LACKS, stated in every report it writes: the snapshot is pruned to the
 * account's inputs. Unscouted PROSPECT candidates are dropped (every adjudicated
 * verdict survives, so the P&L and the excluded-capacity line are intact), corps
 * outside the kinds the plan prices are dropped, the per-room loss attribution
 * maps are dropped, and there is no intel, blackbox or creep census. Lines that
 * read those degrade or go absent - they never read a confident zero, which is
 * the failure spec 41 exists to prevent.
 *
 * Usage:
 *   npm run fiscal:archive            # write any new closes from the newest capture
 *   npm run fiscal:archive -- --list  # just show the ring
 *   npm run fiscal:archive -- --dry
 *
 * @module scripts/fiscal-archive
 */

import * as fs from "fs";
import * as path from "path";
import { METHODOLOGY, computeLedger, formatAccounts, formatLedger, formatSourcePnL } from "./waste-ledger";
import { FiscalPeriod, isYearEnd, periodOf } from "./fiscal";

const FIXTURES = path.join(__dirname, "..", "test", "fixtures", "telemetry");
const OUT = path.join(__dirname, "..", "docs", "fiscal");

/** Positional row helpers - mirror telemetry/fiscalArchive's snapshot(). */
const roomOf = (r: any[]): any => ({
  name: r[0],
  rcl: r[1],
  rclProgress: r[2],
  storageEnergy: r[3],
  controllerStock: r[4],
  feederActive: r[5] === 1,
  siteProgress: r[6],
  siteCount: r[7],
  energyAvailable: r[8]
});
const spawnOf = (s: any[]): any => ({
  name: s[0],
  utilization: s[1],
  partsPerTick: s[2],
  ceiling: s[3],
  queueDepth: s[4]
});
const sourceOf = (s: any[]): any => ({
  id: s[0],
  harvestRate: s[1],
  workParts: s[2],
  spawnDistance: s[3],
  linkServed: s[4] === 1,
  nodeId: s[5]
});
const sinkOf = (s: any[]): any => ({
  id: s[0],
  type: s[1],
  allocated: s[2],
  priority: s[3],
  demand: s[4],
  workParts: s[5],
  spawnLoad: s[6],
  spawnDist: s[7]
});
const haulerOf = (h: any[]): any => ({
  sourceId: h[0],
  carryParts: h[1],
  flowRate: h[2],
  distance: h[3],
  spawnParts: h[4],
  port: h[5] === 1
});
/** Inverse of the positional corp row. `id` is rebuilt as `kind-shortId`. */
const corpOf = (c: any[]): any => ({
  id: `${c[1]}-${c[0]}`,
  kind: c[1],
  creepCount: c[2],
  bodyParts: c[3],
  body: c[4],
  produced: c[5],
  sizing: {
    linkFed: c[6] === 1,
    planFlow: c[7],
    target: c[8],
    targets: c[9],
    heldFrac: c[10]
  }
});
const candOf = (c: any[]): any => ({
  sourceId: c[0],
  net: c[1],
  distance: c[2],
  verdict: c[3],
  rate: c[4],
  tax: c[5]
});

/**
 * Rehydrate one archived record into the CAPTURE shape the account reads. The
 * inverse of `snapshot()` in telemetry/fiscalArchive - keep the two in step.
 */
export function rehydrate(rec: any): { tick: number; data: any } {
  const lo = rec.lo ?? {};
  return {
    tick: rec.t,
    data: {
      core: {
        version: 35,
        tick: rec.t,
        gcl: rec.gcl ? { level: rec.gcl.l, progress: rec.gcl.p, progressTotal: 0 } : undefined,
        cpu: rec.cpu ? { used: rec.cpu.u, bucket: rec.cpu.b, limit: 0, tickLimit: 0 } : undefined,
        warchestTarget: rec.wt,
        spawnSpend: rec.ss,
        losses: {
          windowTicks: lo.w,
          pileDecay: lo.pd,
          structureDecay: lo.sd,
          repairSpend: lo.rs,
          tombstoneLost: lo.tl,
          tombstoneRecovered: lo.tr,
          tombstoneStock: lo.ts,
          cumulative: lo.c
        },
        sourceBuffers: rec.sb,
        sourceDropped: rec.sd,
        rooms: (rec.rm ?? []).map(roomOf),
        bodyParts: rec.bp,
        spawns: (rec.sp ?? []).map(spawnOf),
        links: (rec.lk ?? []).map((l: any[]) => ({
          room: l[0],
          windowTicks: l[1],
          toHubRate: l[2],
          toControllerRate: l[3],
          directShare: l[4],
          taxRate: l[5]
        })),
        // The census is NOT archived - the account never reads it, only the X3
        // orphan leak row does. Stubbed so the row computes to an honest zero
        // rather than crashing the close.
        creeps: { total: 0, tracked: 0, untracked: 0, byKind: {} }
      },
      flow: {
        version: 15,
        tick: rec.t,
        sources: (rec.fs ?? []).map(sourceOf),
        summary: rec.fsum,
        partsLedger: rec.fpl,
        haulers: (rec.fh ?? []).map(haulerOf),
        sinks: (rec.fsk ?? []).map(sinkOf),
        candidates: (rec.fc ?? []).map(candOf)
      },
      corps: { version: 16, tick: rec.t, corps: (rec.co ?? []).map(corpOf) }
    }
  };
}

/**
 * Merge the archive's shards from one capture into a single ring.
 *
 * The bot splits the ring across segments 8 and 9 by byte count, so a reader
 * that takes only `fiscal` silently loses roughly half the sweep. Records are
 * deduped by tick (a re-publish can leave the same month in both shards during
 * a rebalance) and sorted oldest-first.
 */
export function mergeShards(data: any): { recs: any[]; dropped: number; sweep: any; parts: number } | undefined {
  const segs = [data?.data?.fiscal, data?.data?.fiscal2].filter(s => s && Array.isArray(s.recs));
  if (segs.length === 0) return undefined;
  const byTick = new Map<number, any>();
  for (const s of segs) for (const r of s.recs) if (r && typeof r.t === "number") byTick.set(r.t, r);
  if (byTick.size === 0) return undefined;
  return {
    recs: [...byTick.values()].sort((a, b) => a.t - b.t),
    dropped: Math.max(...segs.map(s => s.dropped ?? 0)),
    sweep: segs[0].sweep,
    parts: segs[0].parts ?? segs.length
  };
}

/** The newest capture that actually carries a fiscal archive. */
function newestArchive(): { file: string; seg: any } | undefined {
  const files = fs
    .readdirSync(FIXTURES)
    .filter(f => /^shard1-t\d+\.json$/.test(f))
    .map(f => ({ tick: Number(f.match(/t(\d+)/)![1]), f }))
    .sort((a, b) => b.tick - a.tick);
  for (const { f } of files) {
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
    const seg = mergeShards(data);
    if (seg) return { file: f, seg };
  }
  return undefined;
}

/**
 * Close every month the ring brackets. A month is closed from the snapshot pair
 * that spans it; consecutive snapshots are exactly one month apart, so the pair
 * IS the period.
 */
export function closeFromArchive(seg: any, dry: boolean): string[] {
  const recs = [...(seg.recs ?? [])].sort((a: any, b: any) => a.t - b.t);
  const written: string[] = [];
  for (let i = 1; i < recs.length; i++) {
    const base = rehydrate(recs[i - 1]);
    const cap = rehydrate(recs[i]);
    const dt = cap.tick - base.tick;
    if (dt <= 0) continue;
    // The period that ENDED at the closing snapshot.
    const period: FiscalPeriod = periodOf(cap.tick - 1);
    const outFile = path.join(OUT, `${period.label}.md`);
    if (fs.existsSync(outFile)) continue; // append-only: never rewrite history
    // The archive's own coherence check: a pair must span about one month. A
    // gap (dropped record, a bot down for a month) must not be filed as one.
    const coverage = dt / (period.endTick - period.startTick);
    if (coverage < 0.5 || coverage > 1.75) continue;
    if (cap.data.core.spawnSpend === undefined || base.data.core.spawnSpend === undefined) continue;

    const rows = computeLedger(cap, base);
    const handicap = recs[i].pct;
    const body = [
      `# ${period.label}${isYearEnd(period) ? "  (FISCAL YEAR END)" : ""}`,
      "",
      `**Methodology #${METHODOLOGY}** — reports are only directly comparable at the same stamp.`,
      "",
      `**Closed from the BOT'S OWN month-boundary archive** (segment 8) — snapshots`,
      `**t${base.tick} → t${cap.tick}** (${dt} ticks, ${(coverage * 100).toFixed(0)}% of the period).`,
      "",
      handicap === undefined
        ? "Spawn-capacity handicap: not recorded."
        : `**Spawn-capacity handicap in force this month: ${handicap}%** ` +
          `(planner budgeted ${(100 - handicap).toFixed(0)}% of physical spawn rate)` +
          (recs[i].cyc === undefined ? "" : `, sweep cycle ${recs[i].cyc}`) +
          ".",
      "",
      "An archived close brackets its period ON the boundary, so coverage is ~100% rather than",
      "approximate. In exchange the snapshot is PRUNED to the account's inputs: candidates are",
      "FUNDED-only (the rejected pool is absent, so P&L rows for unfunded sources cannot appear),",
      "only harvest corps are kept, and there is no intel or blackbox segment. Lines fed by those",
      "degrade or go absent — none of them read a confident zero.",
      "",
      "```",
      formatAccounts(cap, base, rows),
      formatSourcePnL(cap),
      "",
      formatLedger(rows, cap.tick, base.tick),
      "```",
      ""
    ].join("\n");

    if (!dry) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(outFile, body);
    }
    written.push(
      `${period.label}  t${base.tick}->t${cap.tick} (${(coverage * 100).toFixed(0)}%, handicap ${handicap ?? "?"}%)`
    );
  }
  return written;
}

if (require.main === module) {
  const dry = process.argv.includes("--dry");
  const found = newestArchive();
  if (!found) {
    console.log("fiscal archive: no capture carries the archive (capture with --segments 0,3,4,5,6,8,9)");
  } else {
    const recs = [...(found.seg.recs ?? [])].sort((a: any, b: any) => a.t - b.t);
    console.log(
      `fiscal archive from ${found.file}: ${recs.length} snapshot(s), ` +
        `dropped ${found.seg.dropped ?? 0}, sweep ${JSON.stringify(found.seg.sweep ?? null)}`
    );
    for (const r of recs)
      console.log(`  t${r.t}  ${periodOf(r.t - 1).label}  handicap ${r.pct ?? "?"}%  cycle ${r.cyc ?? "?"}`);
    if (!process.argv.includes("--list")) {
      const written = closeFromArchive(found.seg, dry);
      console.log(
        written.length
          ? `\nclosed${dry ? " (DRY)" : ""} ${written.length} period(s):\n  ${written.join("\n  ")}`
          : "\nnothing new to close (all already on disk, or no pair spans a full month)"
      );
    }
  }
}
