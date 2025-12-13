import { RoomRoutine } from "./RoomProgram";
import { forEach } from "lodash";

const GRID_SIZE = 50;
const UNVISITED = -1;
const BARRIER = -2;

export class RoomMap extends RoomRoutine {
    name = 'RoomMap';
    private WallDistanceGrid = this.initializeGrid(UNVISITED);
    private WallDistanceAvg = 0;
    private EnergyDistanceGrid = this.initializeGrid(UNVISITED);

    constructor(room: Room) {
        super(new RoomPosition(25, 25, room.name), {});

        let wallPositions: [number, number][] = [];

        const terrain = Game.map.getRoomTerrain(room.name);
        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                    wallPositions.push([x, y]);
                }
            }
        }

        // Calculate distance from walls
        FloodFillDistanceSearch(this.WallDistanceGrid, wallPositions);

        // Calculate average, excluding wall tiles (which are 0)
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
        // First mark walls as barriers (impassable)
        markBarriers(this.EnergyDistanceGrid, wallPositions);

        // Then find energy sources
        let energyPositions: [number, number][] = [];
        forEach(room.find(FIND_SOURCES), (source) => {
            energyPositions.push([source.pos.x, source.pos.y]);
        });

        FloodFillDistanceSearch(this.EnergyDistanceGrid, energyPositions);

        // Find candidate building sites (good distance from energy sources)
        let sites: { x: number, y: number, wallDistance: number, energyDistance: number }[] = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            for (let y = 0; y < GRID_SIZE; y++) {
                const energyDist = this.EnergyDistanceGrid[x][y];
                if (energyDist > 2 && energyDist < 5) {
                    sites.push({
                        x: x,
                        y: y,
                        wallDistance: this.WallDistanceGrid[x][y],
                        energyDistance: energyDist
                    });
                }
            }
        }

        forEach(sites, (site) => {
            room.visual.circle(site.x, site.y, { fill: 'red' });
        });

        const ridgeLines = findRidgeLines(this.WallDistanceGrid);
        forEach(ridgeLines, ([x, y]) => {
            room.visual.circle(x, y, { fill: 'yellow' });
        });
    }


    routine(room: Room): void {

    }

    calcSpawnQueue(room: Room): void {

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

function markBarriers(grid: number[][], positions: [number, number][]): void {
    positions.forEach(([x, y]) => {
        grid[x][y] = BARRIER;
    });
}

function FloodFillDistanceSearch(grid: number[][], startPositions: [number, number][]): void {
    const queue: [number, number, number][] = []; // [x, y, distance]
    const directions: [number, number][] = [
        [1, 0], [-1, 0], [0, 1], [0, -1]
    ];

    // Mark start positions with distance 0 and add to queue
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
                grid[newX][newY] === UNVISITED // Only visit unvisited tiles
            ) {
                grid[newX][newY] = distance + 1;
                queue.push([newX, newY, distance + 1]);
            }
        }
    }
}

function findRidgeLines(grid: number[][]): [number, number][] {
    const ridgeLines: [number, number][] = [];
    const directions: [number, number][] = [
        [1, 0], [-1, 0], [0, 1], [0, -1], [-1, -1], [-1, 1], [1, 1], [1, -1]
    ];

    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            // Skip walls/barriers (distance 0 at start positions is fine)
            if (grid[x][y] <= 0) continue;

            let isRidgePoint = true;

            // Check if the current tile has equal or higher distance than all its neighbors
            for (const [dx, dy] of directions) {
                const newX = x + dx;
                const newY = y + dy;

                if (
                    newX >= 0 &&
                    newX < GRID_SIZE &&
                    newY >= 0 &&
                    newY < GRID_SIZE &&
                    grid[newX][newY] > 0 &&
                    grid[x][y] < grid[newX][newY]
                ) {
                    isRidgePoint = false;
                    break;
                }
            }

            if (isRidgePoint) {
                ridgeLines.push([x, y]);
            }
        }
    }

    return ridgeLines;
}
