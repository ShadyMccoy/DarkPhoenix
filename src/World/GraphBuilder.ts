/**
 * Graph Builder - Assembles the complete world graph
 *
 * Orchestrates:
 * 1. Taking RoomMap snapshots from all rooms
 * 2. Clustering peaks into nodes
 * 3. Creating edges between adjacent nodes
 * 4. Building the final world graph structure
 */

import { RoomMap } from "RoomMap";
import {
  WorldGraph,
  RoomMapSnapshot,
  PeakCluster,
  WorldNode,
  WorldEdge,
} from "./interfaces";
import { PeakClusterer } from "./PeakClusterer";
import { NodeBuilder } from "./NodeBuilder";
import { EdgeBuilder } from "./EdgeBuilder";

export class GraphBuilder {
  /**
   * Build a world graph from a single room.
   *
   * This is the main entry point for graph construction.
   * It handles:
   * - Getting RoomMap data
   * - Clustering peaks
   * - Creating nodes
   * - Creating edges
   * - Building final graph structure
   *
   * @param roomName - Name of room to process
   * @returns WorldGraph for this room
   */
  static buildRoomGraph(roomName: string): WorldGraph {
    const room = Game.rooms[roomName];
    if (!room) {
      throw new Error(`Room ${roomName} not found`);
    }

    // Get or create RoomMap
    let roomMap = (room as any).roomMap as RoomMap;
    if (!roomMap) {
      roomMap = new RoomMap(room);
      (room as any).roomMap = roomMap;
    }

    // Create snapshot
    const snapshot = this.createSnapshot(roomName, roomMap);

    // Cluster peaks
    const clusters = PeakClusterer.cluster(
      snapshot.peaks,
      snapshot.territories
    );

    // Build nodes
    const nodes = NodeBuilder.buildNodes(clusters, roomName);

    // Build edges
    const edges = EdgeBuilder.buildEdges(nodes);

    // Populate adjacency lists
    EdgeBuilder.populateAdjacency(nodes, edges);

    // Build edge index by node
    const edgesByNode = this.buildEdgeIndex(edges);

    // Assemble graph
    const graph: WorldGraph = {
      nodes,
      edges,
      edgesByNode,
      timestamp: Game.time,
      version: 1,
    };

    return graph;
  }

  /**
   * Create a snapshot of RoomMap data for processing.
   */
  private static createSnapshot(
    roomName: string,
    roomMap: RoomMap
  ): RoomMapSnapshot {
    const peaks = roomMap.getPeaks();
    const territories = roomMap.getAllTerritories();

    return {
      room: roomName,
      peaks,
      territories,
      timestamp: Game.time,
    };
  }

