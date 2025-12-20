/**
 * @fileoverview Hydrates test fixtures into fully configured Nodes with Corps.
 *
 * This module converts simple JSON fixture data into the full Node/Corp
 * structure needed for ChainPlanner testing. It handles:
 * - Creating appropriate Corp types based on node resources
 * - Linking Corps to their nearest spawn locations
 * - Setting up economic parameters (travel times, costs)
 *
 * The goal is to test ChainPlanner with fixture data without needing
 * a live Screeps game environment.
 */

import { Position } from "../market/Offer";
import { Node, NodeResource, createNode, createNodeId } from "../nodes/Node";
import { Corp } from "../corps/Corp";
import { MiningCorp } from "../corps/MiningCorp";
import { SpawningCorp } from "../corps/SpawningCorp";
import { UpgradingCorp } from "../corps/UpgradingCorp";
import {
  calculateTravelTime,
  calculateEffectiveWorkTime,
  calculateCreepCostPerEnergy,
  designMiningCreep,
  calculateOptimalWorkParts,
  calculateBodyCost,
  SOURCE_ENERGY_CAPACITY
} from "./EconomicConstants";

/**
 * Resource definition in a fixture
 */
export interface FixtureResource {
  /** Type of resource (source, controller, spawn, etc.) */
  type: "source" | "controller" | "mineral" | "spawn" | "storage" | "container";
  /** Position of the resource */
  position: { x: number; y: number };
  /** Resource capacity (energy for sources, level for controller) */
  capacity?: number;
  /** Mineral type if applicable */
  mineralType?: string;
}

/**
 * Node definition in a fixture
 */
export interface FixtureNode {
  /** Room name (e.g., "W1N1") */
  roomName: string;
  /** Peak position of this node/territory */
  position: { x: number; y: number };
  /** Resources in this node's territory */
  resourceNodes: FixtureResource[];
  /** Optional territory size */
  territorySize?: number;
}

/**
 * Complete fixture definition
 */
export interface Fixture {
  /** Description of what this fixture tests */
  description: string;
  /** Nodes in this fixture */
  nodes: FixtureNode[];
}

/**
 * Configuration for hydration
 */
export interface HydrationConfig {
  /** ID generator for corps (for deterministic testing) */
  idGenerator?: (type: string, nodeId: string, index: number) => string;
  /** Current game tick (for corp creation) */
  currentTick?: number;
}

/**
 * Result of hydrating a fixture
 */
export interface HydrationResult {
  /** Hydrated nodes with corps */
  nodes: Node[];
  /** All corps created (flat list) */
  corps: Corp[];
  /** Spawn positions for reference */
  spawns: Position[];
}

/**
 * Default ID generator for deterministic testing
 */
let globalIdCounter = 0;
export function resetIdCounter(): void {
  globalIdCounter = 0;
}

function defaultIdGenerator(type: string, nodeId: string, _index: number): string {
  return `${type}-${nodeId}-${globalIdCounter++}`;
}

/**
 * Hydrate fixture data into fully configured Nodes with Corps.
 *
 * This is the main entry point for converting test fixtures into
 * the data structures needed by ChainPlanner.
 *
 * @param fixture - The fixture to hydrate
 * @param config - Optional configuration
 * @returns Hydrated nodes, corps, and spawn positions
 */
export function hydrateFixture(
  fixture: Fixture,
  config: HydrationConfig = {}
): HydrationResult {
  const idGen = config.idGenerator ?? defaultIdGenerator;
  const currentTick = config.currentTick ?? 0;

  // First pass: identify all spawn positions
  const spawns: Position[] = [];
  for (const fixtureNode of fixture.nodes) {
    for (const resource of fixtureNode.resourceNodes) {
      if (resource.type === "spawn") {
        spawns.push({
          x: resource.position.x,
          y: resource.position.y,
          roomName: fixtureNode.roomName
        });
      }
    }
  }

  // Second pass: create nodes and corps
  const nodes: Node[] = [];
  const allCorps: Corp[] = [];
  let corpIndex = 0;

  for (const fixtureNode of fixture.nodes) {
    const peakPosition: Position = {
      x: fixtureNode.position.x,
      y: fixtureNode.position.y,
      roomName: fixtureNode.roomName
    };

    const nodeId = createNodeId(fixtureNode.roomName, peakPosition);
    const node = createNode(
      nodeId,
      fixtureNode.roomName,
      peakPosition,
      fixtureNode.territorySize ?? 100,
      [fixtureNode.roomName],
      currentTick
    );

    // Convert resources
    for (const resource of fixtureNode.resourceNodes) {
      const nodeResource: NodeResource = {
        type: resource.type,
        id: `${resource.type}-${node.id}-${resource.position.x}-${resource.position.y}`,
        position: {
          x: resource.position.x,
          y: resource.position.y,
          roomName: fixtureNode.roomName
        },
        capacity: resource.capacity,
        mineralType: resource.mineralType
      };
      node.resources.push(nodeResource);
    }

    // Create corp for this node based on resources
    const corp = createCorpForNode(
      fixtureNode,
      node,
      spawns,
      idGen,
      corpIndex
    );

    if (corp) {
      node.corps.push(corp);
      allCorps.push(corp);
      corpIndex++;
    }

    nodes.push(node);
  }

  return { nodes, corps: allCorps, spawns };
}

