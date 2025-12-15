/**
 * Node Builder - Creates WorldNode objects from peak clusters
 */

import { WorldNode } from "./interfaces";
import { PeakCluster } from "./interfaces";

export class NodeBuilder {
  /**
   * Create WorldNode objects from clustered peaks.
   *
   * @param clusters - Peak clusters from PeakClusterer
   * @param roomName - Name of the room being processed
   * @returns Map of node ID to WorldNode
   */
  static buildNodes(
    clusters: PeakCluster[],
    roomName: string
  ): Map<string, WorldNode> {
    const nodes = new Map<string, WorldNode>();
    const timestamp = Game.time;

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const nodeId = this.generateNodeId(roomName, i);

      const node: WorldNode = {
        id: nodeId,
        pos: cluster.center,
        room: roomName,
        territory: cluster.territory,
        adjacentNodeIds: [], // Will be populated by EdgeBuilder
        createdAt: timestamp,
        peakIndices: cluster.peakIndices,
        priority: cluster.priority,
      };

      nodes.set(nodeId, node);
    }

    return nodes;
  }

  /**
   * Generate a canonical node ID.
   * Format: "roomName-cluster-{index}"
   */
  static generateNodeId(roomName: string, clusterIndex: number): string {
    return `${roomName}-cluster-${clusterIndex}`;
  }

  /**
   * Generate a node ID from a position (for testing/debugging).
   */
  static generateNodeIdFromPosition(room: string, pos: RoomPosition): string {
    return `${room}-node-${pos.x}-${pos.y}`;
  }
}
