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
}
