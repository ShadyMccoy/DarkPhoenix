/**
 * placement.ts — the SPATIAL SEARCH for link stations (owner 2026-08-24:
 * "break the room agnostic rule… perform the spatial search to find the
 * optimal link placements"). Pure and DOM-free, next to the map knowledge
 * it belongs with: world assembly owns the map, the engine still searches
 * ledger space and receives only PRICED wire options.
 *
 * What the search knows that the ledger cannot: link range is CHEBYSHEV
 * and fires through walls (terrain-immune), a pair is legal only within
 * one 50×50 room cell, and a station must stand on a free tile within
 * arm's reach of its place. v0 optimizes station tiles per edge — argmin
 * range subject to room legality; the deeper searches (shared outposts
 * under a link budget, relay chains, border handoffs) build on this.
 */
import { ROOM_SIZE, chebyshev } from "../../src/primitives";
import { Scenario, WALL, XY, cellAt, placeTile } from "./scenario";

export function roomOf(p: XY): string {
  return `R${Math.floor(p.x / ROOM_SIZE)}_${Math.floor(p.y / ROOM_SIZE)}`;
}

function taken(s: Scenario, x: number, y: number): boolean {
  return (
    cellAt(s.terrain, x, y) === WALL ||
    s.links.some(l => l.x === x && l.y === y) ||
    s.sites.some(k => k.x === x && k.y === y) ||
    s.sources.some(k => k.x === x && k.y === y) ||
    s.extensions.some(k => k.x === x && k.y === y) ||
    (s.spawn.x === x && s.spawn.y === y) ||
    (s.bank.x === x && s.bank.y === y) ||
    (s.controller !== null && s.controller.x === x && s.controller.y === y)
  );
}

/** Free tiles within reach 2 of an anchor — a station's legal footprint. */
function footprint(s: Scenario, anchor: XY): XY[] {
  const out: XY[] = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = anchor.x + dx;
      const y = anchor.y + dy;
      if (x < 0 || y < 0 || y >= s.terrain.length || x >= (s.terrain[0]?.length ?? 0)) continue;
      if (!taken(s, x, y)) out.push({ x, y });
    }
  }
  return out;
}

/** A standing link within reach 2 of the anchor, if any. */
function standingNear(s: Scenario, anchor: XY): XY | null {
  const l = s.links.find(k => chebyshev(k, anchor) <= 2);
  return l ? { x: l.x, y: l.y } : null;
}

export interface WireStations {
  mouth: XY;
  hub: XY;
  range: number;
  missingMouth: boolean;
  missingHub: boolean;
}

/**
 * The per-edge search: a HUB station by `toPlace`, a MOUTH station by
 * `fromPlace`, both on free tiles, SAME ROOM, minimizing range. Standing
 * links are reused (their tile is fixed); missing stations pick argmin-
 * range tiles subject to sharing the other station's room — which is
 * exactly where a border-hugging source gets its mouth pulled to the
 * legal side. Null = no legal wire (a border between them, or no tiles).
 */
export function wireStations(s: Scenario, fromPlace: string, toPlace: string): WireStations | null {
  const fromTile = placeTile(s, fromPlace);
  const toTile = placeTile(s, toPlace);
  if (!fromTile || !toTile) return null;

  const standingHub = standingNear(s, toTile);
  const standingMouth = standingNear(s, fromTile);
  const hubChoices = standingHub ? [standingHub] : footprint(s, toTile);
  const mouthChoices = standingMouth ? [standingMouth] : footprint(s, fromTile);

  let best: WireStations | null = null;
  for (const hub of hubChoices) {
    for (const mouth of mouthChoices) {
      if (roomOf(hub) !== roomOf(mouth)) continue;
      const range = Math.max(chebyshev(mouth, hub), 1);
      if (!best || range < best.range) {
        best = { mouth, hub, range, missingMouth: !standingMouth, missingHub: !standingHub };
      }
    }
  }
  return best;
}
