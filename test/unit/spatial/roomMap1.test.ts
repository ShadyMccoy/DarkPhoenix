/**
 * @fileoverview Test to investigate why roomMap1.txt produces no peaks.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  createTerrainFromPattern,
  createDistanceTransform,
  findPeaks,
  filterPeaks,
  visualizeTerrain,
  visualizeDistanceMatrix,
  TERRAIN_MASK_WALL,
} from "../mock";

// Load the terrain from file
function loadTerrainFromFile(filename: string): string[] {
  const filePath = path.join(__dirname, "../../sim", filename);
  const content = fs.readFileSync(filePath, "utf-8");
  // Handle both Windows (CRLF) and Unix (LF) line endings
  return content.trim().split(/\r?\n/).map(line => line.replace(/\r$/, ""));
}

describe("roomMap1.txt investigation", () => {
  let terrain: (x: number, y: number) => number;
  let pattern: string[];

  before(() => {
    pattern = loadTerrainFromFile("roomMap1.txt");
    terrain = createTerrainFromPattern(pattern);
  });

  it("should load 50x50 terrain", () => {
    expect(pattern.length).to.equal(50);
    expect(pattern[0].length).to.equal(50);
  });

  it("should have walkable tiles", () => {
    let walkableCount = 0;
    let wallCount = 0;

    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) {
        if (terrain(x, y) === TERRAIN_MASK_WALL) {
          wallCount++;
        } else {
          walkableCount++;
        }
      }
    }

    console.log(`Walkable tiles: ${walkableCount}`);
    console.log(`Wall tiles: ${wallCount}`);

    expect(walkableCount).to.be.greaterThan(0);
  });

  it("should produce non-zero distances", () => {
    const distanceMatrix = createDistanceTransform(terrain);

    let maxDistance = 0;
    let nonZeroCount = 0;

    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) {
        const d = distanceMatrix[x][y];
        if (d > 0) {
          nonZeroCount++;
          if (d > maxDistance) {
            maxDistance = d;
          }
        }
      }
    }

    console.log(`Max distance: ${maxDistance}`);
    console.log(`Non-zero distance tiles: ${nonZeroCount}`);

    // Visualize distance matrix (sample)
    console.log("\nDistance matrix (rows 18-35, cols 0-20):");
    for (let y = 18; y <= 35; y++) {
      let row = "";
      for (let x = 0; x <= 20; x++) {
        const d = distanceMatrix[x][y];
        row += d < 10 ? d.toString() : "+";
      }
      console.log(`  ${y.toString().padStart(2)}: ${row}`);
    }

    expect(maxDistance).to.be.greaterThan(0);
  });

  it("should find peaks before filtering", () => {
    const distanceMatrix = createDistanceTransform(terrain);
    const peaks = findPeaks(distanceMatrix, terrain);

    console.log(`\nRaw peaks found: ${peaks.length}`);

    // Show top 10 peaks by height
    const sortedPeaks = [...peaks].sort((a, b) => b.height - a.height);
    console.log("Top peaks by height:");
    for (let i = 0; i < Math.min(10, sortedPeaks.length); i++) {
      const p = sortedPeaks[i];
      console.log(`  Peak ${i + 1}: center=(${p.center.x},${p.center.y}) height=${p.height} tiles=${p.tiles.length}`);
    }

    expect(peaks.length).to.be.greaterThan(0);
  });

  it("should find peaks after filtering with default options", () => {
    const distanceMatrix = createDistanceTransform(terrain);
    const peaks = findPeaks(distanceMatrix, terrain);
    const filtered = filterPeaks(peaks);

    console.log(`\nFiltered peaks (default options): ${filtered.length}`);
    for (const p of filtered) {
      console.log(`  Peak: center=(${p.center.x},${p.center.y}) height=${p.height}`);
    }

    // This is the test that might fail - let's see why
    if (filtered.length === 0 && peaks.length > 0) {
      console.log("\n!!! Peaks were filtered out !!!");
      console.log("Checking filter thresholds...");

      // The default minHeight is 2 - check if all peaks are below this
      const peaksAboveThreshold = peaks.filter(p => p.height >= 2);
      console.log(`Peaks with height >= 2: ${peaksAboveThreshold.length}`);

      const peaksAbove1 = peaks.filter(p => p.height >= 1);
      console.log(`Peaks with height >= 1: ${peaksAbove1.length}`);
    }

    expect(filtered.length).to.be.greaterThan(0);
  });

  it("should find peaks with minHeight=1", () => {
    const distanceMatrix = createDistanceTransform(terrain);
    const peaks = findPeaks(distanceMatrix, terrain);
    const filtered = filterPeaks(peaks, { minHeight: 1 });

    console.log(`\nFiltered peaks (minHeight=1): ${filtered.length}`);
    for (const p of filtered) {
      console.log(`  Peak: center=(${p.center.x},${p.center.y}) height=${p.height}`);
    }

    expect(filtered.length).to.be.greaterThan(0);
  });

  it("visualize terrain", () => {
    console.log("\nTerrain visualization:");
    console.log(visualizeTerrain(terrain));
  });
});
