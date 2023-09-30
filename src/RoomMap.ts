import { RoomRoutine } from "RoomProgram";
import { forEach } from "lodash";
import { start } from "repl";

const GRID_SIZE = 50;

export class RoomMap extends RoomRoutine {
    name = 'RoomMap';
    private WallDistanceGrid = this.initializeGrid();
    private EnergyDistanceGrid = this.initializeGrid();

    constructor(room: Room) {
        super(new RoomPosition(25, 25, room.name), {});

        let startPositions: [number, number][] = [];

        Game.map.getRoomTerrain(room.name);
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (Game.map.getRoomTerrain(room.name).get(x, y) == TERRAIN_MASK_WALL) {
                    startPositions.push([x, y]);
                }
            }
        }

        markStartTiles(this.WallDistanceGrid, startPositions);
        FloodFillDistanceSearch(this.WallDistanceGrid);

        markStartTiles(this.EnergyDistanceGrid, startPositions, -2);
        startPositions = [];
        forEach(room.find(FIND_SOURCES), (source) => {
            startPositions.push([source.pos.x, source.pos.y]);
        });
        markStartTiles(this.EnergyDistanceGrid, startPositions);
        FloodFillDistanceSearch(this.EnergyDistanceGrid);

        forEach(this.EnergyDistanceGrid, (row, x) => {
            forEach(row, (value, y) => {
                if (value > 0) {
                    room.visual.text(value.toString(), x, y);
                }
            });
        });
    }

    routine(room: Room): void {

    }

    calcSpawnQueue(room: Room): void {

    }


    // Function to initialize the grid with zeros
    private initializeGrid(): number[][] {
        const grid: number[][] = [];
        for (let x = 0; x < GRID_SIZE; x++) {
            grid[x] = [];
            for (let y = 0; y < GRID_SIZE; y++) {
                grid[x][y] = 0; // Initialize distances to zero
            }
        }
        return grid;
    }



}

function markStartTiles(grid: number[][], startTiles: [x: number, y: number][], startValue: number = -1): void {
    startTiles.forEach(([x, y]) => {
        grid[x][y] = startValue;
    });
}

function FloodFillDistanceSearch(grid: number[][]): void {
    const queue: [number, number, number][] = []; // [x, y, distance]
    const directions: [number, number][] = [
        [1, 0], [-1, 0], [0, 1], [0, -1], [-1, -1], [-1, 1], [1, -1], [1, 1]
    ];

    for (let x = 0; x < GRID_SIZE; x++) {
        for (let y = 0; y < GRID_SIZE; y++) {
            if (grid[x][y] === -1) {
                // Initialize the queue with start tiles
                queue.push([x, y, 0]);
            }
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
                grid[newX][newY] === 0 // Unvisited tile
            ) {
                grid[newX][newY] = distance + 1;
                queue.push([newX, newY, distance + 1]);
            }
        }
    }
}
