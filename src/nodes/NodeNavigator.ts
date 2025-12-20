/**
 * @fileoverview Node network navigation utilities.
 *
 * Provides pathfinding and distance calculations across the colony node network.
 * Each edge in the network represents walking distance between adjacent nodes,
 * enabling quick approximation of travel costs across multiple rooms.
 *
 * Uses Dijkstra's algorithm for optimal path finding through the node graph.
 *
 * @module nodes/NodeNavigator
 */

import { Node } from "./Node";
import { Position } from "../market/Offer";

/**
 * Edge in the node graph.
 * Format: "nodeId1|nodeId2" where IDs are sorted alphabetically.
 */
export type EdgeKey = string;

/**
 * Result of a pathfinding operation.
 */
export interface PathResult {
  /** Ordered list of node IDs from start to end (inclusive) */
  path: string[];
  /** Total walking distance along the path */
  distance: number;
  /** Whether a path was found */
  found: boolean;
}

/**
 * Entry in Dijkstra's priority queue.
 */
interface PriorityQueueEntry {
  nodeId: string;
  distance: number;
}

/**
 * Creates a canonical edge key from two node IDs.
 * IDs are sorted alphabetically to ensure consistent keys.
 */
export function createEdgeKey(nodeId1: string, nodeId2: string): EdgeKey {
  return [nodeId1, nodeId2].sort().join("|");
}

/**
 * Parses an edge key into its component node IDs.
 */
export function parseEdgeKey(edgeKey: EdgeKey): [string, string] {
  const parts = edgeKey.split("|");
  return [parts[0], parts[1]];
}

/**
 * Estimates walking distance between two positions.
 * Uses Manhattan distance with room distance multiplier.
 */
export function estimateWalkingDistance(from: Position, to: Position): number {
  if (from.roomName === to.roomName) {
    // Same room - use Chebyshev distance (max of dx, dy for 8-directional movement)
    return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  }

  // Cross-room estimation
  // Parse room names to calculate room distance
  const fromMatch = from.roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  const toMatch = to.roomName.match(/^([WE])(\d+)([NS])(\d+)$/);

  if (!fromMatch || !toMatch) {
    return Infinity;
  }

  // Calculate world coordinates
  const fromWorldX =
    fromMatch[1] === "E"
      ? parseInt(fromMatch[2], 10)
      : -parseInt(fromMatch[2], 10) - 1;
  const fromWorldY =
    fromMatch[3] === "N"
      ? -parseInt(fromMatch[4], 10) - 1
      : parseInt(fromMatch[4], 10);
  const toWorldX =
    toMatch[1] === "E"
      ? parseInt(toMatch[2], 10)
      : -parseInt(toMatch[2], 10) - 1;
  const toWorldY =
    toMatch[3] === "N"
      ? -parseInt(toMatch[4], 10) - 1
      : parseInt(toMatch[4], 10);

  // Room distance
  const roomDx = Math.abs(toWorldX - fromWorldX);
  const roomDy = Math.abs(toWorldY - fromWorldY);

  // Estimate: each room crossing is ~50 tiles, plus in-room distance
  const roomDistance = Math.max(roomDx, roomDy) * 50;
  const inRoomOffset = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));

  return roomDistance + inRoomOffset;
}

/**
 * NodeNavigator provides pathfinding across the colony node network.
 *
 * The node network is a graph where:
 * - Nodes are territory peaks (spatial regions)
 * - Edges connect adjacent territories
 * - Edge weights represent walking distance between node centers
 *
 * This enables quick approximation of travel costs without computing
 * full pathfinding through the tile-based terrain.
 */
export class NodeNavigator {
  /** Map of node ID to Node object */
  private nodes: Map<string, Node>;

  /** Adjacency list: nodeId -> Set of neighbor nodeIds */
  private adjacency: Map<string, Set<string>>;

  /** Edge weights: edgeKey -> walking distance */
  private edgeWeights: Map<EdgeKey, number>;

