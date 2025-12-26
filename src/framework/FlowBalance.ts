/**
 * @fileoverview Flow balance solver for the bootstrap problem.
 *
 * The bootstrap problem:
 * - Mining requires miners → miners require spawn energy
 * - Hauling requires haulers → haulers require spawn energy
 * - Spawning requires energy → energy requires hauling
 *
 * This creates a circular dependency. The solution is to find an equilibrium
 * where the system is self-sustaining.
 *
 * Mathematical model:
 *
 * Let:
 *   E = total energy produced per tick
 *   M = mining overhead per tick (miner spawn costs / lifetime)
 *   H = hauling overhead per tick (hauler spawn costs / lifetime)
 *   P = project energy per tick (what we're trying to maximize)
 *
 * Constraint: E = M + H + P
 *
 * But M and H depend on the configuration (how many miners/haulers we have),
 * and E depends on M (more miners = more energy up to source limit).
 *
 * Solution approach:
 * 1. Find minimum viable configuration (just enough to be self-sustaining)
 * 2. Iteratively add capacity where it has highest marginal value
 * 3. Stop when no more positive-marginal additions exist
 *
 * @module framework/FlowBalance
 */

import {
  SupplyEdge,
  CarryEdge,
  calculateSupplyEdgeNetPerTick,
  calculateCarryEdgeThroughput,
  calculateCarryEdgeCostPerEnergy,
} from "./FlowEdge";

/**
 * Allocation of resources to a supply edge (source mining).
 */
export interface SupplyAllocation {
  edge: SupplyEdge;

  /** Number of miners assigned */
  minerCount: number;

  /** Energy harvested per tick */
  harvestPerTick: number;

  /** Spawn cost per tick (amortized) */
  spawnCostPerTick: number;

  /** Net energy per tick (harvest - spawn cost) */
  netPerTick: number;

  /** Is this a local source (no hauling needed)? */
  isLocal: boolean;
}

/**
 * Allocation of resources to a carry edge (hauling).
 */
export interface CarryAllocation {
  edge: CarryEdge;

  /** Number of haulers assigned */
  haulerCount: number;

  /** Energy throughput per tick */
  throughputPerTick: number;

  /** Spawn cost per tick (amortized) */
  spawnCostPerTick: number;

  /** Energy being carried on this route */
  energyCarried: number;
}

/**
 * Complete allocation solution.
 */
export interface FlowAllocation {
  /** Supply allocations (mining) */
  supplies: SupplyAllocation[];

  /** Carry allocations (hauling) */
  carries: CarryAllocation[];

  /** Total energy production per tick */
  totalProduction: number;

  /** Total overhead per tick (mining + hauling spawn costs) */
  totalOverhead: number;

  /** Energy available for projects per tick */
  projectEnergy: number;

  /** Is the allocation self-sustaining? */
  isSustainable: boolean;
}

/**
 * Balance solver configuration.
 */
export interface BalanceSolverConfig {
  /** Maximum iterations for convergence */
  maxIterations: number;

  /** Convergence threshold (stop when improvement < this) */
  convergenceThreshold: number;

  /** Minimum project energy before we consider adding more capacity */
  minProjectEnergy: number;
}

const DEFAULT_CONFIG: BalanceSolverConfig = {
  maxIterations: 100,
  convergenceThreshold: 0.01,
  minProjectEnergy: 1,
};

/**
 * Solves for the optimal flow allocation.
 *
 * Algorithm:
 * 1. Start with minimum viable miners (one per source)
 * 2. Calculate required hauling
 * 3. Check if sustainable
 * 4. If not sustainable, reduce least valuable allocations
 * 5. If sustainable with excess, add highest marginal value allocations
 */
