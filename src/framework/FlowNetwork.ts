/**
 * @fileoverview Flow network for colony economy optimization.
 *
 * The colony economy is modeled as a flow network where energy flows from
 * sources through haulers to projects. The key challenge is the bootstrap
 * problem: hauling requires creeps, which require spawning, which requires
 * energy, which requires hauling.
 *
 * Solution: Find the equilibrium where the system is self-sustaining.
 *
 * The network is structured as:
 *
 *   [Sources] --supply--> [Spawn Nodes] --carry--> [Project Nodes]
 *        ^                      |                        |
 *        |                      v                        |
 *        +---- spawn cost <---- [Spawn Capacity] <-------+
 *
 * At equilibrium:
 *   Total Energy Produced = Mining Energy + Hauling Costs + Project Energy
 *
 * We solve for the maximum project energy by iteratively adjusting flows.
 *
 * @module framework/FlowNetwork
 */

import { Node, NodeResource } from "../nodes/Node";
import { NodeNavigator, createEdgeKey } from "../nodes/NodeNavigator";
import {
  FlowEdge,
  SupplyEdge,
  CarryEdge,
  ProjectEdge,
  createSupplyEdge,
  createCarryEdge,
  calculateSupplyEdgeNetPerTick,
  calculateCarryEdgeThroughput,
  calculateCarryEdgeCostPerEnergy,
} from "./FlowEdge";

/**
 * A spawn node in the flow network.
 * Spawns are the central hubs that:
 * - Pay for miners (supply edges)
 * - Pay for haulers (carry edges)
 * - Receive energy from nearby sources
 * - Send energy to projects
 */
export interface SpawnFlowNode {
  /** Node ID containing the spawn */
  nodeId: string;

  /** Spawn game object ID */
  spawnId: string;

  /** Spawn capacity (energy per tick that can be used for spawning) */
  spawnCapacity: number;

  /** Supply edges (sources feeding this spawn) */
  supplyEdges: SupplyEdge[];

  /** Carry edges originating from this spawn's node */
  carryEdges: CarryEdge[];

  /** Energy income per tick (from supply edges) */
  energyIncome: number;

  /** Energy cost per tick (spawn costs for miners + haulers) */
  energyCost: number;

  /** Net energy available for projects per tick */
  netEnergy: number;
}

/**
 * Result of flow network analysis.
 */
export interface FlowNetworkAnalysis {
  /** Spawn nodes in the network */
  spawnNodes: SpawnFlowNode[];

  /** Total energy production per tick (gross) */
  totalProduction: number;

  /** Total mining overhead per tick */
  miningOverhead: number;

  /** Total hauling overhead per tick */
  haulingOverhead: number;

  /** Total energy available for projects per tick */
  projectEnergy: number;

  /** Is the network self-sustaining? */
  isSustainable: boolean;

  /** Bootstrap deficit (if not sustainable) */
  bootstrapDeficit: number;
}

/**
 * Configuration for the flow network.
 */
export interface FlowNetworkConfig {
  /** Maximum distance to consider for source-spawn assignments */
  maxSourceSpawnDistance: number;

  /** Maximum distance for carry edges */
  maxCarryDistance: number;

  /** Miner lifetime in ticks */
  minerLifetime: number;

  /** Hauler lifetime in ticks */
  haulerLifetime: number;

  /** Default hauler carry parts */
  defaultHaulerCarryParts: number;
}

const DEFAULT_CONFIG: FlowNetworkConfig = {
  maxSourceSpawnDistance: 150,
  maxCarryDistance: 200,
  minerLifetime: 1500,
  haulerLifetime: 1500,
  defaultHaulerCarryParts: 10,
};

/**
 * FlowNetwork represents the colony's energy economy as a flow graph.
 *
 * The network connects sources to spawns to projects, tracking how
 * energy flows through the system and what overhead is required.
 */
export class FlowNetwork {
  private nodes: Map<string, Node>;
  private navigator: NodeNavigator;
  private config: FlowNetworkConfig;

