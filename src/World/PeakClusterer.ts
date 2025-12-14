/**
 * Peak Clustering - Groups nearby peaks into single nodes
 *
 * Strategy: Territory Adjacency (Delaunay-inspired)
 * Two peaks are merged if:
 * 1. Their territories share a boundary/edge, OR
 * 2. Their centers are within a distance threshold (12 spaces)
 *
 * This produces a sparse, well-connected graph without redundancy.
 */

import { PeakCluster } from "./interfaces";

interface PeakData {
  tiles: RoomPosition[];
  center: RoomPosition;
  height: number;
}

export class PeakClusterer {
  /** Distance threshold for merging peaks (in spaces) */
  private static readonly MERGE_THRESHOLD = 12;

  /**
   * Cluster peaks using territory adjacency + distance heuristic.
   *
   * @param peaks - Raw peaks from RoomMap
   * @param territories - Territory map from RoomMap (peakId -> positions)
   * @returns Array of peak clusters (merged groups)
   */
  static cluster(
    peaks: PeakData[],
    territories: Map<string, RoomPosition[]>
  ): PeakCluster[] {
    const n = peaks.length;

    // Generate peak IDs based on peak center positions (same as RoomMap)
    const peakIds = peaks.map(peak =>
      `${peak.center.roomName}-${peak.center.x}-${peak.center.y}`
    );

    // Union-find data structure to track clusters
    const parent = Array.from({ length: n }, (_, i) => i);

    const find = (x: number): number => {
      if (parent[x] !== x) {
        parent[x] = find(parent[x]);
      }
      return parent[x];
    };

    const union = (x: number, y: number) => {
      x = find(x);
      y = find(y);
      if (x !== y) {
        parent[x] = y;
      }
    };

    // Test all pairs of peaks for merging
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (this.shouldMergePeaks(peaks[i], peaks[j], peakIds[i], peakIds[j], territories)) {
          union(i, j);
        }
      }
    }

    // Group peaks by their cluster root
    const clusterMap = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!clusterMap.has(root)) {
        clusterMap.set(root, []);
      }
      clusterMap.get(root)!.push(i);
    }

    // Convert clusters to peak cluster objects
    const clusters: PeakCluster[] = [];
    for (const peakIndices of clusterMap.values()) {
      clusters.push(
        this.createClusterFromPeaks(peaks, peakIndices, peakIds, territories)
      );
    }

    return clusters;
  }

  /**
   * Determine if two peaks should be merged.
   *
   * Criteria:
   * 1. Distance between centers < MERGE_THRESHOLD, OR
   * 2. Territories are adjacent (share boundary)
   */
  private static shouldMergePeaks(
    peakA: PeakData,
    peakB: PeakData,
    peakIdA: string,
    peakIdB: string,
    territories: Map<string, RoomPosition[]>
  ): boolean {
    // Check distance criterion
    const distance = peakA.center.getRangeTo(peakB.center);
    if (distance < this.MERGE_THRESHOLD) {
      return true;
    }

    // Check territory adjacency criterion
    const territoriesAreAdjacent = this.territoriesShareBoundary(
      territories.get(peakIdA),
      territories.get(peakIdB)
    );

    return territoriesAreAdjacent;
  }

  /**
   * Check if two territories share a boundary (are adjacent).
   * Two territories are adjacent if a position in one is next to a position in the other.
   */
  private static territoriesShareBoundary(
    territoryA?: RoomPosition[],
    territoryB?: RoomPosition[]
  ): boolean {
    if (!territoryA || !territoryB) {
      return false;
    }

    // Build a set of positions in B for fast lookup
    const bPositions = new Set(territoryB.map(pos => `${pos.x},${pos.y}`));

    // Check each position in A for neighbors in B
    for (const posA of territoryA) {
      // Check all 8 neighbors of posA
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;

          const neighborX = posA.x + dx;
          const neighborY = posA.y + dy;

          // Skip if out of bounds
          if (neighborX < 0 || neighborX >= 50 || neighborY < 0 || neighborY >= 50) {
            continue;
          }

          const neighborKey = `${neighborX},${neighborY}`;
          if (bPositions.has(neighborKey)) {
            return true; // Found adjacent positions
          }
        }
      }
    }

    return false;
  }

  /**
   * Create a PeakCluster from a group of merged peak indices.
   */
  private static createClusterFromPeaks(
    peaks: PeakData[],
    peakIndices: number[],
    peakIds: string[],
    territories: Map<string, RoomPosition[]>
  ): PeakCluster {
    // Merge all territory positions
    const mergedTerritory: RoomPosition[] = [];

    for (const idx of peakIndices) {
      const territory = territories.get(peakIds[idx]);
      if (territory) {
        mergedTerritory.push(...territory);
      }
    }

    // Calculate center as average of all peaks
    const avgX =
      peakIndices.reduce((sum, idx) => sum + peaks[idx].center.x, 0) /
      peakIndices.length;
    const avgY =
      peakIndices.reduce((sum, idx) => sum + peaks[idx].center.y, 0) /
      peakIndices.length;

    // Find the closest actual territory position to the calculated center
    const center = mergedTerritory.reduce((closest, pos) => {
      const distToAvg = Math.abs(pos.x - avgX) + Math.abs(pos.y - avgY);
      const closestDistToAvg =
        Math.abs(closest.x - avgX) + Math.abs(closest.y - avgY);
      return distToAvg < closestDistToAvg ? pos : closest;
    });

    // Priority based on territory size
    const priority = mergedTerritory.length;

    return {
      peakIndices,
      center,
      territory: mergedTerritory,
      priority,
    };
  }
}
