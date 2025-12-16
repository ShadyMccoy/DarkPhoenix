import { Position } from "../market/Offer";
import { CorpType } from "../corps/Corp";
import {
  Node,
  NodeResource,
  NodeResourceType,
  PotentialCorp,
  getResourcesByType,
  getCorpsByType
} from "./Node";

/**
 * Configuration for surveying
 */
export interface SurveyConfig {
  /** Minimum estimated ROI to consider a potential corp viable */
  minROI: number;
  /** Base value per energy unit for ROI calculations */
  energyValue: number;
  /** Base value per upgrade point for ROI calculations */
  upgradeValue: number;
  /** Cost per work-tick for ROI calculations */
  workTickCost: number;
  /** Cost per carry-tick for ROI calculations */
  carryTickCost: number;
}

/**
 * Default survey configuration
 */
export const DEFAULT_SURVEY_CONFIG: SurveyConfig = {
  minROI: 0.1,
  energyValue: 0.01,
  upgradeValue: 1.0,
  workTickCost: 0.01,
  carryTickCost: 0.005
};

/**
 * Survey result for a node
 */
export interface SurveyResult {
  /** Node that was surveyed */
  nodeId: string;
  /** Resources found in the node */
  resources: NodeResource[];
  /** Potential corps that could be created */
  potentialCorps: PotentialCorp[];
  /** Tick when survey was performed */
  surveyedAt: number;
}

/**
 * NodeSurveyor analyzes nodes to identify resources and potential corps.
 *
 * The surveyor:
 * 1. Identifies resources within a node's territory
 * 2. Determines what corps could operate on those resources
 * 3. Estimates ROI for potential corps
 * 4. Filters to viable opportunities
 */
export class NodeSurveyor {
  private config: SurveyConfig;

  constructor(config: Partial<SurveyConfig> = {}) {
    this.config = { ...DEFAULT_SURVEY_CONFIG, ...config };
  }

  /**
   * Survey a node to identify resources and potential corps
   */
  survey(node: Node, currentTick: number): SurveyResult {
    const potentialCorps: PotentialCorp[] = [];

    // Check for mining opportunities (sources)
    const sources = getResourcesByType(node, "source");
    for (const source of sources) {
      const miningCorp = this.evaluateMiningCorp(node, source);
      if (miningCorp && miningCorp.estimatedROI >= this.config.minROI) {
        potentialCorps.push(miningCorp);
      }
    }

    // Check for spawning opportunities (spawns)
    const spawns = getResourcesByType(node, "spawn");
    for (const spawn of spawns) {
      const spawningCorp = this.evaluateSpawningCorp(node, spawn);
      if (spawningCorp && spawningCorp.estimatedROI >= this.config.minROI) {
        potentialCorps.push(spawningCorp);
      }
    }

    // Check for upgrading opportunities (controllers)
    const controllers = getResourcesByType(node, "controller");
    for (const controller of controllers) {
      const upgradingCorp = this.evaluateUpgradingCorp(node, controller);
      if (upgradingCorp && upgradingCorp.estimatedROI >= this.config.minROI) {
        potentialCorps.push(upgradingCorp);
      }
    }

    // Hauling corps are evaluated based on source-destination pairs
    // They connect nodes, so we evaluate them at the colony level

    // Sort by estimated ROI (best first)
    potentialCorps.sort((a, b) => b.estimatedROI - a.estimatedROI);

    return {
      nodeId: node.id,
      resources: node.resources,
      potentialCorps,
      surveyedAt: currentTick
    };
  }

  /**
   * Evaluate potential for a mining corp at a source
   */
  private evaluateMiningCorp(
    node: Node,
    source: NodeResource
  ): PotentialCorp | null {
    // Check if we already have a mining corp for this source
    const existingMiners = getCorpsByType(node, "mining");
    const hasExistingMiner = existingMiners.some(
      // In real implementation, would check sourceId
      () => existingMiners.length > 0
    );

    if (hasExistingMiner && existingMiners.length >= sources(node).length) {
      return null;
    }

    // Calculate estimated ROI
    const sourceCapacity = source.capacity ?? 3000;
    const energyPerLifetime = (sourceCapacity / 300) * 1500; // ~15000 energy
    const revenue = energyPerLifetime * this.config.energyValue;
    const cost = 5 * 1500 * this.config.workTickCost; // 5 WORK parts × lifetime
    const roi = cost > 0 ? (revenue - cost) / cost : 0;

    return {
      type: "mining",
      resource: source,
      estimatedROI: roi,
      position: source.position,
      config: {
        sourceId: source.id,
        sourceCapacity
      }
    };
  }

  /**
   * Evaluate potential for a spawning corp at a spawn
   */
  private evaluateSpawningCorp(
    node: Node,
    spawn: NodeResource
  ): PotentialCorp | null {
    // Check if we already have a spawning corp
    const existingSpawners = getCorpsByType(node, "spawning");
    if (existingSpawners.length > 0) {
      return null; // One spawn corp per spawn
    }

    // Spawning corps have good ROI because they're essential infrastructure
    // They sell work-ticks and carry-ticks to other corps
    const estimatedCreepsPerLifetime = 10; // ~150 ticks per creep, 1500 lifetime
    const energyCostPerCreep = 300;
    const revenuePerCreep = 100; // Margin on spawn service
    const revenue = estimatedCreepsPerLifetime * revenuePerCreep;
    const cost = estimatedCreepsPerLifetime * energyCostPerCreep * this.config.energyValue;
    const roi = cost > 0 ? (revenue - cost) / cost : 0;

    return {
      type: "spawning",
      resource: spawn,
      estimatedROI: roi,
      position: spawn.position,
      config: {
        spawnId: spawn.id
      }
    };
  }