/**
 * Create the appropriate Corp type for a node based on its resources.
 * Priority: spawn > source > controller
 */
function createCorpForNode(
  fixtureNode: FixtureNode,
  node: Node,
  spawns: Position[],
  idGen: (type: string, nodeId: string, index: number) => string,
  index: number
): Corp | null {
  const hasSpawn = fixtureNode.resourceNodes.some((r) => r.type === "spawn");
  const hasSources = fixtureNode.resourceNodes.some((r) => r.type === "source");
  const hasController = fixtureNode.resourceNodes.some(
    (r) => r.type === "controller"
  );

  const nodePosition: Position = {
    x: fixtureNode.position.x,
    y: fixtureNode.position.y,
    roomName: fixtureNode.roomName
  };

  if (hasSpawn) {
    // SpawningCorp for nodes with spawns
    const spawnResource = fixtureNode.resourceNodes.find(
      (r) => r.type === "spawn"
    )!;
    const spawnPosition: Position = {
      x: spawnResource.position.x,
      y: spawnResource.position.y,
      roomName: fixtureNode.roomName
    };

    const corpId = idGen("spawning", node.id, index);
    return createSpawningCorp(corpId, node.id, spawnPosition);
  }

  if (hasSources) {
    // MiningCorp for nodes with sources
    const totalCapacity = fixtureNode.resourceNodes
      .filter((r) => r.type === "source")
      .reduce((sum, r) => sum + (r.capacity ?? SOURCE_ENERGY_CAPACITY), 0);

    // Find nearest spawn
    const nearestSpawn = findNearestSpawn(nodePosition, spawns);

    const corpId = idGen("mining", node.id, index);
    return createMiningCorp(
      corpId,
      node.id,
      nodePosition,
      totalCapacity,
      nearestSpawn
    );
  }

  if (hasController) {
    // UpgradingCorp for nodes with controllers
    const controllerResource = fixtureNode.resourceNodes.find(
      (r) => r.type === "controller"
    )!;
    const controllerPosition: Position = {
      x: controllerResource.position.x,
      y: controllerResource.position.y,
      roomName: fixtureNode.roomName
    };

    // Find nearest spawn
    const nearestSpawn = findNearestSpawn(controllerPosition, spawns);

    const corpId = idGen("upgrading", node.id, index);
    return createUpgradingCorp(
      corpId,
      node.id,
      controllerPosition,
      controllerResource.capacity ?? 1,
      nearestSpawn
    );
  }

  return null;
}

/**
 * Find the nearest spawn position to a given location
 */
function findNearestSpawn(
  position: Position,
  spawns: Position[]
): Position | null {
  if (spawns.length === 0) return null;

  let nearest = spawns[0];
  let minDistance = calculateTravelTime(position, spawns[0]);

  for (let i = 1; i < spawns.length; i++) {
    const distance = calculateTravelTime(position, spawns[i]);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = spawns[i];
    }
  }

  return nearest;
}

/**
 * Create a MiningCorp with economic calculations
 */
function createMiningCorp(
  corpId: string,
  nodeId: string,
  position: Position,
  sourceCapacity: number,
  spawnLocation: Position | null
): MiningCorp {
  const corp = new MiningCorp(nodeId, position, sourceCapacity, corpId);

  // Set spawn location for economic calculations
  if (spawnLocation) {
    // Store spawn location for reference
    (corp as any).spawnLocation = spawnLocation;

    // Calculate and set input cost based on creep economics
    const workPartsNeeded = calculateOptimalWorkParts(sourceCapacity, 300);
    const creepBody = designMiningCreep(workPartsNeeded);
    const spawnCost = calculateBodyCost(creepBody);

    // Calculate effective work time
    const effectiveLifetime = calculateEffectiveWorkTime(spawnLocation, position);

    // Set input cost for pricing (amortized spawn cost per tick)
    if (effectiveLifetime > 0 && typeof corp.setInputCost === "function") {
      corp.setInputCost(spawnCost / effectiveLifetime);
    }
  }

  return corp;
}