  private spawnNodes: Map<string, SpawnFlowNode>;
  private supplyEdges: Map<string, SupplyEdge>;
  private carryEdges: Map<string, CarryEdge>;

  constructor(
    nodes: Node[],
    navigator: NodeNavigator,
    config: Partial<FlowNetworkConfig> = {}
  ) {
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.navigator = navigator;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.spawnNodes = new Map();
    this.supplyEdges = new Map();
    this.carryEdges = new Map();
  }

  /**
   * Builds the flow network by discovering all edges.
   *
   * 1. Find all sources and spawns
   * 2. Create supply edges (source → spawn assignments)
   * 3. Create carry edges (node → node transport)
   * 4. Calculate energy flows
   */
  build(): void {
    this.discoverSpawnNodes();
    this.createSupplyEdges();
    this.createCarryEdges();
    this.calculateFlows();
  }

  /**
   * Discovers all spawn nodes in the network.
   */
  private discoverSpawnNodes(): void {
    for (const node of this.nodes.values()) {
      const spawns = node.resources.filter((r) => r.type === "spawn");

      for (const spawn of spawns) {
        const spawnNode: SpawnFlowNode = {
          nodeId: node.id,
          spawnId: spawn.id,
          // Spawn capacity: one spawn can produce ~5.56 energy/tick worth of creeps
          // (300 energy capacity / 3 ticks per spawn = 100 energy per tick spawn ability)
          // But actually limited by spawn time: 3 ticks per body part
          // A 550 cost miner = 6 parts = 18 ticks to spawn
          // So spawn throughput = 550 / 18 ≈ 30.5 energy/tick spawning capacity
          spawnCapacity: 30,
          supplyEdges: [],
          carryEdges: [],
          energyIncome: 0,
          energyCost: 0,
          netEnergy: 0,
        };

        this.spawnNodes.set(spawn.id, spawnNode);
      }
    }
  }

  /**
   * Creates supply edges connecting sources to nearby spawns.
   *
   * Each source should be assigned to exactly one spawn (the closest one
   * that can afford to mine it). The supply edge captures the full cost
   * and benefit of that mining operation.
   */
  private createSupplyEdges(): void {
    // Find all sources
    const sources: Array<{ resource: NodeResource; node: Node }> = [];
    for (const node of this.nodes.values()) {
      for (const resource of node.resources) {
        if (resource.type === "source") {
          sources.push({ resource, node });
        }
      }
    }

    // Assign each source to the nearest spawn
    for (const { resource: source, node: sourceNode } of sources) {
      let bestSpawn: SpawnFlowNode | null = null;
      let bestDistance = Infinity;

      for (const spawnNode of this.spawnNodes.values()) {
        const distance = this.navigator.getDistance(
          sourceNode.id,
          spawnNode.nodeId,
          "spatial"
        );

        if (distance < bestDistance && distance <= this.config.maxSourceSpawnDistance) {
          bestDistance = distance;
          bestSpawn = spawnNode;
        }
      }

      if (bestSpawn) {
        const edge = createSupplyEdge({
          sourceId: source.id,
          sourceNodeId: sourceNode.id,
          sourcePosition: source.position,
          sourceCapacity: source.capacity ?? 3000,
          spawnId: bestSpawn.spawnId,
          spawnNodeId: bestSpawn.nodeId,
          spawnToSourceDistance: bestDistance,
          minerLifetime: this.config.minerLifetime,
        });

        this.supplyEdges.set(edge.id, edge);
        bestSpawn.supplyEdges.push(edge);
      }
    }
  }