  /**
   * Build an index mapping each node ID to its edge IDs.
   */
  private static buildEdgeIndex(
    edges: Map<string, WorldEdge>
  ): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const edge of edges.values()) {
      // Add edge to fromId list
      if (!index.has(edge.fromId)) {
        index.set(edge.fromId, []);
      }
      index.get(edge.fromId)!.push(edge.id);

      // Add edge to toId list
      if (!index.has(edge.toId)) {
        index.set(edge.toId, []);
      }
      index.get(edge.toId)!.push(edge.id);
    }

    return index;
  }

  /**
   * Merge multiple room graphs into a single world graph.
   * This is for multi-room support (room-atheist design).
   *
   * @param roomGraphs - Map of room name to room graph
   * @returns Combined world graph
   */
  static mergeRoomGraphs(
    roomGraphs: Map<string, WorldGraph>
  ): WorldGraph {
    const mergedNodes = new Map<string, WorldNode>();
    const mergedEdges = new Map<string, WorldEdge>();

    // Merge all nodes and edges from all room graphs
    for (const roomGraph of roomGraphs.values()) {
      for (const [nodeId, node] of roomGraph.nodes) {
        mergedNodes.set(nodeId, node);
      }
      for (const [edgeId, edge] of roomGraph.edges) {
        mergedEdges.set(edgeId, edge);
      }
    }

    // Add cross-room edges (for rooms that are adjacent)
    this.addCrossRoomEdges(mergedNodes, mergedEdges);

    // Rebuild edge index
    const edgesByNode = this.buildEdgeIndex(mergedEdges);

    const graph: WorldGraph = {
      nodes: mergedNodes,
      edges: mergedEdges,
      edgesByNode,
      timestamp: Game.time,
      version: 1,
    };

    return graph;
  }

  /**
   * Add edges between nodes in adjacent rooms.
   *
   * Two rooms are adjacent if their names are adjacent (e.g., "W5S4" and "W6S4").
   * We connect nodes that are near the boundary between the rooms.
   */
  private static addCrossRoomEdges(
    nodes: Map<string, WorldNode>,
    edges: Map<string, WorldEdge>
  ): void {
    // Group nodes by room
    const nodesByRoom = new Map<string, WorldNode[]>();
    for (const node of nodes.values()) {
      if (!nodesByRoom.has(node.room)) {
        nodesByRoom.set(node.room, []);
      }
      nodesByRoom.get(node.room)!.push(node);
    }

    // For each pair of rooms, check if they're adjacent
    const roomNames = Array.from(nodesByRoom.keys());
    for (let i = 0; i < roomNames.length; i++) {
      for (let j = i + 1; j < roomNames.length; j++) {
        const roomA = roomNames[i];
        const roomB = roomNames[j];

        if (this.roomsAreAdjacent(roomA, roomB)) {
          const nodesA = nodesByRoom.get(roomA)!;
          const nodesB = nodesByRoom.get(roomB)!;

          // Connect nearest nodes from adjacent rooms
          this.connectAdjacentRoomNodes(nodesA, nodesB, edges);
        }
      }
    }
  }

  /**
   * Check if two rooms are adjacent.
   *
   * Rooms are adjacent if their room name coordinates differ by exactly 1.
   */
  private static roomsAreAdjacent(roomA: string, roomB: string): boolean {
    // Parse room coordinates
    const parseRoom = (roomName: string): { x: number; y: number } | null => {
      const match = roomName.match(/([WE])(\d+)([NS])(\d+)/);
      if (!match) return null;

      const x = parseInt(match[2], 10) * (match[1] === "W" ? -1 : 1);
      const y = parseInt(match[4], 10) * (match[3] === "N" ? -1 : 1);
      return { x, y };
    };

    const coordA = parseRoom(roomA);
    const coordB = parseRoom(roomB);

    if (!coordA || !coordB) return false;

    const dist = Math.max(Math.abs(coordA.x - coordB.x), Math.abs(coordA.y - coordB.y));
    return dist === 1; // Adjacent if max coordinate difference is 1
  }

  /**
   * Connect nodes from two adjacent rooms.
   * Connects nearest nodes (within threshold distance).
   */
  private static connectAdjacentRoomNodes(
    nodesA: WorldNode[],
    nodesB: WorldNode[],
    edges: Map<string, WorldEdge>
  ): void {
    const CROSS_ROOM_THRESHOLD = 15; // Max distance to connect across rooms

    // For each node in A, find nearest in B
    for (const nodeA of nodesA) {
      let nearestB: WorldNode | null = null;
      let nearestDist = CROSS_ROOM_THRESHOLD;

      for (const nodeB of nodesB) {
        // Calculate distance through the boundary
        const dist = nodeA.pos.getRangeTo(nodeB.pos);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestB = nodeB;
        }
      }

      if (nearestB) {
        // Create edge between them
        const [id1, id2] = [nodeA.id, nearestB.id].sort();
        const edgeId = `${id1}-${id2}`;

        if (!edges.has(edgeId)) {
          edges.set(edgeId, {
            id: edgeId,
            fromId: nodeA.id,
            toId: nearestB.id,
            distance: nearestDist,
            capacity: 10,
          });
        }
      }
    }
  }
}
