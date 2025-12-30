/**
 * FlowSolver - Priority-Weighted Flow Allocation
 *
 * Solves the flow allocation problem: given sources, sinks, and edges,
 * determine optimal miner/hauler assignments and energy distribution.
 *
 * This replaces Market.clear() with a global optimization approach.
 *
 * Algorithm:
 * 1. Assign miners to sources (one per source)
 * 2. Calculate total harvest capacity
 * 3. Calculate mining overhead
 * 4. For each sink (by priority), allocate energy from nearest sources
 * 5. Calculate hauling requirements for each allocation
 * 6. Verify system is sustainable (overhead < harvest)
 */

import {
  FlowSource,
  FlowSink,
  FlowEdge,
  FlowProblem,
  FlowSolution,
  FlowConstraints,
  MinerAssignment,
  HaulerAssignment,
  SinkAllocation,
  MINER_OVERHEAD_PER_TICK,
  BODY_COSTS,
  CREEP_LIFETIME,
  SOURCE_ENERGY_PER_TICK,
  calculateCarryParts,
  calculateHaulerCostPerTick,
  calculateRoundTrip,
  TerrainProfile,
  EdgeVariant,
  HaulerRatio,
  MiningMode,
} from "./FlowTypes";
import {
  generateEdgeVariants,
  selectBestVariant,
  VariantConstraints,
} from "../framework/EdgeVariant";

// =============================================================================
// SOLVER CLASS
// =============================================================================

/**
 * FlowSolver computes optimal energy allocation across the network.
 *
 * The solver uses a greedy priority-based algorithm:
 * 1. Higher priority sinks get energy first
 * 2. Each sink draws from nearest sources
 * 3. Overhead (miners + haulers) is accounted for
 * 4. Remaining energy flows to lower priority sinks
 */
export class FlowSolver {
  /**
   * Solve the flow allocation problem.
   *
   * @param problem - Flow problem with sources, sinks, edges, constraints
   * @returns Flow solution with assignments and metrics
   */
  solve(problem: FlowProblem): FlowSolution {
    const { sources, sinks, edges, constraints } = problem;
    const currentTick = typeof Game !== "undefined" ? Game.time : 0;

    // Initialize solution
    const solution: FlowSolution = {
      miners: [],
      haulers: [],
      sinkAllocations: [],
      totalHarvest: 0,
      miningOverhead: 0,
      haulingOverhead: 0,
      totalOverhead: 0,
      netEnergy: 0,
      efficiency: 0,
      unmetDemand: new Map(),
      isSustainable: false,
      warnings: [],
      computedAt: currentTick,
    };

    if (sources.length === 0) {
      solution.warnings.push("No sources available");
      return solution;
    }

    // Build edge lookup for fast access
    const edgeMap = this.buildEdgeMap(edges);

    // Find spawn sinks for miner assignments
    const spawnSinks = sinks.filter(s => s.type === "spawn");
    if (spawnSinks.length === 0) {
      solution.warnings.push("No spawn sinks - cannot assign miners");
      return solution;
    }

    // Step 1: Assign miners to sources
    const minerAssignments = this.assignMiners(sources, spawnSinks, edgeMap, constraints);
    solution.miners = minerAssignments;

    // Step 2: Calculate total harvest and mining overhead
    solution.totalHarvest = minerAssignments.reduce((sum, m) => sum + m.harvestRate, 0);
    solution.miningOverhead = minerAssignments.reduce((sum, m) => sum + m.spawnCostPerTick, 0);

    // Step 3: Track available energy per source
    const sourceEnergy = new Map<string, number>();
    for (const miner of minerAssignments) {
      sourceEnergy.set(miner.sourceId, miner.harvestRate);
    }

    // Step 4: Allocate energy to sinks by priority
    // Sort sinks by priority (should already be sorted, but ensure it)
    const sortedSinks = [...sinks].sort((a, b) => b.priority - a.priority);

    let totalHaulingOverhead = 0;
    const haulerAssignments: HaulerAssignment[] = [];

    for (const sink of sortedSinks) {
      const allocation = this.allocateToSink(
        sink,
        sourceEnergy,
        edgeMap,
        spawnSinks,
        constraints
      );

      solution.sinkAllocations.push(allocation);

      // Track unmet demand
      if (allocation.unmet > 0) {
        solution.unmetDemand.set(sink.id, allocation.unmet);
      }

      // Create hauler assignments for this allocation
      for (const flow of allocation.sourceFlows) {
        if (flow.amount <= 0) continue;

        const edge = edgeMap.get(this.edgeKey(flow.sourceId, sink.id));
        if (!edge) continue;

        // Find nearest spawn for these haulers
        const nearestSpawn = this.findNearestSpawn(flow.sourceId, spawnSinks, edgeMap);

        // Try variant-based optimization if terrain data is available
        const haulerAssignment = this.createHaulerAssignment(
          edge,
          flow,
          sink.id,
          nearestSpawn?.id || spawnSinks[0].id,
          constraints
        );

        haulerAssignments.push(haulerAssignment);
        totalHaulingOverhead += haulerAssignment.spawnCostPerTick;
      }
    }

    solution.haulers = haulerAssignments;
    solution.haulingOverhead = totalHaulingOverhead;

    // Step 5: Calculate final metrics
    solution.totalOverhead = solution.miningOverhead + solution.haulingOverhead;
    solution.netEnergy = solution.totalHarvest - solution.totalOverhead;
    solution.efficiency = solution.totalHarvest > 0
      ? (solution.netEnergy / solution.totalHarvest) * 100
      : 0;

    // Check sustainability
    solution.isSustainable = solution.netEnergy >= 0;
    if (!solution.isSustainable) {
      solution.warnings.push(
        `Economy not sustainable: overhead ${solution.totalOverhead.toFixed(2)} > harvest ${solution.totalHarvest.toFixed(2)}`
      );
    }

    // Check minimum controller upgrade
    const controllerAlloc = solution.sinkAllocations.find(a => a.sinkType === "controller");
    if (controllerAlloc && controllerAlloc.allocated < constraints.minControllerUpgrade) {
      solution.warnings.push(
        `Controller upgrade ${controllerAlloc.allocated.toFixed(2)} below minimum ${constraints.minControllerUpgrade}`
      );
    }

    return solution;
  }

