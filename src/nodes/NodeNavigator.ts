/**
 * @fileoverview Node network navigation utilities.
 *
 * Provides pathfinding and distance calculations across the colony node network.
 * Each edge in the network represents walking distance between adjacent nodes,
 * enabling quick approximation of travel costs across multiple rooms.
 *
 * Supports two edge types:
 * - Spatial edges: Direct connections between adjacent territories
 * - Economic edges: Direct connections between corp-hosting nodes with shortest path cost
 *
 * Uses Dijkstra's algorithm for optimal path finding through the node graph.
 *
 * @module nodes/NodeNavigator
 */

import { Node } from "./Node";
import { Position } from "../market/Offer";

/**
 * Edge type in the node graph.
 * - spatial: Direct connection between adjacent territories
 * - economic: Connection between corp-hosting nodes (may skip intermediate nodes)
 */
export type EdgeType = "spatial" | "economic";

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
 * Edge data including type and weight.
 */
export interface EdgeData {
  /** Type of edge (spatial or economic) */
  type: EdgeType;
  /** Edge weight (walking distance or path cost) */
  weight: number;
}

/**
 * NodeNavigator provides pathfinding across the colony node network.
 *
 * The node network is a graph where:
 * - Nodes are territory peaks (spatial regions)
 * - Edges connect adjacent territories
 * - Edge weights represent walking distance between node centers
 *
 * Supports two types of edges:
 * - Spatial edges: Direct connections between adjacent territories
 * - Economic edges: Connections between corp-hosting nodes with total path cost
 *
 * This enables quick approximation of travel costs without computing
 * full pathfinding through the tile-based terrain.
 *
 * IMPORTANT: Navigation only traverses existing edges in the graph.
 * Edge weights should come from actual walking distance calculations
 * (e.g., from bfsWalkingDistance in the skeleton builder).
 */
export class NodeNavigator {
  /** Map of node ID to Node object */
  private nodes: Map<string, Node>;

  /** Adjacency list for spatial edges: nodeId -> Set of neighbor nodeIds */
  private spatialAdjacency: Map<string, Set<string>>;

  /** Adjacency list for economic edges: nodeId -> Set of neighbor nodeIds */
  private economicAdjacency: Map<string, Set<string>>;

  /** Edge data: edgeKey -> EdgeData (type + weight) */
  private edgeData: Map<EdgeKey, EdgeData>;

  /**
   * Creates a new NodeNavigator.
   *
   * @param nodes - Array of nodes in the network
   * @param edges - Array of edge keys (format: "nodeId1|nodeId2")
   * @param edgeWeights - Optional map of edge keys to walking distances.
   *                      If not provided, each edge defaults to weight 1.
   * @param edgeTypes - Optional map of edge keys to edge types.
   *                    If not provided, edges default to "spatial".
   */
  constructor(
    nodes: Node[],
    edges: EdgeKey[],
    edgeWeights?: Map<EdgeKey, number>,
    edgeTypes?: Map<EdgeKey, EdgeType>
  ) {
    this.nodes = new Map();
    this.spatialAdjacency = new Map();
    this.economicAdjacency = new Map();
    this.edgeData = new Map();

    // Index nodes
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.spatialAdjacency.set(node.id, new Set());
      this.economicAdjacency.set(node.id, new Set());
    }

