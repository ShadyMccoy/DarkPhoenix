/**
 * Corp-side economic constants and helpers that live CLOSE to body logic:
 * spawn build-rate, travel-tick estimation, and the reservation constants.
 * (The chain/virtual-projection layer that once lived here was retired by
 * spec 04 - site valuation now runs through economy/siteValue.)
 */

// The spawn build-rate and reservation-pricing constants (SPAWN_PARTS_PER_TICK,
// CLAIM_LIFETIME, RESERVER_DUTY) are homed in economy/primitives - spec 35
// phase B inverted the spec-17-P5 debt where the PLAN core imported them from
// this EXECUTE-directory file; phase G closed the one-release re-export
// tolerance (every importer reads primitives directly).

/**
 * Ticks a creep burns per tile walking from the spawn to its post.
 *
 * This is the bootstrap-awareness lever. Early on (low spawn capacity, no roads,
 * MOVE-poor bodies that move at a fraction of a tile per tick) every tile costs
 * several ticks of a short, precious life - so spawn placement matters a lot.
 * Later (bigger spawns imply higher RCL, roads, balanced bodies) a tile is close
 * to one tick and placement barely moves the needle. Energy capacity is the RCL
 * proxy. As the corps learn about roads/terrain this is the one place to sharpen.
 */
export function travelTicksPerTile(energyCapacity: number): number {
  const EARLY = 3; // RCL1: plain, no roads, slow bodies
  const LATE = 1; // RCL6+: roads, balanced bodies
  const t = Math.max(0, Math.min(1, (energyCapacity - 300) / (1300 - 300)));
  return EARLY - (EARLY - LATE) * t;
}

// ---------------------------------------------------------------------------
// Reserving a remote room
// ---------------------------------------------------------------------------

/**
 * Banked-reservation floor (ticks) below which a target room asks for a fresh
 * reserver. Covers the full delivery pipeline before the bank empties: queue
 * wait behind income buys + 24-tick build + a <=150-tick walk at the 1.5x
 * measured factor + margin. One 2-CLAIM stint nets ~+540 above the floor
 * (add 2/tick, decay 1/tick, ~540 working ticks), then coasts back down -
 * one stint per ~1080 ticks = the ~0.5 duty RESERVER_DUTY prices. The corp
 * IMPLEMENTING the duty it is priced at is spec 15 P5; before this gate it
 * re-staffed continuously (duty 1.0, 2x the priced spawn+energy cost).
 */
export const RESERVATION_REFRESH_FLOOR = 800;

/** The engine's reservation accumulation ceiling (ticks). */
export const RESERVATION_BANK_CAP = 5000;

/**
 * Opportunistic-topup threshold (task #11, owner idea): only offer an
 * idle-window reserver when the lowest bank has at least this much headroom
 * to the cap - a 2-CLAIM stint pumps ~+1/tick net, so less headroom than
 * this wastes most of the body's remaining life at the ceiling.
 */
export const OPPORTUNISTIC_BANK_HEADROOM = 1000;

/** Energy cost of the smallest reserver that can hold a room: 1 CLAIM + 1 MOVE. */
export const RESERVER_BODY_COST = 650;