  // ===========================================================================
  // MINER ASSIGNMENT
  // ===========================================================================

  /**
   * Assign miners to sources.
   * Each source gets one miner, assigned to nearest spawn.
   * Only assigns to sources that are profitable (net positive energy after overhead).
   */
  private assignMiners(
    sources: FlowSource[],
    spawnSinks: FlowSink[],
    edgeMap: Map<string, FlowEdge>,
    constraints: FlowConstraints
  ): MinerAssignment[] {
    const assignments: MinerAssignment[] = [];

    for (const source of sources) {
      // Find nearest spawn
      const nearestSpawn = this.findNearestSpawn(source.id, spawnSinks, edgeMap);
      if (!nearestSpawn) continue;

      const spawnDistance = nearestSpawn.distance;

      // Calculate profitability: is this source worth mining?
      // Net = harvestRate - minerOverhead - haulerOverhead
      const harvestRate = source.capacity;
      const minerOverhead = MINER_OVERHEAD_PER_TICK;

      // Estimate hauler overhead to nearest sink (spawn)
      // This is a conservative estimate - actual hauling may be shorter
      const roundTrip = calculateRoundTrip(spawnDistance);
      const carryParts = calculateCarryParts(harvestRate, spawnDistance);
      const haulerOverhead = calculateHaulerCostPerTick(carryParts);

      const totalOverhead = minerOverhead + haulerOverhead;
      const netEnergy = harvestRate - totalOverhead;

      // Calculate efficiency percentage: (harvestRate - totalOverhead) / harvestRate * 100
      const efficiency = (netEnergy / harvestRate) * 100;

      // Only mine if profitable:
      // 1. Net energy must be positive (at least 1 e/tick buffer)
      // 2. Efficiency must be at least 50% (otherwise overhead is too high)
      // This prevents very long-range mines that waste creep time and CPU
      const MIN_NET_ENERGY = 1.0;
      const MIN_EFFICIENCY = 50;
      if (netEnergy < MIN_NET_ENERGY || efficiency < MIN_EFFICIENCY) {
        console.log(`[FlowSolver] Skipping unprofitable source ${source.id.slice(-8)}: ` +
          `harvest=${harvestRate.toFixed(1)}, overhead=${totalOverhead.toFixed(2)}, ` +
          `net=${netEnergy.toFixed(2)}, eff=${efficiency.toFixed(0)}%, distance=${spawnDistance}`);
        continue;
      }

      assignments.push({
        sourceId: source.id,
        nodeId: source.nodeId,
        spawnId: nearestSpawn.id,
        spawnDistance,
        harvestRate: source.capacity,
        spawnCostPerTick: MINER_OVERHEAD_PER_TICK,
        maxMiners: source.maxMiners,
        efficiency,
      });
    }

    return assignments;
  }

  // ===========================================================================
  // SINK ALLOCATION
  // ===========================================================================

