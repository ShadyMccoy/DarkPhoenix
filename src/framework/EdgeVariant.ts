/**
 * @fileoverview Weighted edge variants for multi-dimensional route optimization.
 *
 * Models different mining/transport configurations as edge variants with
 * associated costs. MCMF can then select optimal variants based on:
 * - Mining mode (container, link, drop with N CARRY)
 * - Transport mode (hauler ratios, link transfer)
 * - Terrain profile (road, plain, swamp mix)
 *
 * The selected variant tells corps exactly what configuration to materialize.
 *
 * @module framework/EdgeVariant
 */

import { BODY_PART_COSTS } from "./FlowEdge";

// =============================================================================
// Constants
// =============================================================================

/** Creep lifetime in ticks */
export const CREEP_LIFETIME = 1500;

/** Source regeneration period in ticks */
export const SOURCE_REGEN_TICKS = 300;

/** Energy capacity per CARRY part */
export const CARRY_CAPACITY = 50;

/** Harvest rate per WORK part per tick */
export const HARVEST_PER_WORK = 2;

/** Ground pile decay rate (energy/tick) */
export const PILE_DECAY_RATE = 1;

/** Container build cost */
export const CONTAINER_BUILD_COST = 5000;

/** Container decay (hits lost per tick when not in owned room) */
export const CONTAINER_DECAY_RATE = 5000 / 500; // 5000 hits over 500 ticks = 10/tick

/** Link build cost */
export const LINK_BUILD_COST = 5000;

/** Fatigue per tile by terrain type (for a creep with weight) */
export const TERRAIN_FATIGUE: Record<TerrainType, number> = {
  road: 1,
  plain: 2,
  swamp: 10,
};

// =============================================================================
// Types
// =============================================================================

/** Terrain types affecting movement */
export type TerrainType = "road" | "plain" | "swamp";

/** Mining infrastructure mode */
export type MiningMode = "drop" | "container" | "link";

/** Hauler body ratio (CARRY:MOVE) */
export type HaulerRatio = "2:1" | "1:1" | "1:2";

/** Transport mechanism */
export type TransportMode = "hauler" | "link";

/**
 * Terrain composition of a route.
 * Counts of tiles by terrain type.
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

/**
 * Constraints for generating edge variants.
 */
export interface VariantConstraints {
  /** Available energy for spawning */
  spawnEnergy: number;
  /** Whether containers can be built */
  canBuildContainer: boolean;
  /** Whether links are available (RCL 5+) */
  canBuildLink: boolean;
  /** Budget for infrastructure */
  infrastructureBudget: number;
  /** Source capacity (3000 owned, 1500 unreserved) */
  sourceCapacity: number;
  /** Distance from spawn to source (for harvester travel) */
  spawnToSourceDistance: number;
}

// =============================================================================
// Harvester Calculations
// =============================================================================

/**
 * Creates a harvester configuration.
 *
 * @param workParts - Number of WORK parts (typically 5)
 * @param carryParts - Number of CARRY parts (0-4)
 * @returns Harvester configuration with costs
 */
export function createHarvesterConfig(
  workParts: number,
  carryParts: number
): HarvesterConfig {
  // Move parts: 1 per 2 work parts, minimum to reach source
  const moveParts = Math.ceil(workParts / 2);

  const spawnCost =
    workParts * BODY_PART_COSTS.work +
    carryParts * BODY_PART_COSTS.carry +
    moveParts * BODY_PART_COSTS.move;

  return {
    workParts,
    carryParts,
    moveParts,
    spawnCost,
  };
}

/**
 * Calculates harvester cost per tick (spawn cost amortized).
 */
export function calculateHarvesterCostPerTick(
  harvester: HarvesterConfig,
  spawnToSourceDistance: number
): number {
  // Account for travel time reducing effective lifetime
  const effectiveLifetime = Math.max(1, CREEP_LIFETIME - spawnToSourceDistance);
  return harvester.spawnCost / effectiveLifetime;
}

// =============================================================================
// Hauler Calculations
// =============================================================================

/**
 * Gets the CARRY:MOVE part ratio for a hauler ratio type.
 */
function getPartRatio(ratio: HaulerRatio): { carry: number; move: number } {
  switch (ratio) {
    case "2:1":
      return { carry: 2, move: 1 }; // Road-optimized
    case "1:1":
      return { carry: 1, move: 1 }; // Balanced (plains)
    case "1:2":
      return { carry: 1, move: 2 }; // Swamp-capable
  }
}

