/**
 * @fileoverview Expansion trigger + campaign state (spec 06): decide WHEN to
 * claim the next room and WHICH one, persist the campaign in Memory.expansion,
 * and - once the room is owned - place the founding spawn site so the colony
 * planner sees it as the NEW_SPAWN_SITE_VALUE construction sink (flowAdapter's
 * per-instance pricing). Everything after the claim is economics: no scripted
 * campaign, the energy funnels because the sink outprices ordinary work.
 *
 * The trigger is CAPITAL, not RCL (owner doctrine 2026-07-10: "saved up stocks
 * fund and plan producer corps"): a colony expands exactly when its bank has
 * accumulated the campaign's CAPEX on top of a safety reserve - producers are
 * investments with a CAPEX hump, and the bank exists to cross humps.
 *
 * @module economy/expansion
 */

import { Node } from "../nodes/Node";
import { hostileRooms, isSourceKeeperRoom } from "../utils/RoomDiscovery";

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

/** Savings: storage energy across owned rooms. Working buffers (containers,
 * spawn bank) are operating float, not capital - only the storage is the bank. */
export function bankedEnergy(): number {
  let total = 0;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;
    total += room.storage?.store.energy ?? 0;
  }
  return total;
}

/**
 * Rank claimable candidates: unowned nodes with a spawn placement, in rooms
 * that have a controller (per intel), are not SK/hostile/another player's,
 * and score at least EXPAND_MIN_SCORE. Sorted best-first by expansionScore.
 */
export function expansionCandidates(nodes: Node[], ownedRooms: Set<string>): ExpansionCandidate[] {
  const placements = Memory.spawnPlacements ?? {};
  const danger = hostileRooms();
  const out: ExpansionCandidate[] = [];
  for (const node of nodes) {
    if (!node.roi || node.roi.isOwned) continue;
    if (ownedRooms.has(node.roomName)) continue;
    if (isSourceKeeperRoom(node.roomName)) continue;
    if (danger.has(node.roomName)) continue;
    const intel = Memory.roomIntel?.[node.roomName];
    if (!intel?.controllerPos) continue; // controller-less (highway/SK) - not claimable
    if (intel.controllerOwner) continue; // another player's room
    const score = node.roi.expansionScore ?? 0;
    if (score < EXPAND_MIN_SCORE) continue;
    const spawnPos = placements[node.id];
    if (!spawnPos) continue; // placement scheduler hasn't priced this node yet
    out.push({ nodeId: node.id, roomName: node.roomName, score, spawnPos });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Campaign driver, called on the planning cadence. State machine over
 * Memory.expansion:
 *  - no campaign: evaluate shouldExpand and open one;
 *  - campaign, room not ours yet: nothing to do here (ClaimCorp's demand is
 *    gated on the same memory);
 *  - campaign, room OWNED: place the founding spawn site - from here the
 *    flow planner's NEW_SPAWN_SITE_VALUE sink does the funneling;
 *  - spawn stands or timeout: close the campaign.
 */
export function updateExpansionCampaign(nodes: Node[]): void {
  const expansion = Memory.expansion;
  if (expansion) {
    const room = Game.rooms[expansion.roomName];
    if (room && room.find(FIND_MY_SPAWNS).length > 0) {
      console.log(`[Expansion] ${expansion.roomName} founded - spawn stands, campaign complete`);
      delete Memory.expansion;
      return;
    }
    if (Game.time - expansion.sinceTick > EXPAND_TIMEOUT) {
      console.log(`[Expansion] ${expansion.roomName} campaign timed out after ${EXPAND_TIMEOUT} ticks - abandoning`);
      delete Memory.expansion;
      return;
    }
    if (room?.controller?.my) {
      const hasSpawnSite = room
        .find(FIND_MY_CONSTRUCTION_SITES)
        .some(s => s.structureType === STRUCTURE_SPAWN);
      if (!hasSpawnSite) {
        const { x, y } = expansion.spawnPos;
        const result = room.createConstructionSite(x, y, STRUCTURE_SPAWN);
        if (result === OK) {
          console.log(`[Expansion] founding spawn site placed at ${x},${y} in ${expansion.roomName}`);
        } else if (result !== ERR_RCL_NOT_ENOUGH) {
          // A blocked tile (creep parked, terrain drift) is permanent - fall
          // back to the room's current best placement next planning pass.
          console.log(`[Expansion] spawn site at ${x},${y} in ${expansion.roomName} failed (${result})`);
        }
      }
    }
    return;
  }

  const ownedRooms = new Set<string>();
  for (const roomName in Game.rooms) {
    if (Game.rooms[roomName].controller?.my) ownedRooms.add(roomName);
  }
  const candidates = expansionCandidates(nodes, ownedRooms);
  if (!shouldExpand(Game.gcl.level, ownedRooms.size, candidates, bankedEnergy())) return;

  const target = candidates[0];
  Memory.expansion = {
    roomName: target.roomName,
    nodeId: target.nodeId,
    spawnPos: target.spawnPos,
    sinceTick: Game.time
  };
  console.log(
    `[Expansion] campaign opened: claim ${target.roomName} (node ${target.nodeId}, score ${target.score.toFixed(0)})`
  );
}
