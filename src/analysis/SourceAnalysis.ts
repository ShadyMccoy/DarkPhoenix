/**
 * @fileoverview Source analysis utilities.
 *
 * Analyzes energy sources to determine optimal mining configurations,
 * including available harvest positions and distances.
 *
 * @module analysis/SourceAnalysis
 */

import { SourceMine } from "../types/SourceMine";

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
  { x: 1, y: 1 },
];

/**
 * Analyzes a source to determine mining configuration.
 *
 * Finds all walkable tiles adjacent to the source, sorts them by
 * distance to spawn, and calculates optimal harvest parameters.
 *
 * @param source - The energy source to analyze
 * @param spawnPos - Position of the spawn for distance calculations
 * @returns SourceMine configuration for this source
 */
export function analyzeSource(
  source: Source,
  spawnPos: RoomPosition
): SourceMine {
  const terrain = source.room.getTerrain();
  const harvestPositions: RoomPosition[] = [];

  // Find all walkable tiles adjacent to the source
  for (const offset of ADJACENT_OFFSETS) {
    const x = source.pos.x + offset.x;
    const y = source.pos.y + offset.y;

    // Skip out-of-bounds positions
    if (x < 0 || x > 49 || y < 0 || y > 49) {
      continue;
    }

    // Check if tile is walkable (not a wall)
    const terrainMask = terrain.get(x, y);
    if (terrainMask !== TERRAIN_MASK_WALL) {
      harvestPositions.push(new RoomPosition(x, y, source.room.name));
    }
  }

  // Sort by distance to spawn (closest first)
  harvestPositions.sort((a, b) => {
    const distA = a.getRangeTo(spawnPos);
    const distB = b.getRangeTo(spawnPos);
    return distA - distB;
  });

  // Calculate path distance from source to spawn
  const path = source.pos.findPathTo(spawnPos, { ignoreCreeps: true });
  const distanceToSpawn = path.length;

  return {
    sourceId: source.id,
    HarvestPositions: harvestPositions,
    flow: 10, // 5 WORK parts = 10 energy/tick (full harvest rate)
    distanceToSpawn,
  };
}

/**
 * Gets the number of available mining spots for a source.
 *
 * @param sourceMine - The analyzed source configuration
 * @returns Number of positions where miners can stand
 */
export function getMiningSpots(sourceMine: SourceMine): number {
  return sourceMine.HarvestPositions.length;
}

/**
 * Checks if a source is guarded by source keepers.
 *
 * Source keepers spawn from keeper lairs which are always within 5 tiles
 * of the source they guard. These sources require armored mining operations.
 *
 * @param source - The source to check
 * @returns True if the source has a keeper lair nearby
 */
export function isSourceKeeperSource(source: Source): boolean {
  const keeperLairs = source.pos.findInRange(FIND_HOSTILE_STRUCTURES, 5, {
    filter: (s) => s.structureType === STRUCTURE_KEEPER_LAIR,
  });
  return keeperLairs.length > 0;
}

/**
 * Gets all minable sources in a room (excludes source keeper sources).
 *
 * @param room - The room to search
 * @returns Array of sources that can be mined without armored operations
 */
export function getMinableSources(room: Room): Source[] {
  const sources = room.find(FIND_SOURCES);
  return sources.filter((source) => !isSourceKeeperSource(source));
}