/**
 * Creates a hauler configuration for a given ratio and capacity need.
 *
 * @param ratio - CARRY:MOVE ratio
 * @param carryPartsNeeded - Minimum CARRY parts needed for throughput
 * @returns Hauler configuration
 */
export function createHaulerConfig(
  ratio: HaulerRatio,
  carryPartsNeeded: number
): HaulerConfig {
  const partRatio = getPartRatio(ratio);

  // Round up to nearest complete ratio unit
  const units = Math.ceil(carryPartsNeeded / partRatio.carry);
  const carryParts = units * partRatio.carry;
  const moveParts = units * partRatio.move;

  const spawnCost =
    carryParts * BODY_PART_COSTS.carry + moveParts * BODY_PART_COSTS.move;

  return {
    ratio,
    carryParts,
    moveParts,
    carryCapacity: carryParts * CARRY_CAPACITY,
    spawnCost,
  };
}

/**
 * Calculates movement speed (ticks per tile) for a hauler on terrain.
 *
 * Movement is based on fatigue:
 * - Fatigue gained per tile = weight * terrain_factor
 * - Fatigue reduced per tick = MOVE parts * 2
 * - Ticks per tile = ceil(fatigue / (MOVE * 2))
 *
 * Weight = CARRY parts when full (empty CARRY doesn't count)
 */
export function calculateTicksPerTile(
  hauler: HaulerConfig,
  terrain: TerrainType
): number {
  // When carrying, each CARRY part adds 1 weight
  const weight = hauler.carryParts;
  const fatiguePerTile = weight * TERRAIN_FATIGUE[terrain];
  const fatigueReduction = hauler.moveParts * 2;

  // Minimum 1 tick per tile
  return Math.max(1, Math.ceil(fatiguePerTile / fatigueReduction));
}

/**
 * Calculates round trip time for a hauler over a terrain profile.
 *
 * @param hauler - Hauler configuration
 * @param terrain - Terrain profile (tile counts)
 * @param pickupDropoffTime - Extra ticks for loading/unloading (default 10)
 * @returns Total round trip time in ticks
 */
export function calculateRoundTripTicks(
  hauler: HaulerConfig,
  terrain: TerrainProfile,
  pickupDropoffTime: number = 10
): number {
  // Calculate one-way time (full when going to destination)
  let oneWayFull = 0;
  oneWayFull += terrain.road * calculateTicksPerTile(hauler, "road");
  oneWayFull += terrain.plain * calculateTicksPerTile(hauler, "plain");
  oneWayFull += terrain.swamp * calculateTicksPerTile(hauler, "swamp");

  // Return trip is faster (empty, no weight)
  // Empty hauler: 1 tick per tile on road/plain, more on swamp
  const oneWayEmpty =
    terrain.road * 1 +
    terrain.plain * 1 +
    terrain.swamp * Math.ceil(TERRAIN_FATIGUE.swamp / (hauler.moveParts * 2));

  return oneWayFull + oneWayEmpty + pickupDropoffTime;
}

/**
 * Calculates hauler throughput and cost.
 *
 * @param hauler - Hauler configuration
 * @param terrain - Terrain profile
 * @returns Throughput (energy/tick) and cost per energy
 */
export function calculateHaulerMetrics(
  hauler: HaulerConfig,
  terrain: TerrainProfile
): { throughput: number; costPerEnergy: number; tripsPerLifetime: number } {
  const roundTrip = calculateRoundTripTicks(hauler, terrain);
  const tripsPerLifetime = Math.floor(CREEP_LIFETIME / roundTrip);
  const totalCarried = hauler.carryCapacity * tripsPerLifetime;

  const throughput = totalCarried / CREEP_LIFETIME;
  const costPerEnergy = totalCarried > 0 ? hauler.spawnCost / totalCarried : Infinity;

  return { throughput, costPerEnergy, tripsPerLifetime };
}

// =============================================================================
// Decay Calculations
// =============================================================================

/**
 * Calculates energy decay cost for drop mining.
 *
 * Decay occurs when energy sits on the ground waiting for pickup.
 * More harvester CARRY = longer before first drop = less decay.
 *
 * @param harvester - Harvester configuration
 * @param roundTripTicks - Hauler round trip time
 * @param miningSpots - Number of piles (mining positions)
 * @returns Decay cost in energy per tick
 */
