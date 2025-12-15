/**
 * Graph Analyzer - Computes metrics on world graph structure
 *
 * Provides analysis tools for:
 * - Graph structure metrics (node count, edge count, connectivity)
 * - Territory coverage and balance
 * - Node importance and clustering
 * - Graph health checks
 *
 * Used for empirical refinement and validation of graph algorithms.
 */

import { WorldGraph, WorldNode, WorldEdge } from "./interfaces";

export interface GraphMetrics {
  // Structural metrics
  nodeCount: number;
  edgeCount: number;
  averageDegree: number;
  maxDegree: number;
  minDegree: number;

  // Connectivity metrics
  isConnected: boolean;
  largestComponentSize: number;
  isolatedNodeCount: number;

  // Territory metrics
  averageTerritorySize: number;
  maxTerritorySize: number;
  minTerritorySize: number;
  territoryBalance: number; // 0-1, higher = more balanced

  // Distance metrics
  averageEdgeDistance: number;
  maxEdgeDistance: number;
  averageNodeDistance: number;

  // Health metrics
  hasProblems: boolean;
  problems: string[];
}

export interface NodeMetrics {
  id: string;
  degree: number;
  territorySize: number;
  closeness: number; // Average distance to all other nodes
  betweenness: number; // Rough estimate: how many paths go through this node
  importance: "hub" | "branch" | "leaf";
  redundancy: number; // How many edge deletions before isolation
}

export class GraphAnalyzer {
  /**
   * Analyze the overall graph structure.
   */
  static analyzeGraph(graph: WorldGraph): GraphMetrics {
    const problems: string[] = [];
    const metrics = this.computeStructuralMetrics(graph);

    // Check for common problems
    if (metrics.isolatedNodeCount > 0) {
      problems.push(
        `${metrics.isolatedNodeCount} isolated nodes (degree = 0)`
      );
    }
    if (!metrics.isConnected && metrics.largestComponentSize < metrics.nodeCount) {
      problems.push(
        `Graph not connected: largest component has ${metrics.largestComponentSize}/${metrics.nodeCount} nodes`
      );
    }
    if (metrics.territoryBalance < 0.3) {
      problems.push(
        `Territory imbalance detected (balance = ${metrics.territoryBalance.toFixed(
          2
        )})`
      );
    }

    return {
      ...metrics,
      hasProblems: problems.length > 0,
      problems,
    };
  }

  /**
   * Analyze a single node within its graph context.
   */
  static analyzeNode(graph: WorldGraph, nodeId: string): NodeMetrics | null {
    const node = graph.nodes.get(nodeId);
    if (!node) return null;

    const degree = node.adjacentNodeIds.length;
    const territorySize = node.territory.length;
    const closeness = this.calculateCloseness(graph, nodeId);
    const betweenness = this.estimateBetweenness(graph, nodeId);
    const redundancy = this.calculateRedundancy(graph, nodeId);

    let importance: "hub" | "branch" | "leaf";
    if (degree >= 3) importance = "hub";
    else if (degree === 2) importance = "branch";
    else importance = "leaf";

    return {
      id: nodeId,
      degree,
      territorySize,
      closeness,
      betweenness,
      importance,
      redundancy,
    };
  }

  /**
   * Find bottleneck nodes - nodes whose removal would disconnect the graph.
   */
  static findArticulationPoints(graph: WorldGraph): string[] {
    const articulations: string[] = [];

    for (const nodeId of graph.nodes.keys()) {
      // Try removing this node
      const remaining = new Set(graph.nodes.keys());
      remaining.delete(nodeId);

      if (remaining.size === 0) continue; // Skip if only node

      // Check if remaining is connected
      if (!this.isConnectedSubgraph(graph, remaining)) {
        articulations.push(nodeId);
      }
    }

    return articulations;
  }

  /**
   * Find nodes with low connectivity (potential weak points).
   */
  static findWeakNodes(graph: WorldGraph): string[] {
    const average = this.computeStructuralMetrics(graph).averageDegree;
    const weak: string[] = [];

    for (const node of graph.nodes.values()) {
      if (node.adjacentNodeIds.length < average * 0.5) {
        weak.push(node.id);
      }
    }

    return weak;
  }

