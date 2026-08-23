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
import { HORIZON, LINK_CAPACITY, LINK_COST, LINK_LOSS, ROOM_SIZE, SOURCE_RATE, chebyshev } from "../../src/primitives";
import { haulFleetBillEt } from "../../src/sizing";
import { Scenario, WALL, XY, approachDist, cellAt, distanceField, placeTile } from "./scenario";

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

/** A station tile stands FREE — outside every place's reach-2 mouth
 * zone, so the assembly classifies the built link as an OUTPOST (its
 * own place, the trunk machinery's precondition), never as some
 * source's mouth. */
function freeStanding(s: Scenario, p: XY): boolean {
  return (
    !taken(s, p.x, p.y) &&
    s.sources.every(k => chebyshev(k, p) > 2) &&
    chebyshev(s.bank, p) > 2 &&
    (s.controller === null || chebyshev(s.controller, p) > 2)
  );
}

export interface StationMember {
  id: string;
  collectRange: number;
  /** Displaced hauling: the member's direct fleet bill minus its
   * collector leg and the trunk's tax on its flow. */
  saving: number;
}

export interface StationSearchResult {
  tile: XY;
  members: StationMember[];
  hub: XY;
  hubRoom: string;
  missingHub: boolean;
  range: number;
}

/**
 * The station search, objective = DISPLACED HAULING (owner 2026-08-24:
 * a marginal member shed by the tile choice "would be leaving link
 * transfer capacity on the table — we could displace more hauling with
 * a better placement"). Argmax over free-standing tiles of the summed
 * member savings, membership clipped at zero (a member whose direct
 * route is cheaper stays out — "only close ones" opt out) and trimmed
 * to the trunk's ration by merit. The old argmin-summed-ranges tile was
 * blind to the economics: the fleet bill is a staircase, so range ties
 * are wide, and its centroid tiebreak split legs evenly — pricing out
 * marginal members one CARRY pair from paying. Room legality is INSIDE
 * the search (the trunk needs a same-room bank hub), never a post-hoc
 * veto of a tile chosen blind. Deterministic: the believer re-derives
 * the same answer at build time.
 */
export function stationSearch(s: Scenario, sourceIds: string[], bankField?: number[][]): StationSearchResult | null {
  const tiles = sourceIds
    .map(id => ({ id, tile: placeTile(s, id) }))
    .filter((t): t is { id: string; tile: XY } => t.tile !== null);
  if (tiles.length < 2) return null;
  const flow = SOURCE_RATE;
  // The bank field is identical for every group — planNetwork computes
  // it once and passes it (an O(groups) full-map Dijkstra pileup was
  // the review's one HIGH: ~1s of assembly at 20 clustered sources).
  const field = bankField ?? distanceField(s.terrain, s.bank);
  const directBill = new Map<string, number>(
    tiles.map(t => [t.id, haulFleetBillEt(flow, approachDist(field, t.tile), false)])
  );
  // Bank-side hub choices, the wireStations rule: standing links first
  // (zero capex), then free footprint tiles.
  const hubChoices: { tile: XY; missing: boolean }[] = [
    ...standingsNear(s, s.bank).map(tile => ({ tile, missing: false })),
    ...footprint(s, s.bank).map(tile => ({ tile, missing: true }))
  ];

  // The box spans the members AND the bank: a cluster sitting wholly
  // across a room border from every hub has its only LEGAL tiles on the
  // bank's side of the line — a member-only box never reaches them and
  // a paying station dies unsearched (review finding).
  const w = s.terrain[0]?.length ?? 0;
  const h = s.terrain.length;
  const anchors = [...tiles.map(t => t.tile), s.bank];
  const minX = Math.max(Math.min(...anchors.map(a => a.x)) - 3, 0);
  const maxX = Math.min(Math.max(...anchors.map(a => a.x)) + 3, w - 1);
  const minY = Math.max(Math.min(...anchors.map(a => a.y)) - 3, 0);
  const maxY = Math.min(Math.max(...anchors.map(a => a.y)) + 3, h - 1);

  let best: StationSearchResult | null = null;
  let bestValue = 0;
  let bestLegs = Infinity;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = { x, y };
      if (!freeStanding(s, p)) continue;
      // The trunk partner for THIS tile's room, cost-aware.
      let hub: { tile: XY; missing: boolean } | null = null;
      let hubCost = Infinity;
      for (const c of hubChoices) {
        if (roomOf(c.tile) !== roomOf(p)) continue;
        const cost = (c.missing ? 1e6 : 0) + chebyshev(p, c.tile);
        if (cost < hubCost) {
          hubCost = cost;
          hub = c;
        }
      }
      if (!hub) continue;
      const range = Math.max(chebyshev(p, hub.tile), 1);
      const kept: StationMember[] = [];
      for (const t of tiles) {
        const leg = Math.max(chebyshev(t.tile, p), 1);
        const saving = (directBill.get(t.id) ?? 0) - haulFleetBillEt(flow, leg, false) - LINK_LOSS * flow;
        if (saving > 0) kept.push({ id: t.id, collectRange: leg, saving });
      }
      // Merit-trim to the sender's ration: the smallest saving yields.
      kept.sort((a, b) => b.saving - a.saving || (a.id < b.id ? -1 : 1));
      while (kept.length > 0 && kept.length * flow > LINK_CAPACITY / range + 1e-9) kept.pop();
      if (kept.length < 2) continue;
      const value = kept.reduce((a, m) => a + m.saving, 0);
      const legs = kept.reduce((a, m) => a + m.collectRange, 0);
      if (value > bestValue + 1e-9 || (value > bestValue - 1e-9 && legs < bestLegs)) {
        bestValue = value;
        bestLegs = legs;
        best = { tile: p, members: kept, hub: hub.tile, hubRoom: roomOf(hub.tile), missingHub: hub.missing, range };
      }
    }
  }
  return best;
}

