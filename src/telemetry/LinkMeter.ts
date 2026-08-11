/**
 * @fileoverview LinkMeter - the instrument for the spec-26 link economy.
 *
 * Instrument-first (owner 2026-07-23, "knowledge is power"): before the planner
 * models links, MEASURE what the link network actually carries. Every LinkRunner
 * fire records its energy and destination, so telemetry exports the ACTUAL link
 * throughput - how much lands at the hub vs is DELIVERED to the controller (the
 * receipt the first spec-26 lacked: it asserted "link has energy", which the
 * relay makes always-true), what share took the cheap 1-hop direct path, and the
 * 3% tax paid.
 *
 * Aggregated counters, NOT per-fire rows - so it never floods the black box ring.
 * Module state that re-inits on a global reset (a rolling window since the reset,
 * exactly like the tender duty meter). Rates = counter / (now - sinceTick).
 *
 * Vocabulary (owner-locked): a link is neither source nor sink - it's transit;
 * energy passes through. What defines it is what a CREEP does to it: a DEPOSIT
 * node (a creep loads it - miner at a source-link, feeder at the core) or a
 * WITHDRAW node (a creep unloads it - hauler at the core, upgrader at the
 * controller link). "hub" is the core deposit target; "controller*" deposits
 * into the controller's withdraw-only link. `direct` is the subset that skipped
 * the hub (correspondent settlement, 1 hop instead of 2).
 *
 * @module telemetry/LinkMeter
 */

import { LINK_FIRE_THRESHOLD, LINK_TRANSFER_LOSS } from "../economy/primitives";

/** Where a fired volley landed, in planner terms. */
export type LinkFireTarget = "hub" | "controllerRelay" | "controllerDirect";

/** The 3% link transfer fee (Screeps LINK_LOSS_RATIO). Re-exported from
 *  primitives so the meter and the planner cannot drift apart - the planner
 *  now prices this too (see CorpPlanner's per-source tax term). */
export const LINK_LOSS_RATIO = LINK_TRANSFER_LOSS;

/**
 * The core-fill sampler's boundary IS the runner's fire gate (one home:
 * primitives.LINK_FIRE_THRESHOLD). A core BELOW it can't fire onward to the
 * controller AND a source volley would find room; a core whose FREE capacity
 * is below it can't take a worthwhile source volley (the congestion the
 * pinned-remote incident is about).
 */
const SAMPLE_THRESHOLD = LINK_FIRE_THRESHOLD;

/** Per-SENDER accumulator - the split the owner's link P&L asked for
 *  (2026-08-10: *"Can you show me a link income statement ... per each
 *  link"*). The room aggregate could not say which port carried what; the
 *  capture answered waits per ROUTE but throughput only per room. */
interface LinkMeterSender {
  fires: number;
  /** Energy actually moved (pre-tax) - the throughput column. */
  sent: number;
  /** Fires clamped by the receiver's free room (moved < held). */
  clamped: number;
}

/** Rolling per-room accumulator (energy, since a tick). */
export interface LinkMeterRoom {
  /** Energy fired INTO the core/hub relay-source. */
  toHub: number;
  /** Energy delivered to the controller relay-source (the delivery receipt). */
  toController: number;
  /** Subset of toController that skipped the hub (1-hop correspondent settle). */
  direct: number;
  /** Fire count (a saturation proxy against the window). */
  fires: number;
  /** Count of source-link fires INTO the hub (for the avg-volley diagnostic). */
  hubFires: number;
  /** Hub fires the core could NOT fully hold (moved < the source link wanted) -
   * the "4a83 fires partial because the core is congested" signal. */
  hubClamped: number;
  /** Per-tick core-fill samples (the level distribution the snapshots lacked). */
  coreSamples: number;
  /** Σ core fill across samples (→ average fill). */
  coreFillSum: number;
  /** Ticks the core sat BELOW threshold (drain out-runs income - a source volley
   * would have had room, so the hub throughput is input/fire-limited, not
   * drain-limited). */
  coreEmpty: number;
  /** Ticks the core's FREE capacity sat below threshold (no room for a source
   * volley - drain-limited congestion, the pinned-remote signature). */
  coreCongested: number;
  /** Window start (re-inits on a global reset). */
  sinceTick: number;
  /** Per-sender split, keyed by the sender link id's last 4 (the id form every
   *  spec and console read already uses). Bounded by the engine's 6-link cap
   *  per room, so it can never grow past a handful of keys. */
  perSender: Map<string, LinkMeterSender>;
}

const meter = new Map<string, LinkMeterRoom>();

function ensure(room: string, tick: number): LinkMeterRoom {
  let m = meter.get(room);
  if (!m) {
    m = {
      toHub: 0,
      toController: 0,
      direct: 0,
      fires: 0,
      hubFires: 0,
      hubClamped: 0,
      coreSamples: 0,
      coreFillSum: 0,
      coreEmpty: 0,
      coreCongested: 0,
      sinceTick: tick,
      perSender: new Map()
    };
    meter.set(room, m);
  }
  return m;
}