  /**
   * Creates a new NodeNavigator.
   *
   * @param nodes - Array of nodes in the network
   * @param edges - Array of edge keys (format: "nodeId1|nodeId2")
   * @param edgeWeights - Optional map of edge keys to walking distances.
   *                      If not provided, distances are estimated from node positions.
   */
  constructor(
    nodes: Node[],
    edges: EdgeKey[],
    edgeWeights?: Map<EdgeKey, number>
  ) {
    this.nodes = new Map();
    this.adjacency = new Map();
    this.edgeWeights = new Map();

    // Index nodes
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.adjacency.set(node.id, new Set());
    }

    // Build adjacency list and edge weights
    for (const edgeKey of edges) {
      const [nodeId1, nodeId2] = parseEdgeKey(edgeKey);

      // Skip edges for nodes we don't have
      if (!this.nodes.has(nodeId1) || !this.nodes.has(nodeId2)) {
        continue;
      }

      // Add to adjacency list (bidirectional)
      this.adjacency.get(nodeId1)!.add(nodeId2);
      this.adjacency.get(nodeId2)!.add(nodeId1);

      // Set edge weight
      if (edgeWeights && edgeWeights.has(edgeKey)) {
        this.edgeWeights.set(edgeKey, edgeWeights.get(edgeKey)!);
      } else {
        // Estimate from node positions
        const node1 = this.nodes.get(nodeId1)!;
        const node2 = this.nodes.get(nodeId2)!;
        const distance = estimateWalkingDistance(
          node1.peakPosition,
          node2.peakPosition
        );
        this.edgeWeights.set(edgeKey, distance);
      }
    }
  }

  /**
   * Gets a node by ID.
   */
  getNode(nodeId: string): Node | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Gets all node IDs in the network.
   */
  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Gets the number of nodes in the network.
   */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Gets the number of edges in the network.
   */
  get edgeCount(): number {
    return this.edgeWeights.size;
  }

  /**
   * Gets neighbors of a node (directly connected nodes).
   */
  getNeighbors(nodeId: string): string[] {
    const neighbors = this.adjacency.get(nodeId);
    return neighbors ? Array.from(neighbors) : [];
  }

  /**
   * Gets the walking distance for an edge.
   * Returns Infinity if the edge doesn't exist.
   */
  getEdgeWeight(nodeId1: string, nodeId2: string): number {
    const edgeKey = createEdgeKey(nodeId1, nodeId2);
    return this.edgeWeights.get(edgeKey) ?? Infinity;
  }

  /**
   * Checks if two nodes are directly connected.
   */
  areAdjacent(nodeId1: string, nodeId2: string): boolean {
    const neighbors = this.adjacency.get(nodeId1);
    return neighbors ? neighbors.has(nodeId2) : false;
  }

  /**
   * Finds the shortest path between two nodes using Dijkstra's algorithm.
   *
   * @param startId - Starting node ID
   * @param endId - Destination node ID
   * @returns PathResult with path, total distance, and success flag
   */
  findPath(startId: string, endId: string): PathResult {
    // Handle edge cases
    if (startId === endId) {
      return { path: [startId], distance: 0, found: true };
    }

    if (!this.nodes.has(startId) || !this.nodes.has(endId)) {
      return { path: [], distance: Infinity, found: false };
    }

    // Dijkstra's algorithm
    const distances = new Map<string, number>();
    const previous = new Map<string, string | null>();
    const visited = new Set<string>();

    // Simple priority queue using array (could optimize with heap for large graphs)
    const queue: PriorityQueueEntry[] = [];

    // Initialize
    for (const nodeId of this.nodes.keys()) {
      distances.set(nodeId, nodeId === startId ? 0 : Infinity);
      previous.set(nodeId, null);
    }
    queue.push({ nodeId: startId, distance: 0 });

    while (queue.length > 0) {
      // Get node with minimum distance
      queue.sort((a, b) => a.distance - b.distance);
      const current = queue.shift()!;

      if (visited.has(current.nodeId)) {
        continue;
      }
      visited.add(current.nodeId);

      // Found destination
      if (current.nodeId === endId) {
        break;
      }

      // Skip if unreachable
      if (current.distance === Infinity) {
        continue;
      }

      // Explore neighbors
      const neighbors = this.adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId);
        const newDistance = current.distance + edgeWeight;

        if (newDistance < distances.get(neighborId)!) {
          distances.set(neighborId, newDistance);
          previous.set(neighborId, current.nodeId);
          queue.push({ nodeId: neighborId, distance: newDistance });
        }
      }
    }

    // Reconstruct path
    const finalDistance = distances.get(endId)!;
    if (finalDistance === Infinity) {
      return { path: [], distance: Infinity, found: false };
    }

    const path: string[] = [];
    let current: string | null = endId;
    while (current !== null) {
      path.unshift(current);
      current = previous.get(current) ?? null;
    }

    return { path, distance: finalDistance, found: true };
  }

  /**
   * Gets the approximate walking distance between two nodes.
   * This is the sum of edge weights along the shortest path.
   *
   * @param startId - Starting node ID
   * @param endId - Destination node ID
   * @returns Walking distance, or Infinity if no path exists
   */
  getDistance(startId: string, endId: string): number {
    return this.findPath(startId, endId).distance;
  }

  /**
   * Finds all nodes within a given walking distance from a starting node.
   * Uses Dijkstra's algorithm with early termination.
   *
   * @param startId - Starting node ID
   * @param maxDistance - Maximum walking distance
   * @returns Map of reachable node IDs to their distances
   */
  getNodesWithinDistance(
    startId: string,
    maxDistance: number
  ): Map<string, number> {
    const result = new Map<string, number>();

    if (!this.nodes.has(startId)) {
      return result;
    }

    const distances = new Map<string, number>();
    const visited = new Set<string>();
    const queue: PriorityQueueEntry[] = [];

    distances.set(startId, 0);
    queue.push({ nodeId: startId, distance: 0 });

    while (queue.length > 0) {
      queue.sort((a, b) => a.distance - b.distance);
      const current = queue.shift()!;

      if (visited.has(current.nodeId)) {
        continue;
      }

      // Early termination if we've exceeded max distance
      if (current.distance > maxDistance) {
        break;
      }

      visited.add(current.nodeId);
      result.set(current.nodeId, current.distance);

      const neighbors = this.adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId);
        const newDistance = current.distance + edgeWeight;

        if (newDistance <= maxDistance) {
          const existingDist = distances.get(neighborId) ?? Infinity;
          if (newDistance < existingDist) {
            distances.set(neighborId, newDistance);
            queue.push({ nodeId: neighborId, distance: newDistance });
          }
        }
      }
    }

    return result;
  }

  /**
   * Finds the closest node to a starting node from a set of candidates.
   *
   * @param startId - Starting node ID
   * @param candidateIds - Set of candidate node IDs to search
   * @returns Closest node ID and distance, or null if none reachable
   */
  findClosest(
    startId: string,
    candidateIds: Set<string>
  ): { nodeId: string; distance: number } | null {
    if (!this.nodes.has(startId) || candidateIds.size === 0) {
      return null;
    }

    // Check if start is a candidate
    if (candidateIds.has(startId)) {
      return { nodeId: startId, distance: 0 };
    }

    const distances = new Map<string, number>();
    const visited = new Set<string>();
    const queue: PriorityQueueEntry[] = [];

    distances.set(startId, 0);
    queue.push({ nodeId: startId, distance: 0 });

    while (queue.length > 0) {
      queue.sort((a, b) => a.distance - b.distance);
      const current = queue.shift()!;

      if (visited.has(current.nodeId)) {
        continue;
      }
      visited.add(current.nodeId);

      // Check if this is a candidate
      if (candidateIds.has(current.nodeId)) {
        return { nodeId: current.nodeId, distance: current.distance };
      }

      const neighbors = this.adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId);
        const newDistance = current.distance + edgeWeight;

        const existingDist = distances.get(neighborId) ?? Infinity;
        if (newDistance < existingDist) {
          distances.set(neighborId, newDistance);
          queue.push({ nodeId: neighborId, distance: newDistance });
        }
      }
    }

    return null;
  }

  /**
   * Gets nodes sorted by distance from a starting node.
   *
   * @param startId - Starting node ID
   * @param limit - Maximum number of nodes to return (optional)
   * @returns Array of {nodeId, distance} sorted by ascending distance
   */
  getNodesByDistance(
    startId: string,
    limit?: number
  ): Array<{ nodeId: string; distance: number }> {
    if (!this.nodes.has(startId)) {
      return [];
    }

    const result: Array<{ nodeId: string; distance: number }> = [];
    const distances = new Map<string, number>();
    const visited = new Set<string>();
    const queue: PriorityQueueEntry[] = [];

    distances.set(startId, 0);
    queue.push({ nodeId: startId, distance: 0 });

    while (queue.length > 0) {
      queue.sort((a, b) => a.distance - b.distance);
      const current = queue.shift()!;

      if (visited.has(current.nodeId)) {
        continue;
      }
      visited.add(current.nodeId);
      result.push({ nodeId: current.nodeId, distance: current.distance });

      // Early exit if we've reached the limit
      if (limit !== undefined && result.length >= limit) {
        break;
      }

      const neighbors = this.adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId);
        const newDistance = current.distance + edgeWeight;

        const existingDist = distances.get(neighborId) ?? Infinity;
        if (newDistance < existingDist) {
          distances.set(neighborId, newDistance);
          queue.push({ nodeId: neighborId, distance: newDistance });
        }
      }
    }

    return result;
  }

  /**
   * Gets all edges in the network with their weights.
   */
  getEdges(): Array<{ edge: EdgeKey; weight: number }> {
    return Array.from(this.edgeWeights.entries()).map(([edge, weight]) => ({
      edge,
      weight,
    }));
  }

  /**
   * Creates a subgraph containing only the specified nodes.
   * Edges are preserved only if both endpoints are in the subgraph.
   */
  subgraph(nodeIds: Set<string>): NodeNavigator {
    const subNodes: Node[] = [];
    const subEdges: EdgeKey[] = [];
    const subWeights = new Map<EdgeKey, number>();

    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (node) {
        subNodes.push(node);
      }
    }

    for (const [edgeKey, weight] of this.edgeWeights) {
      const [id1, id2] = parseEdgeKey(edgeKey);
      if (nodeIds.has(id1) && nodeIds.has(id2)) {
        subEdges.push(edgeKey);
        subWeights.set(edgeKey, weight);
      }
    }

    return new NodeNavigator(subNodes, subEdges, subWeights);
  }

  /**
   * Checks if the graph is connected (all nodes reachable from any node).
   */
  isConnected(): boolean {
    if (this.nodes.size === 0) return true;

    const startId = this.nodes.keys().next().value;
    const reachable = this.getNodesWithinDistance(startId, Infinity);

    return reachable.size === this.nodes.size;
  }

  /**
   * Gets connected components of the graph.
   * Returns an array of sets, each containing the node IDs of a connected component.
   */
  getConnectedComponents(): Set<string>[] {
    const components: Set<string>[] = [];
    const visited = new Set<string>();

    for (const nodeId of this.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      // BFS to find all nodes in this component
      const component = new Set<string>();
      const queue = [nodeId];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;

        visited.add(current);
        component.add(current);

        const neighbors = this.adjacency.get(current);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          }
        }
      }

      components.push(component);
    }

    return components;
  }
}

/**
 * Creates a NodeNavigator from nodes and a set of edge keys.
 * Convenience function for common usage pattern.
 */
export function createNodeNavigator(
  nodes: Node[],
  edges: string[] | Set<string>,
  edgeWeights?: Map<string, number>
): NodeNavigator {
  const edgeArray = edges instanceof Set ? Array.from(edges) : edges;
  return new NodeNavigator(nodes, edgeArray, edgeWeights);
}