export function calculateDecayCost(
  harvester: HarvesterConfig,
  roundTripTicks: number,
  miningSpots: number
): number {
  if (miningSpots === 0) return 0;

  // Harvest rate
  const harvestRate = harvester.workParts * HARVEST_PER_WORK;

  // Time to fill harvester's CARRY before dropping
  const fillTime =
    harvester.carryParts > 0
      ? (harvester.carryParts * CARRY_CAPACITY) / harvestRate
      : 0;

  // Time pile exists on ground per cycle
  const pileExistsTime = Math.max(0, roundTripTicks - fillTime);

  // Fraction of time pile is decaying
  const decayFraction = pileExistsTime / roundTripTicks;

  // Each pile decays at PILE_DECAY_RATE when on ground
  return miningSpots * decayFraction * PILE_DECAY_RATE;
}

// =============================================================================
// Infrastructure Calculations
// =============================================================================

/**
 * Calculates amortized infrastructure cost per tick.
 *
 * @param miningMode - Mining infrastructure type
 * @param isOwnedRoom - Whether the room is owned (affects container decay)
 * @returns Infrastructure cost per tick
 */
export function calculateInfrastructureCost(
  miningMode: MiningMode,
  isOwnedRoom: boolean = true
): number {
  switch (miningMode) {
    case "drop":
      return 0;

    case "container":
      // Container: 5000 to build, decays in remote rooms
      // Amortize build cost over expected lifetime
      // In owned rooms: indefinite (repair is cheap)
      // In remote rooms: rebuild every ~500 ticks of active decay
      if (isOwnedRoom) {
        // Minimal repair cost, amortize over long period
        return CONTAINER_BUILD_COST / (CREEP_LIFETIME * 10);
      } else {
        // Need to rebuild/repair more frequently
        return CONTAINER_BUILD_COST / (CREEP_LIFETIME * 3);
      }

    case "link":
      // Link: 5000 to build, no decay, but costs 3% energy per transfer
      // Amortize over very long period (permanent structure)
      // Plus 3% transmission cost
      return LINK_BUILD_COST / (CREEP_LIFETIME * 20);
  }
}

// =============================================================================
// Edge Variant Generation
// =============================================================================

/**
 * Generates all viable edge variants for a route.
 *
 * @param sourceCapacity - Source energy capacity (3000 or 1500)
 * @param terrain - Terrain profile of the route
 * @param spawnToSourceDistance - Distance from spawn to source
 * @param constraints - Budget and capability constraints
 * @returns Array of viable edge variants, sorted by efficiency
 */
export function generateEdgeVariants(
  sourceCapacity: number,
  terrain: TerrainProfile,
  spawnToSourceDistance: number,
  constraints: VariantConstraints
): EdgeVariant[] {
  const variants: EdgeVariant[] = [];
  const grossPerTick = sourceCapacity / SOURCE_REGEN_TICKS;

  // Mining modes to try
  const miningModes: MiningMode[] = ["drop"];
  if (constraints.canBuildContainer) miningModes.push("container");
  if (constraints.canBuildLink) miningModes.push("link");

  // Harvester CARRY variants (0-4)
  const carryOptions = [0, 1, 2, 3, 4];

  // Hauler ratio variants
  const haulerRatios: HaulerRatio[] = ["2:1", "1:1", "1:2"];

  // Standard 5 WORK for full harvest
  const workParts = 5;

  for (const miningMode of miningModes) {
    for (const harvesterCarry of carryOptions) {
      // Skip CARRY on harvesters if using container/link (not needed)
      if (miningMode !== "drop" && harvesterCarry > 0) continue;

      const harvester = createHarvesterConfig(workParts, harvesterCarry);

      // Skip if can't afford harvester
      if (harvester.spawnCost > constraints.spawnEnergy) continue;

      // Link transport mode
      if (miningMode === "link") {
        const variant = createLinkVariant(
          harvester,
          grossPerTick,
          spawnToSourceDistance,
          miningMode
        );
        variants.push(variant);
        continue;
      }

      // Hauler transport modes
      for (const ratio of haulerRatios) {
        // Calculate required hauler size
        const testHauler = createHaulerConfig(ratio, 1);
        const metrics = calculateHaulerMetrics(testHauler, terrain);

        // Scale up to meet throughput needs
        const carryPartsNeeded = Math.ceil(grossPerTick / metrics.throughput);
        const hauler = createHaulerConfig(ratio, carryPartsNeeded);

        // Skip if can't afford hauler
        if (hauler.spawnCost > constraints.spawnEnergy) continue;

        const variant = createHaulerVariant(
          harvester,
          hauler,
          terrain,
          grossPerTick,
          spawnToSourceDistance,
          miningMode
        );
        variants.push(variant);
      }
    }
  }

  // Sort by efficiency (highest first)
  variants.sort((a, b) => b.efficiency - a.efficiency);

  return variants;
}

