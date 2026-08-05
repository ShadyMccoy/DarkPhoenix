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
import { holdCoreRelay, routeSourceVolley } from "./linkRouting";
import { resolveReserveTarget } from "../economy/bank";
// Don't fire a dribble: the fire gate is homed in primitives (one leaf, shared
// with the LinkMeter's core-fill sampler) - rationale at the declaration.
import { LINK_FIRE_THRESHOLD } from "../economy/primitives";

/**
 * Chebyshev range between two links, or undefined when the harness supplies a
 * partial position (the routing rule treats a missing range as neutral, so a
 * mock without getRangeTo keeps its pre-throughput behaviour instead of
 * throwing). Live RoomPositions always answer.
 */
function rangeBetween(from: StructureLink, to: StructureLink): number | undefined {
  return typeof from.pos?.getRangeTo === "function" ? from.pos.getRangeTo(to.pos) : undefined;
}

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

    // ARRIVALS-FIRST (spec 45 leg 1): count the ports that could take CTRL's
    // space DIRECTLY this tick, BEFORE any fire. Screeps intents are deferred -
    // `link.store` still reads its pre-fire value after transferEnergy - so
    // this must be computed up front rather than re-read below, or a port that
    // just fired would still count as pending.
    const pendingSenders = links.filter(
      l =>
        l.id !== core.id &&
        !(ctrl && l.id === ctrl.id) &&
        l.cooldown === 0 &&
        l.store[RESOURCE_ENERGY] >= LINK_FIRE_THRESHOLD
    ).length;

    for (const link of links) {
      if (link.id === core.id) continue;
      if (ctrl && link.id === ctrl.id) continue; // withdraw-only, never a sender
      if (link.cooldown > 0) continue;
      if (link.store[RESOURCE_ENERGY] < LINK_FIRE_THRESHOLD) continue;
      const decision = routeSourceVolley({
        coreFree: core.store.getFreeCapacity(RESOURCE_ENERGY),
        controllerFree: ctrl ? ctrl.store.getFreeCapacity(RESOURCE_ENERGY) : null,
        controllerUnderPlan: preferControllerDirect,
        threshold: LINK_FIRE_THRESHOLD,
        // The three facts the throughput rule needs (owner 2026-07-29): what
        // this link would send, and what each hop costs in cooldown. The
        // engine clamps the transfer to the target's free capacity but charges
        // LINK_COOLDOWN * range in FULL, so a nearly-full controller link used
        // to capture fires it could not absorb and the source stayed backed up.
        payload: link.store[RESOURCE_ENERGY],
        coreRange: rangeBetween(link, core),
        controllerRange: ctrl ? rangeBetween(link, ctrl) : undefined
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

    // The relay is the FALLBACK controller feed, not the competitor: while a
    // port stands loaded and off cooldown, CTRL's space belongs to the cheaper
    // one-hop direct fire (spec 45 leg 1 - see holdCoreRelay for the measured
    // clamp-vs-empty evidence and the warchest carve-out).
    const relayHeld = holdCoreRelay({
      pendingSenders,
      preferControllerDirect,
      controllerFree: ctrl ? ctrl.store.getFreeCapacity(RESOURCE_ENERGY) : null,
      threshold: LINK_FIRE_THRESHOLD
    });

    if (
      ctrl &&
      !relayHeld &&
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