  /**
   * Find territory coverage gaps - areas between nodes not assigned to any.
   * Returns count of uncovered positions.
   */
  static findCoveragegaps(graph: WorldGraph): number {
    const covered = new Set<string>();

    for (const node of graph.nodes.values()) {
      for (const pos of node.territory) {
        covered.add(`${pos.x},${pos.y},${pos.roomName}`);
      }
    }

    // Rough count: how many positions in rooms are not covered?
    // For now, just return count of distinct rooms
    const rooms = new Set(
      Array.from(graph.nodes.values()).map(n => n.room)
    );

    let gaps = 0;
    for (const room of rooms) {
      // Assuming 50x50 grid
      gaps += 2500; // Total positions
      for (const node of graph.nodes.values()) {
        if (node.room === room) {
          gaps -= node.territory.length;
        }
      }
    }

    return Math.max(0, gaps); // Could be negative if nodes span multiple rooms
  }

  // ==================== Private Helpers ====================

  private static computeStructuralMetrics(graph: WorldGraph): Omit<
    GraphMetrics,
    "hasProblems" | "problems"
  > {
    const nodeCount = graph.nodes.size;
    const edgeCount = graph.edges.size;

    let degrees: number[] = [];
    let isolatedCount = 0;

    for (const node of graph.nodes.values()) {
      degrees.push(node.adjacentNodeIds.length);
      if (node.adjacentNodeIds.length === 0) {
        isolatedCount++;
      }
    }

    // Connectivity analysis
    const isConnected = this.isConnectedSubgraph(
      graph,
      new Set(graph.nodes.keys())
    );
    const largestComponentSize = this.findLargestComponent(graph).size;

    // Territory metrics
    const territorySizes = Array.from(graph.nodes.values()).map(
      n => n.territory.length
    );

    const avgTerritory =
      territorySizes.reduce((a, b) => a + b, 0) / (nodeCount || 1);
    const maxTerritory = Math.max(...territorySizes, 0);
    const minTerritory = Math.min(...territorySizes, Infinity);

    // Balance: variance / mean (lower is better)
    const territoryBalance =
      territorySizes.length > 0
        ? this.calculateBalance(territorySizes)
        : 0;

    // Distance metrics
    const distances = Array.from(graph.edges.values()).map(e => e.distance);
    const avgDistance =
      distances.reduce((a, b) => a + b, 0) / (distances.length || 1);
    const maxDistance = Math.max(...distances, 0);

    // Avg distance between all nodes (very rough)
    const avgNodeDistance =
      this.estimateAverageNodeDistance(graph) || avgDistance;

    return {
      nodeCount,
      edgeCount,
      averageDegree: degrees.reduce((a, b) => a + b, 0) / (degrees.length || 1),
      maxDegree: Math.max(...degrees, 0),
      minDegree: Math.min(...degrees, Infinity),
      isConnected,
      largestComponentSize,
      isolatedNodeCount: isolatedCount,
      averageTerritorySize: avgTerritory,
      maxTerritorySize: maxTerritory,
      minTerritorySize: minTerritory,
      territoryBalance,
      averageEdgeDistance: avgDistance,
      maxEdgeDistance: maxDistance,
      averageNodeDistance: avgNodeDistance,
    };
  }

  private static calculateCloseness(
    graph: WorldGraph,
    nodeId: string
  ): number {
    // Closeness = 1 / average distance to all other nodes
    const distances = this.dijkstraDistances(graph, nodeId);
    const validDistances = Array.from(distances.values()).filter(
      d => d !== Infinity
    );

    if (validDistances.length === 0) return 0;

    const avgDist =
      validDistances.reduce((a, b) => a + b, 0) / validDistances.length;
    return avgDist === 0 ? 0 : 1 / avgDist;
  }

