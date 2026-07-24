/**
 * extension-sim/highways - reserved through-traffic patterns for the refill
 * board.
 *
 * A highway is a WALKABLE, UNBUILDABLE tile (see Layout.reserved / engine.ts):
 * general creep traffic and spawn egress route along it, so the extension
 * field must NOT build on it. Feeding these into the evolver / gallery makes
 * the refill fitness pay the cost the README flagged as unmodeled - "guest
 * traffic and spawn-egress tiles are placement constraints this fitness does
 * not model" (README finding #8) - by carving arteries the field must route
 * around.
 *
 * The board is 30x30 with STORAGE at (6,15); the extension field grows roughly
 * x in [3,19], y in [7,23] around it (see evolve.randomGenome), so the arteries
 * below are drawn to actually bisect that field, not miss it.
 */
import { Pos, STORAGE } from "./engine";

export type HighwayPattern = "none" | "spine" | "cross" | "comb";
export const HIGHWAY_PATTERNS: HighwayPattern[] = ["none", "spine", "cross", "comb"];

const inBounds = (p: Pos, size: number): boolean => p.x >= 1 && p.y >= 1 && p.x < size - 1 && p.y < size - 1;
const isStorage = (p: Pos): boolean => p.x === STORAGE.x && p.y === STORAGE.y;

/** A horizontal artery along the storage row, running east across the field. */
function spine(size: number): Pos[] {
  const out: Pos[] = [];
  for (let x = STORAGE.x + 2; x < size - 1; x += 1) out.push({ x, y: STORAGE.y });
  return out;
}

/** The spine plus a vertical avenue crossing it - divides the field in four. */
function cross(size: number): Pos[] {
  const out = spine(size);
  const ax = STORAGE.x + 7;
  for (let y = STORAGE.y - 8; y <= STORAGE.y + 8; y += 1) out.push({ x: ax, y });
  return out;
}

/** A comb of vertical avenues every `period` columns across the field - the
 * "highways for general traffic, extensions squeeze into the avenues between"
 * shape. Extensions can pack the columns between arteries, cul-de-sac style. */
function comb(size: number, period = 4): Pos[] {
  const out: Pos[] = [];
  for (let x = STORAGE.x + 4; x < size - 2; x += period) {
    for (let y = STORAGE.y - 8; y <= STORAGE.y + 8; y += 1) out.push({ x, y });
  }
  return out;
}

/** Reserved tiles for a named pattern, de-duplicated, in bounds, never on the
 * storage tile. */
export function highwayTiles(pattern: HighwayPattern, size = 30): Pos[] {
  const raw = pattern === "spine" ? spine(size) : pattern === "cross" ? cross(size) : pattern === "comb" ? comb(size) : [];
  const seen = new Set<string>();
  const out: Pos[] = [];
  for (const p of raw) {
    const k = `${p.x},${p.y}`;
    if (seen.has(k) || isStorage(p) || !inBounds(p, size)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