/**
 * Record one fire's intended volley. `amount` is the energy moved (pre-tax);
 * `wanted` (hub fires only) is what the source link held BEFORE the fire, so a
 * volley clamped by the core's free room (moved < wanted) is counted.
 * `senderId` (the firing link's id, any length - stored as its last 4)
 * attributes the fire to ITS link for the per-link P&L split; omitted by
 * legacy/harness callers, whose energy still lands in the room aggregate.
 */
export function recordLinkFire(
  room: string,
  target: LinkFireTarget,
  amount: number,
  tick: number,
  wanted?: number,
  senderId?: string
): void {
  if (amount <= 0) return;
  const m = ensure(room, tick);
  const clamped = wanted !== undefined && wanted > amount;
  if (target === "hub") {
    m.toHub += amount;
    m.hubFires += 1;
    if (clamped) m.hubClamped += 1;
  } else {
    m.toController += amount;
    if (target === "controllerDirect") m.direct += amount;
  }
  m.fires += 1;
  if (senderId) {
    const key = senderId.slice(-4);
    let s = m.perSender.get(key);
    if (!s) {
      s = { fires: 0, sent: 0, clamped: 0 };
      m.perSender.set(key, s);
    }
    s.fires += 1;
    s.sent += amount;
    if (clamped) s.clamped += 1;
  }
}

/**
 * Sample the core link's fill ONCE per tick (called every tick a core exists,
 * fire or not). This is the distribution the two-snapshot read could not give:
 * is the core usually EMPTY (drain out-runs income → hub is input/fire-limited)
 * or usually CONGESTED (no room for a source volley → drain-limited, the pinned
 * source link)? `capacity` is the core's max store.
 */
export function recordCoreLevel(room: string, fill: number, capacity: number, tick: number): void {
  const m = ensure(room, tick);
  m.coreSamples += 1;
  m.coreFillSum += fill;
  if (fill < SAMPLE_THRESHOLD) m.coreEmpty += 1;
  if (capacity - fill < SAMPLE_THRESHOLD) m.coreCongested += 1;
}

/** The exported ledger row for one room - all RATES (e/t) over the window. */
export interface LinkLedgerRoom {
  room: string;
  windowTicks: number;
  /** Energy/tick fired into the hub. */
  toHubRate: number;
  /** Energy/tick DELIVERED to the controller via link (the receipt). */
  toControllerRate: number;
  /** Fraction of controller energy that took the cheap 1-hop direct path. */
  directShare: number;
  /** Energy/tick lost to the 3% fee across all fires. */
  taxRate: number;
  /** Average energy moved per hub fire (a full volley is ~800; a low avg means
   * the source links fire small - starved input or a congested core). */
  hubVolleyAvg: number;
  /** Fraction of hub fires the core could not fully hold (drain-limited). */
  hubClampShare: number;
  /** Average core fill across the window (per-tick sampled). */
  coreFillAvg: number;
  /** Fraction of ticks the core sat near-empty (drain out-runs income). */
  coreEmptyShare: number;
  /** Fraction of ticks the core had no room for a source volley (congested). */
  coreCongestedShare: number;
  /** Per-SENDER split (id = link id last-4): each firing link's own
   *  throughput, volley shape and clamp share - the owner's per-link P&L
   *  column the room aggregate could not give. Present from core v39; absent
   *  entries mean a legacy caller recorded without a sender id. */
  perLink: {
    id: string;
    fires: number;
    sentRate: number;
    volleyAvg: number;
    clampShare: number;
  }[];
}

/** Snapshot every room's link ledger as rates. Pure over the accumulated meter. */
export function linkLedger(now: number): LinkLedgerRoom[] {
  const out: LinkLedgerRoom[] = [];
  for (const [room, m] of meter) {
    const w = Math.max(1, now - m.sinceTick);
    const total = m.toHub + m.toController;
    out.push({
      room,
      windowTicks: w,
      toHubRate: m.toHub / w,
      toControllerRate: m.toController / w,
      directShare: m.toController > 0 ? m.direct / m.toController : 0,
      taxRate: (total * LINK_LOSS_RATIO) / w,
      hubVolleyAvg: m.hubFires > 0 ? m.toHub / m.hubFires : 0,
      hubClampShare: m.hubFires > 0 ? m.hubClamped / m.hubFires : 0,
      coreFillAvg: m.coreSamples > 0 ? m.coreFillSum / m.coreSamples : 0,
      coreEmptyShare: m.coreSamples > 0 ? m.coreEmpty / m.coreSamples : 0,
      coreCongestedShare: m.coreSamples > 0 ? m.coreCongested / m.coreSamples : 0,
      // Sorted by throughput so the heaviest carrier reads first - the same
      // ordering every ranked ledger row uses.
      perLink: [...m.perSender.entries()]
        .map(([id, s]) => ({
          id,
          fires: s.fires,
          sentRate: s.sent / w,
          volleyAvg: s.fires > 0 ? s.sent / s.fires : 0,
          clampShare: s.fires > 0 ? s.clamped / s.fires : 0
        }))
        .sort((a, b) => b.sentRate - a.sentRate || (a.id < b.id ? -1 : 1))
    });
  }
  return out;
}

/** Test seam / global-reset hook. */
export function resetLinkMeter(): void {
  meter.clear();
}
