# Spatial Analysis System

This document describes the RoomMap spatial analysis system used for colony planning.

## Overview

The spatial system analyzes room terrain to identify optimal locations and creates the foundation for flow-based resource allocation.

**Key outputs used by MFMC:**
- **Peaks** → Become territory centers (Nodes)
- **Territories** → Define Node boundaries for FlowGraph
- **Distance metrics** → Feed into FlowEdge cost calculations

The system identifies optimal locations for:

- Base placement
- Extension clusters
- Tower positioning
- Road networks
- Defense perimeters

## Core Concepts

### Distance Transform

A distance transform calculates how far each tile is from walls.

**Traditional**: Higher values = farther from walls
**Inverted** (our approach): Higher values = more open space

```
Wall Distance → Invert → Distance Transform
     0            HIGH        PEAKS = OPEN
   (walls)        (walls)     (building zones)
```

### Peaks

Peaks are local maxima in the inverted distance transform.

- Represent centers of open areas
- Higher peaks = larger open areas
- Ideal for base placement

### Territories

The room is divided into territories using BFS from peaks.

- Each tile belongs to nearest peak
- Enables zone-based management
- Supports distributed operations

## Algorithms

### 1. Distance Transform Algorithm

```typescript
function createDistanceTransform(room: Room): number[][] {
  // Initialize: walls = 0, others = Infinity
  for (let x = 0; x < 50; x++) {
    for (let y = 0; y < 50; y++) {
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
        grid[x][y] = 0;
        queue.push({ x, y, distance: 0 });
      } else {
        grid[x][y] = Infinity;
      }
    }
  }

  // BFS propagation (8-directional)
  while (queue.length > 0) {
    const { x, y, distance } = queue.shift();
    for (const neighbor of neighbors) {
      const newDistance = distance + 1;
      if (newDistance < grid[nx][ny]) {
        grid[nx][ny] = newDistance;
        queue.push({ x: nx, y: ny, distance: newDistance });
        highestDistance = Math.max(highestDistance, newDistance);
      }
    }
  }

  // Invert: open areas become peaks
  for (let x = 0; x < 50; x++) {
    for (let y = 0; y < 50; y++) {
      if (grid[x][y] !== Infinity && grid[x][y] !== 0) {
        grid[x][y] = 1 + highestDistance - grid[x][y];
      }
    }
  }

  return grid;
}
```

**Complexity**: O(n) where n = room tiles (2500)

### 2. Peak Detection Algorithm

```typescript
function findPeaks(distanceMatrix: number[][], room: Room): Peak[] {
  const peaks: Peak[] = [];
  const visited = new Set<string>();

  // Collect and sort tiles by height (highest first)
  const tiles = collectNonWallTiles(distanceMatrix);
  tiles.sort((a, b) => b.height - a.height);

  while (tiles.length > 0) {
    const tile = tiles.shift();
    if (visited.has(key(tile))) continue;

    // BFS to find connected tiles at same height (plateau)
    const cluster = [];
    const queue = [tile];

    while (queue.length > 0) {
      const current = queue.pop();
      if (visited.has(key(current))) continue;
      if (distanceMatrix[current.x][current.y] !== tile.height) continue;

      visited.add(key(current));
      cluster.push(current);

      // Add 4-connected neighbors
      queue.push(...getNeighbors(current));
    }

    if (cluster.length > 0) {
      peaks.push({
        tiles: cluster.map(t => new RoomPosition(t.x, t.y, room.name)),
        center: calculateCentroid(cluster),
        height: tile.height
      });
    }
  }

  return peaks;
}
```

**Complexity**: O(n) where n = room tiles

### 3. Peak Filtering Algorithm

```typescript
function filterPeaks(peaks: Peak[]): Peak[] {
  // Sort by height descending
  peaks.sort((a, b) => b.height - a.height);

  const finalPeaks: Peak[] = [];
  const excludedPositions = new Set<string>();

  for (const peak of peaks) {
    // Skip if peak center already excluded
    if (excludedPositions.has(key(peak.center))) continue;

    finalPeaks.push(peak);

    // Exclude nearby positions based on peak height
    const exclusionRadius = Math.floor(peak.height * 0.75);
    for (let dx = -exclusionRadius; dx <= exclusionRadius; dx++) {
      for (let dy = -exclusionRadius; dy <= exclusionRadius; dy++) {
        excludedPositions.add(key(peak.center.x + dx, peak.center.y + dy));
      }
    }
  }

  return finalPeaks;
}
```

**Logic**: Taller peaks "own" larger areas, preventing nearby shorter peaks.

### 4. Territory Division Algorithm

```typescript
function bfsDivideRoom(peaks: Peak[], room: Room): Map<string, RoomPosition[]> {
  const territories = new Map<string, RoomPosition[]>();
  const visited = new Set<string>();
  const queue: QueueItem[] = [];

  // Initialize territories and seed queue with peak centers
  for (const peak of peaks.sort((a, b) => b.height - a.height)) {
    const peakId = `${room.name}-${peak.center.x}-${peak.center.y}`;
    territories.set(peakId, []);
    queue.push({ x: peak.center.x, y: peak.center.y, peakId });
  }

  // Simultaneous BFS expansion
  while (queue.length > 0) {
    const { x, y, peakId } = queue.shift();
    if (visited.has(key(x, y))) continue;
    if (isWall(x, y)) continue;

    visited.add(key(x, y));
    territories.get(peakId).push(new RoomPosition(x, y, room.name));

    // Add unvisited neighbors (all expand at same rate)
    for (const neighbor of getNeighbors(x, y)) {
      if (!visited.has(key(neighbor))) {
        queue.push({ ...neighbor, peakId });
      }
    }
  }

  return territories;
}
```