    // Build adjacency lists and edge data
    for (const edgeKey of edges) {
      const [nodeId1, nodeId2] = parseEdgeKey(edgeKey);

      // Skip edges for nodes we don't have
      if (!this.nodes.has(nodeId1) || !this.nodes.has(nodeId2)) {
        continue;
      }

      const weight = edgeWeights?.get(edgeKey) ?? 1;
      const type = edgeTypes?.get(edgeKey) ?? "spatial";

      // Add to appropriate adjacency list (bidirectional)
      if (type === "spatial") {
        this.spatialAdjacency.get(nodeId1)!.add(nodeId2);
        this.spatialAdjacency.get(nodeId2)!.add(nodeId1);
      } else {
        this.economicAdjacency.get(nodeId1)!.add(nodeId2);
        this.economicAdjacency.get(nodeId2)!.add(nodeId1);
      }

      // Store edge data
      this.edgeData.set(edgeKey, { type, weight });
    }
  }

  /**
   * Gets the adjacency map for the specified edge type.
   */
  private getAdjacencyMap(
    edgeType?: EdgeType
  ): Map<string, Set<string>> {
    if (edgeType === "spatial") {
      return this.spatialAdjacency;
    } else if (edgeType === "economic") {
      return this.economicAdjacency;
    }
    // Return combined adjacency for all edges
    const combined = new Map<string, Set<string>>();
    for (const nodeId of this.nodes.keys()) {
      const neighbors = new Set<string>();
      const spatial = this.spatialAdjacency.get(nodeId);
      const economic = this.economicAdjacency.get(nodeId);
      if (spatial) {
        for (const n of spatial) neighbors.add(n);
      }
      if (economic) {
        for (const n of economic) neighbors.add(n);
      }
      combined.set(nodeId, neighbors);
    }
    return combined;
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
   * @param edgeType - Optional filter by edge type
   */
  getEdgeCount(edgeType?: EdgeType): number {
    if (!edgeType) {
      return this.edgeData.size;
    }
    let count = 0;
    for (const data of this.edgeData.values()) {
      if (data.type === edgeType) count++;
    }
    return count;
  }

  /**
   * Gets the total number of edges (for backwards compatibility).
   */
  get edgeCount(): number {
    return this.edgeData.size;
  }

  /**
   * Gets neighbors of a node (directly connected nodes).
   * @param nodeId - The node to get neighbors for
   * @param edgeType - Optional filter by edge type
   */
  getNeighbors(nodeId: string, edgeType?: EdgeType): string[] {
    const adjacency = this.getAdjacencyMap(edgeType);
    const neighbors = adjacency.get(nodeId);
    return neighbors ? Array.from(neighbors) : [];
  }

  /**
   * Gets the walking distance for an edge.
   * Returns Infinity if the edge doesn't exist.
   * @param nodeId1 - First node ID
   * @param nodeId2 - Second node ID
   * @param edgeType - Optional filter by edge type
   */
  getEdgeWeight(nodeId1: string, nodeId2: string, edgeType?: EdgeType): number {
    const edgeKey = createEdgeKey(nodeId1, nodeId2);
    const data = this.edgeData.get(edgeKey);
    if (!data) return Infinity;
    if (edgeType && data.type !== edgeType) return Infinity;
    return data.weight;
  }

  /**
   * Gets the edge data for an edge.
   * Returns undefined if the edge doesn't exist.
   */
  getEdgeData(nodeId1: string, nodeId2: string): EdgeData | undefined {
    const edgeKey = createEdgeKey(nodeId1, nodeId2);
    return this.edgeData.get(edgeKey);
  }

  /**
   * Gets the type of an edge.
   * Returns undefined if the edge doesn't exist.
   */
  getEdgeType(nodeId1: string, nodeId2: string): EdgeType | undefined {
    return this.getEdgeData(nodeId1, nodeId2)?.type;
  }

  /**
   * Checks if two nodes are directly connected.
   * @param nodeId1 - First node ID
   * @param nodeId2 - Second node ID
   * @param edgeType - Optional filter by edge type
   */
  areAdjacent(nodeId1: string, nodeId2: string, edgeType?: EdgeType): boolean {
    const adjacency = this.getAdjacencyMap(edgeType);
    const neighbors = adjacency.get(nodeId1);
    return neighbors ? neighbors.has(nodeId2) : false;
  }

  /**
   * Finds the shortest path between two nodes using Dijkstra's algorithm.
   *
   * @param startId - Starting node ID
   * @param endId - Destination node ID
   * @param edgeType - Optional filter by edge type (spatial, economic, or all)
   * @returns PathResult with path, total distance, and success flag
   */
  findPath(startId: string, endId: string, edgeType?: EdgeType): PathResult {
    // Handle edge cases
    if (startId === endId) {
      return { path: [startId], distance: 0, found: true };
    }

    if (!this.nodes.has(startId) || !this.nodes.has(endId)) {
      return { path: [], distance: Infinity, found: false };
    }

    const adjacency = this.getAdjacencyMap(edgeType);

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
      const neighbors = adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId, edgeType);
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
   * @param edgeType - Optional filter by edge type
   * @returns Walking distance, or Infinity if no path exists
   */
  getDistance(startId: string, endId: string, edgeType?: EdgeType): number {
    return this.findPath(startId, endId, edgeType).distance;
  }

  /**
   * Finds all nodes within a given walking distance from a starting node.
   * Uses Dijkstra's algorithm with early termination.
   *
   * @param startId - Starting node ID
   * @param maxDistance - Maximum walking distance
   * @param edgeType - Optional filter by edge type
   * @returns Map of reachable node IDs to their distances
   */
  getNodesWithinDistance(
    startId: string,
    maxDistance: number,
    edgeType?: EdgeType
  ): Map<string, number> {
    const result = new Map<string, number>();

    if (!this.nodes.has(startId)) {
      return result;
    }

    const adjacency = this.getAdjacencyMap(edgeType);
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

      const neighbors = adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId, edgeType);
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
   * @param edgeType - Optional filter by edge type
   * @returns Closest node ID and distance, or null if none reachable
   */
  findClosest(
    startId: string,
    candidateIds: Set<string>,
    edgeType?: EdgeType
  ): { nodeId: string; distance: number } | null {
    if (!this.nodes.has(startId) || candidateIds.size === 0) {
      return null;
    }

    // Check if start is a candidate
    if (candidateIds.has(startId)) {
      return { nodeId: startId, distance: 0 };
    }

    const adjacency = this.getAdjacencyMap(edgeType);
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

      const neighbors = adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId, edgeType);
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
   * @param edgeType - Optional filter by edge type
   * @returns Array of {nodeId, distance} sorted by ascending distance
   */
  getNodesByDistance(
    startId: string,
    limit?: number,
    edgeType?: EdgeType
  ): Array<{ nodeId: string; distance: number }> {
    if (!this.nodes.has(startId)) {
      return [];
    }

    const adjacency = this.getAdjacencyMap(edgeType);
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

      const neighbors = adjacency.get(current.nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;

        const edgeWeight = this.getEdgeWeight(current.nodeId, neighborId, edgeType);
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
   * Gets all edges in the network with their weights and types.
   * @param edgeType - Optional filter by edge type
   */
  getEdges(edgeType?: EdgeType): Array<{ edge: EdgeKey; weight: number; type: EdgeType }> {
    const result: Array<{ edge: EdgeKey; weight: number; type: EdgeType }> = [];
    for (const [edge, data] of this.edgeData.entries()) {
      if (!edgeType || data.type === edgeType) {
        result.push({ edge, weight: data.weight, type: data.type });
      }
    }
    return result;
  }

  /**
   * Creates a subgraph containing only the specified nodes.
   * Edges are preserved only if both endpoints are in the subgraph.
   * @param nodeIds - Set of node IDs to include
   * @param edgeType - Optional filter by edge type
   */
  subgraph(nodeIds: Set<string>, edgeType?: EdgeType): NodeNavigator {
    const subNodes: Node[] = [];
    const subEdges: EdgeKey[] = [];
    const subWeights = new Map<EdgeKey, number>();
    const subTypes = new Map<EdgeKey, EdgeType>();

    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      if (node) {
        subNodes.push(node);
      }
    }

    for (const [edgeKey, data] of this.edgeData) {
      if (edgeType && data.type !== edgeType) continue;

      const [id1, id2] = parseEdgeKey(edgeKey);
      if (nodeIds.has(id1) && nodeIds.has(id2)) {
        subEdges.push(edgeKey);
        subWeights.set(edgeKey, data.weight);
        subTypes.set(edgeKey, data.type);
      }
    }

    return new NodeNavigator(subNodes, subEdges, subWeights, subTypes);
  }

  /**
   * Checks if the graph is connected (all nodes reachable from any node).
   * @param edgeType - Optional filter by edge type
   */
  isConnected(edgeType?: EdgeType): boolean {
    if (this.nodes.size === 0) return true;

    const startIdResult = this.nodes.keys().next();
    if (startIdResult.done) return true;
    const startId = startIdResult.value;

    const reachable = this.getNodesWithinDistance(startId, Infinity, edgeType);

    return reachable.size === this.nodes.size;
  }

  /**
   * Gets connected components of the graph.
   * Returns an array of sets, each containing the node IDs of a connected component.
   * @param edgeType - Optional filter by edge type
   */
  getConnectedComponents(edgeType?: EdgeType): Set<string>[] {
    const adjacency = this.getAdjacencyMap(edgeType);
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

        const neighbors = adjacency.get(current);
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

  /**
   * Adds an edge to the navigator.
   * This modifies the navigator in place.
   *
   * @param nodeId1 - First node ID
   * @param nodeId2 - Second node ID
   * @param weight - Edge weight
   * @param type - Edge type (spatial or economic)
   */
  addEdge(nodeId1: string, nodeId2: string, weight: number, type: EdgeType): void {
    if (!this.nodes.has(nodeId1) || !this.nodes.has(nodeId2)) {
      return;
    }

    const edgeKey = createEdgeKey(nodeId1, nodeId2);

    // Add to appropriate adjacency list
    if (type === "spatial") {
      this.spatialAdjacency.get(nodeId1)!.add(nodeId2);
      this.spatialAdjacency.get(nodeId2)!.add(nodeId1);
    } else {
      this.economicAdjacency.get(nodeId1)!.add(nodeId2);
      this.economicAdjacency.get(nodeId2)!.add(nodeId1);
    }

    // Store edge data
    this.edgeData.set(edgeKey, { type, weight });
  }

  /**
   * Gets all nodes that have corps (economically significant nodes).
   */
  getCorpHostingNodes(): Node[] {
    const result: Node[] = [];
    for (const node of this.nodes.values()) {
      if (node.corps && node.corps.length > 0) {
        result.push(node);
      }
    }
    return result;
  }

  /**
   * Gets IDs of all nodes that have corps (economically significant nodes).
   */
  getCorpHostingNodeIds(): Set<string> {
    const result = new Set<string>();
    for (const node of this.nodes.values()) {
      if (node.corps && node.corps.length > 0) {
        result.add(node.id);
      }
    }
    return result;
  }
}

/**
 * Creates a NodeNavigator from nodes and a set of edge keys.
 * Convenience function for common usage pattern.
 *
 * @param nodes - Array of nodes
 * @param edges - Edge keys (array or set)
 * @param edgeWeights - Optional map of edge weights
 * @param edgeTypes - Optional map of edge types
 */
export function createNodeNavigator(
  nodes: Node[],
  edges: string[] | Set<string>,
  edgeWeights?: Map<string, number>,
  edgeTypes?: Map<string, EdgeType>
): NodeNavigator {
  const edgeArray = edges instanceof Set ? Array.from(edges) : edges;
  return new NodeNavigator(nodes, edgeArray, edgeWeights, edgeTypes);
}

/**
 * Builds economic edges between all corp-hosting nodes.
 *
 * For each pair of corp-hosting nodes, computes the shortest path via
 * spatial edges and creates an economic edge with that total cost.
 *
 * @param navigator - NodeNavigator with spatial edges already set up
 * @returns Map of economic edge keys to their weights (path costs)
 */
export function buildEconomicEdges(
  navigator: NodeNavigator
): Map<EdgeKey, number> {
  const economicEdges = new Map<EdgeKey, number>();
  const corpNodes = navigator.getCorpHostingNodeIds();

  if (corpNodes.size < 2) {
    return economicEdges;
  }

  // For each pair of corp-hosting nodes
  const nodeIds = Array.from(corpNodes);
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const nodeId1 = nodeIds[i];
      const nodeId2 = nodeIds[j];

      // Compute shortest path using spatial edges
      const result = navigator.findPath(nodeId1, nodeId2, "spatial");

      if (result.found && result.distance < Infinity) {
        const edgeKey = createEdgeKey(nodeId1, nodeId2);
        economicEdges.set(edgeKey, result.distance);
      }
    }
  }

  return economicEdges;
}

/**
 * Adds economic edges to an existing navigator.
 *
 * Computes economic edges between all corp-hosting nodes and adds
 * them to the navigator. Economic edges have the total travel cost
 * via spatial edges as their weight.
 *
 * @param navigator - NodeNavigator to add economic edges to
 */
export function addEconomicEdgesToNavigator(navigator: NodeNavigator): void {
  const economicEdges = buildEconomicEdges(navigator);

  for (const [edgeKey, weight] of economicEdges) {
    const [nodeId1, nodeId2] = parseEdgeKey(edgeKey);
    navigator.addEdge(nodeId1, nodeId2, weight, "economic");
  }
}
