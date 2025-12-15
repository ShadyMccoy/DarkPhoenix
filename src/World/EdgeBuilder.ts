/**
 * Edge Builder - Creates edges between adjacent nodes
 *
 * Strategy: Delaunay Connectivity (territory adjacency)
 * Two nodes are connected if their territories share a boundary.
 * This creates a sparse, well-connected graph without redundant edges.
 */

import { WorldNode, WorldEdge } from "./interfaces";

export class EdgeBuilder {
  /**
   * Build edges between nodes using territory adjacency.
   *
   * @param nodes - Map of node ID to WorldNode
   * @returns Map of edge ID to WorldEdge
   */
  static buildEdges(nodes: Map<string, WorldNode>): Map<string, WorldEdge> {
    const edges = new Map<string, WorldEdge>();
    const nodeArray = Array.from(nodes.values());

    // Test all pairs of nodes
    for (let i = 0; i < nodeArray.length; i++) {
      for (let j = i + 1; j < nodeArray.length; j++) {
        const nodeA = nodeArray[i];
        const nodeB = nodeArray[j];

        if (this.territoriesAreAdjacent(nodeA.territory, nodeB.territory)) {
          const edge = this.createEdge(nodeA, nodeB);
          edges.set(edge.id, edge);
        }
      }
    }

    return edges;
  }

  /**
   * Check if two territories share a boundary (are adjacent).
   * Territories are adjacent if a position in one is orthogonally or diagonally
   * next to a position in the other.
   */
  private static territoriesAreAdjacent(
    territoryA: RoomPosition[],
    territoryB: RoomPosition[]
  ): boolean {
    // Build a set of positions in B for fast lookup
    const bPositions = new Set(
      territoryB.map(pos => `${pos.x},${pos.y}`)
    );

    // Check each position in A for neighbors in B
    for (const posA of territoryA) {
      // Check all 8 neighbors of posA
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;

          const neighborX = posA.x + dx;
          const neighborY = posA.y + dy;

          // Skip if out of bounds
          if (
            neighborX < 0 ||
            neighborX >= 50 ||
            neighborY < 0 ||
            neighborY >= 50
          ) {
            continue;
          }

          const neighborKey = `${neighborX},${neighborY}`;
          if (bPositions.has(neighborKey)) {
            return true; // Found adjacent territories
          }
        }
      }
    }

    return false;
  }

  /**
   * Create an edge between two nodes.
   * Calculates distance and capacity.
   */
  private static createEdge(nodeA: WorldNode, nodeB: WorldNode): WorldEdge {
    // Create canonical ID (ensure consistent ordering)
    const [id1, id2] = [nodeA.id, nodeB.id].sort();
    const edgeId = `${id1}-${id2}`;

    // Calculate distance between node centers
    const distance = nodeA.pos.getRangeTo(nodeB.pos);

    // Capacity is arbitrary for now - could be refined based on territory size
    const capacity = 10;

    const edge: WorldEdge = {
      id: edgeId,
      fromId: nodeA.id,
      toId: nodeB.id,
      distance,
      capacity,
    };

    return edge;
  }

  /**
   * Update node adjacency lists based on edges.
   * Call this after building all edges.
   */
  static populateAdjacency(
    nodes: Map<string, WorldNode>,
    edges: Map<string, WorldEdge>
  ): void {
    // Clear existing adjacency lists
    for (const node of nodes.values()) {
      node.adjacentNodeIds = [];
    }

    // Populate from edges
    for (const edge of edges.values()) {
      const nodeA = nodes.get(edge.fromId);
      const nodeB = nodes.get(edge.toId);

      if (nodeA && nodeB) {
        nodeA.adjacentNodeIds.push(nodeB.id);
        nodeB.adjacentNodeIds.push(nodeA.id);
      }
    }
  }
}
