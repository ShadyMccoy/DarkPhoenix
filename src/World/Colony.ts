/**
 * Colony System - Multi-graph world state management
 *
 * A colony represents a connected component of the world graph:
 * - A single node graph (all nodes reachable from each other)
 * - Complete isolation from other colonies (no edges between)
 * - Independent resource pool and operations
 * - Can expand, contract, or merge with other colonies
 *
 * Multiple colonies can exist simultaneously:
 * - Initial spawn: 1 colony
 * - Scout expansion: new colony formed in new region
 * - Reconnection: 2 colonies merge into 1
 * - Siege/split: 1 colony splits into 2
 */

import { WorldGraph, WorldNode, WorldEdge } from "./interfaces";

export type ColonyStatus =
  | "nascent"     // Just created, very small
  | "established" // Main base established
  | "thriving"    // Growing and stable
  | "declining"   // Losing resources/creeps
  | "dormant";    // Inactive (siege, waiting)

/**
 * Represents a single connected colony (node network).
 * All nodes in a colony are reachable from each other.
 */
export interface Colony {
  /** Unique identifier: auto-generated or user-defined */
  id: string;

  /** Name for user reference */
  name: string;

  /** The connected node graph for this colony */
  graph: WorldGraph;

  /** Current colony status */
  status: ColonyStatus;

  /** When this colony was created */
  createdAt: number;

  /** Last significant update */
  lastUpdated: number;

  /** Primary room (where main spawn is located) */
  primaryRoom: string;

  /** All rooms controlled by this colony */
  controlledRooms: Set<string>;

  /** Resources available to colony (aggregated) */
  resources: ColonyResources;

  /** Operations running in this colony */
  operations: Map<string, OperationInfo>;

  /** Metadata for extensions and tracking */
  metadata: Record<string, any>;
}

/**
 * Resource tracking for a colony.
 */
export interface ColonyResources {
  energy: number;
  power: number;
  minerals: Map<string, number>; // mineral type -> amount
  lastUpdated: number;
}

/**
 * Info about an operation running in a colony.
 */
export interface OperationInfo {
  id: string;
  type: string; // 'mining', 'building', 'defense', 'expansion', etc.
  assignedNodes: string[]; // Node IDs where operation is active
  status: "active" | "paused" | "failed";
  priority: number;
  createdAt: number;
}

/**
 * World state: collection of all colonies.
 */
export interface World {
  /** All colonies indexed by ID */
  colonies: Map<string, Colony>;

  /** Which colony owns which node (fast lookup) */
  nodeToColony: Map<string, string>;

  /** Timestamp of last world update */
  timestamp: number;

  /** Version number (increment on structural changes) */
  version: number;

  /** Metadata about the world state */
  metadata: {
    totalNodes: number;
    totalEdges: number;
    totalEnergy: number;
    missionStatus?: string; // e.g., "attacking W5S5", "scouting"
  };
}

/**
 * Colony Manager - Creates and manages colonies from world graphs.
 *
 * Key operations:
 * 1. Split connected graph into separate colonies
 * 2. Track colony status and resources
 * 3. Detect and handle colony merging
 * 4. Persist colony state to memory
 */
export class ColonyManager {
  /**
   * Build colonies from a world graph.
   *
   * Detects connected components and creates a separate colony for each.
   * If the graph is fully connected, returns a single colony.
   * If graph is fragmented, returns multiple colonies.
   *
   * @param graph - WorldGraph (possibly containing multiple components)
   * @param roomName - Primary room name for this graph
   * @returns World state with colonies
   */
  static buildColonies(
    graph: WorldGraph,
    roomName: string
  ): World {
    // Find all connected components
    const components = this.findConnectedComponents(graph);

    // Create a colony for each component
    const colonies = new Map<string, Colony>();
    const nodeToColony = new Map<string, string>();
    let totalEnergy = 0;

    for (let i = 0; i < components.length; i++) {
      const nodeIds = components[i];
      const colonyId = `colony-${roomName}-${i}-${Game.time}`;

      // Build subgraph for this colony
      const subgraph = this.buildSubgraph(graph, nodeIds);

      // Get primary room (room with most nodes)
      const rooms = this.getRoomDistribution(subgraph);
      const primaryRoom = rooms.reduce((a, b) =>
        a.count > b.count ? a : b
      ).room;

      // Create colony
      const colony: Colony = {
        id: colonyId,
        name: `Colony-${i}`,
        graph: subgraph,
        status: "nascent",
        createdAt: Game.time,
        lastUpdated: Game.time,
        primaryRoom,
        controlledRooms: new Set(rooms.map(r => r.room)),
        resources: {
          energy: 0,
          power: 0,
          minerals: new Map(),
          lastUpdated: Game.time,
        },
        operations: new Map(),
        metadata: {},
      };

      colonies.set(colonyId, colony);

      // Map nodes to colony
      for (const nodeId of nodeIds) {
        nodeToColony.set(nodeId, colonyId);
      }
    }

    // Build world state
    const world: World = {
      colonies,
      nodeToColony,
      timestamp: Game.time,
      version: 1,
      metadata: {
        totalNodes: graph.nodes.size,
        totalEdges: graph.edges.size,
        totalEnergy,
      },
    };

    return world;
  }