  /**
   * Evaluate potential for an upgrading corp at a controller
   */
  private evaluateUpgradingCorp(
    node: Node,
    controller: NodeResource
  ): PotentialCorp | null {
    // Check if we already have an upgrading corp
    const existingUpgraders = getCorpsByType(node, "upgrading");
    if (existingUpgraders.length > 0) {
      return null; // One upgrade corp per controller
    }

    // Upgrading corps generate credits (the ultimate value)
    const workParts = 15;
    const upgradePointsPerLifetime = workParts * 1500; // 22500 points
    const energyCost = upgradePointsPerLifetime * this.config.energyValue;
    const workTicksCost = workParts * 1500 * this.config.workTickCost;
    const totalCost = energyCost + workTicksCost;
    const revenue = upgradePointsPerLifetime * this.config.upgradeValue;
    const roi = totalCost > 0 ? (revenue - totalCost) / totalCost : 0;

    return {
      type: "upgrading",
      resource: controller,
      estimatedROI: roi,
      position: controller.position,
      config: {
        controllerId: controller.id,
        controllerLevel: controller.level ?? 1
      }
    };
  }

  /**
   * Evaluate potential hauling routes between nodes
   */
  evaluateHaulingRoutes(
    sourceNode: Node,
    destNode: Node,
    currentTick: number
  ): PotentialCorp[] {
    const routes: PotentialCorp[] = [];

    // Find energy sources in source node
    const sources = getResourcesByType(sourceNode, "source");

    // Find energy sinks in destination node (controller, spawn)
    const sinks = [
      ...getResourcesByType(destNode, "controller"),
      ...getResourcesByType(destNode, "spawn")
    ];

    for (const source of sources) {
      for (const sink of sinks) {
        const route = this.evaluateHaulingRoute(source, sink, sourceNode, destNode);
        if (route && route.estimatedROI >= this.config.minROI) {
          routes.push(route);
        }
      }
    }

    return routes;
  }

  /**
   * Evaluate a single hauling route
   */
  private evaluateHaulingRoute(
    source: NodeResource,
    sink: NodeResource,
    sourceNode: Node,
    destNode: Node
  ): PotentialCorp | null {
    // Calculate distance
    const distance = this.manhattanDistance(source.position, sink.position);
    if (distance === Infinity) return null;

    // Calculate throughput
    const carryParts = 10;
    const capacity = carryParts * 50; // 500 per trip
    const roundTripTime = Math.ceil(distance * 2 * 1.5); // 1.5 ticks per tile average
    if (roundTripTime === 0) return null;

    const tripsPerLifetime = Math.floor(1500 / roundTripTime);
    const throughput = capacity * tripsPerLifetime;

    // Calculate ROI
    const energyCost = throughput * this.config.energyValue;
    const carryTicksCost = carryParts * 1500 * this.config.carryTickCost;
    const totalCost = energyCost + carryTicksCost;

    // Energy at destination is worth more (closer to usage)
    const destinationPremium = 1.2; // 20% premium
    const revenue = throughput * this.config.energyValue * destinationPremium;
    const roi = totalCost > 0 ? (revenue - totalCost) / totalCost : 0;

    return {
      type: "hauling",
      resource: source,
      estimatedROI: roi,
      position: source.position,
      config: {
        fromPosition: source.position,
        toPosition: sink.position,
        distance,
        throughput
      }
    };
  }

  /**
   * Update survey configuration
   */
  setConfig(config: Partial<SurveyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): SurveyConfig {
    return { ...this.config };
  }

  /**
   * Calculate Manhattan distance between positions
   */
  private manhattanDistance(a: Position, b: Position): number {
    if (a.roomName !== b.roomName) {
      // Cross-room distance would need room coordinate parsing
      return Infinity;
    }
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
}

/**
 * Helper to get sources from a node
 */
function sources(node: Node): NodeResource[] {
  return getResourcesByType(node, "source");
}

/**
 * Create a resource from game data (pure function for creating test data)
 */
export function createResource(
  type: NodeResourceType,
  id: string,
  position: Position,
  capacity?: number,
  level?: number
): NodeResource {
  return {
    type,
    id,
    position,
    capacity,
    level
  };
}

/**
 * Estimate ROI for a mining operation (pure function)
 */
export function estimateMiningROI(
  sourceCapacity: number,
  energyValue: number,
  workTickCost: number,
  workParts: number = 5,
  creepLifetime: number = 1500
): number {
  const energyPerLifetime = (sourceCapacity / 300) * creepLifetime;
  const revenue = energyPerLifetime * energyValue;
  const cost = workParts * creepLifetime * workTickCost;
  return cost > 0 ? (revenue - cost) / cost : 0;
}

/**
 * Estimate ROI for a hauling operation (pure function)
 */
export function estimateHaulingROI(
  distance: number,
  energyValue: number,
  carryTickCost: number,
  destinationPremium: number = 1.2,
  carryParts: number = 10,
  creepLifetime: number = 1500
): number {
  const capacity = carryParts * 50;
  const roundTripTime = Math.ceil(distance * 2 * 1.5);
  if (roundTripTime === 0) return 0;

  const trips = Math.floor(creepLifetime / roundTripTime);
  const throughput = capacity * trips;

  const energyCost = throughput * energyValue;
  const carryTicksCost = carryParts * creepLifetime * carryTickCost;
  const totalCost = energyCost + carryTicksCost;
  const revenue = throughput * energyValue * destinationPremium;

  return totalCost > 0 ? (revenue - totalCost) / totalCost : 0;
}
