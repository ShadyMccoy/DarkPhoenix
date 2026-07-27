/**
 * @fileoverview Spatial telemetry writers - segments 1 (nodes) and 2 (edges).
 *
 * Charter: the node-graph export family. Both segments project the SAME
 * colony node list in the SAME order (owned first, then ROI score descending -
 * the shared sort is the coupling that makes them one module): segment 1
 * carries the compact per-node data (territories, resources, expansion
 * scoring), segment 2 the spatial adjacency as index pairs into that order.
 * The emitted bytes are a frozen external contract (versioned; an external
 * app parses them) - field order and version numbers never change in a
 * refactor.
 *
 * Layer: telemetry writer (Game/Memory-coupled; writes RawMemory segments 1-2).
 *
 * @module telemetry/spatialSegments
 */

import { Colony } from "../colony/Colony";
import { TELEMETRY_SEGMENTS } from "./segmentIds";

/**
 * Node telemetry data structure (Segment 1).
 * Uses compact keys to minimize size:
 * - id, r=roomName, p=peakPosition, t=territorySize
 * - res=resources, roi, spans=spansRooms
 */
export interface NodeTelemetry {
  version: number;
  tick: number;
  nodes: {
    id: string;
    r: string; // roomName
    p: { x: number; y: number; r: string }; // peakPosition
    t: number; // territorySize
    res: {
      // resources (compact)
      t: string; // type
      x: number;
      y: number;
    }[];
    roi?: {
      s: number; // score
      e: number; // expansionScore
      o: number; // openness
      d: number; // distanceFromOwned
      own: boolean; // isOwned
      src: number; // sourceCount
      ctrl: boolean; // hasController
    };
    spans: string[]; // spansRooms
    econ?: boolean; // is part of economic network (has corps)
    sp?: number; // number of spawn structures in this node's room
  }[];
  summary: {
    totalNodes: number;
    ownedNodes: number;
    expansionCandidates: number;
    totalSources: number;
    avgROI: number;
  };
}

/**
 * Edges telemetry data structure (Segment 2).
 * Uses compressed numeric format to minimize size:
 * - nodeIndex maps node position in nodes array to node ID
 * - edges are [idx1, idx2] pairs (indices into nodeIndex)
 */
export interface EdgesTelemetry {
  version: number;
  tick: number;
  /** Node IDs in index order - position = index for edge references */
  nodeIndex: string[];
  /** Spatial edges as [idx1, idx2] pairs (indices into nodeIndex) */
  edges: [number, number][];
  /** Retired with the node-graph pipeline - always empty (shape kept for
   * dashboard consumers). */
  economicEdges: [number, number, number, number?][];
}

/**
 * Updates nodes telemetry (Segment 1).
 * Uses compact keys to fit more nodes in the 100KB segment limit.
 */
export function updateNodesTelemetry(colony: Colony | undefined): void {
  const nodes = colony?.getNodes() || [];

  // Calculate summary stats from full node list
  const ownedNodes = nodes.filter(n => n.roi?.isOwned).length;
  const expansionCandidates = nodes.filter(n => !n.roi?.isOwned && (n.roi?.score || 0) > 0).length;
  const totalSources = nodes.reduce((sum, n) => sum + (n.roi?.sourceCount || 0), 0);
  const avgROI = nodes.length > 0 ? nodes.reduce((sum, n) => sum + (n.roi?.score || 0), 0) / nodes.length : 0;

  // Sort nodes: owned first, then by ROI score descending
  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.roi?.isOwned && !b.roi?.isOwned) return -1;
    if (!a.roi?.isOwned && b.roi?.isOwned) return 1;
    return (b.roi?.score || 0) - (a.roi?.score || 0);
  });

  // Count spawn structures per room
  const spawnCountsByRoom: { [roomName: string]: number } = {};
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      const spawns = room.find(FIND_MY_SPAWNS);
      if (spawns.length > 0) {
        spawnCountsByRoom[roomName] = spawns.length;
      }
    }
  }

  // Build compact node data
  const nodeData: NodeTelemetry["nodes"] = sortedNodes.map(node => ({
    id: node.id,
    r: node.roomName,
    p: { x: node.peakPosition.x, y: node.peakPosition.y, r: node.peakPosition.roomName },
    t: node.territorySize,
    res: node.resources.map(r => ({
      t: r.type,
      x: r.position.x,
      y: r.position.y
    })),
    roi: node.roi
      ? {
          s: node.roi.score,
          e: node.roi.expansionScore,
          o: node.roi.openness,
          d: node.roi.distanceFromOwned,
          own: node.roi.isOwned,
          src: node.roi.sourceCount,
          ctrl: node.roi.hasController
        }
      : undefined,
    spans: node.spansRooms,
    sp: spawnCountsByRoom[node.roomName] || undefined
  }));

  const telemetry: NodeTelemetry = {
    version: 5, // Version 5: edges moved to segment 2
    tick: Game.time,
    nodes: nodeData,
    summary: {
      totalNodes: nodes.length,
      ownedNodes,
      expansionCandidates,
      totalSources,
      avgROI
    }
  };

  const json = JSON.stringify(telemetry);
  if (json.length > 100000) {
    console.log(`[Telemetry] Warning: Node segment ${json.length} bytes exceeds 100KB limit`);
  }
  RawMemory.segments[TELEMETRY_SEGMENTS.NODES] = json;
}

/**
 * Updates edges telemetry (Segment 2).
 * Uses compressed numeric format: edges as index pairs instead of string IDs.
 */
export function updateEdgesTelemetry(colony: Colony | undefined): void {
  const nodes = colony?.getNodes() || [];

  // Build node ID to index map (sorted same as nodes telemetry)
  const sortedNodes = [...nodes].sort((a, b) => {
    if (a.roi?.isOwned && !b.roi?.isOwned) return -1;
    if (!a.roi?.isOwned && b.roi?.isOwned) return 1;
    return (b.roi?.score || 0) - (a.roi?.score || 0);
  });

  const nodeIdToIndex = new Map<string, number>();
  const nodeIndex: string[] = [];
  sortedNodes.forEach((node, idx) => {
    nodeIdToIndex.set(node.id, idx);
    nodeIndex.push(node.id);
  });

  // Convert spatial edges to index pairs
  const edges: [number, number][] = [];
  for (const edge of Memory.nodeEdges || []) {
    const [id1, id2] = edge.split("|");
    const idx1 = nodeIdToIndex.get(id1);
    const idx2 = nodeIdToIndex.get(id2);
    if (idx1 !== undefined && idx2 !== undefined) {
      edges.push([idx1, idx2]);
    }
  }

  // Economic edges retired with the deleted node-graph pipeline; the segment
  // keeps the field (empty) so dashboard consumers see a valid shape.
  const economicEdges: [number, number, number, number?][] = [];

  const telemetry: EdgesTelemetry = {
    version: 2,
    tick: Game.time,
    nodeIndex,
    edges,
    economicEdges
  };

  const json = JSON.stringify(telemetry);
  if (json.length > 100000) {
    console.log(`[Telemetry] Warning: Edges segment ${json.length} bytes exceeds 100KB limit`);
  }
  RawMemory.segments[TELEMETRY_SEGMENTS.EDGES] = json;
}
