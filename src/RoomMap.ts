import { RoomRoutine } from "./RoomProgram";
import { forEach } from "lodash";

const GRID_SIZE = 50;
const UNVISITED = -1;
const BARRIER = -2;

/**
 * Represents a spatial peak (local maximum in distance from walls).
 * Peaks identify optimal locations for bases, extensions, and control points.
 */
export interface Peak {
    tiles: RoomPosition[];     // All tiles at this peak's height
    center: RoomPosition;       // Centroid of the peak
    height: number;             // Distance transform value (higher = more open)
}

/**
 * Territory assigned to a peak via BFS flood fill.
 * Used for zone-based creep management and resource allocation.
 */
export interface Territory {
    peakId: string;
    positions: RoomPosition[];
}

export class RoomMap extends RoomRoutine {
    name = 'RoomMap';

    // Distance transform grid (inverted: higher values = more open areas)
    private distanceTransform: number[][] = [];

    // Detected peaks (optimal building locations)
    private peaks: Peak[] = [];

    // Territory assignments (which peak owns which tiles)
    private territories: Map<string, RoomPosition[]> = new Map();

    // Legacy grids for backwards compatibility
    private WallDistanceGrid = this.initializeGrid(UNVISITED);
    private WallDistanceAvg = 0;
    private EnergyDistanceGrid = this.initializeGrid(UNVISITED);

    constructor(room: Room) {
        super(new RoomPosition(25, 25, room.name), {});

        const terrain = Game.map.getRoomTerrain(room.name);
        let wallPositions: [number, number][] = [];

        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                    wallPositions.push([x, y]);
                }
            }
        }

        // NEW: Create inverted distance transform (peaks = open areas)
        this.distanceTransform = createDistanceTransform(room);

        // NEW: Find and filter peaks
        this.peaks = findPeaks(this.distanceTransform, room);
        this.peaks = filterPeaks(this.peaks);

        // NEW: Divide room into territories using BFS
        this.territories = bfsDivideRoom(this.peaks, room);

        // Legacy: Calculate simple wall distance for backwards compatibility
        FloodFillDistanceSearch(this.WallDistanceGrid, wallPositions);

        // Calculate average, excluding wall tiles
        let sum = 0;
        let count = 0;
        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                if (this.WallDistanceGrid[x][y] > 0) {
                    sum += this.WallDistanceGrid[x][y];
                    count++;
                }
            }
        }
        this.WallDistanceAvg = count > 0 ? sum / count : 0;

        // Calculate distance from energy sources
        markBarriers(this.EnergyDistanceGrid, wallPositions);

        let energyPositions: [number, number][] = [];
        forEach(room.find(FIND_SOURCES), (source) => {
            energyPositions.push([source.pos.x, source.pos.y]);
        });

        FloodFillDistanceSearch(this.EnergyDistanceGrid, energyPositions);

        // Visualize results
        this.visualize(room);
    }

    /**
     * Get all detected peaks, sorted by height (most open first)
     */
    getPeaks(): Peak[] {
        return [...this.peaks].sort((a, b) => b.height - a.height);
    }

    /**
     * Get the best peak for base placement (highest = most open area)
     */
    getBestBasePeak(): Peak | undefined {
        return this.peaks.reduce((best, peak) =>
            !best || peak.height > best.height ? peak : best,
            undefined as Peak | undefined
        );
    }

    /**
     * Get territory for a specific peak
     */
    getTerritory(peakId: string): RoomPosition[] {
        return this.territories.get(peakId) || [];
    }

    /**
     * Get all territories
     */
    getAllTerritories(): Map<string, RoomPosition[]> {
        return new Map(this.territories);
    }

    /**
     * Find which peak's territory contains a given position
     */
    findTerritoryOwner(pos: RoomPosition): string | undefined {
        for (const [peakId, positions] of this.territories) {
            if (positions.some(p => p.x === pos.x && p.y === pos.y)) {
                return peakId;
            }
        }
        return undefined;
    }

    private visualize(room: Room): void {
        // Visualize peaks with varying opacity by height
        const maxHeight = Math.max(...this.peaks.map(p => p.height), 1);
        forEach(this.peaks, (peak, index) => {
            const opacity = 0.3 + (peak.height / maxHeight) * 0.7;
            room.visual.circle(peak.center.x, peak.center.y, {
                fill: 'yellow',
                opacity,
                radius: 0.5
            });
            // Label top 3 peaks
            if (index < 3) {
                room.visual.text(`P${index + 1}`, peak.center.x, peak.center.y - 1, {
                    font: 0.4,
                    color: 'white'
                });
            }
        });

        // Visualize territory boundaries (optional, can be expensive)
        const colors = ['#ff000044', '#00ff0044', '#0000ff44', '#ffff0044', '#ff00ff44'];
        let colorIndex = 0;
        for (const [peakId, positions] of this.territories) {
            if (colorIndex >= colors.length) break;
            const color = colors[colorIndex++];
            // Only draw boundary positions (not all positions)
            const boundary = positions.filter(pos =>
                !positions.some(p =>
                    Math.abs(p.x - pos.x) + Math.abs(p.y - pos.y) === 1 &&
                    positions.every(pp => pp !== p || (pp.x !== pos.x + 1 || pp.y !== pos.y))
                )
            ).slice(0, 100); // Limit for performance
            forEach(boundary, (pos) => {
                room.visual.rect(pos.x - 0.5, pos.y - 0.5, 1, 1, { fill: color });
            });
        }

        // Find candidate building sites (good distance from energy sources)
        let sites: { x: number, y: number }[] = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                const energyDist = this.EnergyDistanceGrid[x][y];
                if (energyDist > 2 && energyDist < 5) {
                    sites.push({ x, y });
                }
            }
        }

        forEach(sites, (site) => {
            room.visual.circle(site.x, site.y, { fill: 'red', radius: 0.3, opacity: 0.5 });
        });
    }

    routine(room: Room): void {
        // Re-visualize each tick
        this.visualize(room);
    }

    calcSpawnQueue(room: Room): void {
        // RoomMap doesn't spawn creeps
    }

    private initializeGrid(initialValue: number = UNVISITED): number[][] {
        const grid: number[][] = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            grid[x] = [];
            for (let y = 0; y < GRID_SIZE; y++) {
                grid[x][y] = initialValue;
            }
        }
        return grid;
    }
}

