/**
 * roadScoring - the EMPIRICAL counterpart to roadEconomics.
 *
 * roadEconomics reasons A PRIORI about a KNOWN route (source->depot) carrying an
 * ASSUMED flow. This module reasons from OBSERVATION: it watches where our
 * creeps actually STEP on unpaved ground and pay move-fatigue a road would have
 * removed, and accumulates a per-tile SCORE. Over many ticks the hottest tiles
 * trace the colony's real traffic lanes - including ones no a-priori planner
 * ever drew (extension refill loops, upgrader shuttles, remote paths that a
 * pathfinder happened to route through swamp). The scores then RANK candidate
 * road tiles for the builder.
 *
 * THE SCORE. A road removes move-fatigue: a non-MOVE body part generates 2
 * fatigue stepping onto plain, 10 onto swamp, and only 1 onto a road (game
 * table). So the marginal value of paving a tile, per creep-step, is exactly
 * the fatigue that road would have saved:
 *
 *   stepScore = fatigueParts * (terrainFatigue - ROAD_FATIGUE)
 *
 * which is 1x per fatigue-part on plain (2 -> 1) and 9x on swamp (10 -> 1).
 * An EMPTY hauler or an all-MOVE body generates no fatigue, so its steps score
 * zero - a road there buys nothing. This is the same fatigue currency
 * roadEconomics prices in energy/spawn-parts, so a tile's accumulated score is
 * directly proportional to the recurring saving roadEconomics would compute for
 * the traffic that produced it - measured instead of assumed.
 *
 * The accumulator is intentionally a DURABLE statistical signal (thousands of
 * steps), NOT a per-tick trigger keyed to a creep's position - the trap the
 * playbook warns about (a signal that flaps on a single creep's death/vision).
 * Decay lets it forget stale lanes so a re-routed or already-paved path fades.
 */

import { CARRY_CAPACITY } from "./primitives";

/** Move-fatigue one non-MOVE part generates stepping onto each surface. */
export const PLAIN_FATIGUE = 2;
export const SWAMP_FATIGUE = 10;
export const ROAD_FATIGUE = 1;

/** Score map for one room: packed tile index -> accumulated score. */
export type RoadScoreMap = { [packed: number]: number };

/** Pack a tile (0..49, 0..49) into a single 0..2499 index. */
export function packTile(x: number, y: number): number {
  return x * 50 + y;
}

/** Inverse of {@link packTile}. */
export function unpackTile(packed: number): { x: number; y: number } {
  return { x: Math.floor(packed / 50), y: packed % 50 };
}

/**
 * How many body parts generate move-fatigue on THIS step. MOVE parts never do.
 * A CARRY part only does when it is loaded, and only in proportion to the load:
 * the engine charges ceil(usedCapacity / CARRY_CAPACITY) carry parts, so an
 * empty hauler charges zero and a half-full one charges half its CARRY. Every
 * other part (WORK, ATTACK, ...) always charges. Damaged (hits 0) parts are
 * disabled and charge nothing.
 *
 * Pure: takes the raw body-part descriptors and the creep's used store so it is
 * unit-testable without a live creep.
 */
export function countFatigueParts(
  body: { type: string; hits?: number }[],
  usedCapacity: number
): number {
  let heavy = 0; // non-MOVE, non-CARRY parts (always charge when alive)
  let carry = 0; // live CARRY parts
  for (const part of body) {
    if (part.hits !== undefined && part.hits <= 0) continue; // disabled part
    if (part.type === MOVE) continue;
    if (part.type === CARRY) carry++;
    else heavy++;
  }
  const loadedCarry = Math.min(carry, Math.ceil(Math.max(0, usedCapacity) / CARRY_CAPACITY));
  return heavy + loadedCarry;
}

/**
 * Score increment for one creep-step onto an UNPAVED tile of the given terrain
 * mask, the creep carrying `fatigueParts` fatigue-generating parts this step.
 * Equals the move-fatigue a road on that tile would have removed. Walls have no
 * unpaved baseline (impassable without a tunnel road already), so they score
 * zero here - and so do fatigue-free steps.
 */
export function stepScore(terrainMask: number, fatigueParts: number): number {
  if (fatigueParts <= 0) return 0;
  const base = terrainFatigue(terrainMask);
  const saved = base - ROAD_FATIGUE;
  return saved > 0 ? fatigueParts * saved : 0;
}

/** Unpaved move-fatigue per part on this terrain (walls have no baseline: 0). */
function terrainFatigue(terrainMask: number): number {
  // eslint-disable-next-line no-bitwise
  if (terrainMask & TERRAIN_MASK_WALL) return 0;
  // eslint-disable-next-line no-bitwise
  if (terrainMask & TERRAIN_MASK_SWAMP) return SWAMP_FATIGUE;
  return PLAIN_FATIGUE;
}

/** Add `inc` to a tile's score (no-op for inc <= 0). Mutates and returns the map. */
export function recordStep(map: RoadScoreMap, x: number, y: number, inc: number): RoadScoreMap {
  if (inc > 0) {
    const key = packTile(x, y);
    map[key] = (map[key] ?? 0) + inc;
  }
  return map;
}

/**
 * Multiply every score by `factor` (0..1) so stale traffic fades, then drop
 * tiles that fell below `floor` (keeps the map sparse - a re-routed or
 * already-paved lane decays out instead of dominating forever). Mutates and
 * returns the map. Returns via the map; callers can read Object.keys().length.
 */
export function decayScores(map: RoadScoreMap, factor: number, floor = 1): RoadScoreMap {
  for (const key in map) {
    const next = map[key] * factor;
    if (next < floor) delete map[key];
    else map[key] = next;
  }
  return map;
}

export interface ScoredTile {
  x: number;
  y: number;
  score: number;
}

/**
 * The highest-scoring tiles, descending. `min` filters weak signal; `limit`
 * caps the count (defaults: everything at or above 1). Ties break by packed
 * index for determinism (grid/sim reproducibility).
 */
export function topScoredTiles(
  map: RoadScoreMap,
  opts: { min?: number; limit?: number } = {}
): ScoredTile[] {
  const min = opts.min ?? 1;
  const tiles: (ScoredTile & { key: number })[] = [];
  for (const key in map) {
    const score = map[key];
    if (score < min) continue;
    const packed = Number(key);
    const { x, y } = unpackTile(packed);
    tiles.push({ x, y, score, key: packed });
  }
  tiles.sort((a, b) => b.score - a.score || a.key - b.key);
  const capped = opts.limit !== undefined ? tiles.slice(0, opts.limit) : tiles;
  return capped.map(({ x, y, score }) => ({ x, y, score }));
}