/** The searched tile alone — what the believer anchors sites on. */
export function stationTile(s: Scenario, sourceIds: string[]): XY | null {
  return stationSearch(s, sourceIds)?.tile ?? null;
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
    missingHub?: boolean;
    hubRoom?: string;
  }
  const candidates: Candidate[] = [];
  for (const src of eligible) {
    const w = wireStations(s, src.id, "bank");
    if (!w) continue;
    const links = (w.missingMouth ? 1 : 0) + (w.missingHub ? 1 : 0);
    const value = directBill(src.id) - LINK_LOSS * flowOf() - (links * LINK_COST) / HORIZON;
    candidates.push({
      kind: "mouth",
      sources: [src.id],
      tile: w.mouth,
      range: w.range,
      collect: {},
      links,
      value,
      missingHub: w.missingHub,
      hubRoom: w.hubRoom
    });
  }
  // Shared stations: pairs/triples of neighbors (Chebyshev ≤ 20 — an
  // ENUMERATION bound only; the collector bills price the legs, so long
  // legs price themselves out). Enumeration runs over ALL sources — a
  // member needs no private mouth pair of its own, only the station's
  // tile room does. Membership, tile, hub, and the ration trim all come
  // from stationSearch — ONE owner of the displacement arithmetic.
  const seenStations = new Set<string>();
  const bankField = distanceField(s.terrain, s.bank);
  for (let i = 0; i < s.sources.length; i++) {
    for (let j = i + 1; j < s.sources.length; j++) {
      const group2 = [s.sources[i], s.sources[j]];
      for (const group of [group2, ...s.sources.slice(j + 1).map(third => [...group2, third])]) {
        const tiles = group.map(g => placeTile(s, g.id)).filter((t): t is XY => t !== null);
        if (tiles.length !== group.length) continue;
        if (Math.max(...tiles.map(a => Math.max(...tiles.map(b => chebyshev(a, b))))) > 20) continue;
        let search = stationSearch(
          s,
          group.map(g => g.id).sort(),
          bankField
        );
        if (!search) continue;
        let ids = search.members.map(m => m.id).sort();
        // The candidate is registered under its KEPT members — so its
        // geometry must be the kept set's OWN search, the same call the
        // believer re-derives from the approval id. A full-group tile
        // for a trimmed membership diverged at build time (review
        // finding); a set that won't hold still is no candidate.
        if (ids.length !== group.length) {
          search = stationSearch(s, ids, bankField);
          if (!search) continue;
          const again = search.members.map(m => m.id).sort();
          if (again.join("+") !== ids.join("+")) continue;
          ids = again;
        }
        const key = ids.join("+");
        if (seenStations.has(key)) continue;
        seenStations.add(key);
        const collect: Record<string, number> = {};
        let memberValue = 0;
        for (const m of search.members) {
          collect[m.id] = m.collectRange;
          memberValue += m.saving;
        }
        const links = 1 + (search.missingHub ? 1 : 0);
        const value = memberValue - (links * LINK_COST) / HORIZON;
        candidates.push({
          kind: "station",
          sources: ids,
          tile: search.tile,
          range: search.range,
          collect,
          links,
          value,
          missingHub: search.missingHub,
          hubRoom: search.hubRoom
        });
      }
    }
  }
  candidates.sort(
    (a, b) => b.value / b.links - a.value / a.links || a.sources.join("+").localeCompare(b.sources.join("+"))
  );

  const used = new Set<string>();
  let left = budget;
  const plan: NetworkPlan = { mouths: [], stations: [] };
  // Hub sharing is PER ROOM (a border bank keeps one hub per side): a
  // global flag let a candidate needing a fresh hub in room B ride free
  // on room A's — a two-link project debited one budget slot (review
  // finding). A candidate whose room already has a standing hub carries
  // missingHub=false and charges nothing here by construction.
  const hubPaid = new Set<string>();
  for (const c of candidates) {
    if (c.value <= 0 || c.sources.some(id => used.has(id))) continue;
    const shared = (c.missingHub ?? false) && c.hubRoom !== undefined && hubPaid.has(c.hubRoom);
    const needed = c.links - (shared ? 1 : 0);
    if (needed > left) continue;
    left -= needed;
    if ((c.missingHub ?? false) && !shared && c.hubRoom !== undefined) hubPaid.add(c.hubRoom);
    for (const id of c.sources) used.add(id);
    if (c.kind === "mouth") plan.mouths.push(c.sources[0]);
    else {
      plan.stations.push({
        id: `station:${c.sources.join("+")}`,
        tile: c.tile as XY,
        sources: c.sources.map(id => ({ id, collectRange: c.collect[id] })),
        range: c.range,
        missingHub: c.missingHub ?? true,
        hubRoom: c.hubRoom ?? roomOf(c.tile as XY)
      });
    }
  }
  return plan;
}
