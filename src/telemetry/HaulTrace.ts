/**
 * @fileoverview HaulTrace - a per-tick flight recorder for ONE hauler.
 *
 * Owner 2026-08-02: *"I think we should maybe just store to memory each of the
 * 1500 ticks of a hauler. See what it's doing. Or not doing."*
 *
 * Every hauling instrument we have is an AGGREGATE, and aggregates answer the
 * wrong question. The duty meter says a corp's creeps were "active" 94% of
 * ticks; `staged` says the source held 2860 energy; `carryNeeded` says the
 * fleet is sized correctly - and cd8e still ran buffer-full for 100% of a
 * window with sufficient carry fielded. Every one of those numbers is a MEAN
 * over a bimodal life, which is exactly the failure spec 40 was written about.
 *
 * A mean cannot show you a hauler standing on one tile for forty ticks. A
 * timeline can.
 *
 * WHAT IS RECORDED, and why each field earns its bytes:
 *   pos + room   where it stood - the difference between "stuck at the source",
 *                "stuck at the sink" and "oscillating in a lane"
 *   energy       the load, so a full creep parked outside a sink is visible
 *   leg          which half of the circuit it believes it is on (memory.working)
 *   class        the duty classifier's verdict for the tick, unaggregated
 *   target       the id it is currently driving at
 *
 * Cost is deliberately bounded: ONE creep, one row per tick, flushed to its own
 * segment on a stride. Segments are not parsed each tick the way Memory is, so
 * this costs nothing until it is read - which is the whole reason it does not
 * live in Memory despite the owner's phrasing.
 *
 * ARMING (live console):
 *   Memory.haulTrace = { corp: "mining-W43N24-harvest-cd8e" }   // first hauler of that corp
 *   Memory.haulTrace = { creep: "h_1234" }                       // a specific creep
 *   delete Memory.haulTrace                                      // stop
 *
 * The subject is LOCKED once chosen, so the trace follows one life rather than
 * hopping between creeps and producing a timeline of nobody.
 *
 * @module telemetry/HaulTrace
 */

import { TELEMETRY_SEGMENTS } from "./segmentIds";
import { CREEP_LIFETIME } from "../economy/primitives";
import "../types/Memory"; // Memory.haulTrace augmentation (the arming key)

/** Rows kept. One creep generation; the ring drops the oldest beyond it. */
export const HAUL_TRACE_MAX_ROWS = CREEP_LIFETIME;
/** Flush cadence - stringifying the ring every tick would be the only real cost. */
const FLUSH_STRIDE = 25;

/** The tick classifier's verdict, as the duty meter already computes it. */
export type HaulTickClass = "active" | "idleSource" | "idleSink" | "seed";

/**
 * One tick of one hauler, as a positional tuple rather than an object - 1500
 * objects of named keys would not fit a segment, 1500 short arrays do.
 * [tick, x, y, roomIdx, energy, leg(0 deliver/1 load), class, targetIdx]
 */
export type HaulTraceRow = [number, number, number, number, number, number, number, number];

const CLASS_CODE: Record<HaulTickClass, number> = { active: 0, idleSource: 1, idleSink: 2, seed: 3 };

interface TraceState {
  subject: string;
  corpId: string;
  bornAt: number;
  rooms: string[];
  targets: string[];
  rows: HaulTraceRow[];
  body: { carry: number; move: number };
}

let state: TraceState | undefined;
let lastFlush = 0;

/** Drop the recorder (global reset, or a test). */
export function resetHaulTrace(): void {
  state = undefined;
  lastFlush = 0;
}

function intern(list: string[], value: string): number {
  const i = list.indexOf(value);
  if (i >= 0) return i;
  list.push(value);
  return list.length - 1;
}

/**
 * Record one tick for the armed subject. Called from the duty meter, which
 * already holds the REALIZED position and energy for the tick (pos/store still
 * carry last tick's outcome), so the trace records what happened rather than
 * what was intended.
 */
export function traceHaulTick(
  creep: Creep,
  corpId: string,
  tick: number,
  energy: number,
  verdict: HaulTickClass
): void {
  const armed = typeof Memory !== "undefined" ? Memory.haulTrace : undefined;
  if (!armed) {
    if (state) resetHaulTrace(); // disarmed live: stop cleanly, keep the segment
    return;
  }

  // SUBJECT LOCK. Follow one life; a trace that hops between creeps is a
  // timeline of nobody.
  if (!state) {
    if (armed.creep && armed.creep !== creep.name) return;
    if (armed.corp && armed.corp !== corpId) return;
    state = {
      subject: creep.name,
      corpId,
      bornAt: tick,
      rooms: [],
      targets: [],
      rows: [],
      body: {
        carry: creep.getActiveBodyparts(CARRY),
        move: creep.getActiveBodyparts(MOVE)
      }
    };
  }
  if (state.subject !== creep.name) return;

  const mem = creep.memory as unknown as {
    working?: boolean;
    deliveryTargetId?: string;
    deliverSinkId?: string;
    assignedSourceId?: string;
  };
  const target = mem.deliveryTargetId ?? mem.deliverSinkId ?? mem.assignedSourceId ?? "";

  state.rows.push([
    tick,
    creep.pos.x,
    creep.pos.y,
    intern(state.rooms, creep.pos.roomName),
    Math.round(energy),
    mem.working ? 1 : 0,
    CLASS_CODE[verdict],
    target ? intern(state.targets, target) : -1
  ]);
  if (state.rows.length > HAUL_TRACE_MAX_ROWS) state.rows.splice(0, state.rows.length - HAUL_TRACE_MAX_ROWS);

  if (tick - lastFlush >= FLUSH_STRIDE) {
    lastFlush = tick;
    flushHaulTrace(tick);
  }
}

/** Serialize the ring to its segment. Cheap because it is stride-gated. */
export function flushHaulTrace(tick: number): void {
  if (!state || typeof RawMemory === "undefined") return;
  RawMemory.segments[TELEMETRY_SEGMENTS.HAUL_TRACE] = JSON.stringify({
    version: 1,
    tick,
    subject: state.subject,
    corpId: state.corpId,
    bornAt: state.bornAt,
    body: state.body,
    rooms: state.rooms,
    targets: state.targets,
    /** [tick, x, y, roomIdx, energy, leg, class, targetIdx] */
    rows: state.rows
  });
}

/** Test/console read-side view of the current ring. */
export function haulTraceRows(): HaulTraceRow[] {
  return state ? state.rows.slice() : [];
}

/** The subject this recorder locked onto, if any. */
export function haulTraceSubject(): string | undefined {
  return state?.subject;
}