export function solveFlowBalance(
  supplyEdges: SupplyEdge[],
  carryEdges: CarryEdge[],
  config: Partial<BalanceSolverConfig> = {}
): FlowAllocation {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Initialize allocations
  const supplies: SupplyAllocation[] = supplyEdges.map((edge) => ({
    edge,
    minerCount: 1, // Start with one miner per source
    harvestPerTick: 0,
    spawnCostPerTick: 0,
    netPerTick: 0,
    isLocal: false, // Will be determined later
  }));

  const carries: CarryAllocation[] = carryEdges.map((edge) => ({
    edge,
    haulerCount: 0, // Start with no haulers
    throughputPerTick: 0,
    spawnCostPerTick: 0,
    energyCarried: 0,
  }));

  // Group supply edges by spawn node to determine local vs remote
  const supplyBySpawn = new Map<string, SupplyAllocation[]>();
  for (const supply of supplies) {
    const spawnId = supply.edge.spawnId;
    if (!supplyBySpawn.has(spawnId)) {
      supplyBySpawn.set(spawnId, []);
    }
    supplyBySpawn.get(spawnId)!.push(supply);

    // Local if source is in same node as spawn
    supply.isLocal = supply.edge.fromNodeId === supply.edge.toNodeId;
  }

  // Group carry edges by spawn
  const carryBySpawn = new Map<string, CarryAllocation[]>();
  for (const carry of carries) {
    const spawnId = carry.edge.spawnId;
    if (!carryBySpawn.has(spawnId)) {
      carryBySpawn.set(spawnId, []);
    }
    carryBySpawn.get(spawnId)!.push(carry);
  }

  // Iterate to find equilibrium
  let previousProjectEnergy = -Infinity;

  for (let iteration = 0; iteration < cfg.maxIterations; iteration++) {
    // Calculate current state
    calculateSupplyMetrics(supplies);
    calculateCarryRequirements(supplies, carries);

    const totalProduction = supplies.reduce((sum, s) => sum + s.harvestPerTick, 0);
    const miningOverhead = supplies.reduce((sum, s) => sum + s.spawnCostPerTick, 0);
    const haulingOverhead = carries.reduce((sum, c) => sum + c.spawnCostPerTick, 0);
    const projectEnergy = totalProduction - miningOverhead - haulingOverhead;

    // Check convergence
    if (Math.abs(projectEnergy - previousProjectEnergy) < cfg.convergenceThreshold) {
      break;
    }
    previousProjectEnergy = projectEnergy;

    // If not sustainable, trim allocations
    if (projectEnergy < 0) {
      trimLowestValueAllocation(supplies, carries);
      continue;
    }

    // If sustainable with excess, try to add more capacity
    if (projectEnergy > cfg.minProjectEnergy) {
      const added = addHighestValueAllocation(supplies, carries);
      if (!added) {
        // No more positive-marginal additions possible
        break;
      }
    }
  }

  // Final calculation
  calculateSupplyMetrics(supplies);
  calculateCarryRequirements(supplies, carries);

  const totalProduction = supplies.reduce((sum, s) => sum + s.harvestPerTick, 0);
  const totalOverhead =
    supplies.reduce((sum, s) => sum + s.spawnCostPerTick, 0) +
    carries.reduce((sum, c) => sum + c.spawnCostPerTick, 0);
  const projectEnergy = totalProduction - totalOverhead;

  return {
    supplies,
    carries,
    totalProduction,
    totalOverhead,
    projectEnergy,
    isSustainable: projectEnergy >= 0,
  };
}

/**
 * Calculates metrics for each supply allocation.
 */
function calculateSupplyMetrics(supplies: SupplyAllocation[]): void {
  for (const supply of supplies) {
    const edge = supply.edge;

    // Harvest rate per miner
    const harvestPerMiner = edge.minerWorkParts * 2;

    // Source rate limit
    const sourceLimit = edge.sourceCapacity / 300;

    // Actual harvest rate (capped by source)
    supply.harvestPerTick = Math.min(
      supply.minerCount * harvestPerMiner,
      sourceLimit
    );

    // Spawn cost (amortized)
    supply.spawnCostPerTick =
      (supply.minerCount * edge.minerSpawnCost) / edge.minerLifetime;

    // Net energy
    supply.netPerTick = supply.harvestPerTick - supply.spawnCostPerTick;
  }
}

/**
 * Calculates hauler requirements based on remote source production.
 */
function calculateCarryRequirements(
  supplies: SupplyAllocation[],
  carries: CarryAllocation[]
): void {
  // Build map of node -> energy to carry out
  const energyToCarry = new Map<string, number>();

  for (const supply of supplies) {
    if (!supply.isLocal && supply.netPerTick > 0) {
      const sourceNode = supply.edge.fromNodeId;
      const current = energyToCarry.get(sourceNode) ?? 0;
      energyToCarry.set(sourceNode, current + supply.netPerTick);
    }
  }

  // Assign haulers to carry edges
  for (const carry of carries) {
    const energyNeeded = energyToCarry.get(carry.edge.toNodeId) ?? 0;

    if (energyNeeded > 0) {
      // Calculate how many haulers needed
      const throughputPerHauler = calculateCarryEdgeThroughput(carry.edge);

      if (throughputPerHauler > 0) {
        carry.haulerCount = Math.ceil(energyNeeded / throughputPerHauler);
        carry.throughputPerTick = Math.min(
          carry.haulerCount * throughputPerHauler,
          energyNeeded
        );
        carry.energyCarried = carry.throughputPerTick;
        carry.spawnCostPerTick =
          (carry.haulerCount * carry.edge.haulerSpawnCost) /
          carry.edge.haulerLifetime;
      }
    } else {
      carry.haulerCount = 0;
      carry.throughputPerTick = 0;
      carry.energyCarried = 0;
      carry.spawnCostPerTick = 0;
    }
  }
}

