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
 * Vocabulary (owner-locked): a link is a relay-SOURCE, never a sink. "hub" is the
 * core relay-source; "controller*" is the terminal relay-source feeding the
 * controller SINK. `direct` is the subset that skipped the hub (correspondent
 * settlement, 1 hop instead of 2).
 *
 * @module telemetry/LinkMeter
 */

/** Where a fired volley landed, in planner terms. */
export type LinkFireTarget = "hub" | "controllerRelay" | "controllerDirect";

/** The 3% link transfer fee (Screeps LINK_LOSS_RATIO). */
export const LINK_LOSS_RATIO = 0.03;

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
  /** Window start (re-inits on a global reset). */
  sinceTick: number;
}

const meter = new Map<string, LinkMeterRoom>();

/** Record one fire's intended volley. `amount` is the energy moved (pre-tax). */
export function recordLinkFire(room: string, target: LinkFireTarget, amount: number, tick: number): void {
  if (amount <= 0) return;
  let m = meter.get(room);
  if (!m) {
    m = { toHub: 0, toController: 0, direct: 0, fires: 0, sinceTick: tick };
    meter.set(room, m);
  }
  if (target === "hub") {
    m.toHub += amount;
  } else {
    m.toController += amount;
    if (target === "controllerDirect") m.direct += amount;
  }
  m.fires += 1;
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
      taxRate: (total * LINK_LOSS_RATIO) / w
    });
  }
  return out;
}

/** Test seam / global-reset hook. */
export function resetLinkMeter(): void {
  meter.clear();
}
