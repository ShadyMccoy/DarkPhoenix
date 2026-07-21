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

import { controllerLink, coreLink } from "../corps/nodeEnergy";

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

    // The controller link is a SINK (spec 24 rung 3): the core fires INTO it
    // (the feeder loads the core from storage one tile away), and it must
    // never fire back at the core - a two-link ping-pong burns 3% per hop.
    const ctrl = controllerLink(room);

    for (const link of links) {
      if (link.id === core.id) continue;
      if (ctrl && link.id === ctrl.id) continue; // sink, never a sender
      if (link.cooldown > 0) continue;
      if (link.store[RESOURCE_ENERGY] < LINK_FIRE_THRESHOLD) continue;
      // BANK FIRST: income lands at the core (the hub the haulers drain).
      // When the core is congested - full, or without room for a meaningful
      // volley - spill DIRECTLY to the controller link instead (owner
      // 2026-07-21: "it can send to the upgrader link as well"): one 3% hop
      // instead of two, into the sink the relay was feeding anyway. A
      // sub-volley core remainder is still taken before holding outright.
      const coreFree = core.store.getFreeCapacity(RESOURCE_ENERGY);
      const target =
        coreFree >= LINK_FIRE_THRESHOLD
          ? core
          : ctrl && ctrl.store.getFreeCapacity(RESOURCE_ENERGY) >= LINK_FIRE_THRESHOLD
          ? ctrl
          : coreFree > 0
          ? core
          : null;
      if (target) link.transferEnergy(target);
    }

    if (
      ctrl &&
      core.cooldown === 0 &&
      core.store[RESOURCE_ENERGY] >= LINK_FIRE_THRESHOLD &&
      ctrl.store.getFreeCapacity(RESOURCE_ENERGY) >= LINK_FIRE_THRESHOLD
    ) {
      core.transferEnergy(ctrl);
    }
  }
}
