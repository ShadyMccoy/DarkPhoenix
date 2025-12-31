import { Position } from "../types/Position";
import { Corp, CorpType } from "../corps/Corp";

// Declare Game for environments where @types/screeps is not available
declare const Game: {
  map: {
    getRoomLinearDistance(roomA: string, roomB: string): number;
  };
  rooms: { [roomName: string]: Room | undefined };
} | undefined;

/**
 * Estimate room distance for test environments where Game object is unavailable.
 * Parses room names like "W1N1" and calculates Manhattan distance.
 */
function estimateRoomDistance(roomA: string, roomB: string): number {
  const parseRoom = (name: string): { x: number; y: number } | null => {
    const match = name.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return null;
    const x = match[1] === "W" ? -parseInt(match[2]) : parseInt(match[2]);
    const y = match[3] === "N" ? -parseInt(match[4]) : parseInt(match[4]);
    return { x, y };
  };

  const a = parseRoom(roomA);
  const b = parseRoom(roomB);
  if (!a || !b) return Infinity;

  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Types of resources that can exist in a node
 */
export type NodeResourceType =
  | "source"
  | "controller"
  | "mineral"
  | "spawn"
  | "storage"
  | "container";

/**
 * A resource within a node territory
 */
export interface NodeResource {
  /** Type of resource */
  type: NodeResourceType;
  /** Game object ID */
  id: string;
  /** Position of the resource */
  position: Position;
  /** Resource-specific capacity (e.g., energy per regen for sources) */
  capacity?: number;
  /** Level (e.g., RCL for controller) */
  level?: number;
  /** Mineral type if applicable */
  mineralType?: string;
  /** Whether this resource is owned by us (for controllers) */
  isOwned?: boolean;
}

/**
 * A potential corp that could be created in a node
 */
export interface PotentialCorp {
  /** Type of corp that could be created */
  type: CorpType;
  /** Resource this corp would use */
  resource: NodeResource;
  /** Estimated ROI for this corp */
  estimatedROI: number;
  /** Position where the corp would operate */
  position: Position;
  /** Additional config for corp creation */
  config?: Record<string, unknown>;
}

/**
 * Information about a reachable source from an adjacent node.
 * Used to calculate expansion scores.
 */
export interface ReachableSource {
  /** Source capacity (energy per regen cycle) */
  capacity: number;
  /** Distance from the target node's peak to this source */
  distance: number;
}

/**
 * Potential corp ROI summary for a node.
 */
export interface PotentialCorpROI {
  /** Corp type */
  type: CorpType;
  /** Estimated ROI for this corp */
  estimatedROI: number;
  /** Resource this corp would use */
  resourceId: string;
}

/**
 * ROI metrics for a node - used to evaluate expansion potential.
 * ROI is calculated by surveying what corps could operate in this node.
 */
export interface NodeROI {
  /** Overall ROI score (sum of potential corps' ROI, adjusted for distance) */
  score: number;

  /**
   * Expansion score - ROI if we claimed this room and built a spawn here.
   * This is the score without distance penalty, plus owned bonus.
   * Use this to evaluate whether a room is worth expanding to.
   */
  expansionScore: number;

  /** Total estimated ROI from all potential corps (before distance adjustment) */
  rawCorpROI: number;

  /** Potential corps that could operate in this node */
  potentialCorps: PotentialCorpROI[];

  /** Peak height - indicates buildable space */
  openness: number;

  /** Distance from nearest owned room (in rooms, 0 = owned) */
  distanceFromOwned: number;

  /** Whether this node is in an owned room */
  isOwned: boolean;

  /** Number of sources in/near this territory */
  sourceCount: number;

  /** Whether there's a controller in this territory */
  hasController: boolean;
}

/**
 * Node represents a territory-based spatial region.
 * Nodes are derived from peak detection in the spatial system.
 *
 * A room may contain multiple nodes (one per territory peak).
 * Corps operate within nodes and compete for resources.
 */
export interface Node {
  /** Unique identifier (e.g., "W1N1-25-30" for room-x-y of peak) */
  id: string;

  /** Room name where this node exists */
  roomName: string;

  /** Peak position (center of territory) */
  peakPosition: Position;

  /** Number of tiles in this territory */
  territorySize: number;

  /** Room names this territory spans */
  spansRooms: string[];

  /** Corps operating in this node */
  corps: Corp[];

  /** Resources available in this territory */
  resources: NodeResource[];

  /** Tick when node was created */
  createdAt: number;

  /** ROI metrics for expansion planning */
  roi?: NodeROI;

  /**
   * Optimal position for hauler pickup/delivery within this node.
   * Calculated as the position with minimum average walking distance
   * to all sources and sinks (containers, storage, spawns) in the node.
   * Used by haulers when pathing between nodes.
   */
  haulerDeliveryPos?: Position;
}

/**
 * Serialized node state for persistence
 */
export interface SerializedNode {
  id: string;
  roomName: string;
  peakPosition: Position;
  territorySize: number;
  spansRooms: string[];
  resources: NodeResource[];
  corpIds: string[];
  createdAt: number;
  roi?: NodeROI;
  haulerDeliveryPos?: Position;
}

/**
 * Create a node ID from room name and peak position
 */
export function createNodeId(roomName: string, peakPosition: Position): string {
  return `${roomName}-${peakPosition.x}-${peakPosition.y}`;
}

/**
 * Create an empty node
 */
export function createNode(
  id: string,
  roomName: string,
  peakPosition: Position,
  territorySize: number = 0,
  spansRooms: string[] = [],
  currentTick: number = 0
): Node {
  return {
    id,
    roomName,
    peakPosition,
    territorySize,
    spansRooms: spansRooms.length > 0 ? spansRooms : [roomName],
    corps: [],
    resources: [],
    createdAt: currentTick
  };
}

/**
 * Get corps of a specific type from a node
 */
export function getCorpsByType(node: Node, type: CorpType): Corp[] {
  return node.corps.filter((corp) => corp.type === type);
}

/**
 * Get resources of a specific type from a node
 */
export function getResourcesByType(
  node: Node,
  type: NodeResourceType
): NodeResource[] {
  return node.resources.filter((resource) => resource.type === type);
}

/**
 * Check if a node has a specific resource type
 */
export function hasResourceType(node: Node, type: NodeResourceType): boolean {
  return node.resources.some((resource) => resource.type === type);
}

/**
 * Check if a node has a corp for a specific resource
 */
export function hasCorpForResource(node: Node, resourceId: string): boolean {
  // Corps would need to track their resource IDs for this to work
  // For now, check by type matching
  return node.corps.length > 0;
}

/**
 * Calculate total balance of all corps in a node
 */
export function getTotalBalance(node: Node): number {
  return node.corps.reduce((sum, corp) => sum + corp.balance, 0);
}

/**
 * Get active corps in a node
 */
export function getActiveCorps(node: Node): Corp[] {
  return node.corps.filter((corp) => corp.isActive);
}

/**
 * Prune dead corps from a node
 * Returns the pruned corps
 */
export function pruneDead(node: Node, currentTick: number, gracePeriod: number = 1500): Corp[] {
  const pruned: Corp[] = [];

  node.corps = node.corps.filter((corp) => {
    // Keep if has positive balance
    if (corp.balance > 10) return true;

    // Keep if active in a chain
    if (corp.isActive) return true;

    // Grace period for new corps
    const age = currentTick - corp.createdAt;
    if (age < gracePeriod) return true;

    // Prune this corp
    pruned.push(corp);
    return false;
  });

  return pruned;
}

/**
 * Serialize a node for persistence
 */
export function serializeNode(node: Node): SerializedNode {
  return {
    id: node.id,
    roomName: node.roomName,
    peakPosition: node.peakPosition,
    territorySize: node.territorySize,
    spansRooms: node.spansRooms,
    resources: node.resources,
    corpIds: node.corps.map((c) => c.id),
    createdAt: node.createdAt,
    roi: node.roi,
    haulerDeliveryPos: node.haulerDeliveryPos,
  };
}

/**
 * Deserialize a node from persistence.
 * Note: Corps are not restored here - they are managed separately.
 */
export function deserializeNode(data: SerializedNode): Node {
  return {
    id: data.id,
    roomName: data.roomName,
    peakPosition: data.peakPosition,
    territorySize: data.territorySize,
    spansRooms: data.spansRooms,
    corps: [], // Corps are restored separately
    resources: data.resources,
    createdAt: data.createdAt,
    roi: data.roi,
    haulerDeliveryPos: data.haulerDeliveryPos,
  };
}

/**
 * Calculate ROI metrics for a node based on potential corps.
 *
 * The ROI is calculated by surveying what corps could operate in this node
 * and summing their estimated ROI. Distance from owned rooms applies a
 * logistics penalty to the score.
 *
 * @param node - The node to calculate ROI for
 * @param peakHeight - The peak height from spatial analysis
 * @param ownedRooms - Set of owned room names for distance calculation
 * @param potentialCorps - Potential corps from NodeSurveyor (optional, for pre-computed survey)
 * @param reachableSources - Sources from adjacent nodes that could be mined if we expand here
 * @returns ROI metrics
 */
export function calculateNodeROI(
  node: Node,
  peakHeight: number,
  ownedRooms: Set<string>,
  potentialCorps: PotentialCorp[] = [],
  reachableSources: ReachableSource[] = []
): NodeROI {
  const isOwned = ownedRooms.has(node.roomName);

  // Calculate distance from nearest owned room
  let distanceFromOwned = 0;
  if (!isOwned) {
    distanceFromOwned = Infinity;
    for (const ownedRoom of ownedRooms) {
      const dist = typeof Game !== "undefined"
        ? Game.map.getRoomLinearDistance(node.roomName, ownedRoom)
        : estimateRoomDistance(node.roomName, ownedRoom);
      if (dist < distanceFromOwned) {
        distanceFromOwned = dist;
      }
    }
  }

  // Count sources from node resources
  const sourceCount = node.resources.filter(r => r.type === "source").length;

  // Check for controller
  const hasController = node.resources.some(r => r.type === "controller");

  // Build potential corps ROI summary
  const potentialCorpROIs: PotentialCorpROI[] = potentialCorps.map(pc => ({
    type: pc.type,
    estimatedROI: pc.estimatedROI,
    resourceId: pc.resource.id
  }));

  // Raw ROI is sum of all potential corps' estimated ROI
  // Each corp's ROI is typically 0.1-2.0 range, so we scale it up for readability
  const rawCorpROI = potentialCorps.reduce((sum, pc) => sum + pc.estimatedROI, 0);

  // Calculate base score (before distance and ownership adjustments)
  // Base: raw corp ROI scaled to ~0-100 range + openness bonus
  const baseScore = rawCorpROI * 50 + peakHeight * 2;

  // Calculate expansion score: what would the ROI be if we claimed this room?
  // This includes:
  // 1. Local sources (baseScore without distance penalty)
  // 2. Nearby sources from adjacent nodes that could be mined with haulers
  // 3. Owned bonus (we'd have infrastructure)
  let expansionScore = baseScore + 25; // Base + owned bonus

  // Add value from reachable sources in adjacent nodes
  // Each reachable source contributes mining value minus hauling cost
  for (const source of reachableSources) {
    // Mining value: ~10 energy/tick from a source (3000 capacity / 300 regen)
    const energyPerTick = source.capacity / 300;

    // Hauling efficiency decreases with distance
    // At 50 tiles (adjacent room), efficiency ~60%
    // At 100 tiles (2 rooms away), efficiency ~30%
    const haulingEfficiency = Math.max(0.1, 1 - source.distance / 150);

    // Net value per tick, scaled similar to mining corps
    const netValue = energyPerTick * haulingEfficiency * 0.01; // energyValue = 0.01

    // Scale to match our ROI scoring (50x multiplier)
    expansionScore += netValue * 50;
  }

  expansionScore = Math.max(0, expansionScore);

  // Calculate final score (current value based on distance)
  let score = baseScore;

  // Distance penalty - logistics cost increases with distance
  // Each room away reduces value significantly
  if (!isOwned && distanceFromOwned !== Infinity) {
    // Logistics penalty: 20% reduction per room away
    const logisticsPenalty = Math.pow(0.8, distanceFromOwned);
    score *= logisticsPenalty;
  }

  // Owned rooms get a bonus (already have infrastructure)
  if (isOwned) {
    score += 25;
  }

  // Floor at 0
  score = Math.max(0, score);

  return {
    score,
    expansionScore,
    rawCorpROI,
    potentialCorps: potentialCorpROIs,
    openness: peakHeight,
    distanceFromOwned,
    isOwned,
    sourceCount,
    hasController
  };
}

/**
 * Calculate the distance from a position to the node's peak.
 * Supports cross-room positions using room coordinate math.
 */
export function distanceToPeak(node: Node, position: Position): number {
  if (position.roomName === node.peakPosition.roomName) {
    // Same room - simple Manhattan distance
    return (
      Math.abs(position.x - node.peakPosition.x) +
      Math.abs(position.y - node.peakPosition.y)
    );
  }

  // Cross-room distance estimation using linear distance
  // This is approximate but good enough for territory decisions
  const roomDistance = typeof Game !== "undefined"
    ? Game.map.getRoomLinearDistance(position.roomName, node.peakPosition.roomName)
    : estimateRoomDistance(position.roomName, node.peakPosition.roomName);

  if (roomDistance === undefined || roomDistance === null) {
    return Infinity;
  }

  // Estimate: room distance * 50 (room width) + in-room offset
  // This gives a reasonable approximation for sorting purposes
  return roomDistance * 50 + Math.abs(position.x - node.peakPosition.x) + Math.abs(position.y - node.peakPosition.y);
}

/**
 * Get all unique room names that a node's territory spans.
 */
export function getNodeRooms(node: Node): string[] {
  return node.spansRooms;
}

/**
 * Calculate the optimal hauler delivery position for a node.
 *
 * This finds the position with minimum average walking distance to all
 * sources and sinks within the node. Tests candidate positions and
 * selects the one with best average accessibility.
 *
 * Sources/sinks considered:
 * - Sources (energy sources)
 * - Containers
 * - Storage
 * - Spawns
 *
 * @param node - The node to calculate delivery position for
 * @param room - The room object (required for pathfinding)
 * @returns The optimal position, or peakPosition if calculation fails
 */
export function calculateHaulerDeliveryPos(node: Node, room: Room): Position {
  // Get all relevant resource positions
  const targetPositions: Position[] = [];

  for (const resource of node.resources) {
    if (
      resource.type === "source" ||
      resource.type === "container" ||
      resource.type === "storage" ||
      resource.type === "spawn"
    ) {
      targetPositions.push(resource.position);
    }
  }

  // If no targets, use peak position
  if (targetPositions.length === 0) {
    return node.peakPosition;
  }

  // If only one target, return that position
  if (targetPositions.length === 1) {
    return targetPositions[0];
  }

  // Calculate centroid as starting point
  let sumX = 0;
  let sumY = 0;
  for (const pos of targetPositions) {
    sumX += pos.x;
    sumY += pos.y;
  }
  const centroidX = Math.round(sumX / targetPositions.length);
  const centroidY = Math.round(sumY / targetPositions.length);

  // Test positions in a grid around the centroid
  // Search radius based on territory size
  const searchRadius = Math.min(5, Math.ceil(Math.sqrt(node.territorySize) / 3));

  let bestPos: Position = { x: centroidX, y: centroidY, roomName: node.roomName };
  let bestScore = Infinity;

  // Get terrain for walkability check
  const terrain = room.getTerrain();

  for (let dx = -searchRadius; dx <= searchRadius; dx++) {
    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
      const testX = centroidX + dx;
      const testY = centroidY + dy;

      // Skip out of bounds
      if (testX < 1 || testX > 48 || testY < 1 || testY > 48) continue;

      // Skip walls
      if (terrain.get(testX, testY) === TERRAIN_MASK_WALL) continue;

      // Calculate total walking distance to all targets
      // Use Chebyshev distance (8-directional movement)
      let totalDistance = 0;
      for (const target of targetPositions) {
        if (target.roomName === node.roomName) {
          // Same room - Chebyshev distance
          totalDistance += Math.max(
            Math.abs(testX - target.x),
            Math.abs(testY - target.y)
          );
        } else {
          // Different room - add room crossing penalty
          totalDistance += 50 + Math.max(
            Math.abs(testX - target.x),
            Math.abs(testY - target.y)
          );
        }
      }

      // Average distance
      const avgDistance = totalDistance / targetPositions.length;

      if (avgDistance < bestScore) {
        bestScore = avgDistance;
        bestPos = { x: testX, y: testY, roomName: node.roomName };
      }
    }
  }

  return bestPos;
}

/**
 * Update the hauler delivery position for a node.
 * Should be called when node resources change (during planning phase).
 *
 * @param node - The node to update
 * @param room - The room object (optional, will lookup if not provided)
 */
export function updateHaulerDeliveryPos(node: Node, room?: Room): void {
  // Get room if not provided
  const targetRoom = room ?? (typeof Game !== "undefined" ? Game.rooms[node.roomName] : undefined);

  if (!targetRoom) {
    // No vision of room, use centroid of resources as fallback
    const positions = node.resources
      .filter(r => r.type === "source" || r.type === "container" || r.type === "storage" || r.type === "spawn")
      .map(r => r.position);

    if (positions.length === 0) {
      node.haulerDeliveryPos = node.peakPosition;
      return;
    }

    let sumX = 0;
    let sumY = 0;
    for (const pos of positions) {
      sumX += pos.x;
      sumY += pos.y;
    }
    node.haulerDeliveryPos = {
      x: Math.round(sumX / positions.length),
      y: Math.round(sumY / positions.length),
      roomName: node.roomName,
    };
    return;
  }

  node.haulerDeliveryPos = calculateHaulerDeliveryPos(node, targetRoom);
}
