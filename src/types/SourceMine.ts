/**
 * @fileoverview Source mining configuration types.
 *
 * Defines the data structure for energy source mining operations,
 * including harvest positions and logistics information.
 *
 * @module types/SourceMine
 */

/**
 * Configuration for mining an energy source.
 *
 * Captures all information needed to set up and manage
 * harvesting operations at a specific energy source.
 *
 * @example
 * const mine: SourceMine = {
 *   sourceId: '5bbcac219099fc01' as Id<Source>,
 *   harvestPositions: [new RoomPosition(24, 25, 'W1N1')],
 *   flow: 10,
 *   distanceToSpawn: 15
 * };
 */
export interface SourceMine {
  /** Unique identifier of the energy source being mined */
  sourceId: Id<Source>;

  /**
   * Valid positions adjacent to the source where harvesters can stand.
   * Sorted by distance to spawn (closest first) for optimal assignment.
   */
  harvestPositions: RoomPosition[];

  /**
   * Expected energy flow rate (energy per tick).
   * Default is 10 for a source with 2 WORK parts harvesting.
   */
  flow: number;

  /**
   * Distance from the source to the nearest spawn.
   * Used for route planning and carrier assignment.
   */
  distanceToSpawn: number;
}
