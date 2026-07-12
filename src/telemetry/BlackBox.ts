/**
 * @fileoverview BlackBox - the colony's flight recorder (spec 09 phase 4).
 *
 * A compact ring of the last ~200 ticks of DECISIONS - spawns bought, spawns
 * held (and why), commission churn, watch samples (downgrade timer, bucket),
 * and caught errors - so a live incident arrives with its own recent history
 * attached instead of demanding archaeology. Sims never catch the live-only
 * failure classes (stale spawn ids, lost vision); the black box is how those
 * incidents become fixtures (`npm run capture:incident`).
 *
 * Rows are fixed-shape and small: { t, k, d } (tick, kind, data). The ring
 * lives on the heap and is flushed to RawMemory segment 5 (public, so the
 * capture script and telemetry-app read it without auth gymnastics) every
 * FLUSH_INTERVAL ticks, plus a small tail into Memory.blackBoxTail so a
 * global reset - often the most interesting moment - still leaves evidence.
 *
 * @module telemetry/BlackBox
 */

import "../types/Memory"; // Memory.blackBoxTail augmentation

export const BLACKBOX_SEGMENT = 5;

/** Row kinds. Keep the vocabulary tiny and stable - dashboards parse it. */
export type BlackBoxKind =
  | "spawn" // a creep was bought: {role, corp, cost}
  | "hold" // an evaluated spawn bought nothing: {why, top role/corp, bank}
  | "churn" // commission set changed: {created, demobilized}
  | "watch" // periodic sample: {dt: downgradeTicks, bucket, creeps}
  | "err"; // a caught error: {phase, msg (truncated)}

export interface BlackBoxRow {
  t: number;
  k: BlackBoxKind;
  d: Record<string, unknown>;
}

const MAX_ROWS = 400; // ~200 ticks of mixed traffic; segment stays well under 100KB
const FLUSH_INTERVAL = 10;
const TAIL_ROWS = 40; // survives resets in Memory (kept small - Memory is parsed every tick)
const ERR_MSG_MAX = 160;

let ring: BlackBoxRow[] = [];

/** Record one decision row. Cheap; call from anywhere in the loop. */
export function record(kind: BlackBoxKind, data: Record<string, unknown>, tick?: number): void {
  const t = tick ?? (typeof Game !== "undefined" ? Game.time : 0);
  if (kind === "err" && typeof data.msg === "string" && data.msg.length > ERR_MSG_MAX) {
    data = { ...data, msg: (data.msg as string).slice(0, ERR_MSG_MAX) };
  }
  ring.push({ t, k: kind, d: data });
  if (ring.length > MAX_ROWS) ring.splice(0, ring.length - MAX_ROWS);
}

/** The current ring (read-only view), for tests and the flush. */
export function rows(): readonly BlackBoxRow[] {
  return ring;
}

/** Test seam. */
export function reset(): void {
  ring = [];
}

/**
 * Flush the ring to segment 5 + the reset-surviving tail. Call once per tick
 * from the telemetry phase; it self-gates to every FLUSH_INTERVAL ticks.
 * `alerts` are the watchdog verdicts (telemetry/watchdogs, evaluated by the
 * BOT so the rules live in one unit-tested place) - the dashboard displays
 * them, it never re-derives them.
 */
export function flush(tick: number, alerts: ReadonlyArray<{ kind: string; message: string }> = []): void {
  if (tick % FLUSH_INTERVAL !== 0) return;
  if (typeof RawMemory !== "undefined") {
    try {
      RawMemory.segments[BLACKBOX_SEGMENT] = JSON.stringify({ v: 1, tick, alerts, rows: ring });
    } catch {
      // Segment quota exceeded this tick - drop the flush, never the tick.
    }
  }
  if (typeof Memory !== "undefined") {
    Memory.blackBoxTail = ring.slice(-TAIL_ROWS);
  }
}

/** Tick of the last "spawn" row in the ring (0 when none) - watchdog input. */
export function lastSpawnTick(): number {
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i].k === "spawn") return ring[i].t;
  }
  return 0;
}

/** "err" rows currently in the ring - watchdog input. */
export function errRowCount(): number {
  return ring.reduce((n, r) => n + (r.k === "err" ? 1 : 0), 0);
}
