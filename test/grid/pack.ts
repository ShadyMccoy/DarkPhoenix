/**
 * pack - assign grid cells to isolated slots in one mockup world.
 *
 * Isolation invariant (docs/specs/08, verified against engine source): two
 * cells never interfere iff (a) every reachable room is border()-sealed except
 * deliberate intra-cell gaps, and (b) the nearest rooms of two different cells
 * are >= 4 apart in room-grid Chebyshev distance - the bot's terrain analysis
 * box is a radius-3 room-name sweep (get7x7BoxAroundOwnedRooms) that ignores
 * walls, so stride-5 column slots on one row keep every foreign room outside
 * every bot's box. Scouts and movement are stopped by the walls themselves
 * (describeExits returns {} for a fully walled border).
 *
 * Slots: cell k's home room is column 5k on row N0 (W0N0, W5N0, W10N0, ...).
 * Multi-room cells place their extra handles in adjacent columns inside the
 * slot. Row N0 is always Source-Keeper-safe (SK rooms need BOTH coords % 10 in
 * [4,6]); the allocator still screens every name so future packing changes
 * cannot silently hand a cell an SK room and declassify its sources.
 */

import { GridCell } from "./GridCell";
import { formatRoomName, parseRoomName } from "../integration/loadLayout";

const STRIDE = 5;

/** A cell with its resolved room names. */
export interface PackedCell {
  cell: GridCell;
  /** handle -> packed room name ("home" always present). */
  rooms: Record<string, string>;
}

export interface PackedBatch {
  cells: PackedCell[];
  /** Every real (loaded) room across all cells. */
  allRooms: string[];
  /** Batch-wide engine-mod signature (cells must agree; see partition). */
  mods: string[];
  /** Batch run length = max cell window. */
  window: number;
}

/** True iff a room name is Source-Keeper-classified by the bot's rule. */
export function isSkRoomName(name: string): boolean {
  const m = /^[WE](\d+)[NS](\d+)$/.exec(name);
  if (!m) return false;
  const h = Number(m[1]) % 10;
  const v = Number(m[2]) % 10;
  const inBand = (n: number) => n >= 4 && n <= 6;
  return inBand(h) && inBand(v) && !(h === 5 && v === 5);
}

const DIR: Record<"E" | "W" | "N" | "S", { dx: number; dy: number }> = {
  E: { dx: 1, dy: 0 },
  W: { dx: -1, dy: 0 },
  N: { dx: 0, dy: -1 },
  S: { dx: 0, dy: 1 },
};

/** Resolve one cell's handles to concrete room names from its home column. */
function resolveRooms(cell: GridCell, column: number): Record<string, string> {
  // Pinned cells use their absolute names verbatim (SK-classification cells);
  // the isolation audit below still applies to them.
  if (cell.pinnedRooms) {
    const rooms: Record<string, string> = { ...cell.pinnedRooms };
    for (const handle of Object.keys(cell.rooms)) {
      if (!rooms[handle]) throw new Error(`grid pack: cell ${cell.id} pins rooms but omits handle "${handle}"`);
    }
    return rooms;
  }
  // Column c -> room name W{c}N0 via signed grid coords (W{n} is x = -n-1).
  const home = formatRoomName(-column - 1, -1);
  const homeCoord = parseRoomName(home);
  if (!homeCoord) throw new Error(`grid pack: bad home room ${home}`);

  const rooms: Record<string, string> = { home };
  for (const handle of Object.keys(cell.rooms)) {
    if (handle === "home") continue;
    const dir = cell.adjacency?.[handle];
    if (!dir) {
      throw new Error(`grid pack: cell ${cell.id} room "${handle}" has no adjacency direction`);
    }
    const { dx, dy } = DIR[dir];
    rooms[handle] = formatRoomName(homeCoord.x + dx, homeCoord.y + dy);
  }
  return rooms;
}

