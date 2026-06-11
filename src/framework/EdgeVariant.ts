/**
 * @fileoverview Edge-variant TYPES.
 *
 * These describe a route's terrain, mining mode and hauler body ratio. They are
 * still used to annotate FlowSource/FlowSink/MinerAssignment/HaulerAssignment and
 * to drive SpawningCorp's CARRY:MOVE body ratios.
 *
 * The variant-SEARCH that once lived here (generateEdgeVariants / selectBestVariant
 * and the supply/carry cost model in FlowEdge.ts) was dead - it required a route
 * terrain profile that the graph never populated - and has been removed. Only the
 * vocabulary remains.
 *
 * @module framework/EdgeVariant
 */

/** Terrain types affecting movement */
export type TerrainType = "road" | "plain" | "swamp";

/** Mining infrastructure mode */
export type MiningMode = "drop" | "container" | "link";

/** Hauler body ratio (CARRY:MOVE) */
export type HaulerRatio = "2:1" | "1:1" | "1:2";

/** Transport mechanism */
export type TransportMode = "hauler" | "link";

/**
 * Terrain composition of a route. Counts of tiles by terrain type.
 */
export interface TerrainProfile {
  road: number;
  plain: number;
  swamp: number;
}

/**
 * Harvester configuration for a mining variant.
 */
export interface HarvesterConfig {
  /** Number of WORK parts (typically 5 for full harvest) */
  workParts: number;
  /** Number of CARRY parts (0-4, affects decay) */
  carryParts: number;
  /** Number of MOVE parts */
  moveParts: number;
  /** Total spawn cost */
  spawnCost: number;
}

/**
 * Hauler configuration for a transport variant.
 */
export interface HaulerConfig {
  /** CARRY:MOVE ratio */
  ratio: HaulerRatio;
  /** Number of CARRY parts */
  carryParts: number;
  /** Number of MOVE parts */
  moveParts: number;
  /** Total carry capacity */
  carryCapacity: number;
  /** Total spawn cost */
  spawnCost: number;
}

/**
 * Complete edge variant representing a mining + transport configuration.
 */
export interface EdgeVariant {
  /** Unique variant identifier */
  id: string;

  // === Mining Configuration ===
  /** Mining infrastructure mode */
  miningMode: MiningMode;
  /** Harvester body configuration */
  harvester: HarvesterConfig;
  /** Number of mining spots used (affects decay calculation) */
  miningSpots: number;

  // === Transport Configuration ===
  /** Transport mechanism */
  transportMode: TransportMode;
  /** Hauler configuration (null for link transport) */
  hauler: HaulerConfig | null;
  /** Terrain profile of the route */
  terrain: TerrainProfile;

  // === Derived Costs (energy per tick) ===
  /** Infrastructure cost amortized over lifetime */
  infrastructureCost: number;
  /** Harvester spawn cost amortized over lifetime */
  harvesterCost: number;
  /** Energy decay cost (drop mining only) */
  decayCost: number;
  /** Hauler spawn cost amortized over lifetime */
  haulCost: number;

  // === Summary ===
  /** Total cost per tick */
  totalCostPerTick: number;
  /** Cost per unit of energy transported */
  costPerEnergy: number;
  /** Gross energy per tick from source */
  grossPerTick: number;
  /** Net energy per tick after costs */
  netPerTick: number;
  /** Efficiency percentage (net/gross) */
  efficiency: number;
}
