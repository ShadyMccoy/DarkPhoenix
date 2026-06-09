/**
 * RoomBuilder - compose Screeps room layouts from primitives.
 *
 * Hand-writing 50 terrain strings (or nested x/y loops) for every test scenario
 * is slow and error-prone. RoomBuilder lets a scenario read like what it is:
 *
 *   new RoomBuilder("W0N0")
 *     .border()
 *     .vWall(16, { gap: [24, 25] })   // divider with a 2-tile corridor
 *     .vWall(33, { gap: [24, 25] })
 *     .source(8, 25)                  // west chamber
 *     .controller(41, 25)             // east chamber
 *     .toRoom();
 *
 * The output is a {@link ScenarioRoom} (terrain strings + objects) ready for
 * loadLayout. Every method returns `this` so calls chain, and the grid is pure
 * data so the result is deterministic and unit-testable without a server.
 */

export type Tile = "plain" | "wall" | "swamp";

/** A placeable room object. `spawn` is created via addBot, not placed here. */
export interface ScenarioObject {
  type:
    | "source"
    | "controller"
    | "mineral"
    | "extension"
    | "container"
    | "tower"
    | "storage"
    | "link"
    | "road";
  x: number;
  y: number;
  /** Engine attributes merged over loadLayout's per-type defaults. */
  attributes?: Record<string, unknown>;
}

/** A single room's terrain + objects, in loadLayout's string-terrain format. */
export interface ScenarioRoom {
  room: string;
  /** 50 rows of 50 chars: '#' wall, '~' swamp, '.' plain. */
  terrain: string[];
  objects: ScenarioObject[];
}

const SIZE = 50;
const TILE_CHAR: Record<Tile, string> = { plain: ".", wall: "#", swamp: "~" };

/** Optional gap(s) to leave open when drawing a wall (corridors through it). */
interface WallOptions {
  /** Inclusive coordinate range left open, e.g. [24, 25] for a 2-wide corridor. */
  gap?: [number, number];
}

export class RoomBuilder {
  /** grid[y][x] */
  private readonly grid: Tile[][];
  private readonly objects: ScenarioObject[] = [];

  constructor(private readonly room: string) {
    this.grid = Array.from({ length: SIZE }, () =>
      Array.from({ length: SIZE }, () => "plain" as Tile)
    );
  }

  // --- terrain ---------------------------------------------------------------

  /** Set every tile to `t`. */
  fill(t: Tile): this {
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) this.grid[y][x] = t;
    return this;
  }

  /** Draw the outer edge of the room (default: walls). */
  border(t: Tile = "wall"): this {
    for (let i = 0; i < SIZE; i++) {
      this.set(i, 0, t);
      this.set(i, SIZE - 1, t);
      this.set(0, i, t);
      this.set(SIZE - 1, i, t);
    }
    return this;
  }

  /** Fill an inclusive rectangle with `t`. */
  rect(x1: number, y1: number, x2: number, y2: number, t: Tile): this {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) this.set(x, y, t);
    }
    return this;
  }

  /** A full-height vertical wall at column `x`, optionally leaving a corridor gap. */
  vWall(x: number, opts: WallOptions = {}): this {
    for (let y = 0; y < SIZE; y++) {
      if (opts.gap && y >= opts.gap[0] && y <= opts.gap[1]) continue;
      this.set(x, y, "wall");
    }
    return this;
  }

  /** A full-width horizontal wall at row `y`, optionally leaving a corridor gap. */
  hWall(y: number, opts: WallOptions = {}): this {
    for (let x = 0; x < SIZE; x++) {
      if (opts.gap && x >= opts.gap[0] && x <= opts.gap[1]) continue;
      this.set(x, y, "wall");
    }
    return this;
  }

  /** Set a single tile. */
  tile(x: number, y: number, t: Tile): this {
    this.set(x, y, t);
    return this;
  }

  // --- objects ---------------------------------------------------------------

  source(x: number, y: number, attributes?: Record<string, unknown>): this {
    return this.obj("source", x, y, attributes);
  }

  controller(x: number, y: number): this {
    return this.obj("controller", x, y);
  }

  extension(x: number, y: number): this {
    return this.obj("extension", x, y);
  }

  container(x: number, y: number): this {
    return this.obj("container", x, y);
  }

  /** Place an arbitrary object; its tile is forced to plain so it is reachable. */
  obj(
    type: ScenarioObject["type"],
    x: number,
    y: number,
    attributes?: Record<string, unknown>
  ): this {
    this.set(x, y, "plain");
    this.objects.push({ type, x, y, attributes });
    return this;
  }

  // --- output ----------------------------------------------------------------

  /** Emit the room as terrain strings + objects for loadLayout. */
  toRoom(): ScenarioRoom {
    const terrain = this.grid.map((row) => row.map((t) => TILE_CHAR[t]).join(""));
    return { room: this.room, terrain, objects: this.objects.map((o) => ({ ...o })) };
  }

  private set(x: number, y: number, t: Tile): void {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    this.grid[y][x] = t;
  }
}
