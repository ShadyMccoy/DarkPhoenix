/**
 * Graph Visualizer - Renders world graph structure to room visuals
 *
 * Provides multiple visualization modes for debugging:
 * - Node visualization: circles for each node, sized by territory
 * - Edge visualization: lines connecting nodes, colored by accessibility
 * - Territory visualization: colored regions showing sphere of influence
 * - Flow visualization: animated particles showing traffic
 * - Debug visualization: node metrics and internal state
 *
 * Use Game.getObjectById() or room memory to toggle visualization modes.
 */

import { WorldGraph, WorldNode, WorldEdge } from "./interfaces";

export interface VisualizationOptions {
  showNodes?: boolean;
  showEdges?: boolean;
  showTerritories?: boolean;
  showLabels?: boolean;
  showDebug?: boolean;
  colorScheme?: "default" | "temperature" | "terrain";
  edgeThickness?: number;
}

const DEFAULT_OPTIONS: VisualizationOptions = {
  showNodes: true,
  showEdges: true,
  showTerritories: false,
  showLabels: true,
  showDebug: false,
  colorScheme: "default",
  edgeThickness: 1,
};

export class GraphVisualizer {
  /**
   * Render the graph to a room's visuals.
   * Call each tick to update visualization.
   */
  static visualize(
    room: Room,
    graph: WorldGraph,
    options: VisualizationOptions = {}
  ): void {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Clear previous visuals
    room.visual.clear();

    if (opts.showTerritories) {
      this.visualizeTerritories(room, graph, opts);
    }

    if (opts.showNodes) {
      this.visualizeNodes(room, graph, opts);
    }

    if (opts.showEdges) {
      this.visualizeEdges(room, graph, opts);
    }

    if (opts.showDebug) {
      this.visualizeDebug(room, graph, opts);
    }
  }

  /**
   * Visualize nodes as circles, sized by territory importance.
   */
  private static visualizeNodes(
    room: Room,
    graph: WorldGraph,
    opts: VisualizationOptions
  ): void {
    const maxTerritory = Math.max(
      ...Array.from(graph.nodes.values()).map(n => n.territory.length),
      1
    );

    for (const node of graph.nodes.values()) {
      const radius = (node.territory.length / maxTerritory) * 2 + 0.5;
      const color = this.getNodeColor(node, opts.colorScheme || "default");
      const opacity =
        Math.max(0.3, Math.min(1, node.priority / 100));

      room.visual.circle(node.pos, {
        radius,
        fill: color,
        stroke: "#fff",
        strokeWidth: 0.1,
        opacity,
      });

      if (opts.showLabels) {
        // Extract node identifier
        const label = node.id.split("-").pop() || "?";
        room.visual.text(label, node.pos, {
          color: "#000",
          font: 0.5,
          align: "center",
        });
      }
    }
  }

  /**
   * Visualize edges as lines between nodes.
   */
  private static visualizeEdges(
    room: Room,
    graph: WorldGraph,
    opts: VisualizationOptions
  ): void {
    const maxDist = Math.max(
      ...Array.from(graph.edges.values()).map(e => e.distance),
      1
    );

    for (const edge of graph.edges.values()) {
      const fromNode = graph.nodes.get(edge.fromId);
      const toNode = graph.nodes.get(edge.toId);

      if (!fromNode || !toNode) continue;

      const thickness = (opts.edgeThickness || 1) *
        (edge.capacity / 10);
      const color = this.getEdgeColor(
        edge,
        opts.colorScheme || "default"
      );

      // Draw line
      room.visual.line(fromNode.pos, toNode.pos, {
        color: color,
        width: thickness,
        opacity: 0.6,
      });

      // Draw distance label at midpoint
      const midX = (fromNode.pos.x + toNode.pos.x) / 2;
      const midY = (fromNode.pos.y + toNode.pos.y) / 2;
      const label = edge.distance.toString();

      room.visual.text(label, new RoomPosition(midX, midY, room.name), {
        color,
        font: 0.3,
        align: "center",
      });
    }
  }

