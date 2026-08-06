/**
 * @fileoverview THE FISCAL ARCHIVE - segments 8-9. Per-month accounting snapshots
 * the bot takes itself, so a fiscal period is recoverable long after it closed.
 *
 * Charter: owns the month-boundary snapshot, its ring, the handicap sweep's
 * persistence, and segments 8-9. Takes no
 * measurement of its own - every field is copied verbatim out of the segments
 * that were just written, so the archive and a live capture can never disagree
 * about a number, only about how far back they can see.
 *
 * ## The problem it solves
 *
 * `scripts/fiscal-close.ts` closes a fiscal month by DIFFERENCING two committed
 * captures that bracket it (cumulative spawn spend, losses, gcl.progress,
 * storage). That works only if somebody was there to capture: a month with no
 * capture near either end is closed at 50-175% coverage or not at all, and once
 * the captures scroll past, that month is gone forever - the record is
 * append-only, so it can never be filled in later.
 *
 * That is fine for an attended audit cycle and useless for an UNATTENDED
 * experiment. The handicap sweep (economy/spawnSweep) runs 21 fiscal months -
 * ~31,500 ticks - and its whole deliverable is the income statement of each one
 * (owner 2026-08-06: *"I want to make sure all those income statements will be
 * recoverable by the end ... I don't want to re-deploy or monitor from here"*).
 * Nobody will be capturing on a 1500-tick cadence for that long.
 *
 * So the bot brackets its own months. At every boundary it appends a snapshot of
 * exactly the fields the ENERGY ACCOUNT and SOURCE P&L read; ONE capture at the
 * end then yields every month in the ring, each bracketed by a snapshot taken
 * within a tick of its true boundary. Coverage stops being a compromise - an
 * archived close is ~100% by construction, where a capture-bracketed one has
 * never been better than approximate.
 *
 * ## Why it is a projection, not a store
 *
 * The ring lives in `Memory` and segment 8 is its publish surface, following the
 * doctrine telemetry/LossMeter and telemetry/spawnLedger paid for: heap state is
 * bounded by VM lifetime (~480 ticks after a deploy, measured t72722670), which
 * is less than one fiscal month, so a heap ring would lose exactly the periods
 * this exists to keep.
 *
 * ## Honesty limits
 *
 * - A snapshot is PRUNED to the account's inputs, not a whole capture: only
 *   ADJUDICATED candidates (unscouted prospects dropped), only the corp kinds
 *   the plan prices, no per-room loss attribution maps, and no intel, blackbox
 *   or creep census at all. A close built from the archive states this, and the
 *   round-trip test pins that what remains still reproduces the account.
 * - The ring is finite (`MAX_RECORDS`). It holds one full sweep plus margin; a
 *   month older than that is dropped, oldest first, and `dropped` counts them so
 *   a gap is never silent.
 *
 * Layer: telemetry writer (Game/Memory-coupled; writes RawMemory segments 8-9).
 *
 * @module telemetry/fiscalArchive
 */

import { TELEMETRY_SEGMENTS } from "./segmentIds";
import {
  SWEEP_MONTH_TICKS,
  SWEEP_STEP_PCT,
  SpawnSweepState,
  advanceSweep,
  isMonthBoundary,
  newSweep,
  setHandicapPct
} from "../economy/spawnSweep";

// ---------------------------------------------------------------------------
// THE SWEEP'S MEMORY BINDING.
//
// economy/spawnSweep is on the PLAN-layer PURE list (spec 17) because
// economy/primitives resolves the planner's margin through it - so it may not
// touch Memory, and the persistence lives HERE, in a module that is already
// Game/Memory-coupled. This file owns the fiscal-month hook; owning the
// calendar's state alongside it keeps one seam instead of two.
// ---------------------------------------------------------------------------

/** Game-free fallback store, mirroring telemetry/spawnLedger's pattern. */
let localSweep: SpawnSweepState | undefined;

/** The persisted sweep, or undefined when the experiment is not armed. */
export function getSweep(): SpawnSweepState | undefined {
  if (typeof Memory === "undefined") return localSweep;
  return (Memory as unknown as { spawnSweep?: SpawnSweepState }).spawnSweep;
}

