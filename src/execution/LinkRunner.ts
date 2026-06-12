/**
 * @fileoverview LinkRunner - operate each owned room's link network (RCL 5+).
 *
 * The network has one shape: SOURCE links (fed by the miner standing beside
 * them) fire their energy to the CORE link beside the storage, where the
 * haulers pick it up (see nodeEnergy.sourcePickupSpot). This replaces the long
 * source->core haul with an instant transfer, so a far in-room source costs
 * almost nothing to log home once its link pair is built.
 *
 * Firing is intent-only and cheap; this runs every tick from the main loop.
 *
 * @module execution/LinkRunner
 */

import { coreLink } from "../corps/nodeEnergy";

/**
 * Don't fire a dribble: wait until the source link holds at least this much, so
 * the (distance-long) cooldown and the 3% transfer fee are paid on a full-ish
 * load. Miners feed 50 per transfer, so this is a couple of feeds.
 */
const LINK_FIRE_THRESHOLD = 100;

/** Run the link network of every owned room. */
export function runLinks(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;

    const core = coreLink(room);
    if (!core) continue;

    const links = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_LINK
    }) as StructureLink[];

    for (const link of links) {
      if (link.id === core.id) continue;
      if (link.cooldown > 0) continue;
      if (link.store[RESOURCE_ENERGY] < LINK_FIRE_THRESHOLD) continue;
      if (core.store.getFreeCapacity(RESOURCE_ENERGY) === 0) continue;
      link.transferEnergy(core);
    }
  }
}
