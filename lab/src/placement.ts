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
import { HORIZON, LINK_COST, LINK_LOSS, ROOM_SIZE, SOURCE_RATE, chebyshev } from "../../src/primitives";
import { haulFleetBillEt } from "../../src/sizing";
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

/** A shared station's deterministic tile: near the members' centroid,
 * on a free tile that stands FREE — outside every place's reach-2 mouth
 * zone, so the assembly classifies it as an OUTPOST (its own place, the
 * trunk machinery's precondition), never as some source's mouth. Argmin
 * of the summed collector ranges; the believer re-derives the same
 * answer at build time. */
export function stationTile(s: Scenario, sourceIds: string[]): XY | null {
  const tiles = sourceIds.map(id => placeTile(s, id)).filter((t): t is XY => t !== null);
  if (tiles.length === 0) return null;
  const cx = Math.round(tiles.reduce((a, t) => a + t.x, 0) / tiles.length);
  const cy = Math.round(tiles.reduce((a, t) => a + t.y, 0) / tiles.length);
  const freeStanding = (p: XY): boolean =>
    !taken(s, p.x, p.y) &&
    s.sources.every(k => chebyshev(k, p) > 2) &&
    chebyshev(s.bank, p) > 2 &&
    (s.controller === null || chebyshev(s.controller, p) > 2);
  let best: XY | null = null;
  let bestScore = Infinity;
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      const p = { x: cx + dx, y: cy + dy };
      if (p.x < 0 || p.y < 0 || p.y >= s.terrain.length || p.x >= (s.terrain[0]?.length ?? 0)) continue;
      if (!freeStanding(p)) continue;
      const score = tiles.reduce((a, t) => a + chebyshev(t, p), 0) * 100 + Math.abs(dx) + Math.abs(dy);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

export interface StationPlan {
  id: string;
  tile: XY;
  sources: { id: string; collectRange: number }[];
  range: number;
  missingHub: boolean;
  hubRoom: string;
}

export interface NetworkPlan {
  /** Sources whose whole link is worth spending: private adjacent mouth. */
  mouths: string[];
  /** The branching trees: M1..MN short-haul into one shared station. */
  stations: StationPlan[];
}

/**
 * The NETWORK plan (owner 2026-08-24: the optimal placements form "a
 * sort of branching tree structure with M1..MN hauling to L1 which
 * transfers back to the link at the bank"). Links are SCARCE — the
 * per-RCL allowance, staged as `linkBudget` — so allocation is greedy
 * by VALUE PER LINK: a private mouth (zero haul labor) where a whole
 * link is worth one source, a shared collection station (short
 * collector legs, one sender) where it is not. Capacity binds per
 * sender (800/range ≥ Σ member flow); legality binds per room.
 * Collector legs are Chebyshev-approximated (recorded; real paths when
 * the traffic overlay walks tiles).
 */
export function planNetwork(s: Scenario, srcDistToBank: Record<string, number>): NetworkPlan {
  const budget = s.linkBudget - s.links.length - s.sites.filter(k => k.structure === "link").length;
  const eligible = s.sources.filter(src => wireStations(s, src.id, "bank") !== null);
  const flowOf = (): number => SOURCE_RATE;
  const directBill = (id: string): number => haulFleetBillEt(flowOf(), srcDistToBank[id] ?? 50, false);

  interface Candidate {
    kind: "mouth" | "station";
    sources: string[];
    tile: XY | null;
    range: number;
    collect: Record<string, number>;
    links: number;
    value: number;
  }
  const candidates: Candidate[] = [];
  for (const src of eligible) {
    const w = wireStations(s, src.id, "bank");
    if (!w) continue;
    const links = (w.missingMouth ? 1 : 0) + (w.missingHub ? 1 : 0);
    const value = directBill(src.id) - LINK_LOSS * flowOf() - (links * LINK_COST) / HORIZON;
    candidates.push({ kind: "mouth", sources: [src.id], tile: w.mouth, range: w.range, collect: {}, links, value });
  }
  // Shared stations: pairs/triples of neighbors (Chebyshev ≤ 20 — an
  // ENUMERATION bound only; the collector bills price the legs, so long
  // legs price themselves out). A member whose own contribution is
  // negative (near sources: tax + collector ≥ direct bill) is DROPPED
  // rather than sinking the cluster — a station needs two members that
  // each genuinely pay.
  const seenStations = new Set<string>();
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const group2 = [eligible[i], eligible[j]];
      for (const group of [group2, ...eligible.slice(j + 1).map(third => [...group2, third])]) {
        const tiles = group.map(g => placeTile(s, g.id)).filter((t): t is XY => t !== null);
        if (tiles.length !== group.length) continue;
        if (Math.max(...tiles.map(a => Math.max(...tiles.map(b => chebyshev(a, b))))) > 20) continue;
        const allIds = group.map(g => g.id).sort();
        const tile = stationTile(s, allIds);
        if (!tile) continue;
        const hubW = wireStations(s, group[0].id, "bank");
        if (!hubW || roomOf(tile) !== hubW.hubRoom) continue;
        const range = Math.max(chebyshev(tile, hubW.hub), 1);
        const collect: Record<string, number> = {};
        const kept: string[] = [];
        let memberValue = 0;
        for (const g of group) {
          const t = placeTile(s, g.id);
          const leg = Math.max(chebyshev(t ?? tile, tile), 1);
          const contribution = directBill(g.id) - haulFleetBillEt(flowOf(), leg, false) - LINK_LOSS * flowOf();
          if (contribution <= 0) continue;
          collect[g.id] = leg;
          kept.push(g.id);
          memberValue += contribution;
        }
        if (kept.length < 2) continue;
        const flow = flowOf() * kept.length;
        if (800 / range + 1e-9 < flow) continue;
        const ids = kept.sort();
        const key = ids.join("+");
        if (seenStations.has(key)) continue;
        seenStations.add(key);
        const links = 1 + (hubW.missingHub ? 1 : 0);
        const value = memberValue - (links * LINK_COST) / HORIZON;
        candidates.push({ kind: "station", sources: ids, tile, range, collect, links, value });
      }
    }
  }
  candidates.sort(
    (a, b) => b.value / b.links - a.value / a.links || a.sources.join("+").localeCompare(b.sources.join("+"))
  );

  const used = new Set<string>();
  let left = budget;
  const plan: NetworkPlan = { mouths: [], stations: [] };
  let hubCharged = s.links.some(l => chebyshev(l, s.bank) <= 2);
  for (const c of candidates) {
    if (c.value <= 0 || c.sources.some(id => used.has(id))) continue;
    const needed = c.links - (hubCharged && c.links > 1 ? 1 : 0);
    if (needed > left) continue;
    left -= needed;
    if (needed >= c.links && c.links > 1) hubCharged = true;
    for (const id of c.sources) used.add(id);
    if (c.kind === "mouth") plan.mouths.push(c.sources[0]);
    else {
      const w = wireStations(s, c.sources[0], "bank");
      plan.stations.push({
        id: `station:${c.sources.join("+")}`,
        tile: c.tile as XY,
        sources: c.sources.map(id => ({ id, collectRange: c.collect[id] })),
        range: c.range,
        missingHub: w?.missingHub ?? true,
        hubRoom: w?.hubRoom ?? roomOf(c.tile as XY)
      });
    }
  }
  return plan;
}