  /**
   * Visualize territories as colored regions.
   */
  private static visualizeTerritories(
    room: Room,
    graph: WorldGraph,
    opts: VisualizationOptions
  ): void {
    const colors = this.generateColors(graph.nodes.size);
    let colorIndex = 0;

    for (const node of graph.nodes.values()) {
      const color = colors[colorIndex % colors.length];
      colorIndex++;

      // Draw small squares for each territory position
      for (const pos of node.territory) {
        if (pos.roomName === room.name) {
          room.visual.rect(pos.x - 0.5, pos.y - 0.5, 1, 1, {
            fill: color,
            stroke: "transparent",
            opacity: 0.1,
          });
        }
      }

      // Draw territory boundary (approximately)
      if (node.territory.length > 0) {
        const boundaryPositions = this.findTerritoryBoundary(
          node.territory,
          room.name
        );
        for (let i = 0; i < boundaryPositions.length; i++) {
          const current = boundaryPositions[i];
          const next = boundaryPositions[(i + 1) % boundaryPositions.length];

          room.visual.line(current, next, {
            color: color,
            width: 0.2,
            opacity: 0.5,
          });
        }
      }
    }
  }

  /**
   * Visualize debug information for each node.
   */
  private static visualizeDebug(
    room: Room,
    graph: WorldGraph,
    opts: VisualizationOptions
  ): void {
    for (const node of graph.nodes.values()) {
      if (node.room !== room.name) continue;

      const info = [
        `ID: ${node.id.substring(0, 8)}`,
        `Deg: ${node.adjacentNodeIds.length}`,
        `Ter: ${node.territory.length}`,
        `Pri: ${node.priority}`,
      ];

      for (let i = 0; i < info.length; i++) {
        const y = node.pos.y - 1.5 + i * 0.4;
        room.visual.text(info[i], node.pos.x, y, {
          color: "#ccc",
          font: 0.3,
          align: "center",
        });
      }
    }
  }

  // ==================== Helper Methods ====================

  private static getNodeColor(
    node: WorldNode,
    scheme: string
  ): string {
    switch (scheme) {
      case "temperature":
        // Red for high priority, blue for low
        const intensity = Math.min(1, node.priority / 50);
        return `hsl(0, 100%, ${50 - intensity * 30}%)`;

      case "terrain":
        // Based on room position
        return `hsl(${(node.pos.x + node.pos.y) % 360}, 50%, 50%)`;

      default: // "default"
        return "#ffaa00";
    }
  }

  private static getEdgeColor(
    edge: WorldEdge,
    scheme: string
  ): string {
    switch (scheme) {
      case "temperature":
        // Edge color based on distance
        const hue = Math.max(0, 120 - edge.distance * 10); // Green to red
        return `hsl(${hue}, 100%, 50%)`;

      case "terrain":
        return "#888";

      default: // "default"
        return "#666";
    }
  }

  private static generateColors(count: number): string[] {
    const colors: string[] = [];
    for (let i = 0; i < count; i++) {
      const hue = (i * 360) / count;
      colors.push(`hsl(${hue}, 70%, 50%)`);
    }
    return colors;
  }

  private static findTerritoryBoundary(
    positions: RoomPosition[],
    roomName: string
  ): RoomPosition[] {
    // Return positions on the convex hull / boundary
    // For simplicity, just return a sample of boundary positions
    const inRoom = positions.filter(p => p.roomName === roomName);

    if (inRoom.length === 0) return [];
    if (inRoom.length <= 3) return inRoom;

    // Find min/max coordinates
    const xs = inRoom.map(p => p.x);
    const ys = inRoom.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // Return corners and some edge points
    const boundary: RoomPosition[] = [];

    // Top edge
    for (let x = minX; x <= maxX; x += 5) {
      const pos = inRoom.find(p => p.x === x && p.y === minY);
      if (pos) boundary.push(pos);
    }

    // Right edge
    for (let y = minY; y <= maxY; y += 5) {
      const pos = inRoom.find(p => p.x === maxX && p.y === y);
      if (pos) boundary.push(pos);
    }

    // Bottom edge
    for (let x = maxX; x >= minX; x -= 5) {
      const pos = inRoom.find(p => p.x === x && p.y === maxY);
      if (pos) boundary.push(pos);
    }

    // Left edge
    for (let y = maxY; y >= minY; y -= 5) {
      const pos = inRoom.find(p => p.x === minX && p.y === y);
      if (pos) boundary.push(pos);
    }

    return boundary.length > 0 ? boundary : [inRoom[0]];
  }
}
