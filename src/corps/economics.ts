/**
 * Virtual-mode economics for corps.
 *
 * A corp's economics live in the corp itself: given a scene (a spawn position,
 * the energy it can afford, and a way to locate resources), each corp reports
 * what it would cost to staff and what it would move - computed from its OWN
 * body and cost logic, with no live game state. Scoring a spawn site is then
 * just standing up the relevant corps and summing their projections; there is no
 * separate economic model to maintain. Improve a corp, or add a new corp type,
 * and the scores follow automatically.
 */

import { Position } from "../types/Position";

/** A resource a corp acts on, located in the scene. */
export interface SceneResource {
  pos: Position;
  /** Energy per regeneration cycle, for sources. */
  capacity?: number;
}

/**
 * The world a virtual corp reasons about: where its spawn is, how much energy
 * that spawn can afford a body, the controller it feeds, and a resource lookup.
 * Distances are injected so the whole thing stays pure and game-free.
 */
export interface ChainScene {
  spawnPos: Position;
  /** Energy a single creep body may cost (spawn + extensions capacity). */
  energyCapacity: number;
  /** The controller this chain upgrades, if any. */
  controllerPos?: Position;
  dist: (a: Position, b: Position) => number;
  resource(id: string): SceneResource | undefined;
}

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
 * corp's {@link CorpEconomics.spawnPartsPerTick} by this to price its spawn
 * build-time in energy, then subtract from net (see {@link effectiveNet}). This
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

/** What a corp projects it would cost and move, per tick, in a given scene. */
export interface CorpEconomics {
  /**
   * Energy/tick to keep this corp's creeps alive (its spawn overhead),
   * discounted for the life each creep wastes walking from the spawn to its
   * post - so a corp far from its worksite costs more.
   */
  costPerTick: number;
  /** Energy/tick this corp delivers toward the goal (0 for pure consumers). */
  throughput: number;
  /**
   * Body parts/tick this corp draws from spawn throughput: its claim on the
   * spawn's finite build rate (see {@link SPAWN_PARTS_PER_TICK}). Computed on the
   * same creep-count and useful-life basis as {@link costPerTick}, so the two
   * budgets stay in step. This is what makes the spawn-time wall fall out of
   * planning: sum it across the corps a spawn supports and a far, part-hungry
   * roster exceeds the spawn's build rate long before it exhausts the energy.
   */
  spawnPartsPerTick: number;
}

/**
 * Net energy/tick of a corp (or a summed chain) in a single currency: its energy
 * delivery, minus its energy upkeep, minus its spawn build-time priced in energy
 * (see {@link SPAWN_PART_ENERGY_VALUE}). This is the number to RANK by - a corp
 * that delivers energy but hogs the spawn's build rate (a far hauler fleet, a
 * reserver) is demoted just as if it cost that much energy, so the spawn-time
 * constraint falls out of the same comparison that already weighs energy.
 */
export function effectiveNet(econ: CorpEconomics): number {
  return econ.throughput - econ.costPerTick - econ.spawnPartsPerTick * SPAWN_PART_ENERGY_VALUE;
}

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