function putSweep(s: SpawnSweepState | undefined): void {
  if (typeof Memory === "undefined") {
    localSweep = s;
  } else {
    const mem = Memory as unknown as { spawnSweep?: SpawnSweepState };
    if (s) mem.spawnSweep = s;
    else delete mem.spawnSweep;
  }
  setHandicapPct(s?.pct);
}

/**
 * Mirror the persisted handicap into the pure module, EVERY tick and before the
 * planner reads it.
 *
 * Not optional bookkeeping: the pure side is heap state, so the first tick after
 * a global reset would otherwise plan at the fail-safe 0.9 while the experiment
 * believes it is at, say, 14% - one silently mis-labelled tick per deploy.
 */
export function syncSweep(): void {
  setHandicapPct(getSweep()?.pct);
}

/**
 * Arm the experiment. Deliberate and one-time - the bot never calls this, so an
 * unarmed colony (grid cell, sim, fresh Memory) keeps the measured-good 0.9.
 */
export function armSweep(startPct = 0, step: number = SWEEP_STEP_PCT): SpawnSweepState {
  const s = newSweep(startPct, step);
  putSweep(s);
  return s;
}

/** Disarm - back to the static SPAWN_PLAN_FRACTION. */
export function disarmSweep(): void {
  putSweep(undefined);
}

/**
 * Ring capacity. The sweep's longest ramp is 21 months (0..20 at 1%/month), and a
 * close needs the boundary on BOTH sides of a month, so 22 snapshots is the
 * minimum that recovers a whole pass; 24 leaves two months of margin.
 *
 * This is the COUNT bound only. The binding one is publishable capacity - see
 * `trim`, which evicts anything that will not shard across ARCHIVE_SEGMENTS.
 */
export const MAX_RECORDS = 24;

/**
 * Per-segment byte ceiling. Screeps rejects a segment write over 100 KB; 90 KB
 * leaves headroom for the wrapper fields and for a record that widens when the
 * colony claims another room. At the measured ~6.8 KB/record that is ~13 months
 * per segment, so the two-segment shard holds the whole sweep.
 */
export const BYTE_BUDGET = 90000;

/** The segments the ring is sharded across, in order. */
export const ARCHIVE_SEGMENTS = [TELEMETRY_SEGMENTS.FISCAL, TELEMETRY_SEGMENTS.FISCAL2];

/** Round to 2dp - these are report figures, not physics. Keeps the ring small. */
function r2(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) ? undefined : Math.round(n * 100) / 100;
}

/** Short source key: the tail of the id, enough to join rows across months. */
function shortId(id: unknown): string {
  return String(id)
    .replace(/^source-/, "")
    .slice(-6);
}

/**
 * A hauler route key: its classifying PREFIX plus enough tail to stay distinct.
 * `source-5982fc1db097071b4adbcd8e` -> `source-cd8e`, `bank-W43N23` unchanged.
 */
function routeKey(sourceId: unknown): string {
  const s = String(sourceId);
  const dash = s.indexOf("-");
  if (dash < 0) return s.slice(0, 16);
  const prefix = s.slice(0, dash);
  const rest = s.slice(dash + 1);
  return rest.length <= 8 ? s : `${prefix}-${rest.slice(-4)}`;
}

/**
 * The cumulative loss block, minus its per-room / per-reason attribution maps.
 * Those decorate the tombstone line (a "killed where" / "recycled why" split);
 * the ACCOUNT reads only the totals, and the maps grow with every room the
 * colony has ever fought in - unbounded width inside a size-bound ring.
 */
function pruneCumulative(c: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!c) return undefined;
  const keep = [
    "pileDecay",
    "structureDecay",
    "repairSpend",
    "tombstoneGross",
    "tombstoneRecovered",
    "tombstoneExpired",
    "tombstoneKilled",
    "tombstoneRecycled",
    "tombstoneCauseUnknown",
    "tombstoneKilledHostileRoom",
    "tombstoneKilledHostileAtDeath",
    "tombstoneTtlSum",
    "tombstoneTtlKnown",
    "pileDecayCeilPenalty",
    "pileTicks",
    "pileTicksSmall"
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (c[k] !== undefined) out[k] = c[k];
  // Role attribution is 4 keys and answers "which fleet is dying" - cheap, kept.
  if (c.tombstoneByRole !== undefined) out.tombstoneByRole = c.tombstoneByRole;
  return out;
}