/** Chebyshev distance between two rooms on the room grid. */
function roomDistance(a: string, b: string): number {
  const ca = parseRoomName(a);
  const cb = parseRoomName(b);
  if (!ca || !cb) return Infinity;
  return Math.max(Math.abs(ca.x - cb.x), Math.abs(ca.y - cb.y));
}

/**
 * Pack cells into one batch: stride-5 slots, SK screening, isolation audit.
 * Throws on any violation - a mispacked grid produces verdicts about packing,
 * not about the bot, so packing errors are loud.
 */
export function packBatch(cells: GridCell[]): PackedBatch {
  if (cells.length === 0) throw new Error("grid pack: no cells");

  const ids = new Set<string>();
  for (const c of cells) {
    if (ids.has(c.id)) throw new Error(`grid pack: duplicate cell id ${c.id}`);
    ids.add(c.id);
    if (!c.rooms.home) throw new Error(`grid pack: cell ${c.id} has no "home" room`);
  }

  const modsSig = JSON.stringify([...(cells[0].mods ?? [])].sort());
  for (const c of cells) {
    if (JSON.stringify([...(c.mods ?? [])].sort()) !== modsSig) {
      throw new Error(
        `grid pack: cell ${c.id} has a different engine-mod signature; ` +
          `mods are world-global, so partition into separate batches first`
      );
    }
  }

  const packed: PackedCell[] = cells.map((cell, i) => ({
    cell,
    rooms: resolveRooms(cell, i * STRIDE),
  }));

  // Screen + audit: SK-safe names (deliberately pinned SK rooms exempt),
  // and >= 4 rooms between any two cells.
  for (const p of packed) {
    if (p.cell.pinnedRooms) continue;
    for (const name of Object.values(p.rooms)) {
      if (isSkRoomName(name)) {
        throw new Error(`grid pack: cell ${p.cell.id} allocated SK room ${name}`);
      }
    }
  }
  for (let i = 0; i < packed.length; i++) {
    for (let j = i + 1; j < packed.length; j++) {
      for (const a of Object.values(packed[i].rooms)) {
        for (const b of Object.values(packed[j].rooms)) {
          const d = roomDistance(a, b);
          if (d < 4) {
            throw new Error(
              `grid pack: cells ${packed[i].cell.id} and ${packed[j].cell.id} ` +
                `are only ${d} rooms apart (${a} vs ${b}); need >= 4`
            );
          }
        }
      }
    }
  }

  const allRooms: string[] = [];
  for (const p of packed) allRooms.push(...Object.values(p.rooms));

  return {
    cells: packed,
    allRooms,
    mods: cells[0].mods ?? [],
    window: Math.max(...cells.map((c) => c.window)),
  };
}

/** Max bots per world; more just dilutes wall-clock per tick. */
export const MAX_BOTS_PER_WORLD = 12;

/**
 * Partition cells into batches: split by engine-mod signature first (mods are
 * world-global), then chunk to MAX_BOTS_PER_WORLD by window band so short
 * cells don't ride long worlds.
 */
export function partition(cells: GridCell[]): GridCell[][] {
  const bySig = new Map<string, GridCell[]>();
  for (const c of cells) {
    const sig = JSON.stringify([...(c.mods ?? [])].sort());
    const list = bySig.get(sig) ?? [];
    list.push(c);
    bySig.set(sig, list);
  }

  const batches: GridCell[][] = [];
  for (const group of bySig.values()) {
    // soloWorld cells (journey snapshots) each get a private world: they
    // restore objects with original ids/room names, which cannot share a db.
    const solo = group.filter((c) => c.soloWorld);
    for (const c of solo) batches.push([c]);
    const shared = group.filter((c) => !c.soloWorld);
    const sorted = [...shared].sort((a, b) => a.window - b.window);
    for (let i = 0; i < sorted.length; i += MAX_BOTS_PER_WORLD) {
      batches.push(sorted.slice(i, i + MAX_BOTS_PER_WORLD));
    }
  }
  return batches;
}
