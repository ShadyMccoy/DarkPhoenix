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

/** ALL standing links within reach 2 of the anchor — every one is a
 * zero-capex reuse choice (returning only the first built duplicate
 * hubs beside legal ones, caught in the wide-world run). */
function standingsNear(s: Scenario, anchor: XY): XY[] {
  return s.links.filter(k => chebyshev(k, anchor) <= 2).map(k => ({ x: k.x, y: k.y }));
}

export interface WireStations {
  mouth: XY;
  hub: XY;
  hubRoom: string;
  range: number;
  missingMouth: boolean;
  missingHub: boolean;
}

/**
 * The per-edge search: a HUB station by `toPlace`, a MOUTH station by
 * `fromPlace`, both on free tiles, SAME ROOM. Choice is COST-AWARE
 * lexicographic: fewest stations still to build, then minimum range —
 * so standing links are reused when a legal pair forms through them,
 * but never LOCK the edge out (a bank on a border keeps one hub per
 * side: a standing west-side hub must not doom every east-room source
 * to bodies — the flaw the first cut had). A border-hugging place gets
 * its station pulled to the legal side the same way. Null = no legal
 * wire at all.
 */
export function wireStations(s: Scenario, fromPlace: string, toPlace: string): WireStations | null {
  const fromTile = placeTile(s, fromPlace);
  const toTile = placeTile(s, toPlace);
  if (!fromTile || !toTile) return null;

  const hubChoices: { tile: XY; missing: boolean }[] = [
    ...standingsNear(s, toTile).map(tile => ({ tile, missing: false })),
    ...footprint(s, toTile).map(tile => ({ tile, missing: true }))
  ];
  const mouthChoices: { tile: XY; missing: boolean }[] = [
    ...standingsNear(s, fromTile).map(tile => ({ tile, missing: false })),
    ...footprint(s, fromTile).map(tile => ({ tile, missing: true }))
  ];

  let best: WireStations | null = null;
  let bestCost = Infinity;
  for (const hub of hubChoices) {
    for (const mouth of mouthChoices) {
      if (roomOf(hub.tile) !== roomOf(mouth.tile)) continue;
      const range = Math.max(chebyshev(mouth.tile, hub.tile), 1);
      const cost = ((hub.missing ? 1 : 0) + (mouth.missing ? 1 : 0)) * 1e6 + range;
      if (cost < bestCost) {
        bestCost = cost;
        best = {
          mouth: mouth.tile,
          hub: hub.tile,
          hubRoom: roomOf(hub.tile),
          range,
          missingMouth: mouth.missing,
          missingHub: hub.missing
        };
      }
    }
  }
  return best;
}