/** The flow summary's account-facing figures; `fleetCharge`'s nested detail is dropped. */
function pruneSummary(s: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  return {
    totalHarvest: r2(s.totalHarvest as number),
    totalOverhead: s.totalOverhead,
    spawnMaintenance: r2(s.spawnMaintenance as number),
    netEnergy: r2(s.netEnergy as number),
    efficiency: r2(s.efficiency as number),
    isSustainable: s.isSustainable,
    minerCount: s.minerCount,
    haulerCount: s.haulerCount
  };
}

/** Link meter rows, pruned to the tax the account charges and the LINK row's gauges. */
function pruneLinks(rows: Record<string, unknown>[] | undefined): unknown[][] | undefined {
  if (!rows) return undefined;
  return rows.map(l => [
    l.room,
    l.windowTicks,
    r2(l.toHubRate as number),
    r2(l.toControllerRate as number),
    r2(l.directShare as number),
    r2(l.taxRate as number)
  ]);
}

/**
 * Corp kinds the PLAN prices, and therefore the only ones an income statement
 * needs. `harvest` carries the revenue contra (`produced`, `heldFrac`); the rest
 * carry the budget column's fleet lines (waste-ledger `planSpawnLoad` reads
 * upgrade for parts-per-WORK, tender/reservation/raidGuard for their standing
 * bodies, and the controllerFeeder corp for its link-fed stamp).
 */
const PRICED_CORP_KINDS = new Set([
  "harvest",
  "upgrade",
  "tender",
  "reservation",
  "raidGuard",
  "controllerFeeder",
  "construction"
]);

/**
 * One month-boundary snapshot. Field names are SHORT because the ring is
 * size-bound and this is an internal format with exactly one reader
 * (scripts/fiscal-archive.ts), which rehydrates it back to capture shape.
 */
export interface FiscalArchiveRecord {
  /** Tick the snapshot was taken - within a tick or two of the true boundary. */
  t: number;
  /**
   * Handicap in force during the month that STARTS at this tick, percent.
   *
   * The boundary hook advances the sweep BEFORE the snapshot is taken (so the
   * month's first re-solve already prices at the new margin), which means a
   * record's `pct` describes the month ahead of it, not the one behind. A close
   * spanning recs[i-1] -> recs[i] therefore reports recs[i-1].pct. Getting this
   * backwards labels every income statement with the NEXT month's handicap.
   */
  pct?: number;
  /** Sweep cycle index at this boundary. */
  cyc?: number;
  gcl?: { p: number; l: number };
  cpu?: { u?: number; b: number };
  /** Dynamic warchest/reserve target. */
  wt?: number;
  /** CUMULATIVE spawn spend by role - the account's operating-cost side. */
  ss?: unknown;
  /** Loss meter: window figures plus the CUMULATIVE block the account differences. */
  lo?: Record<string, unknown>;
  /** Source buffer / ground pile stocks. */
  sb?: unknown;
  sd?: unknown;
  /** Rooms, positional: [name, rcl, rclProgress, storage, ctrlStock, feeder, siteProgress, siteCount, energyAvail]. */
  rm?: unknown[][];
  bp?: unknown;
  /** Spawn meter, positional: [name, utilization, partsPerTick, ceiling, queueDepth]. */
  sp?: unknown[][];
  /** Plan sources, positional: [id, harvestRate, workParts, spawnDistance, linkServed]. */
  fs?: unknown[][];
  fsum?: unknown;
  fpl?: unknown;
  /** Plan haulers, positional: [sourceId, carryParts, flowRate, distance, spawnParts]. */
  fh?: unknown[][];
  /** Plan sinks, positional: [id, type, allocated, priority, demand, workParts, spawnLoad, spawnDist]. */
  fsk?: unknown[][];
  /** FUNDED candidates only, positional: [id, net, distance]. */
  fc?: unknown[][];
  /** Link meter rows - the account's link-transfer cost line. */
  lk?: unknown;
  /**
   * Corps the PLAN prices, pruned. Not just harvest: the budget column derives
   * its reservation / infra / defense / consumer lines from the standing fleet
   * (waste-ledger `planSpawnLoad`), so dropping them zeroed half the income
   * statement's budget side - measured on the first round-trip, which is why
   * this test exists.
   */
  co?: unknown[][];
}

