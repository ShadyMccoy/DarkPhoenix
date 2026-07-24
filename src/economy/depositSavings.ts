/**
 * @fileoverview depositSavings - the spec-26 DEPOSIT-side instrument (stage 4).
 *
 * A remote hauler is a creep: it carries energy across the room boundary INTO
 * the home room, then walks all the way to storage. But it passes home-room
 * links on the way. If it DEPOSITED at one of those (a source link that fires to
 * the core), the link would finish the in-room last leg by teleport and the
 * hauler could turn around early - a shorter route, a smaller body. (Cross-room
 * link-to-link is impossible; the hauler bridges the rooms, the link only does
 * the in-room hop - this is legal where a link fire is not.)
 *
 * This module MEASURES the opportunity before any routing changes: for each
 * source, the nearest DEPOSIT-capable home-room link and the route it would
 * save, plus the flow that would pile onto each link (the throughput the owner
 * flagged: "don't send more than the link can handle"). Read-only knowledge; the
 * depositPos plumbing re-activation is a later, data-driven step.
 *
 * IMPORTANT: candidate links are DEPOSIT links only - ones that fire to the core
 * and bank. The terminal controller link (withdraw-only) is NOT a candidate: a
 * hauler depositing there would misroute its bank energy into the controller.
 * The caller filters the controller link out before passing `links`.
 *
 * Pure and unit-pinned; the caller supplies positions and the dist function.
 *
 * @module economy/depositSavings
 */

import { Position } from "../types/Position";

/** A source the plan hauls, with its current haul distance to storage. */
export interface DepositSource {
  id: string;
  pos: Position;
  /** Energy/tick the source ships. */
  flowRate: number;
  /** Current haul distance source -> storage (the plan's number). */
  haulDist: number;
}

/** A deposit-capable home-room link (fires to the core; NOT the controller link). */
export interface DepositLink {
  id: string;
  pos: Position;
}

/** One source's best deposit opportunity. */
export interface DepositCandidate {
  sourceId: string;
  haulDist: number;
  linkId: string;
  /** Distance source -> deposit link. */
  linkDist: number;
  /** Tiles saved on the one-way haul (haulDist - linkDist). */
  saving: number;
  flowRate: number;
}

/** Per-link throughput load once deposits pile on. */
export interface LinkLoad {
  linkId: string;
  /** Sum of flowRate of sources that would deposit here. */
  depositFlow: number;
  sources: number;
}

export interface DepositSavingsReport {
  candidates: DepositCandidate[];
  perLink: LinkLoad[];
  /** The terminal controller link, when it is among the deposit candidates. A
   * deposit here is NOT a misroute: it displaces an equal core->controller relay
   * feed (bank-neutral) - but only UP TO `controllerCapacity` e/t (the
   * controller's feed rate). Deposit flow beyond that can't be absorbed (the
   * controller link is terminal and fills). Set by the caller, which knows the
   * feed rate; the routing enforces the cap, the instrument just surfaces it. */
  controllerLinkId?: string;
  controllerCapacity?: number;
}

/**
 * For each source, find the nearest deposit-capable link and the route it would
 * save (haulDist - source->link). A source is a candidate only when a link is at
 * least `minSaving` tiles closer than storage - a shorter walk that actually
 * pays for the turn-around and the 3% link toll. Aggregates the deposit flow per
 * link so an over-subscribed link is visible before we route to it.
 */
export function computeDepositSavings(
  sources: DepositSource[],
  links: DepositLink[],
  dist: (a: Position, b: Position) => number,
  minSaving = 5
): DepositSavingsReport {
  const candidates: DepositCandidate[] = [];
  const load = new Map<string, LinkLoad>();

  for (const s of sources) {
    let best: { link: DepositLink; d: number } | null = null;
    for (const link of links) {
      const d = dist(s.pos, link.pos);
      if (best === null || d < best.d) best = { link, d };
    }
    if (!best) continue;
    const saving = s.haulDist - best.d;
    if (saving < minSaving) continue;
    candidates.push({
      sourceId: s.id,
      haulDist: s.haulDist,
      linkId: best.link.id,
      linkDist: best.d,
      saving,
      flowRate: s.flowRate
    });
    const l = load.get(best.link.id) ?? { linkId: best.link.id, depositFlow: 0, sources: 0 };
    l.depositFlow += s.flowRate;
    l.sources += 1;
    load.set(best.link.id, l);
  }

  return { candidates, perLink: [...load.values()] };
}