/**
 * Create a SpawningCorp
 */
function createSpawningCorp(
  corpId: string,
  nodeId: string,
  position: Position
): SpawningCorp {
  return new SpawningCorp(nodeId, position, corpId);
}

/**
 * Create an UpgradingCorp with economic calculations
 */
function createUpgradingCorp(
  corpId: string,
  nodeId: string,
  position: Position,
  controllerLevel: number,
  spawnLocation: Position | null
): UpgradingCorp {
  const corp = new UpgradingCorp(nodeId, position, controllerLevel, corpId);

  // Store spawn location for reference
  if (spawnLocation) {
    (corp as any).spawnLocation = spawnLocation;
  }

  return corp;
}

/**
 * Convenience function to hydrate nodes from a simple node array
 * (for backwards compatibility and simpler test cases)
 */
export function hydrateNodes(
  nodes: FixtureNode[],
  config: HydrationConfig = {}
): Node[] {
  const fixture: Fixture = {
    description: "Inline fixture",
    nodes
  };
  return hydrateFixture(fixture, config).nodes;
}

/**
 * Create a simple mining fixture for testing
 */
export function createSimpleMiningFixture(
  roomName: string = "W1N1",
  spawnPos: { x: number; y: number } = { x: 25, y: 25 },
  sourcePos: { x: number; y: number } = { x: 10, y: 10 },
  sourceCapacity: number = SOURCE_ENERGY_CAPACITY
): Fixture {
  return {
    description: "Simple mining with spawn",
    nodes: [
      {
        roomName,
        position: spawnPos,
        resourceNodes: [
          {
            type: "spawn",
            position: spawnPos,
            capacity: 300
          }
        ]
      },
      {
        roomName,
        position: sourcePos,
        resourceNodes: [
          {
            type: "source",
            position: sourcePos,
            capacity: sourceCapacity
          }
        ]
      }
    ]
  };
}

/**
 * Create a remote mining fixture (spawn and source in different rooms)
 */
export function createRemoteMiningFixture(
  homeRoom: string = "W1N1",
  remoteRoom: string = "W2N1",
  spawnPos: { x: number; y: number } = { x: 25, y: 25 },
  sourcePos: { x: number; y: number } = { x: 40, y: 40 }
): Fixture {
  return {
    description: "Remote mining with long travel time",
    nodes: [
      {
        roomName: homeRoom,
        position: spawnPos,
        resourceNodes: [
          {
            type: "spawn",
            position: spawnPos,
            capacity: 300
          }
        ]
      },
      {
        roomName: remoteRoom,
        position: sourcePos,
        resourceNodes: [
          {
            type: "source",
            position: sourcePos,
            capacity: SOURCE_ENERGY_CAPACITY
          }
        ]
      }
    ]
  };
}

/**
 * Create a complete room fixture with spawn, sources, and controller
 */
export function createCompleteRoomFixture(
  roomName: string = "W1N1"
): Fixture {
  return {
    description: "Complete room with spawn, sources, and controller",
    nodes: [
      {
        roomName,
        position: { x: 25, y: 25 },
        resourceNodes: [
          {
            type: "spawn",
            position: { x: 25, y: 25 },
            capacity: 300
          }
        ]
      },
      {
        roomName,
        position: { x: 10, y: 10 },
        resourceNodes: [
          {
            type: "source",
            position: { x: 10, y: 10 },
            capacity: SOURCE_ENERGY_CAPACITY
          }
        ]
      },
      {
        roomName,
        position: { x: 40, y: 10 },
        resourceNodes: [
          {
            type: "source",
            position: { x: 40, y: 10 },
            capacity: SOURCE_ENERGY_CAPACITY
          }
        ]
      },
      {
        roomName,
        position: { x: 25, y: 40 },
        resourceNodes: [
          {
            type: "controller",
            position: { x: 25, y: 40 },
            capacity: 1 // RCL 1
          }
        ]
      }
    ]
  };
}
