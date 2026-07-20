/**
 * @fileoverview Expansion campaign driver (spec 06), EXECUTION half: gather
 * the live facts, run the pure trigger/ranking (economy/expansion), persist
 * the campaign in Memory.expansion, and - once the room is owned - place the
 * founding spawn site so the planner sees it as the NEW_SPAWN_SITE_VALUE
 * construction sink. Everything after the claim is economics: no scripted
 * campaign, the energy funnels because the sink outprices ordinary work.
 *
 * Split out of economy/expansion.ts (spec 17 P3): a game intent
 * (createConstructionSite) and Memory writes have no business in the planning
 * directory. Behavior is unchanged.
 *
 * @module execution/ExpansionCampaign
 */

import {
  EXPAND_TIMEOUT,
  ExpansionFacts,
  expansionCandidates,
  shouldExpand
} from "../economy/expansion";
import { Node } from "../nodes/Node";
import { hostileRooms } from "../utils/RoomDiscovery";

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

/** The live facts the pure candidate ranking consumes. */
function gatherFacts(): ExpansionFacts {
  return {
    placements: Memory.spawnPlacements ?? {},
    intel: Memory.roomIntel ?? {},
    hostileRooms: hostileRooms()
  };
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
  const candidates = expansionCandidates(nodes, ownedRooms, gatherFacts());
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