// ============================================================================
// PORTED FROM SANTA BRANCH: Distance Transform Algorithm
// Creates an inverted distance transform where open areas have HIGH values
// ============================================================================

/**
 * Creates an inverted distance transform matrix.
 * Uses BFS from walls to calculate distance, then inverts so peaks = open areas.
 * This is more sophisticated than simple flood fill for identifying building zones.
 *
 * @param room - The room to analyze
 * @returns 2D array where higher values indicate more open areas
 */
function createDistanceTransform(room: Room): number[][] {
    const grid: number[][] = [];
    const queue: { x: number; y: number; distance: number }[] = [];
    const terrain = Game.map.getRoomTerrain(room.name);
    let highestDistance = 0;

    // Initialize grid
    for (let x = 0; x < GRID_SIZE; x++) {
        grid[x] = [];
        for (let y = 0; y < GRID_SIZE; y++) {
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                grid[x][y] = 0;
                queue.push({ x, y, distance: 0 });
            } else {
                grid[x][y] = Infinity;
            }
        }
    }

    // BFS to propagate distances from walls (8-directional for accuracy)
    const neighbors = [
        { dx: -1, dy: -1 }, { dx: -1, dy: 0 }, { dx: -1, dy: 1 },
        { dx: 0, dy: 1 },
        { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
        { dx: 0, dy: -1 }
    ];

    while (queue.length > 0) {
        const { x, y, distance } = queue.shift()!;

        for (const { dx, dy } of neighbors) {
            const nx = x + dx;
            const ny = y + dy;

            if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
                const currentDistance = grid[nx][ny];
                const newDistance = distance + 1;

                if (terrain.get(nx, ny) !== TERRAIN_MASK_WALL && newDistance < currentDistance) {
                    grid[nx][ny] = newDistance;
                    queue.push({ x: nx, y: ny, distance: newDistance });
                    highestDistance = Math.max(highestDistance, newDistance);
                }
            }
        }
    }

    // Invert distances: open areas become peaks
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            const originalDistance = grid[x][y];
            if (originalDistance !== Infinity && originalDistance !== 0) {
                grid[x][y] = 1 + highestDistance - originalDistance;
            } else if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                grid[x][y] = 0; // Walls stay at 0
            }
        }
    }

    return grid;
}