export interface FiscalArchiveState {
  /** Boundary snapshots, oldest first. */
  recs: FiscalArchiveRecord[];
  /** A boundary was crossed and its snapshot is not taken yet (see takeIfPending). */
  pending?: number;
  /** Months evicted from the ring - a dropped period is counted, never silent. */
  dropped?: number;
}

let localArchive: FiscalArchiveState | undefined;

function archive(): FiscalArchiveState {
  if (typeof Memory === "undefined") {
    if (!localArchive) localArchive = { recs: [] };
    return localArchive;
  }
  const mem = Memory as unknown as { fiscalArchive?: FiscalArchiveState };
  if (!mem.fiscalArchive) mem.fiscalArchive = { recs: [] };
  if (!mem.fiscalArchive.recs) mem.fiscalArchive.recs = [];
  return mem.fiscalArchive;
}

/** Test seam - drops all archived state. */
export function resetFiscalArchive(): void {
  localArchive = { recs: [] };
  if (typeof Memory !== "undefined") {
    (Memory as unknown as { fiscalArchive?: FiscalArchiveState }).fiscalArchive = { recs: [] };
  }
}

export function getArchive(): FiscalArchiveState {
  return archive();
}

/**
 * Called EVERY tick from the main loop, outside the telemetry gate.
 *
 * Two jobs, both idempotent per boundary: advance the handicap sweep, and mark
 * that a snapshot is owed. The snapshot itself cannot be taken here because it
 * copies from segments that `Telemetry.update` writes later in the tick - and
 * that write is skipped entirely under CPU-governor degradation. Marking now and
 * taking when the segments next exist means a governed tick DELAYS a month's
 * snapshot by a tick or two instead of losing it.
 */
export function onTick(tick: number, ctx: { rcl?: number; rclProgress?: number; rclProgressTotal?: number }): void {
  // Refresh the pure mirror first, unconditionally - see syncSweep.
  syncSweep();
  if (!isMonthBoundary(tick)) return;
  const arc = archive();
  // Only mark a boundary we have not already snapshotted or queued.
  const last = arc.recs.length > 0 ? arc.recs[arc.recs.length - 1].t : -1;
  if (arc.pending === tick || last === tick) return;
  arc.pending = tick;
  const stepped = advanceSweep(getSweep(), {
    tick,
    rcl: ctx.rcl,
    rclProgress: ctx.rclProgress,
    rclProgressTotal: ctx.rclProgressTotal
  });
  if (stepped) putSweep(stepped);
}