/**
 * Removes the lowest value allocation to reduce deficit.
 */
function trimLowestValueAllocation(
  supplies: SupplyAllocation[],
  carries: CarryAllocation[]
): boolean {
  // Find the supply with lowest net value per miner
  let lowestSupply: SupplyAllocation | null = null;
  let lowestValue = Infinity;

  for (const supply of supplies) {
    if (supply.minerCount > 0) {
      const valuePerMiner = supply.netPerTick / supply.minerCount;
      if (valuePerMiner < lowestValue) {
        lowestValue = valuePerMiner;
        lowestSupply = supply;
      }
    }
  }

  // If we found a supply with negative or low value, remove a miner
  if (lowestSupply && lowestValue < 0) {
    lowestSupply.minerCount = Math.max(0, lowestSupply.minerCount - 1);
    return true;
  }

  return false;
}

/**
 * Adds the highest marginal value allocation.
 */
function addHighestValueAllocation(
  supplies: SupplyAllocation[],
  _carries: CarryAllocation[]
): boolean {
  // Find supply with highest marginal value for adding a miner
  let bestSupply: SupplyAllocation | null = null;
  let bestMarginalValue = 0;

  for (const supply of supplies) {
    const marginalValue = calculateMinerMarginalValue(supply);
    if (marginalValue > bestMarginalValue) {
      bestMarginalValue = marginalValue;
      bestSupply = supply;
    }
  }

  if (bestSupply) {
    bestSupply.minerCount += 1;
    return true;
  }

  return false;
}

/**
 * Calculates the marginal value of adding one more miner.
 */
function calculateMinerMarginalValue(supply: SupplyAllocation): number {
  const edge = supply.edge;
  const harvestPerMiner = edge.minerWorkParts * 2;
  const sourceLimit = edge.sourceCapacity / 300;
  const currentHarvest = supply.minerCount * harvestPerMiner;

  // If at source limit, no marginal value
  if (currentHarvest >= sourceLimit) {
    return -edge.minerSpawnCost / edge.minerLifetime;
  }

  // Additional harvest from one more miner
  const additionalHarvest = Math.min(harvestPerMiner, sourceLimit - currentHarvest);

  // Marginal cost
  const marginalCost = edge.minerSpawnCost / edge.minerLifetime;

  // For remote sources, also subtract carry cost
  let carryCost = 0;
  if (!supply.isLocal) {
    // Rough estimate: ~10% overhead for hauling
    carryCost = additionalHarvest * 0.1;
  }

  return additionalHarvest - marginalCost - carryCost;
}

/**
 * Prints a summary of the flow allocation.
 */
export function formatFlowAllocation(allocation: FlowAllocation): string {
  const lines: string[] = [
    "=== Flow Allocation Summary ===",
    "",
    `Total Production: ${allocation.totalProduction.toFixed(2)}/tick`,
    `Total Overhead:   ${allocation.totalOverhead.toFixed(2)}/tick`,
    `Project Energy:   ${allocation.projectEnergy.toFixed(2)}/tick`,
    `Sustainable:      ${allocation.isSustainable ? "YES" : "NO"}`,
    "",
    "--- Mining ---",
  ];

  for (const supply of allocation.supplies) {
    if (supply.minerCount > 0) {
      lines.push(
        `  ${supply.edge.sourceId}: ${supply.minerCount} miners, ` +
          `${supply.harvestPerTick.toFixed(1)}/tick harvest, ` +
          `${supply.netPerTick.toFixed(1)}/tick net` +
          (supply.isLocal ? " (local)" : " (remote)")
      );
    }
  }

  lines.push("", "--- Hauling ---");

  for (const carry of allocation.carries) {
    if (carry.haulerCount > 0) {
      lines.push(
        `  ${carry.edge.fromNodeId} → ${carry.edge.toNodeId}: ${carry.haulerCount} haulers, ` +
          `${carry.energyCarried.toFixed(1)}/tick`
      );
    }
  }

  return lines.join("\n");
}
