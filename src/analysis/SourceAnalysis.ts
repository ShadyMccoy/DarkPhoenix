/**
 * @fileoverview Source analysis utilities.
 *
 * @module analysis/SourceAnalysis
 */

/**
 * 8-directional offsets for finding adjacent tiles.
 */
const ADJACENT_OFFSETS: { x: number; y: number }[] = [
  { x: -1, y: -1 },
  { x: -1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 }
];

/**
 * Counts walkable tiles adjacent to a source.
 *
 * @param source - The energy source to analyze
 * @returns Number of positions where miners can stand
 */
export function countMiningSpots(source: Source): number {
  const terrain = source.room.getTerrain();
  let count = 0;

  for (const offset of ADJACENT_OFFSETS) {
    const x = source.pos.x + offset.x;
    const y = source.pos.y + offset.y;

    if (x < 0 || x > 49 || y < 0 || y > 49) continue;

    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
      count++;
    }
  }

  return count;
}
