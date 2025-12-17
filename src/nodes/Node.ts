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

  /** All positions in this territory */
  positions: Position[];

  /** Corps operating in this node */
  corps: Corp[];

  /** Resources available in this territory */
  resources: NodeResource[];

  /** Tick when node was created */
  createdAt: number;
}

/**
 * Serialized node state for persistence
 */
export interface SerializedNode {
  id: string;
  roomName: string;
  peakPosition: Position;
  positions: Position[];
  resources: NodeResource[];
  corpIds: string[];
  createdAt: number;
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
  positions: Position[] = [],
  currentTick: number = 0
): Node {
  return {
    id,
    roomName,
    peakPosition,
    positions,
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
    positions: node.positions,
    resources: node.resources,
    corpIds: node.corps.map((c) => c.id),
    createdAt: node.createdAt
  };
}

/**
 * Check if a position is within a node's territory
 */
export function isPositionInNode(node: Node, position: Position): boolean {
  if (position.roomName !== node.roomName) return false;

  return node.positions.some(
    (p) => p.x === position.x && p.y === position.y
  );
}

/**
 * Calculate the distance from a position to the node's peak
 */
export function distanceToPeak(node: Node, position: Position): number {
  if (position.roomName !== node.roomName) return Infinity;

  return (
    Math.abs(position.x - node.peakPosition.x) +
    Math.abs(position.y - node.peakPosition.y)
  );
}
