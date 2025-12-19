import { Position, Offer } from "../market/Offer";
import { Corp, CorpType } from "../corps/Corp";

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
 * Collect all offers from corps in a node
 */
export function collectNodeOffers(node: Node): Offer[] {
  const offers: Offer[] = [];
  for (const corp of node.corps) {
    offers.push(...corp.sells());
    offers.push(...corp.buys());
  }
  return offers;
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
    roi: node.roi
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
 * @returns ROI metrics
 */
export function calculateNodeROI(
  node: Node,
  peakHeight: number,
  ownedRooms: Set<string>,
  potentialCorps: PotentialCorp[] = []
): NodeROI {
  const isOwned = ownedRooms.has(node.roomName);

  // Calculate distance from nearest owned room
  let distanceFromOwned = 0;
  if (!isOwned) {
    distanceFromOwned = Infinity;
    for (const ownedRoom of ownedRooms) {
      const dist = Game.map.getRoomLinearDistance(node.roomName, ownedRoom);
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

  // Calculate final score
  // Base: raw corp ROI scaled to ~0-100 range
  let score = rawCorpROI * 50;

  // Openness bonus (peak height typically 3-12)
  score += peakHeight * 2;

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
  const roomDistance = Game.map.getRoomLinearDistance(
    position.roomName,
    node.peakPosition.roomName
  );

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
