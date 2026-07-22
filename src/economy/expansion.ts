/**
 * @fileoverview Expansion economics (spec 06), PURE half: the capital-gated
 * trigger and candidate ranking. The campaign STATE MACHINE (Memory.expansion
 * writes, the founding-spawn construction intent, timeouts) is execution-layer
 * work and lives in execution/ExpansionCampaign.ts (spec 17 P3 split) - this
 * module is a pure function of the facts handed to it, and the purity ratchet
 * (test/unit/economy/purity.test.ts) enforces that.
 *
 * The trigger is CAPITAL, not RCL (owner doctrine 2026-07-10: "saved up stocks
 * fund and plan producer corps"): a colony expands exactly when its bank has
 * accumulated the campaign's CAPEX on top of a safety reserve - producers are
 * investments with a CAPEX hump, and the bank exists to cross humps.
 *
 * @module economy/expansion
 */

import { Node } from "../nodes/Node";
import { isSourceKeeperRoom } from "../utils/RoomDiscovery";

/** Claimer body (CLAIM 600 + MOVE 50). */
export const CLAIMER_COST = 650;
/** A spawn's construction energy. */
const SPAWN_BUILD_COST = 15_000;
/** Seed bodies to bootstrap the new room until its own economy stands. */
const SEED_BODY_BUDGET = 2_000;
/** The campaign's total capital outlay. */
export const EXPANSION_CAPEX = CLAIMER_COST + SPAWN_BUILD_COST + SEED_BODY_BUDGET;
/** Banked energy that must REMAIN after committing the CAPEX. */
export const EXPANSION_SAFETY_RESERVE = 5_000;
/** Minimum candidate expansionScore (Node ROI scale; see calculateNodeROI). */
export const EXPAND_MIN_SCORE = 50;
/** Abandon a campaign that shows no progress for this long. */
export const EXPAND_TIMEOUT = 20_000;

/** An expansion candidate: an unowned node with a computed spawn placement. */
export interface ExpansionCandidate {
  nodeId: string;
  roomName: string;
  score: number;
  spawnPos: { x: number; y: number; roomName: string };
}

/**
 * The world facts candidate ranking needs, gathered by the EXECUTION caller
 * (ExpansionCampaign reads Memory.spawnPlacements / Memory.roomIntel / the
 * hostile lens) and passed in as data - this module never reads globals.
 */
export interface ExpansionFacts {
  /** Spawn placements priced by the placement scheduler, by node id. */
  placements: { [nodeId: string]: { x: number; y: number; roomName: string } | undefined };
  /** Room intel: controller position (claimability) and owner. */
  intel: {
    [roomName: string]:
      | { controllerPos?: { x: number; y: number } | null; controllerOwner?: string | null }
      | undefined;
  };
  /** Rooms marked hostile by the vision-free defense lens. */
  hostileRooms: ReadonlySet<string>;
}

/**
 * PURE trigger (spec 06): expand when GCL has headroom over the rooms we own,
 * a worthwhile candidate exists, and savings underwrite the whole campaign.
 */
export function shouldExpand(
  gclLevel: number,
  ownedRoomCount: number,
  candidates: ExpansionCandidate[],
  bankedEnergy: number
): boolean {
  if (gclLevel <= ownedRoomCount) return false;
  if (candidates.length === 0) return false;
  return bankedEnergy >= EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE;
}

/**
 * Rank claimable candidates: unowned nodes with a spawn placement, in rooms
 * that have a controller (per intel), are not SK/hostile/another player's,
 * and score at least EXPAND_MIN_SCORE. Sorted best-first by expansionScore.
 * Pure - every world fact arrives via {@link ExpansionFacts}.
 */
export function expansionCandidates(
  nodes: Node[],
  ownedRooms: Set<string>,
  facts: ExpansionFacts
): ExpansionCandidate[] {
  const out: ExpansionCandidate[] = [];
  for (const node of nodes) {
    if (!node.roi || node.roi.isOwned) continue;
    if (ownedRooms.has(node.roomName)) continue;
    if (isSourceKeeperRoom(node.roomName)) continue;
    if (facts.hostileRooms.has(node.roomName)) continue;
    const intel = facts.intel[node.roomName];
    if (!intel?.controllerPos) continue; // controller-less (highway/SK) - not claimable
    if (intel.controllerOwner) continue; // another player's room
    const score = node.roi.expansionScore ?? 0;
    if (score < EXPAND_MIN_SCORE) continue;
    const spawnPos = facts.placements[node.id];
    if (!spawnPos) continue; // placement scheduler hasn't priced this node yet
    out.push({ nodeId: node.id, roomName: node.roomName, score, spawnPos });
  }
  return out.sort((a, b) => b.score - a.score);
}