  /**
   * Allocate energy to a single sink from available sources.
   * Uses greedy nearest-source allocation.
   */
  private allocateToSink(
    sink: FlowSink,
    sourceEnergy: Map<string, number>,
    edgeMap: Map<string, FlowEdge>,
    spawnSinks: FlowSink[],
    constraints: FlowConstraints
  ): SinkAllocation {
    const allocation: SinkAllocation = {
      sinkId: sink.id,
      sinkType: sink.type,
      allocated: 0,
      demand: sink.demand,
      unmet: sink.demand,
      priority: sink.priority,
      sourceFlows: [],
    };

    // Special case: spawn sink needs overhead allocation
    // This is the energy to produce miners/haulers, not direct transfer
    if (sink.type === "spawn") {
      // Spawn overhead is accounted for in mining overhead
      // Here we just need to ensure energy reaches the spawn for creep production
      // The "demand" for spawn is the overhead we need to cover
    }

    // Get all edges to this sink, sorted by distance
    const edgesToSink: Array<{ sourceId: string; edge: FlowEdge; available: number }> = [];

    for (const [sourceId, available] of sourceEnergy) {
      if (available <= 0) continue;

      const edge = edgeMap.get(this.edgeKey(sourceId, sink.id));
      if (edge) {
        edgesToSink.push({ sourceId, edge, available });
      }
    }

    // Sort by distance (greedy nearest-first)
    edgesToSink.sort((a, b) => a.edge.distance - b.edge.distance);

    // Allocate from nearest sources until demand is met or sources exhausted
    let remaining = Math.min(sink.demand, sink.capacity);

    for (const { sourceId, edge, available } of edgesToSink) {
      if (remaining <= 0) break;

      const take = Math.min(available, remaining);

      // Deduct from source
      sourceEnergy.set(sourceId, available - take);

      // Record flow
      allocation.sourceFlows.push({
        sourceId,
        amount: take,
        distance: edge.distance,
      });

      allocation.allocated += take;
      remaining -= take;
    }

    allocation.unmet = Math.max(0, sink.demand - allocation.allocated);

    return allocation;
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Build edge lookup map for fast access.
   */
  private buildEdgeMap(edges: FlowEdge[]): Map<string, FlowEdge> {
    const map = new Map<string, FlowEdge>();
    for (const edge of edges) {
      map.set(edge.id, edge);
      // Also index by from|to key
      map.set(this.edgeKey(edge.fromId, edge.toId), edge);
    }
    return map;
  }

  /**
   * Create edge key for lookup.
   */
  private edgeKey(fromId: string, toId: string): string {
    return fromId < toId ? `${fromId}|${toId}` : `${toId}|${fromId}`;
  }

  /**
   * Find nearest spawn to a source.
   */
  private findNearestSpawn(
    sourceId: string,
    spawnSinks: FlowSink[],
    edgeMap: Map<string, FlowEdge>
  ): { id: string; distance: number } | null {
    let nearest: { id: string; distance: number } | null = null;

    for (const spawn of spawnSinks) {
      const edge = edgeMap.get(this.edgeKey(sourceId, spawn.id));
      if (edge && (!nearest || edge.distance < nearest.distance)) {
        nearest = { id: spawn.id, distance: edge.distance };
      }
    }

    return nearest;
  }

  /**
   * Create a hauler assignment, using variant optimization if terrain data is available.
   */
  private createHaulerAssignment(
    edge: FlowEdge,
    flow: { sourceId: string; amount: number; distance: number },
    sinkId: string,
    spawnId: string,
    constraints: FlowConstraints
  ): HaulerAssignment {
    // If edge has terrain profile and we have spawn energy capacity, use variant selection
    if (edge.terrain && constraints.spawnEnergyCapacity) {
      const variantConstraints: VariantConstraints = {
        spawnEnergy: constraints.spawnEnergyCapacity,
        canBuildContainer: constraints.canBuildContainer ?? false,
        canBuildLink: constraints.canBuildLink ?? false,
        infrastructureBudget: constraints.infrastructureBudget ?? 0,
        sourceCapacity: flow.amount * 300, // Convert flow/tick back to capacity
        spawnToSourceDistance: flow.distance,
      };

      // Generate and select best variant
      const variants = generateEdgeVariants(
        flow.amount * 300, // sourceCapacity
        edge.terrain,
        flow.distance,
        variantConstraints
      );

      const bestVariant = selectBestVariant(variants, variantConstraints);

      if (bestVariant && bestVariant.hauler) {
        // Use variant-optimized configuration
        return {
          edgeId: edge.id,
          fromId: flow.sourceId,
          toId: sinkId,
          distance: flow.distance,
          carryParts: bestVariant.hauler.carryParts,
          flowRate: flow.amount,
          spawnCostPerTick: bestVariant.haulCost,
          spawnId,
          // Variant-specific fields
          terrain: edge.terrain,
          haulerRatio: bestVariant.hauler.ratio,
          selectedVariant: bestVariant,
        };
      }
    }

    // Fallback: use classic 1:1 calculation
    const carryParts = calculateCarryParts(flow.amount, flow.distance);
    const haulerCost = calculateHaulerCostPerTick(carryParts);

    return {
      edgeId: edge.id,
      fromId: flow.sourceId,
      toId: sinkId,
      distance: flow.distance,
      carryParts,
      flowRate: flow.amount,
      spawnCostPerTick: haulerCost,
      spawnId,
    };
  }
}

// =============================================================================
// ITERATIVE SOLVER (For Bootstrap/Deficit Scenarios)
// =============================================================================

/**
 * Iteratively solve flow allocation, adjusting for overhead feedback.
 *
 * The basic solver doesn't account for the circular dependency:
 * hauling overhead depends on allocations, but allocations depend on
 * available energy after overhead.
 *
 * This iterative solver:
 * 1. Makes initial allocation ignoring hauling overhead
 * 2. Calculates actual hauling overhead
 * 3. Adjusts allocations to account for overhead
 * 4. Repeats until convergence
 *
 * @param problem - Flow problem
 * @param maxIterations - Maximum iterations (default: 10)
 * @returns Converged flow solution
 */
export function solveIteratively(
  problem: FlowProblem,
  maxIterations: number = 10
): FlowSolution {
  const solver = new FlowSolver();
  let solution = solver.solve(problem);

  // If already sustainable, return
  if (solution.isSustainable && solution.unmetDemand.size === 0) {
    return solution;
  }

  // Iteratively reduce allocations to account for overhead
  for (let i = 0; i < maxIterations; i++) {
    const prevOverhead = solution.totalOverhead;

    // Adjust sink demands based on available energy
    const availableForSinks = solution.totalHarvest - solution.miningOverhead;
    const totalDemand = problem.sinks.reduce((sum, s) => sum + s.demand, 0);

    if (availableForSinks < totalDemand) {
      // Scale down demands proportionally
      const scale = availableForSinks / totalDemand;
      for (const sink of problem.sinks) {
        sink.demand = sink.demand * scale;
      }
    }

    // Re-solve
    solution = solver.solve(problem);

    // Check convergence
    if (Math.abs(solution.totalOverhead - prevOverhead) < 0.01) {
      break;
    }
  }

  return solution;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Calculate efficiency for a given harvest and overhead.
 */
export function calculateEfficiency(harvest: number, overhead: number): number {
  if (harvest <= 0) return 0;
  return ((harvest - overhead) / harvest) * 100;
}

/**
 * Estimate total overhead for a flow problem.
 * Quick estimate without full solve.
 */
export function estimateOverhead(problem: FlowProblem): {
  miningOverhead: number;
  haulingOverhead: number;
  totalOverhead: number;
} {
  const miningOverhead = problem.sources.length * MINER_OVERHEAD_PER_TICK;

  // Estimate hauling based on average distance
  let totalHaulDistance = 0;
  let edgeCount = 0;

  for (const edge of problem.edges) {
    totalHaulDistance += edge.distance;
    edgeCount++;
  }

  const avgDistance = edgeCount > 0 ? totalHaulDistance / edgeCount : 30;
  const totalHarvest = problem.sources.length * SOURCE_ENERGY_PER_TICK;

  // Rough estimate: all energy hauled at average distance
  const avgCarryParts = calculateCarryParts(totalHarvest, avgDistance);
  const haulingOverhead = calculateHaulerCostPerTick(avgCarryParts);

  return {
    miningOverhead,
    haulingOverhead,
    totalOverhead: miningOverhead + haulingOverhead,
  };
}

/**
 * Debug: Print solution summary.
 */
export function printSolutionSummary(solution: FlowSolution): void {
  console.log("\n=== Flow Solution ===");
  console.log(`Computed at tick: ${solution.computedAt}`);
  console.log(`Sustainable: ${solution.isSustainable}`);
  console.log("");
  console.log("Energy Flow:");
  console.log(`  Total Harvest:    ${solution.totalHarvest.toFixed(2)}/tick`);
  console.log(`  Mining Overhead:  ${solution.miningOverhead.toFixed(2)}/tick`);
  console.log(`  Hauling Overhead: ${solution.haulingOverhead.toFixed(2)}/tick`);
  console.log(`  Total Overhead:   ${solution.totalOverhead.toFixed(2)}/tick`);
  console.log(`  Net Energy:       ${solution.netEnergy.toFixed(2)}/tick`);
  console.log(`  Efficiency:       ${solution.efficiency.toFixed(1)}%`);
  console.log("");
  console.log(`Miners: ${solution.miners.length}`);
  console.log(`Haulers: ${solution.haulers.length} assignments`);
  console.log(`Sink Allocations: ${solution.sinkAllocations.length}`);

  if (solution.unmetDemand.size > 0) {
    console.log("\nUnmet Demand:");
    for (const [sinkId, unmet] of solution.unmetDemand) {
      console.log(`  ${sinkId}: ${unmet.toFixed(2)}/tick`);
    }
  }

  if (solution.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of solution.warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }
}
