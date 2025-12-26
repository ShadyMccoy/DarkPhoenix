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

import { Position } from "../types/Position";
import { Node, NodeResource, createNode, createNodeId } from "../nodes/Node";
import {
  calculateTravelTime,
  SOURCE_ENERGY_CAPACITY
} from "./EconomicConstants";
import {
  AnyCorpState,
  createSourceState,
  createMiningState,
  createSpawningState,
  createUpgradingState,
  createHaulingState
} from "../corps/CorpState";

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
  /** Hydrated nodes */
  nodes: Node[];
  /** Spawn positions for reference */
  spawns: Position[];
  /** Corp states for pure projection functions */
  corpStates: AnyCorpState[];
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

  // Second pass: create nodes
  const nodes: Node[] = [];

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

    nodes.push(node);
  }

  // Third pass: create corp states with proper dependency chain
  // Order: SpawningCorps -> SourceCorps -> MiningOperations -> UpgradingCorps
  const allCorpStates = createCorpStatesWithDependencies(
    fixture.nodes,
    nodes,
    spawns,
    idGen
  );

  return { nodes, spawns, corpStates: allCorpStates };
}

/**
 * Create corp states with proper dependency chain.
 *
 * Order (enforces clean operation structure):
 * 1. SpawningCorps (from spawns)
 * 2. SourceCorps (passive, from sources)
 * 3. MiningOperations (depend on SourceCorp + SpawningCorp)
 * 4. HaulingOperations (depend on MiningOperation + SpawningCorp)
 * 5. UpgradingCorps (depend on SpawningCorp, consumes delivered-energy)
 *
 * This ensures dependencies are created before the operations that need them.
 */
function createCorpStatesWithDependencies(
  fixtureNodes: FixtureNode[],
  nodes: Node[],
  spawns: Position[],
  idGen: (type: string, nodeId: string, index: number) => string
): AnyCorpState[] {
  const corpStates: AnyCorpState[] = [];
  let corpIndex = 0;

  // Track IDs for dependency resolution
  let spawningCorpId: string | null = null;
  const sourceCorpIds: Map<string, string> = new Map(); // sourceResourceId -> sourceCorpId
  // Track mining corps for hauling dependency
  const harvestCorps: Array<{ id: string; position: Position; nodeId: string }> = [];

  // Pass 1: Create SpawningCorps first
  for (let i = 0; i < fixtureNodes.length; i++) {
    const fixtureNode = fixtureNodes[i];
    const node = nodes[i];

    for (const resource of fixtureNode.resourceNodes) {
      if (resource.type === "spawn") {
        const spawnPosition: Position = {
          x: resource.position.x,
          y: resource.position.y,
          roomName: fixtureNode.roomName
        };

        spawningCorpId = idGen("spawning", node.id, corpIndex++);
        const spawningState = createSpawningState(
          spawningCorpId,
          node.id,
          spawnPosition,
          resource.capacity ?? 300
        );
        corpStates.push(spawningState);
      }
    }
  }

  // Use a placeholder if no spawn found
  if (!spawningCorpId) {
    spawningCorpId = "unknown-spawn";
  }

  // Pass 2: Create SourceCorps for each source
  for (let i = 0; i < fixtureNodes.length; i++) {
    const fixtureNode = fixtureNodes[i];
    const node = nodes[i];

    for (const resource of fixtureNode.resourceNodes) {
      if (resource.type === "source") {
        const sourcePosition: Position = {
          x: resource.position.x,
          y: resource.position.y,
          roomName: fixtureNode.roomName
        };

        const sourceResourceId = `source-${node.id}-${resource.position.x}-${resource.position.y}`;
        const sourceCorpId = idGen("source", node.id, corpIndex++);
        sourceCorpIds.set(sourceResourceId, sourceCorpId);

        const sourceState = createSourceState(
          sourceCorpId,
          node.id,
          sourcePosition,
          sourceResourceId, // sourceId (game object ID placeholder)
          resource.capacity ?? SOURCE_ENERGY_CAPACITY,
          1 // miningSpots (default to 1)
        );
        corpStates.push(sourceState);
      }
    }
  }

  // Pass 3: Create MiningOperations that reference SourceCorps
  for (let i = 0; i < fixtureNodes.length; i++) {
    const fixtureNode = fixtureNodes[i];
    const node = nodes[i];

    for (const resource of fixtureNode.resourceNodes) {
      if (resource.type === "source") {
        const sourcePosition: Position = {
          x: resource.position.x,
          y: resource.position.y,
          roomName: fixtureNode.roomName
        };

        const sourceResourceId = `source-${node.id}-${resource.position.x}-${resource.position.y}`;
        const sourceCorpId = sourceCorpIds.get(sourceResourceId) ?? "unknown-source";
        const nearestSpawn = findNearestSpawn(sourcePosition, spawns);

        const miningCorpId = idGen("mining", node.id, corpIndex++);
        const miningState = createMiningState(
          miningCorpId,
          node.id,
          sourceCorpId,
          spawningCorpId,
          sourcePosition,
          resource.capacity ?? SOURCE_ENERGY_CAPACITY,
          nearestSpawn
        );
        corpStates.push(miningState);

        // Track for hauling dependency
        harvestCorps.push({ id: miningCorpId, position: sourcePosition, nodeId: node.id });
      }
    }
  }

  // Find controller position for hauling destination (default to spawn if no controller)
  let controllerPosition: Position | null = null;
  for (const fixtureNode of fixtureNodes) {
    for (const resource of fixtureNode.resourceNodes) {
      if (resource.type === "controller") {
        controllerPosition = {
          x: resource.position.x,
          y: resource.position.y,
          roomName: fixtureNode.roomName
        };
        break;
      }
    }
    if (controllerPosition) break;
  }

  // Pass 4: Create HaulingOperations that reference MiningOperations
  // Each mining operation needs a corresponding hauling operation to move energy
  const DEFAULT_CARRY_CAPACITY = 500; // 10 CARRY parts × 50
  for (const miningCorp of harvestCorps) {
    const nearestSpawn = findNearestSpawn(miningCorp.position, spawns);
    // Destination: controller if available, otherwise spawn
    const destination = controllerPosition ?? nearestSpawn ?? miningCorp.position;

    const haulingCorpId = idGen("hauling", miningCorp.nodeId, corpIndex++);
    const haulingState = createHaulingState(
      haulingCorpId,
      miningCorp.nodeId,
      miningCorp.id, // miningCorpId dependency
      spawningCorpId!,
      miningCorp.position, // sourcePosition (pick up from mining location)
      destination, // destinationPosition (deliver to controller/spawn)
      DEFAULT_CARRY_CAPACITY,
      nearestSpawn
    );
    corpStates.push(haulingState);
  }

  // Pass 5: Create UpgradingCorps (depend on SpawningCorp for work-ticks)
  for (let i = 0; i < fixtureNodes.length; i++) {
    const fixtureNode = fixtureNodes[i];
    const node = nodes[i];

    for (const resource of fixtureNode.resourceNodes) {
      if (resource.type === "controller") {
        const controllerPosition: Position = {
          x: resource.position.x,
          y: resource.position.y,
          roomName: fixtureNode.roomName
        };

        const nearestSpawn = findNearestSpawn(controllerPosition, spawns);
        const upgradingCorpId = idGen("upgrading", node.id, corpIndex++);

        const upgradingState = createUpgradingState(
          upgradingCorpId,
          node.id,
          spawningCorpId!, // spawningCorpId dependency
          controllerPosition,
          resource.capacity ?? 1,
          nearestSpawn
        );
        corpStates.push(upgradingState);
      }
    }
  }

  return corpStates;
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