// ============================================================================
// PORTED FROM SANTA BRANCH: Peak Detection Algorithm
// Finds local maxima in the distance transform (optimal building locations)
// ============================================================================

/**
 * Finds peaks (local maxima) in the distance transform.
 * Peaks represent the most open areas in the room - ideal for bases.
 *
 * @param distanceMatrix - Inverted distance transform grid
 * @param room - Room for creating RoomPositions
 * @returns Array of peaks with their tiles, center, and height
 */
function findPeaks(distanceMatrix: number[][], room: Room): Peak[] {
    const terrain = Game.map.getRoomTerrain(room.name);
    const searchCollection: { x: number; y: number; height: number }[] = [];
    const visited = new Set<string>();
    const peaks: Peak[] = [];

    // Collect all non-wall tiles with their heights
    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                const height = distanceMatrix[x][y];
                if (height > 0 && height !== Infinity) {
                    searchCollection.push({ x, y, height });
                }
            }
        }
    }

    // Sort by height descending (process highest first)
    searchCollection.sort((a, b) => b.height - a.height);

    // Find peaks by clustering connected tiles of same height
    while (searchCollection.length > 0) {
        const tile = searchCollection.shift()!;
        if (visited.has(`${tile.x},${tile.y}`)) continue;

        // Find all connected tiles at the same height (forming a peak plateau)
        const cluster: { x: number; y: number }[] = [];
        const queue = [{ x: tile.x, y: tile.y }];

        while (queue.length > 0) {
            const { x, y } = queue.pop()!;
            const key = `${x},${y}`;

            if (visited.has(key)) continue;
            if (distanceMatrix[x][y] !== tile.height) continue;

            visited.add(key);
            cluster.push({ x, y });

            // Check 4-connected neighbors for same height
            const neighbors = [
                { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
                { dx: 0, dy: -1 }, { dx: 0, dy: 1 }
            ];

            for (const { dx, dy } of neighbors) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
                    queue.push({ x: nx, y: ny });
                }
            }
        }

        if (cluster.length === 0) continue;

        // Calculate centroid of the cluster
        const centerX = Math.round(cluster.reduce((sum, t) => sum + t.x, 0) / cluster.length);
        const centerY = Math.round(cluster.reduce((sum, t) => sum + t.y, 0) / cluster.length);

        peaks.push({
            tiles: cluster.map(t => new RoomPosition(t.x, t.y, room.name)),
            center: new RoomPosition(centerX, centerY, room.name),
            height: tile.height
        });
    }

    return peaks;
}

/**
 * Filters peaks to remove those too close to larger peaks.
 * Uses the peak's height as exclusion radius - taller peaks dominate more area.
 *
 * @param peaks - Unfiltered peaks from findPeaks
 * @returns Filtered peaks with appropriate spacing
 */
function filterPeaks(peaks: Peak[]): Peak[] {
    // Sort by height descending (keep tallest)
    peaks.sort((a, b) => b.height - a.height);

    const finalPeaks: Peak[] = [];
    const excludedPositions = new Set<string>();

    for (const peak of peaks) {
        const key = `${peak.center.x},${peak.center.y}`;
        if (excludedPositions.has(key)) continue;

        finalPeaks.push(peak);

        // Exclude nearby positions based on peak height (taller = larger exclusion)
        const exclusionRadius = Math.floor(peak.height * 0.75); // Slightly less aggressive
        for (let dx = -exclusionRadius; dx <= exclusionRadius; dx++) {
            for (let dy = -exclusionRadius; dy <= exclusionRadius; dy++) {
                const ex = peak.center.x + dx;
                const ey = peak.center.y + dy;
                if (ex >= 0 && ex < GRID_SIZE && ey >= 0 && ey < GRID_SIZE) {
                    excludedPositions.add(`${ex},${ey}`);
                }
            }
        }
    }

    return finalPeaks;
}

