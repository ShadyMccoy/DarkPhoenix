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
import { recordLinkFire } from "../telemetry/LinkMeter";
import { routeSourceVolley } from "./linkRouting";
import { WARCHEST_TARGET } from "../economy/bank";

/**
 * Don't fire a dribble: wait until the source link holds at least this much, so
 * the (distance-long) cooldown and the 3% transfer fee are paid on a full-ish
 * load. Miners feed 50 per transfer, so this is a couple of feeds.
 */
const LINK_FIRE_THRESHOLD = 100;

/**
 * At/above warchest the core->controller RELAY yields to direct source deposits:
 * it only tops the controller link once it drains below this low-water mark
 * (direct fell behind). Without this the relay refills the controller link every
 * tick, leaving no room for a source volley - so direct share stayed 0% (measured
 * t72528xxx, the first stage-2 deploy). Above low-water, source links keep it
 * topped 1-hop; below, the relay is the safety net so the controller never
 * starves. Below warchest the relay is unchanged (bank-first regime).
 */
const CONTROLLER_LINK_LOW_WATER = 400;

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

    // The controller link is WITHDRAW-ONLY (upgraders take from it; nothing
    // deposits and it never fires onward - "terminal"). Sources may deposit
    // straight into it, but it must never fire back - a two-link ping-pong burns
    // 3% per hop.
    const ctrl = controllerLink(room);

    // v1 control law (spec-26 stage 2): prefer the cheap 1-hop DIRECT deposit
    // into the controller only once the WARCHEST is satisfied - below it,
    // production-first keeps banking at the core (unchanged, no regression).
    // The instrument (LinkMeter) measures the resulting direct share; a tighter
    // feederRelayRate cap is the v2 refinement if this over-feeds.
    const banked = room.storage?.my ? room.storage.store?.[RESOURCE_ENERGY] ?? 0 : 0;
    const preferControllerDirect = banked >= WARCHEST_TARGET;

    for (const link of links) {
      if (link.id === core.id) continue;
      if (ctrl && link.id === ctrl.id) continue; // withdraw-only, never a sender
      if (link.cooldown > 0) continue;
      if (link.store[RESOURCE_ENERGY] < LINK_FIRE_THRESHOLD) continue;
      const decision = routeSourceVolley({
        coreFree: core.store.getFreeCapacity(RESOURCE_ENERGY),
        controllerFree: ctrl ? ctrl.store.getFreeCapacity(RESOURCE_ENERGY) : null,
        controllerUnderPlan: preferControllerDirect,
        threshold: LINK_FIRE_THRESHOLD
      });
      const target = decision === "core" ? core : decision === "controllerDirect" ? ctrl : null;
      if (target) {
        // Instrument (LinkMeter): the intended volley = what fits at the target.
        const amount = Math.min(link.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY));
        link.transferEnergy(target);
        recordLinkFire(room.name, ctrl && target.id === ctrl.id ? "controllerDirect" : "hub", amount, Game.time);
      }
    }

    // The relay is a FALLBACK at warchest: fire only once the controller link
    // drains below low-water, so source links get the room to deposit direct
    // (1 hop). Below warchest it fires whenever there's room (bank-first regime,
    // source links go to the core - the relay does the controller feed).
    const relayYieldsToDirect = preferControllerDirect && ctrl && ctrl.store[RESOURCE_ENERGY] >= CONTROLLER_LINK_LOW_WATER;
    if (
      ctrl &&
      !relayYieldsToDirect &&
      core.cooldown === 0 &&
      core.store[RESOURCE_ENERGY] >= LINK_FIRE_THRESHOLD &&
      ctrl.store.getFreeCapacity(RESOURCE_ENERGY) >= LINK_FIRE_THRESHOLD
    ) {
      const amount = Math.min(core.store[RESOURCE_ENERGY], ctrl.store.getFreeCapacity(RESOURCE_ENERGY));
      core.transferEnergy(ctrl);
      recordLinkFire(room.name, "controllerRelay", amount, Game.time);
    }
  }
}