**Key insight**: Using a single queue ensures all peaks expand at the same rate, creating fair Voronoi-like divisions.

## Data Structures

### Peak

```typescript
interface Peak {
  tiles: RoomPosition[];     // All tiles at peak height
  center: RoomPosition;      // Centroid of cluster
  height: number;            // Distance transform value
}
```

### Territory

```typescript
interface Territory {
  peakId: string;            // Owner peak identifier
  positions: RoomPosition[]; // All tiles in territory
}
```

## RoomMap API

### Construction

```typescript
const roomMap = new RoomMap(room);
// Automatically calculates:
// - Distance transform
// - Peak detection and filtering
// - Territory division
```

### Queries

```typescript
// Get all peaks (sorted by height)
const peaks: Peak[] = roomMap.getPeaks();

// Get best base location
const bestPeak: Peak | undefined = roomMap.getBestBasePeak();

// Get territory for a peak
const territory: RoomPosition[] = roomMap.getTerritory(peakId);

// Get all territories
const territories: Map<string, RoomPosition[]> = roomMap.getAllTerritories();

// Find which peak owns a position
const owner: string | undefined = roomMap.findTerritoryOwner(position);
```

### Visualization

RoomMap automatically renders debug visuals:

```typescript
// Peaks shown as yellow circles
// Top 3 peaks labeled P1, P2, P3
// Territories shown with colored boundaries
// Building candidate sites shown as red dots
```

## Use Cases

### Base Placement

```typescript
const roomMap = new RoomMap(room);
const basePeak = roomMap.getBestBasePeak();

if (basePeak) {
  // Place spawn near peak center
  const spawnPos = basePeak.center;
  room.createConstructionSite(spawnPos.x, spawnPos.y, STRUCTURE_SPAWN);
}
```

### Extension Clustering

```typescript
const peaks = roomMap.getPeaks();
const primaryPeak = peaks[0];  // Largest open area
const secondaryPeak = peaks[1]; // Second largest

// Place extensions around primary peak
// Place storage/links near secondary peak
```

### Zone Management

```typescript
const territory = roomMap.getTerritory(peakId);

// Assign creeps to zones
creeps.forEach(creep => {
  const zone = roomMap.findTerritoryOwner(creep.pos);
  if (zone === peakId) {
    // This creep is in our zone
  }
});
```

### Road Planning

```typescript
// Connect peak centers with roads
const peaks = roomMap.getPeaks().slice(0, 3);
for (let i = 0; i < peaks.length - 1; i++) {
  const path = PathFinder.search(peaks[i].center, peaks[i+1].center);
  path.path.forEach(pos => {
    room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD);
  });
}
```

## Legacy Grids

RoomMap maintains backwards-compatible grids:

### WallDistanceGrid

Simple wall distance (not inverted):
- Value = BFS distance from nearest wall
- Used for basic proximity checks

### EnergyDistanceGrid

Distance from energy sources:
- Value = BFS distance from nearest source
- Used for identifying building candidates

```typescript
// Building candidates: 2-5 tiles from energy
for (let x = 0; x < 50; x++) {
  for (let y = 0; y < 50; y++) {
    const dist = roomMap.EnergyDistanceGrid[x][y];
    if (dist > 2 && dist < 5) {
      candidates.push({ x, y });
    }
  }
}
```

## Performance Considerations

### Caching

RoomMap calculation is expensive. Use the cache:

```typescript
// main.ts caches RoomMaps
const ROOM_MAP_CACHE_TTL = 100; // Recalculate every 100 ticks

const cached = roomMapCache[room.name];
if (!cached || Game.time - cached.tick > ROOM_MAP_CACHE_TTL) {
  roomMapCache[room.name] = { map: new RoomMap(room), tick: Game.time };
}
```

### CPU Impact

Typical RoomMap construction:
- Distance transform: ~0.5ms
- Peak detection: ~0.3ms
- Peak filtering: ~0.1ms
- Territory division: ~0.2ms
- Total: ~1.1ms per room

### Memory Impact

```typescript
// Distance transform: 50 * 50 * 8 bytes ≈ 20KB
// Peaks: Variable, typically < 1KB
// Territories: Variable, typically < 5KB
// Total per room: ~25KB temporary, ~5KB persisted
```

## Algorithm Visualization

### Distance Transform Example

```
Room with walls:
████████████
█..........█
█..████....█
█..████....█
█..........█
████████████

Distance Transform (before invert):
000000000000
012321234321
012100123321
012100123321
012321234321
000000000000

Distance Transform (after invert):
000000000000
054345432345
054565432345
054565432345
054345432345
000000000000

Peaks detected: (5,3) with height 6
```

### Territory Division Example

```
Two peaks at P1 and P2:

Before division:
████████████
█....P1....█
█..........█
█....P2....█
████████████

After BFS division:
████████████
█AAAAAAAAAA█
█AAAAAAAAAA█
█BBBBBBBBBB█
████████████

Territory A belongs to P1
Territory B belongs to P2
```

## Future Enhancements

### Planned

- **Dynamic updates**: Incremental recalculation when terrain changes
- **Multi-room**: Territory division across room boundaries
- **Cost maps**: Incorporate swamp/plain costs
- **Structure awareness**: Exclude existing structures from peaks

### Experimental

- **Machine learning**: Train peak quality predictor
- **Flood analysis**: Identify chokepoints
- **Defense scoring**: Rate positions for tower placement
