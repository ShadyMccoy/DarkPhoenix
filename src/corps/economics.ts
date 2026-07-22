/**
 * Corp-side economic constants and helpers that live CLOSE to body logic:
 * spawn build-rate, spawn-part pricing, travel-tick estimation, and the
 * reserver toll. (The chain/virtual-projection layer that once lived here was
 * retired by spec 04 - site valuation now runs through economy/siteValue.)
 */

/**
 * Body parts a single spawn can build per tick. A spawn produces one part every
 * SPAWN_TIME_PER_PART (3) ticks, so this is 1/3 - i.e. 500 parts over a creep's
 * 1500-tick life. It is the spawn's *time* budget, separate from and often
 * tighter than its energy budget: a far source can stay net-energy-positive yet
 * demand more hauler parts than the spawn can physically build. Corps compete for
 * this budget the same way they compete for energy, so a source that is too far
 * loses the competition and falls out - no hard distance limit required.
 */
export const SPAWN_PARTS_PER_TICK = 1 / 3;

/**
 * Energy value of one unit of spawn throughput - energy per (part/tick), i.e. the
 * energy a body part held continuously (respawned forever) is worth. Multiply a
 * roster's parts-per-tick by this to price its spawn build-time in energy,
 * then subtract from net (the effective-energy model, docs/ECONOMIC_FRAMEWORK). This
 * is what makes the spawn-time wall fall out of a pure-energy ranking: a far
 * source whose haulers eat the build budget is penalized enough to lose to a near
 * one, with no hard distance limit.
 *
 * Calibrated from a representative source at the average remote distance
 * (~75 tiles): it nets ~7.4 e/tick on ~70 body parts, so a held part is worth
 * ~7.4/70 ~ 0.1 e/tick, i.e. ~155 energy over its 1500-tick life. The implied
 * "harvest a spawn can support" is ~155 * 0.333 ~ 52 e/tick. Tunable; recalibrate
 * against real colonies.
 */
export const SPAWN_PART_ENERGY_VALUE = 155;

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
 * Lifetime of a creep carrying a CLAIM part (CREEP_CLAIM_LIFE_TIME). Reservers
 * live only 600 ticks, not 1500 - a big part of why the reserver toll is steep.
 */
export const CLAIM_LIFETIME = 600;

/**
 * Reserver duty cycle. A reservation accumulates (to 5000) and decays 1/tick, so a
 * reserver need not be present continuously - let it build up, let it tick down,
 * then top up. ~50% duty roughly halves the amortized cost.
 */
export const RESERVER_DUTY = 0.5;

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

/**
 * Energy-equivalent cost per tick of keeping ONE remote room reserved from a spawn
 * `distance` tiles away - the reserver's body upkeep plus its spawn build-time
 * priced in energy, amortized over its short (CLAIM) life and its duty cycle.
 * Returns Infinity when the room cannot even afford a reserver body (energyCapacity
 * < 650, i.e. below RCL 3) - so reserving simply never wins there, with no RCL gate.
 *
 * This is a per-ROOM cost: one reserver covers all of a room's sources, so callers
 * weigh it against the whole room's reserved gain (see {@link reserveRoomWorthIt}).
 */
export function reserverTollPerRoom(energyCapacity: number, distance: number): number {
  if (energyCapacity < RESERVER_BODY_COST) return Infinity; // can't build a reserver yet
  const RESERVER_PARTS = 2; // CLAIM + MOVE
  const life = Math.max(1, CLAIM_LIFETIME - distance); // walks out, then reserves
  const energyOH = RESERVER_BODY_COST / life;
  const partOH = (RESERVER_PARTS / life) * SPAWN_PART_ENERGY_VALUE;
  return RESERVER_DUTY * (energyOH + partOH);
}

/**
 * Is reserving a remote room worth it? Reserving lifts each of the room's `sources`
 * from the unreserved 5 e/tick to the reserved 10 (+5 each); that whole-room gain is
 * weighed against the single per-room reserver toll. So two sources justify
 * reserving (and reaching farther) where one might not, and a room too far - or a
 * spawn too small to build a reserver - simply loses. The miner/hauler costs are
 * the same either way, so they cancel and only the +5/source vs the toll matter.
 */
export function reserveRoomWorthIt(energyCapacity: number, distance: number, sources: number): boolean {
  return sources * 5 > reserverTollPerRoom(energyCapacity, distance);
}