  /**
   * Creates carry edges between nodes.
   *
   * Carry edges represent the ability to move energy between nodes.
   * They're needed when:
   * - A source node doesn't have a spawn (energy must be carried to spawn)
   * - A project is in a different node than the spawn
   */
  private createCarryEdges(): void {
    // For each spawn node, create carry edges to nearby nodes
    for (const spawnNode of this.spawnNodes.values()) {
      const nearbyNodes = this.navigator.getNodesWithinDistance(
        spawnNode.nodeId,
        this.config.maxCarryDistance,
        "spatial"
      );

      for (const [targetNodeId, distance] of nearbyNodes) {
        if (targetNodeId === spawnNode.nodeId) continue;
        if (distance === 0) continue;

        const edge = createCarryEdge({
          fromNodeId: spawnNode.nodeId,
          toNodeId: targetNodeId,
          spawnId: spawnNode.spawnId,
          walkingDistance: distance,
          haulerCarryParts: this.config.defaultHaulerCarryParts,
          haulerLifetime: this.config.haulerLifetime,
        });

        this.carryEdges.set(edge.id, edge);
        spawnNode.carryEdges.push(edge);
      }
    }
  }

  /**
   * Calculates energy flows through the network.
   *
   * This is the core of the bootstrap problem solution.
   * We need to find an equilibrium where:
   *   energy_income >= mining_cost + hauling_cost + project_energy
   */
  private calculateFlows(): void {
    for (const spawnNode of this.spawnNodes.values()) {
      // Calculate energy income from supply edges
      let energyIncome = 0;
      let miningCost = 0;

      for (const edge of spawnNode.supplyEdges) {
        // Gross energy harvested per tick
        const harvestRate = edge.minerWorkParts * 2;
        const sourceRateLimit = edge.sourceCapacity / 300;
        const grossPerTick = Math.min(harvestRate, sourceRateLimit);

        energyIncome += grossPerTick;

        // Mining cost = spawn cost amortized over lifetime
        miningCost += edge.minerSpawnCost / edge.minerLifetime;
      }

      // Calculate hauling costs for moving energy from remote sources
      let haulingCost = 0;
      for (const edge of spawnNode.supplyEdges) {
        // If source is in a different node, we need haulers
        if (edge.fromNodeId !== spawnNode.nodeId) {
          // Find the carry edge cost
          const carryEdge = spawnNode.carryEdges.find(
            (c) => c.toNodeId === edge.fromNodeId || c.fromNodeId === edge.fromNodeId
          );

          if (carryEdge) {
            // Cost to carry this source's energy
            const sourceOutput = calculateSupplyEdgeNetPerTick(edge);
            const costPerEnergy = calculateCarryEdgeCostPerEnergy(carryEdge);
            haulingCost += sourceOutput * costPerEnergy;
          }
        }
      }

      spawnNode.energyIncome = energyIncome;
      spawnNode.energyCost = miningCost + haulingCost;
      spawnNode.netEnergy = energyIncome - spawnNode.energyCost;
    }
  }

  /**
   * Analyzes the flow network and returns key metrics.
   */
  analyze(): FlowNetworkAnalysis {
    let totalProduction = 0;
    let miningOverhead = 0;
    let haulingOverhead = 0;
    let projectEnergy = 0;

    for (const spawnNode of this.spawnNodes.values()) {
      totalProduction += spawnNode.energyIncome;

      // Mining overhead = spawn cost for miners
      for (const edge of spawnNode.supplyEdges) {
        miningOverhead += edge.minerSpawnCost / edge.minerLifetime;
      }

      // Hauling overhead (simplified - assumes we need to carry all remote energy)
      for (const carryEdge of spawnNode.carryEdges) {
        if (carryEdge.allocatedFlow > 0) {
          haulingOverhead += carryEdge.allocatedFlow * carryEdge.costPerUnit;
        }
      }

      // Project energy is what's left
      projectEnergy += Math.max(0, spawnNode.netEnergy);
    }

    const isSustainable = projectEnergy > 0;
    const bootstrapDeficit = isSustainable ? 0 : -projectEnergy;

    return {
      spawnNodes: Array.from(this.spawnNodes.values()),
      totalProduction,
      miningOverhead,
      haulingOverhead,
      projectEnergy,
      isSustainable,
      bootstrapDeficit,
    };
  }