  private static estimateBetweenness(
    graph: WorldGraph,
    nodeId: string
  ): number {
    // Rough estimate: count how many shortest paths from A to B go through this node
    // For now, just return degree as a proxy (higher degree = more paths)
    const node = graph.nodes.get(nodeId);
    return node ? node.adjacentNodeIds.length : 0;
  }

  private static calculateRedundancy(
    graph: WorldGraph,
    nodeId: string
  ): number {
    // How many edges can be removed before isolation?
    const node = graph.nodes.get(nodeId);
    if (!node) return 0;

    return node.adjacentNodeIds.length;
  }

  private static isConnectedSubgraph(
    graph: WorldGraph,
    nodeIds: Set<string>
  ): boolean {
    if (nodeIds.size <= 1) return true;

    const visited = new Set<string>();
    const queue = [Array.from(nodeIds)[0]];
    visited.add(queue[0]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = graph.nodes.get(current);
      if (!node) continue;

      for (const neighborId of node.adjacentNodeIds) {
        if (nodeIds.has(neighborId) && !visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }
    }

    return visited.size === nodeIds.size;
  }

  private static findLargestComponent(graph: WorldGraph): Set<string> {
    const visited = new Set<string>();
    let largestComponent = new Set<string>();

    for (const nodeId of graph.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      const component = new Set<string>();
      const queue = [nodeId];
      component.add(nodeId);
      visited.add(nodeId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const node = graph.nodes.get(current);
        if (!node) continue;

        for (const neighborId of node.adjacentNodeIds) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            component.add(neighborId);
            queue.push(neighborId);
          }
        }
      }

      if (component.size > largestComponent.size) {
        largestComponent = component;
      }
    }

    return largestComponent;
  }

  private static dijkstraDistances(
    graph: WorldGraph,
    startId: string
  ): Map<string, number> {
    const distances = new Map<string, number>();
    for (const nodeId of graph.nodes.keys()) {
      distances.set(nodeId, Infinity);
    }
    distances.set(startId, 0);

    const unvisited = new Set(graph.nodes.keys());

    while (unvisited.size > 0) {
      let current: string | null = null;
      let minDist = Infinity;

      for (const nodeId of unvisited) {
        const dist = distances.get(nodeId) || Infinity;
        if (dist < minDist) {
          minDist = dist;
          current = nodeId;
        }
      }

      if (current === null || minDist === Infinity) break;

      unvisited.delete(current);
      const node = graph.nodes.get(current);
      if (!node) continue;

      for (const neighborId of node.adjacentNodeIds) {
        if (unvisited.has(neighborId)) {
          const edge = this.findEdge(graph, current, neighborId);
          const edgeDist = edge ? edge.distance : 1;
          const newDist = minDist + edgeDist;

          if (newDist < (distances.get(neighborId) || Infinity)) {
            distances.set(neighborId, newDist);
          }
        }
      }
    }

    return distances;
  }

  private static findEdge(
    graph: WorldGraph,
    fromId: string,
    toId: string
  ): WorldEdge | null {
    const [id1, id2] = [fromId, toId].sort();
    const edgeId = `${id1}-${id2}`;
    return graph.edges.get(edgeId) || null;
  }

  private static estimateAverageNodeDistance(graph: WorldGraph): number {
    let totalDist = 0;
    let count = 0;

    // Sample: compute distances from a few random nodes
    const sampleSize = Math.min(5, graph.nodes.size);
    const nodeIds = Array.from(graph.nodes.keys()).slice(0, sampleSize);

    for (const nodeId of nodeIds) {
      const distances = this.dijkstraDistances(graph, nodeId);
      const validDistances = Array.from(distances.values()).filter(
        d => d !== Infinity && d > 0
      );

      totalDist +=
        validDistances.reduce((a, b) => a + b, 0) / (validDistances.length || 1);
      count++;
    }

    return count > 0 ? totalDist / count : 0;
  }

  private static calculateBalance(values: number[]): number {
    if (values.length <= 1) return 1;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Balance = 1 / (1 + cv) where cv = stdDev / mean
    const cv = mean > 0 ? stdDev / mean : 0;
    return 1 / (1 + cv);
  }
}