  /**
   * Create a single colony from a connected graph.
   */
  static createColony(
    graph: WorldGraph,
    id: string,
    name: string,
    primaryRoom: string
  ): Colony {
    return {
      id,
      name,
      graph,
      status: "nascent",
      createdAt: Game.time,
      lastUpdated: Game.time,
      primaryRoom,
      controlledRooms: new Set(
        Array.from(graph.nodes.values()).map(n => n.room)
      ),
      resources: {
        energy: 0,
        power: 0,
        minerals: new Map(),
        lastUpdated: Game.time,
      },
      operations: new Map(),
      metadata: {},
    };
  }

  /**
   * Update colony resources from actual game state.
   */
  static updateColonyResources(
    colony: Colony,
    roomResources: Map<string, ColonyResources>
  ): void {
    colony.resources = {
      energy: 0,
      power: 0,
      minerals: new Map(),
      lastUpdated: Game.time,
    };

    for (const room of colony.controlledRooms) {
      const roomRes = roomResources.get(room);
      if (roomRes) {
        colony.resources.energy += roomRes.energy;
        colony.resources.power += roomRes.power;

        for (const [mineral, amount] of roomRes.minerals) {
          const current = colony.resources.minerals.get(mineral) || 0;
          colony.resources.minerals.set(mineral, current + amount);
        }
      }
    }
  }

  /**
   * Update colony status based on metrics.
   */
  static updateColonyStatus(colony: Colony): void {
    const energy = colony.resources.energy;
    const nodeCount = colony.graph.nodes.size;

    if (energy < 5000) {
      colony.status = "declining";
    } else if (energy < 20000) {
      colony.status = "nascent";
    } else if (energy < 100000) {
      colony.status = "established";
    } else {
      colony.status = "thriving";
    }
  }

  /**
   * Merge two colonies into one.
   * Call when their graphs become connected.
   */
  static mergeColonies(colonyA: Colony, colonyB: Colony): Colony {
    // Merge graphs
    const mergedGraph: WorldGraph = {
      nodes: new Map([...colonyA.graph.nodes, ...colonyB.graph.nodes]),
      edges: new Map([...colonyA.graph.edges, ...colonyB.graph.edges]),
      edgesByNode: this.rebuildEdgeIndex(
        new Map([...colonyA.graph.nodes, ...colonyB.graph.nodes]),
        new Map([...colonyA.graph.edges, ...colonyB.graph.edges])
      ),
      timestamp: Game.time,
      version: Math.max(colonyA.graph.version, colonyB.graph.version) + 1,
    };

    // Merge resources
    const mergedResources: ColonyResources = {
      energy: colonyA.resources.energy + colonyB.resources.energy,
      power: colonyA.resources.power + colonyB.resources.power,
      minerals: this.mergeMinerals(
        colonyA.resources.minerals,
        colonyB.resources.minerals
      ),
      lastUpdated: Game.time,
    };

    // Create merged colony
    const merged: Colony = {
      id: `${colonyA.id}-${colonyB.id}-merged`,
      name: `${colonyA.name}+${colonyB.name}`,
      graph: mergedGraph,
      status: colonyA.status, // Use stronger status
      createdAt: Math.min(colonyA.createdAt, colonyB.createdAt),
      lastUpdated: Game.time,
      primaryRoom: colonyA.primaryRoom, // Keep original primary
      controlledRooms: new Set([
        ...colonyA.controlledRooms,
        ...colonyB.controlledRooms,
      ]),
      resources: mergedResources,
      operations: new Map([...colonyA.operations, ...colonyB.operations]),
      metadata: { ...colonyA.metadata, ...colonyB.metadata },
    };

    return merged;
  }