  /**
   * Gets all supply edges in the network.
   */
  getSupplyEdges(): SupplyEdge[] {
    return Array.from(this.supplyEdges.values());
  }

  /**
   * Gets all carry edges in the network.
   */
  getCarryEdges(): CarryEdge[] {
    return Array.from(this.carryEdges.values());
  }

  /**
   * Gets spawn nodes.
   */
  getSpawnNodes(): SpawnFlowNode[] {
    return Array.from(this.spawnNodes.values());
  }

  /**
   * Gets the supply edge for a specific source.
   */
  getSupplyEdgeForSource(sourceId: string): SupplyEdge | undefined {
    for (const edge of this.supplyEdges.values()) {
      if (edge.sourceId === sourceId) {
        return edge;
      }
    }
    return undefined;
  }

  /**
   * Gets carry edges from a spawn node.
   */
  getCarryEdgesFromSpawn(spawnId: string): CarryEdge[] {
    const spawnNode = this.spawnNodes.get(spawnId);
    return spawnNode?.carryEdges ?? [];
  }
}

/**
 * Finds the optimal flow allocation to maximize project energy.
 *
 * This solves the bootstrap problem by iteratively adjusting the allocation
 * of spawn capacity between miners, haulers, and project workers.
 *
 * The algorithm:
 * 1. Start with minimum viable mining (just enough to cover spawn costs)
 * 2. Add haulers as needed to transport energy
 * 3. Allocate remaining capacity to projects
 * 4. Iterate until equilibrium
 */
export function optimizeFlowAllocation(network: FlowNetwork): FlowNetworkAnalysis {
  // For now, just rebuild and analyze
  // TODO: Implement iterative optimization
  network.build();
  return network.analyze();
}

/**
 * Calculates the marginal value of adding one more miner to a source.
 *
 * Marginal value = (additional energy harvested) - (miner spawn cost / lifetime)
 *
 * If marginal value > 0, it's worth adding the miner.
 * If marginal value < 0, we're over-mining.
 */
export function calculateMiningMarginalValue(
  supplyEdge: SupplyEdge,
  currentMiners: number
): number {
  const harvestRatePerMiner = supplyEdge.minerWorkParts * 2;
  const currentHarvestRate = currentMiners * harvestRatePerMiner;
  const sourceRateLimit = supplyEdge.sourceCapacity / 300;

  // If we're already at the source limit, marginal value is negative
  if (currentHarvestRate >= sourceRateLimit) {
    return -supplyEdge.minerSpawnCost / supplyEdge.minerLifetime;
  }

  // Additional harvest rate from one more miner
  const additionalHarvest = Math.min(
    harvestRatePerMiner,
    sourceRateLimit - currentHarvestRate
  );

  // Marginal cost = spawn cost amortized
  const marginalCost = supplyEdge.minerSpawnCost / supplyEdge.minerLifetime;

  return additionalHarvest - marginalCost;
}

/**
 * Calculates the marginal value of adding one more hauler to a route.
 *
 * Marginal value = (energy delivered per tick) - (hauler spawn cost / lifetime)
 *
 * This accounts for the round-trip time and capacity utilization.
 */
export function calculateHaulingMarginalValue(
  carryEdge: CarryEdge,
  energyToCarry: number,
  currentHaulers: number
): number {
  const throughputPerHauler = calculateCarryEdgeThroughput(carryEdge);
  const currentThroughput = currentHaulers * throughputPerHauler;

  // If current throughput exceeds energy to carry, marginal value is negative
  if (currentThroughput >= energyToCarry) {
    return -carryEdge.haulerSpawnCost / carryEdge.haulerLifetime;
  }

  // Additional throughput from one more hauler
  const additionalThroughput = Math.min(
    throughputPerHauler,
    energyToCarry - currentThroughput
  );

  // Marginal cost = spawn cost amortized
  const marginalCost = carryEdge.haulerSpawnCost / carryEdge.haulerLifetime;

  return additionalThroughput - marginalCost;
}
