/**
 * base-lab/stamps - the "PCB component" format and starter library.
 *
 * A stamp is a set of structures at RELATIVE offsets from an anchor tile, plus
 * an optional `feed` tile (the router/feeder seat). This is the durable
 * artifact of the whole exploration: the same offset table the lab renders here
 * can later feed the real planner (place + orient at a terrain-chosen anchor),
 * per the "subsystems the planner places" hybrid.
 *
 * `reserved` cells are footprint holes (corners left open, spawn-exit lanes) -
 * they are part of the stamp's shape but place no structure, so terrain under
 * them is not constrained.
 */
export type CellKind =
  | "spawn"
  | "extension"
  | "link"
  | "storage"
  | "terminal"
  | "tower"
  | "container"
  | "feeder" // the stationary CARRY router seat (manager / ring feeder)
  | "reserved"; // footprint hole - no structure, terrain unconstrained

export interface StampCell {
  dx: number;
  dy: number;
  kind: CellKind;
}

export interface Stamp {
  name: string;
  /** The seat a feeder/manager is spawned onto (relative to anchor). */
  feed: { dx: number; dy: number };
  cells: StampCell[];
}

/** Single ASCII glyph per kind for the overlay renderer. */
export const GLYPH: Record<CellKind, string> = {
  spawn: "P",
  extension: "E",
  link: "L",
  storage: "O",
  terminal: "M",
  tower: "T",
  container: "C",
  feeder: "@",
  reserved: "." // rendered only if nothing else claims the tile
};

/** Cells that place a real structure (everything but reserved holes). */
export const solidCells = (s: Stamp): StampCell[] => s.cells.filter(c => c.kind !== "reserved");

export const extensionCount = (s: Stamp): number => s.cells.filter(c => c.kind === "extension").length;

/**
 * RING FEEDER pocket (the design we converged on). A 5x5 diamond: 15
 * extensions + a central link, a spawn at the bottom, and a 4-tile ring of
 * feeder seats around the link. One (or a few) pure-CARRY feeders circle the
 * ring - "ring around the rosy" - topping up all 15 extensions from the link.
 * Anchor = the central link (0,0). Corners are reserved holes.
 *
 *        c0  c1  c2  c3  c4
 *   r0    .   E   E   E   .
 *   r1    E   E   @   E   E
 *   r2    E   @   L   @   E
 *   r3    E   E   @   E   E
 *   r4    .   E   P   E   .
 */
export const RING_FEEDER: Stamp = {
  name: "ring-feeder",
  feed: { dx: 0, dy: 1 }, // the ring seat directly above the spawn (spawn-seatable)
  cells: [
    // extensions (dx,dy relative to the central link at 0,0)
    { dx: -1, dy: -2, kind: "extension" },
    { dx: 0, dy: -2, kind: "extension" },
    { dx: 1, dy: -2, kind: "extension" },
    { dx: -2, dy: -1, kind: "extension" },
    { dx: -1, dy: -1, kind: "extension" },
    { dx: 1, dy: -1, kind: "extension" },
    { dx: 2, dy: -1, kind: "extension" },
    { dx: -2, dy: 0, kind: "extension" },
    { dx: 2, dy: 0, kind: "extension" },
    { dx: -2, dy: 1, kind: "extension" },
    { dx: -1, dy: 1, kind: "extension" },
    { dx: 1, dy: 1, kind: "extension" },
    { dx: 2, dy: 1, kind: "extension" },
    { dx: -1, dy: 2, kind: "extension" },
    { dx: 1, dy: 2, kind: "extension" },
    // central link + the 4-tile feeder ring around it
    { dx: 0, dy: 0, kind: "link" },
    { dx: 0, dy: -1, kind: "feeder" },
    { dx: -1, dy: 0, kind: "feeder" },
    { dx: 1, dy: 0, kind: "feeder" },
    { dx: 0, dy: 1, kind: "feeder" },
    // spawn faces OUT the bottom; corners left open
    { dx: 0, dy: 2, kind: "spawn" },
    { dx: -2, dy: -2, kind: "reserved" },
    { dx: 2, dy: -2, kind: "reserved" },
    { dx: -2, dy: 2, kind: "reserved" },
    { dx: 2, dy: 2, kind: "reserved" }
  ]
};

/**
 * CORE POCKET - the logistics core. A 3x3 whose center is the stationary
 * 0-MOVE "manager" seat, adjacency-complete over storage / terminal / link /
 * two towers / spawn / two extensions. The manager never moves; it routes
 * energy among its 8 neighbors. Anchor = the manager seat (0,0), which is the
 * spawn spot picked by pickSpawnSpot (all 8 neighbors guaranteed plain).
 *
 *        c0  c1  c2
 *   r0    L   T   M      L link, T tower, M terminal
 *   r1    O   @   T      O storage, @ manager, T tower
 *   r2    P   E   E      P spawn, E extension
 */
export const CORE_POCKET: Stamp = {
  name: "core-pocket",
  feed: { dx: 0, dy: 0 }, // the manager seat itself (spawn-seatable from the SW spawn)
  cells: [
    { dx: 0, dy: 0, kind: "feeder" },
    { dx: -1, dy: -1, kind: "link" },
    { dx: 0, dy: -1, kind: "tower" },
    { dx: 1, dy: -1, kind: "terminal" },
    { dx: -1, dy: 0, kind: "storage" },
    { dx: 1, dy: 0, kind: "tower" },
    { dx: -1, dy: 1, kind: "spawn" },
    { dx: 0, dy: 1, kind: "extension" },
    { dx: 1, dy: 1, kind: "extension" }
  ]
};