  /**
   * Split a colony into multiple colonies if its graph becomes disconnected.
   * Returns original colony if still connected, or new array of colonies if split.
   */
  static splitColonyIfNeeded(colony: Colony): Colony[] {
    const components = this.findConnectedComponents(colony.graph);

    if (components.length === 1) {
      // Still connected
      return [colony];
    }

    // Create separate colony for each component
    const colonies: Colony[] = [];
    for (let i = 0; i < components.length; i++) {
      const nodeIds = components[i];
      const subgraph = this.buildSubgraph(colony.graph, nodeIds);
      const rooms = this.getRoomDistribution(subgraph);
      const primaryRoom = rooms.reduce((a, b) =>
        a.count > b.count ? a : b
      ).room;

      const subcolony: Colony = {
        id: `${colony.id}-split-${i}`,
        name: `${colony.name}-${i}`,
        graph: subgraph,
        status: colony.status,
        createdAt: colony.createdAt,
        lastUpdated: Game.time,
        primaryRoom,
        controlledRooms: new Set(rooms.map(r => r.room)),
        resources: colony.resources, // TODO: divide resources proportionally
        operations: new Map(),
        metadata: colony.metadata,
      };

      colonies.push(subcolony);
    }

    return colonies;
  }

  // ==================== Private Helpers ====================

  /**
   * Find all connected components in a graph.
   * Returns array of node ID arrays, one per component.
   */
  private static findConnectedComponents(graph: WorldGraph): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const nodeId of graph.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      // BFS to find component
      const component: string[] = [];
      const queue = [nodeId];
      visited.add(nodeId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);

        const node = graph.nodes.get(current);
        if (!node) continue;

        for (const neighborId of node.adjacentNodeIds) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            queue.push(neighborId);
          }
        }
      }

      components.push(component);
    }

    return components;
  }

  /**
   * Build a subgraph containing only specified nodes and their edges.
   */
  private static buildSubgraph(
    graph: WorldGraph,
    nodeIds: string[]
  ): WorldGraph {
    const nodeIdSet = new Set(nodeIds);
    const nodes = new Map<string, WorldNode>();
    const edges = new Map<string, WorldEdge>();

    // Copy relevant nodes
    for (const nodeId of nodeIds) {
      const node = graph.nodes.get(nodeId);
      if (node) {
        nodes.set(nodeId, node);
      }
    }

    // Copy edges between these nodes
    for (const edge of graph.edges.values()) {
      if (nodeIdSet.has(edge.fromId) && nodeIdSet.has(edge.toId)) {
        edges.set(edge.id, edge);
      }
    }

    // Rebuild edge index
    const edgesByNode = this.rebuildEdgeIndex(nodes, edges);

    return {
      nodes,
      edges,
      edgesByNode,
      timestamp: graph.timestamp,
      version: graph.version,
    };
  }

  /**
   * Rebuild edge-by-node index.
   */
  private static rebuildEdgeIndex(
    nodes: Map<string, WorldNode>,
    edges: Map<string, WorldEdge>
  ): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const edge of edges.values()) {
      if (!index.has(edge.fromId)) {
        index.set(edge.fromId, []);
      }
      index.get(edge.fromId)!.push(edge.id);

      if (!index.has(edge.toId)) {
        index.set(edge.toId, []);
      }
      index.get(edge.toId)!.push(edge.id);
    }

    return index;
  }

  /**
   * Get distribution of nodes across rooms.
   */
  private static getRoomDistribution(
    graph: WorldGraph
  ): Array<{ room: string; count: number }> {
    const dist = new Map<string, number>();

    for (const node of graph.nodes.values()) {
      dist.set(node.room, (dist.get(node.room) || 0) + 1);
    }

    return Array.from(dist.entries())
      .map(([room, count]) => ({ room, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Merge two mineral maps.
   */
  private static mergeMinerals(
    mineralsA: Map<string, number>,
    mineralsB: Map<string, number>
  ): Map<string, number> {
    const merged = new Map(mineralsA);

    for (const [mineral, amount] of mineralsB) {
      merged.set(mineral, (merged.get(mineral) || 0) + amount);
    }

    return merged;
  }
}