/** Parse a segment we just wrote. Returns undefined rather than throwing. */
function readSegment(id: number): Record<string, unknown> | undefined {
  try {
    const raw = RawMemory.segments[id];
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Prune three segment payloads into one boundary record. PURE - no Game, no
 * Memory, no RawMemory - so the round-trip (prune -> rehydrate -> account) is
 * testable against real captured segments, which is the only proof that the
 * archive actually carries an income statement's inputs.
 *
 * Its inverse lives in scripts/fiscal-archive.ts `rehydrate()`; the two are one
 * contract and change together.
 */
export function pruneToRecord(
  tick: number,
  core: Record<string, unknown>,
  flow: Record<string, unknown> | undefined,
  corps: Record<string, unknown> | undefined,
  sweep?: { pct: number; cycle: number }
): FiscalArchiveRecord {
  const gcl = core.gcl as { level: number; progress: number } | undefined;
  const cpu = core.cpu as { used: number; bucket: number } | undefined;
  const losses = (core.losses ?? {}) as Record<string, unknown>;
  const rooms = (core.rooms ?? []) as Record<string, unknown>[];
  const spawns = (core.spawns ?? []) as Record<string, unknown>[];
  const fsources = ((flow?.sources ?? []) as Record<string, unknown>[]) || [];
  const fsinks = ((flow?.sinks ?? []) as Record<string, unknown>[]) || [];
  const fcands = ((flow?.candidates ?? []) as Record<string, unknown>[]) || [];
  const fhaulers = ((flow?.haulers ?? []) as Record<string, unknown>[]) || [];
  const corpRows = ((corps?.corps ?? []) as Record<string, unknown>[]) || [];

  return {
    t: tick,
    pct: sweep?.pct,
    cyc: sweep?.cycle,
    gcl: gcl ? { p: gcl.progress, l: gcl.level } : undefined,
    cpu: cpu ? { u: r2(cpu.used), b: cpu.bucket } : undefined,
    wt: core.warchestTarget as number | undefined,
    ss: core.spawnSpend,
    lo: {
      w: losses.windowTicks,
      pd: r2(losses.pileDecay as number),
      sd: r2(losses.structureDecay as number),
      rs: r2(losses.repairSpend as number),
      tl: r2(losses.tombstoneLost as number),
      tr: r2(losses.tombstoneRecovered as number),
      ts: r2(losses.tombstoneStock as number),
      c: pruneCumulative(losses.cumulative as Record<string, unknown> | undefined)
    },
    sb: core.sourceBuffers,
    sd: core.sourceDropped,
    rm: rooms.map(r => [
      r.name,
      r.rcl,
      r.rclProgress,
      r.storageEnergy,
      r.controllerStock,
      r.feederActive === true ? 1 : 0,
      r.siteProgress,
      r.siteCount,
      r.energyAvailable
    ]),
    bp: core.bodyParts,
    sp: spawns.map(s => [
      s.name,
      r2(s.utilization as number),
      r2(s.partsPerTick as number),
      r2(s.ceiling as number),
      s.queueDepth
    ]),
    // nodeId carries the ROOM: the account splits remote from home sources on
    // it to price the reservation uplift, so a source without it reads remote.
    fs: fsources.map(s => [
      shortId(s.id),
      s.harvestRate,
      s.workParts,
      s.spawnDistance,
      s.linkServed === true ? 1 : 0,
      s.nodeId
    ]),
    fsum: pruneSummary(flow?.summary as Record<string, unknown> | undefined),
    fpl: flow?.partsLedger,
    // sourceId is kept INTACT: the ledger classifies a route by its prefix
    // ("bank-", "scavenge-"), so a truncated id would silently reclassify
    // transient haulers as source routes.
    // `port` is load-bearing, not decoration: deposit-port routes pay a link hop
    // the budget prices (spec 26), and dropping the flag silently zeroed the
    // link-transfer budget line.
    fh: fhaulers.map(h => [
      // Prefix + tail. The ledger classifies a route by its PREFIX ("bank-",
      // "scavenge-") and never joins a hauler to a source, so the middle of a
      // 40-char id is dead weight - but the prefix itself is load-bearing, and
      // truncating it would reclassify transient haulers as source routes.
      routeKey(h.sourceId),
      r2(h.carryParts as number),
      r2(h.flowRate as number),
      h.distance,
      h.spawnParts,
      // `port` is a POSITION in the segment, not a boolean; the budget only
      // tests it for truthiness, so it archives as a flag.
      h.port ? 1 : 0
    ]),
    fsk: fsinks.map(s => [
      String(s.id).slice(-10),
      s.type,
      r2(s.allocated as number),
      s.priority,
      r2(s.demand as number),
      r2(s.workParts as number),
      s.spawnLoad,
      s.spawnDist
    ]),
    // Every ADJUDICATED candidate - funded, over-budget and defunded alike.
    // Only unscouted `prospect` rows are dropped (27 of 38 live, and no account
    // line reads them).
    //
    // The rejected pool is not optional for THIS experiment: raising the
    // handicap shrinks the spawn budget, and the first thing that budget does is
    // stop admitting marginal sources. "2 remotes fell out at 12%" is the
    // sweep's primary observable, and it is visible only in these verdicts.
    fc: fcands
      .filter(c => c.verdict !== "prospect")
      .map(c => [shortId(c.sourceId), r2(c.net as number), c.distance, c.verdict, c.rate, r2(c.tax as number)]),
    lk: pruneLinks(core.links as Record<string, unknown>[] | undefined),
    co: corpRows
      .filter(c => PRICED_CORP_KINDS.has(String(c.kind)))
      .map(c => {
        const sz = (c.sizing ?? {}) as Record<string, unknown>;
        return [
          // Short id + kind. The rehydrator rebuilds the id as `kind-shortId`,
          // which keeps the two things the ledger actually does with it working:
          // the harvest `produced` join across months (needs stability, not the
          // full id) and the feeder lookup (`includes("controllerFeeder")`,
          // satisfied by the kind prefix).
          String(c.id).slice(-6),
          c.kind,
          c.creepCount,
          c.bodyParts,
          c.body,
          c.produced,
          sz.linkFed === true ? 1 : 0,
          // The feeder's planned relay - the controller-link hop's budget.
          r2(sz.planFlow as number),
          sz.target,
          sz.targets,
          // 4dp, not 2: heldFrac is summed across every harvest corp into the
          // revenue contra, so 2dp rounding visibly moved the forgone line.
          sz.heldFrac === undefined || !Number.isFinite(sz.heldFrac as number)
            ? undefined
            : Math.round((sz.heldFrac as number) * 10000) / 10000
        ];
      })
  };
}

/** Read back the segments just written and prune them into a boundary record. */
function snapshot(tick: number): FiscalArchiveRecord | undefined {
  const core = readSegment(TELEMETRY_SEGMENTS.CORE);
  // Core is the account's whole actual side; without it the record is worthless.
  if (!core) return undefined;
  return pruneToRecord(
    tick,
    core,
    readSegment(TELEMETRY_SEGMENTS.FLOW),
    readSegment(TELEMETRY_SEGMENTS.CORPS),
    getSweep()
  );
}

/**
 * Take the owed snapshot, if any, and publish the ring. Call from
 * `Telemetry.update` AFTER the core/corps/flow writes - it copies from them.
 */
export function takeIfPending(): void {
  const arc = archive();
  if (arc.pending === undefined) {
    publish(arc);
    return;
  }
  const rec = snapshot(arc.pending);
  if (!rec) return; // segments not written yet - stay pending, try next tick
  arc.recs.push(rec);
  arc.pending = undefined;
  trim(arc);
  publish(arc);
}

/**
 * Enforce the record count and the PUBLISHABLE capacity, oldest first.
 *
 * The binding constraint is the second loop: whatever cannot be sharded across
 * `ARCHIVE_SEGMENTS` cannot be read back, so holding it in Memory would be a
 * month the archive believes it has and no capture can ever recover.
 */
function trim(arc: FiscalArchiveState): void {
  const evict = (): void => {
    arc.recs.shift();
    arc.dropped = (arc.dropped ?? 0) + 1;
  };
  while (arc.recs.length > MAX_RECORDS) evict();
  while (arc.recs.length > 2 && shard(arc.recs).length > ARCHIVE_SEGMENTS.length) evict();
}

/**
 * Split the ring into per-segment shards, each under BYTE_BUDGET.
 *
 * A month's snapshot is ~6.8 KB, so ~13 fit a segment and the 21-month sweep
 * needs two. Sharding by BYTE COUNT rather than a fixed record count keeps that
 * correct as a record grows - a colony that claims a second room widens every
 * per-room field, and a fixed split would silently start dropping the segment
 * over cap instead of rebalancing.
 *
 * Returns oldest-first shards; records that fit in NO shard are the caller's
 * signal to evict.
 */
export function shard(recs: FiscalArchiveRecord[]): FiscalArchiveRecord[][] {
  const shards: FiscalArchiveRecord[][] = [];
  let cur: FiscalArchiveRecord[] = [];
  let curBytes = 2; // "[]"
  for (const r of recs) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length > 0 && curBytes + n > BYTE_BUDGET) {
      shards.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(r);
    curBytes += n;
  }
  if (cur.length > 0) shards.push(cur);
  return shards;
}

function payload(arc: FiscalArchiveState, part: number, parts: number, recs: FiscalArchiveRecord[]): string {
  return JSON.stringify({
    // v1: the sweep experiment's archive (owner 2026-08-06).
    version: 1,
    tick: typeof Game === "undefined" ? 0 : Game.time,
    monthTicks: SWEEP_MONTH_TICKS,
    sweep: getSweep(),
    dropped: arc.dropped ?? 0,
    part,
    parts,
    count: recs.length,
    recs
  });
}

function publish(arc: FiscalArchiveState): void {
  if (typeof RawMemory === "undefined") return;
  const shards = shard(arc.recs);
  for (let i = 0; i < ARCHIVE_SEGMENTS.length; i++) {
    try {
      // Segments past the last shard are written EMPTY, not left stale: a reader
      // merging a live shard with a leftover one would resurrect dropped months.
      RawMemory.segments[ARCHIVE_SEGMENTS[i]] = payload(arc, i, shards.length, shards[i] ?? []);
    } catch {
      // Segment quota exceeded this tick - drop the publish, never the tick. The
      // ring itself is in Memory and unaffected; the next tick republishes.
    }
  }
}