// ============================================================================
// PORTED FROM SANTA BRANCH: BFS Territory Division
// Divides room tiles among peaks using simultaneous BFS expansion
// ============================================================================

/**
 * Divides room tiles among peaks using BFS flood fill from each peak.
 * Tiles are assigned to the nearest peak (by BFS distance).
 * Peaks expand simultaneously at the same rate.
 *
 * @param peaks - Peaks to divide territory among
 * @param room - Room for terrain checking
 * @returns Map of peak IDs to their assigned positions
 */
function bfsDivideRoom(peaks: Peak[], room: Room): Map<string, RoomPosition[]> {
    const territories = new Map<string, RoomPosition[]>();
    const visited = new Set<string>();
    const terrain = Game.map.getRoomTerrain(room.name);

    // Initialize territories and queue
    interface QueueItem {
        x: number;
        y: number;
        peakId: string;
    }

    const queue: QueueItem[] = [];

    // Sort peaks by height (highest first gets priority in ties)
    const sortedPeaks = [...peaks].sort((a, b) => b.height - a.height);

    for (const peak of sortedPeaks) {
        const peakId = `${peak.center.roomName}-${peak.center.x}-${peak.center.y}`;
        territories.set(peakId, []);

        // Add peak center to queue
        queue.push({ x: peak.center.x, y: peak.center.y, peakId });
    }

    // BFS expansion - all peaks expand at same rate
    while (queue.length > 0) {
        const { x, y, peakId } = queue.shift()!;
        const key = `${x},${y}`;

        // Skip if already visited or wall
        if (visited.has(key)) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

        visited.add(key);

        // Assign tile to this peak's territory
        const territory = territories.get(peakId)!;
        territory.push(new RoomPosition(x, y, room.name));

        // Add unvisited neighbors to queue
        const neighbors = [
            { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
            { dx: 0, dy: -1 }, { dx: 0, dy: 1 }
        ];

        for (const { dx, dy } of neighbors) {
            const nx = x + dx;
            const ny = y + dy;
            const nkey = `${nx},${ny}`;

            if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE &&
                !visited.has(nkey) && terrain.get(nx, ny) !== TERRAIN_MASK_WALL) {
                queue.push({ x: nx, y: ny, peakId });
            }
        }
    }

    return territories;
}

// ============================================================================
// LEGACY FUNCTIONS (kept for backwards compatibility)
// ============================================================================

function markBarriers(grid: number[][], positions: [number, number][]): void {
    positions.forEach(([x, y]) => {
        grid[x][y] = BARRIER;
    });
}

function FloodFillDistanceSearch(grid: number[][], startPositions: [number, number][]): void {
    const queue: [number, number, number][] = [];
    const directions: [number, number][] = [
        [1, 0], [-1, 0], [0, 1], [0, -1]
    ];

    for (const [x, y] of startPositions) {
        if (grid[x][y] !== BARRIER) {
            grid[x][y] = 0;
            queue.push([x, y, 0]);
        }
    }

    while (queue.length > 0) {
        const [x, y, distance] = queue.shift()!;
        for (const [dx, dy] of directions) {
            const newX = x + dx;
            const newY = y + dy;
            if (
                newX >= 0 &&
                newX < GRID_SIZE &&
                newY >= 0 &&
                newY < GRID_SIZE &&
                grid[newX][newY] === UNVISITED
            ) {
                grid[newX][newY] = distance + 1;
                queue.push([newX, newY, distance + 1]);
            }
        }
    }
}
