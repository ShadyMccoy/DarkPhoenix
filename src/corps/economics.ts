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
 * Rough energy/tick a single spawn can keep harvested + delivered. Used only to
 * PRICE spawn build-time in energy terms, not as a hard cap. Pricing the spawn's
 * 0.333 parts/tick against this gives {@link SPAWN_PART_ENERGY_VALUE}, the energy
 * a unit of spawn throughput is "worth" - so a part-hungry corp can be penalized
 * in pure energy and ranked against everything else. A conservative mid estimate
 * (a couple of well-staffed sources); tune against real colonies.
 */
export const SPAWN_SUPPORTED_HARVEST = 60;

/**
 * Energy value of one unit of spawn throughput (energy per part/tick): how much
 * harvested energy the spawn could support if that build-time went to its best
 * use. = SPAWN_SUPPORTED_HARVEST / SPAWN_PARTS_PER_TICK. Multiply a corp's
 * {@link CorpEconomics.spawnPartsPerTick} by this to get its build-time cost in
 * energy, then subtract it from net energy (see {@link effectiveNet}). This is
 * what makes the spawn-time wall fall out of a pure-energy ranking: a far source
 * whose haulers eat the build budget is penalized enough to lose to a near one,
 * with no hard distance limit.
 */
export const SPAWN_PART_ENERGY_VALUE = SPAWN_SUPPORTED_HARVEST / SPAWN_PARTS_PER_TICK;

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
