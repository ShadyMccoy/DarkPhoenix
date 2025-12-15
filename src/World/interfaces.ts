/**
 * World Graph System - Core Data Structures
 *
 * This system represents the game world as a room-agnostic graph of nodes and edges.
 * Nodes represent territories (clusters of peaks).
 * Edges represent adjacency between territories.
 * The graph is independent of room boundaries.
 */

/**
 * Represents a node in the world graph.
 * A node corresponds to a territory or cluster of peaks.
 * Its "capital" position is just the center of influence.
 */
export interface WorldNode {
  /** Unique identifier for this node */
  id: string;

  /** Primary position (center of territory) */
  pos: RoomPosition;

  /** Room name where the primary position is located */
  room: string;

  /** All room positions that belong to this node's territory */
  territory: RoomPosition[];

  /** IDs of adjacent nodes (will be populated by edge builder) */
  adjacentNodeIds: string[];

  /** When this node was created */
  createdAt: number;

  /** Index of the peaks that were merged into this node */
  peakIndices: number[];

  /** Priority/importance of this node (higher = more important) */
  priority: number;
}

/**
 * Represents an edge between two nodes in the world graph.
 * An edge exists when two node territories are adjacent.
 */
export interface WorldEdge {
  /** Unique canonical identifier (always "id1-id2" where id1 < id2) */
  id: string;

  /** Source node ID */
  fromId: string;

  /** Target node ID */
  toId: string;

  /** Distance between node centers (in room position spaces) */
  distance: number;

  /** Expected throughput capacity (arbitrary units for now) */
  capacity: number;
}

/**
 * The complete world graph structure.
 * Room-atheist representation of all nodes and their connections.
 */
export interface WorldGraph {
  /** All nodes indexed by ID */
  nodes: Map<string, WorldNode>;

  /** All edges indexed by ID */
  edges: Map<string, WorldEdge>;

  /** Quick lookup: for each node, list of edge IDs it participates in */
  edgesByNode: Map<string, string[]>;

  /** Timestamp when graph was created/updated */
  timestamp: number;

  /** Version number (increment on structural changes) */
  version: number;
}

/**
 * Result of clustering peaks for analysis.
 * Maps each merged cluster to its constituent peaks.
 */
export interface PeakCluster {
  /** Indices of peaks in this cluster */
  peakIndices: number[];

  /** Merged peak data (representative center) */
  center: RoomPosition;

  /** Combined territory (all positions from merged peaks) */
  territory: RoomPosition[];

  /** Priority based on cluster size/importance */
  priority: number;
}

/**
 * Intermediate data structure for graph construction.
 * Represents the raw output of RoomMap before clustering.
 */
export interface RoomMapSnapshot {
  /** Room name */
  room: string;

  /** Raw peaks from RoomMap.getPeaks() */
  peaks: Array<{
    tiles: RoomPosition[];
    center: RoomPosition;
    height: number;
  }>;

  /** Territory map from RoomMap */
  territories: Map<string, RoomPosition[]>;

  /** Distance transform grid (for analysis) */
  distanceGrid?: number[][];

  /** Timestamp when snapshot was taken */
  timestamp: number;
}
