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
import { recordLinkFire, recordCoreLevel } from "../telemetry/LinkMeter";
import { routeSourceVolley } from "./linkRouting";
import { resolveReserveTarget } from "../economy/bank";
// Don't fire a dribble: the fire gate is homed in primitives (one leaf, shared
// with the LinkMeter's core-fill sampler) - rationale at the declaration.
import { LINK_FIRE_THRESHOLD } from "../economy/primitives";

/** Run the link network of every owned room. */
export function runLinks(): void {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;

    const core = coreLink(room);
    if (!core) continue;

    // Sample the core fill EVERY tick (fire or not): the level distribution that
    // decides drain-limited-congestion vs input-limited for the pinned-remote
    // investigation. Cheap: one read, aggregated in the meter.
    recordCoreLevel(
      room.name,
      core.store[RESOURCE_ENERGY],
      core.store[RESOURCE_ENERGY] + core.store.getFreeCapacity(RESOURCE_ENERGY),
      Game.time
    );

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
    // Spec 129 made the reserve a dynamic liquidity buffer; read the published
    // target through resolveReserveTarget so runtime and plan share ONE number.
    const preferControllerDirect =
      banked >= resolveReserveTarget(typeof Memory !== "undefined" ? Memory.warchestTarget : undefined);

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
        // `wanted` (what the source link held) lets the meter count volleys the
        // core clamped - the "fires partial because the core is congested" signal.
        const wanted = link.store[RESOURCE_ENERGY];
        const amount = Math.min(wanted, target.store.getFreeCapacity(RESOURCE_ENERGY));
        const isDirect = !!ctrl && target.id === ctrl.id;
        link.transferEnergy(target);
        recordLinkFire(room.name, isDirect ? "controllerDirect" : "hub", amount, Game.time, isDirect ? undefined : wanted);
      }
    }

    if (
      ctrl &&
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
