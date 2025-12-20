/**
 * @fileoverview Visualization rendering for the colony.
 *
 * This module handles all RoomVisual rendering for nodes and spatial analysis.
 * Visualization is non-critical for game logic and can be disabled without
 * affecting colony operation.
 *
 * @module execution/Visualization
 */

import { Colony } from "../colony";
import { visualizeMultiRoomAnalysis, MultiRoomAnalysisResult } from "../spatial";

/**
 * Renders node visualization in rooms with vision.
 * Draws nodes at their peak positions and connections for cross-room nodes.
 */
export function renderNodeVisuals(colony: Colony): void {
  const nodes = colony.getNodes();

  for (const node of nodes) {
    const roomName = node.peakPosition.roomName;
    // RoomVisual works without vision - no need to check Game.rooms
    const visual = new RoomVisual(roomName);
    const peak = node.peakPosition;
    const isOwned = node.roi?.isOwned;

    // Draw node circle at peak position
    const radius = Math.min(2, Math.max(0.8, (node.roi?.openness || 5) / 5));
    visual.circle(peak.x, peak.y, {
      radius,
      fill: isOwned ? "#60a5fa" : "#facc15",
      opacity: 0.6,
      stroke: isOwned ? "#3b82f6" : "#eab308",
      strokeWidth: 0.1,
    });

    // Draw source count in node
    const sourceCount = node.roi?.sourceCount || 0;
    visual.text(String(sourceCount), peak.x, peak.y + 0.15, {
      font: "bold 0.6 sans-serif",
      color: "#ffffff",
      align: "center",
    });

    // Draw controller indicator (small diamond above node)
    if (node.roi?.hasController) {
      visual.poly([
        [peak.x, peak.y - radius - 0.4],
        [peak.x + 0.3, peak.y - radius - 0.7],
        [peak.x, peak.y - radius - 1.0],
        [peak.x - 0.3, peak.y - radius - 0.7],
      ], {
        fill: "#e94560",
        opacity: 0.8,
      });
    }

    // Draw dashed lines to other rooms this node spans
    if (node.spansRooms.length > 1) {
      for (const spanRoom of node.spansRooms) {
        if (spanRoom === roomName) continue;

        // Find exit direction to target room and draw line toward it
        const exits = Game.map.describeExits(roomName);
        for (const [dir, exitRoom] of Object.entries(exits || {})) {
          if (exitRoom === spanRoom) {
            let targetX = peak.x;
            let targetY = peak.y;
            if (dir === "1") targetY = 0; // TOP
            if (dir === "3") targetX = 49; // RIGHT
            if (dir === "5") targetY = 49; // BOTTOM
            if (dir === "7") targetX = 0; // LEFT

            visual.line(peak.x, peak.y, targetX, targetY, {
              color: "#4a4a6e",
              width: 0.1,
              opacity: 0.5,
              lineStyle: "dashed",
            });
          }
        }
      }
    }
  }
}

/**
 * Renders spatial visualization (edges between peaks) for rooms.
 * Draws for all rooms in the analysis (owned rooms + nearby rooms).
 */
export function renderSpatialVisuals(analysisCache: { result: MultiRoomAnalysisResult } | null): void {
  if (!analysisCache) return;

  // Get all unique room names from the analysis
  const roomsInAnalysis = new Set<string>();
  for (const peak of analysisCache.result.peaks) {
    roomsInAnalysis.add(peak.roomName);
  }

  for (const roomName of roomsInAnalysis) {
    // Skip peaks since renderNodeVisuals draws colony nodes with ownership styling
    visualizeMultiRoomAnalysis(roomName, analysisCache.result, false, true);
  }
}