/**
 * Creates a hauler-based transport variant.
 */
function createHaulerVariant(
  harvester: HarvesterConfig,
  hauler: HaulerConfig,
  terrain: TerrainProfile,
  grossPerTick: number,
  spawnToSourceDistance: number,
  miningMode: MiningMode
): EdgeVariant {
  const roundTrip = calculateRoundTripTicks(hauler, terrain);
  const miningSpots = miningMode === "drop" ? 2 : 0; // Assume 2 spots for drop mining

  // Calculate costs
  const infrastructureCost = calculateInfrastructureCost(miningMode);
  const harvesterCost = calculateHarvesterCostPerTick(harvester, spawnToSourceDistance);
  const decayCost =
    miningMode === "drop"
      ? calculateDecayCost(harvester, roundTrip, miningSpots)
      : 0;
  const haulerMetrics = calculateHaulerMetrics(hauler, terrain);
  const haulCost = haulerMetrics.costPerEnergy * grossPerTick;

  const totalCostPerTick = infrastructureCost + harvesterCost + decayCost + haulCost;
  const netPerTick = grossPerTick - totalCostPerTick;
  const efficiency = (netPerTick / grossPerTick) * 100;
  const costPerEnergy = totalCostPerTick / grossPerTick;

  const variantId = `${miningMode}-${harvester.carryParts}c-${hauler.ratio}`;

  return {
    id: variantId,
    miningMode,
    harvester,
    miningSpots,
    transportMode: "hauler",
    hauler,
    terrain,
    infrastructureCost,
    harvesterCost,
    decayCost,
    haulCost,
    totalCostPerTick,
    costPerEnergy,
    grossPerTick,
    netPerTick,
    efficiency,
  };
}

/**
 * Creates a link-based transport variant.
 */
function createLinkVariant(
  harvester: HarvesterConfig,
  grossPerTick: number,
  spawnToSourceDistance: number,
  miningMode: MiningMode
): EdgeVariant {
  // Link has 3% transmission cost
  const linkTransmissionCost = grossPerTick * 0.03;

  const infrastructureCost = calculateInfrastructureCost(miningMode);
  const harvesterCost = calculateHarvesterCostPerTick(harvester, spawnToSourceDistance);
  const decayCost = 0;
  const haulCost = linkTransmissionCost;

  const totalCostPerTick = infrastructureCost + harvesterCost + decayCost + haulCost;
  const netPerTick = grossPerTick - totalCostPerTick;
  const efficiency = (netPerTick / grossPerTick) * 100;
  const costPerEnergy = totalCostPerTick / grossPerTick;

  return {
    id: "link-0c",
    miningMode,
    harvester,
    miningSpots: 0,
    transportMode: "link",
    hauler: null,
    terrain: { road: 0, plain: 0, swamp: 0 },
    infrastructureCost,
    harvesterCost,
    decayCost,
    haulCost,
    totalCostPerTick,
    costPerEnergy,
    grossPerTick,
    netPerTick,
    efficiency,
  };
}

/**
 * Selects the best edge variant given constraints.
 *
 * @param variants - Available variants (pre-sorted by efficiency)
 * @param constraints - Current constraints
 * @returns Best viable variant, or null if none viable
 */
export function selectBestVariant(
  variants: EdgeVariant[],
  constraints: VariantConstraints
): EdgeVariant | null {
  for (const variant of variants) {
    // Check infrastructure budget
    if (variant.miningMode === "container") {
      if (constraints.infrastructureBudget < CONTAINER_BUILD_COST) continue;
    }
    if (variant.miningMode === "link") {
      if (constraints.infrastructureBudget < LINK_BUILD_COST) continue;
      if (!constraints.canBuildLink) continue;
    }

    // Check spawn energy for bodies
    if (variant.harvester.spawnCost > constraints.spawnEnergy) continue;
    if (variant.hauler && variant.hauler.spawnCost > constraints.spawnEnergy) continue;

    return variant;
  }

  return null;
}
