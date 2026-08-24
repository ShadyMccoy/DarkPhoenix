/**
 * scenario.ts — the lab's staged world and its assembly into the engine's
 * EconomyView. Pure and DOM-free: the unit suite drives this file headless,
 * and its scenario files double as engine fixtures (graph-lab requirement
 * #3: round-trip through the editor, checked in, deterministic replays).
 *
 * Maps are any size (owner 2026-08-23). The room-agnostic ruling was
 * AMENDED (owner 2026-08-24): rooms enter as 50×50 LINK-LEGALITY cells
 * — a link pair stands only within one room, its range is Chebyshev and
 * terrain-immune, and lab/src/placement.ts searches station tiles. All
 * other structure stays map-derived; walls remain editor terrain.
 *
 * Assembly is the pure world-assembly step of lab requirement #2: the map
 * is INPUT — real path distances derive here — and the engine still
 * searches ledger space only. A free-standing link (near no known place)
 * becomes an OUTPOST: its own place, a collection branch the broker may
 * route through (owner 2026-08-23: "consolidate multiple haul routes into
 * one link outpost").
 */
import { BankBranchKind, EXTENSION_CAPACITY } from "../../src/primitives";
import {
  EconomyView,
  ViewCreep,
  ViewLink,
  ViewOutpost,
  ViewSite,
  ViewStationOption,
  ViewWireOption
} from "../../src/engine/view";
import { StructureKind } from "../../src/engine/vocabulary";
import { planNetwork, roomOf as placementRoomOf, wireStations as placementWireStations } from "./placement";

/** Default dimensions for a fresh map — not a bound. */
export const SIZE = 50;
export const PLAIN = ".";
export const WALL = "#";
export const SWAMP = "~";
/** Move cost per tile for a full-speed body: plain 1, swamp 5. */
const MOVE_COST: Record<string, number> = { [PLAIN]: 1, [SWAMP]: 5 };

export interface XY {
  x: number;
  y: number;
}

export interface ScenarioSource {
  id: string;
  x: number;
  y: number;
}

export interface ScenarioLink {
  id: string;
  x: number;
  y: number;
}

/** An open construction site — world state; progress survives a reset. */
export interface ScenarioSite {
  id: string;
  structure: StructureKind;
  x: number;
  y: number;
  /** Full project capex — the constant rate base. */
  total: number;
  remaining: number;
  /** The edge whose approval created it, when it serves one. */
  edge?: { from: string; to: string };
}

export interface Scenario {
  name: string;
  /** Rows of '.', '#', '~'. Height = rows, width = row length. */
  terrain: string[];
  spawn: XY;
  /** The designated bank tile — the founding kernel's first branch. */
  bank: XY;
  controller: XY | null;
  sources: ScenarioSource[];
  /** Standing link structures — placed by hand or built by the build
   * corp when a site completes. */
  links: ScenarioLink[];
  /** Open construction sites — placed on plan approvals, burned down by
   * the build corp, realized into structures at zero remaining. */
  sites: ScenarioSite[];
  /** Standing extensions — each adds EXTENSION_CAPACITY to the estate's
   * body budget (Tier 1.2: bodyBudget is endogenous). */
  extensions: XY[];
  /** Ground containers standing at PORT places — the haul-fed trunk's
   * arrival buffer (Addendum 4: the port's mouth). The bank's own kernel
   * branch stays `bankBranch`; these are the link corp's capital. */
  containers?: XY[];
  /** The bank's physical branch at the kernel — a pile until the ladder's
   * capex clears (Tier 1.3). */
  bankBranch: BankBranchKind;
  /** Paved routes between places (Tier 1.4) — the roaded reprice; tiles
   * stay the editor's business, the model prices the route. */
  roads: { from: string; to: string }[];
  bankStock: number;
  bodyBudget: number;
  /** The estate's link allowance — the per-RCL scarcity, staged (RCL8
   * grants 6). The network plan allocates these greedily. */
  linkBudget: number;
  /** Staged initial fleet (cascade B/C worlds stage living creeps). */
  creeps: ViewCreep[];
}

export function mapHeight(terrain: string[]): number {
  return terrain.length;
}

export function mapWidth(terrain: string[]): number {
  return terrain.length > 0 ? terrain[0].length : 0;
}

export function emptyTerrain(width = SIZE, height = SIZE): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) rows.push(PLAIN.repeat(width));
  return rows;
}

export function cellAt(terrain: string[], x: number, y: number): string {
  if (y < 0 || y >= terrain.length) return WALL;
  const row = terrain[y];
  if (x < 0 || x >= row.length) return WALL;
  return row.charAt(x);
}

export function setCell(terrain: string[], x: number, y: number, ch: string): void {
  if (y < 0 || y >= terrain.length) return;
  const row = terrain[y];
  if (x < 0 || x >= row.length) return;
  terrain[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

/** Pad or crop to new dimensions, top-left anchored, preserving content. */
export function resizeTerrain(terrain: string[], width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    const row = y < terrain.length ? terrain[y] : "";
    rows.push(row.length >= width ? row.slice(0, width) : row + PLAIN.repeat(width - row.length));
  }
  return rows;
}

/**
 * Weighted distance field from one tile over 8-directional movement (the
 * game's geometry), walls blocking, swamp at its cost. Integer costs, so
 * Dial's bucket queue keeps it linear in cells — fast enough to replan on
 * every editor click at large map sizes.
 */
export function distanceField(terrain: string[], from: XY): number[][] {
  const h = mapHeight(terrain);
  const w = mapWidth(terrain);
  const dist: number[][] = [];
  for (let y = 0; y < h; y++) dist.push(new Array<number>(w).fill(Infinity));
  if (from.y < 0 || from.y >= h || from.x < 0 || from.x >= w) return dist;
  if (cellAt(terrain, from.x, from.y) === WALL) return dist;
  dist[from.y][from.x] = 0;
  const buckets: XY[][] = [[{ x: from.x, y: from.y }]];
  for (let d = 0; d < buckets.length; d++) {
    const bucket = buckets[d];
    if (!bucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      const cur = bucket[i];
      if (dist[cur.y][cur.x] !== d) continue;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cur.x + dx;
          const ny = cur.y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ch = terrain[ny].charAt(nx);
          if (ch === WALL) continue;
          const nd = d + MOVE_COST[ch];
          if (nd < dist[ny][nx]) {
            dist[ny][nx] = nd;
            while (buckets.length <= nd) buckets.push([]);
            buckets[nd].push({ x: nx, y: ny });
          }
        }
      }
    }
  }
  return dist;
}

function neighbors(p: XY): XY[] {
  const out: XY[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      out.push({ x: p.x + dx, y: p.y + dy });
    }
  }
  return out;
}

/** Walkable tiles adjacent to a cell — a source's standing room. */
export function spotsAt(terrain: string[], p: XY): number {
  return neighbors(p).filter(n => cellAt(terrain, n.x, n.y) !== WALL).length;
}

/** Best adjacent approach distance: an element's route cost to the field's
 * origin. */
export function approachDist(dist: number[][], p: XY): number {
  const h = dist.length;
  const w = h > 0 ? dist[0].length : 0;
  let best = Infinity;
  for (const n of neighbors(p)) {
    if (n.x < 0 || n.y < 0 || n.x >= w || n.y >= h) continue;
    best = Math.min(best, dist[n.y][n.x]);
  }
  return Number.isFinite(best) ? Math.max(best, 1) : w + h;
}

/** A place id's tile on the staged map — the same knowledge assemble()
 * mints the ids from; one home, shared by the believer and assembly. */
export function placeTile(s: Scenario, place: string): XY | null {
  if (place === "bank") return s.bank;
  if (place === "ctrl") return s.controller;
  if (place.indexOf("outpost:") === 0) {
    const l = s.links.find(k => `outpost:${k.id}` === place);
    return l ? { x: l.x, y: l.y } : null;
  }
  if (place.indexOf("site:") === 0) {
    const site = s.sites.find(k => `site:${k.id}` === place);
    return site ? { x: site.x, y: site.y } : null;
  }
  const src = s.sources.find(k => k.id === place);
  return src ? { x: src.x, y: src.y } : null;
}

/** Which place a link tile serves: the bank, a source, or the controller
 * within short reach — otherwise it stands free and becomes an OUTPOST,
 * its own place. */
export function linkPlace(s: Scenario, link: ScenarioLink): string | null {
  const near = (p: XY | null): boolean => !!p && Math.max(Math.abs(p.x - link.x), Math.abs(p.y - link.y)) <= 2;
  if (near(s.bank)) return "bank";
  for (const src of s.sources) if (near(src)) return src.id;
  if (near(s.controller)) return "ctrl";
  return null;
}

/** The pure world-assembly step: staged map in, EconomyView out. */
export function assemble(s: Scenario, creeps: ViewCreep[], bankStock: number, tick: number): EconomyView {
  const dist = distanceField(s.terrain, s.bank);
  // Rooms are link-legality cells (owner 2026-08-24) — the placement
  // module owns the geometry; assembly just tags what it exposes.
  const links: ViewLink[] = [];
  const outposts: ViewOutpost[] = [];
  for (const l of s.links) {
    const at = linkPlace(s, l);
    const room = placementRoomOf({ x: l.x, y: l.y });
    if (at) {
      links.push({ id: l.id, at, room, x: l.x, y: l.y });
      continue;
    }
    // Free-standing: an outpost — its own place, with the collector legs
    // priced by real paths. Its trunk pair, range, and ration are the
    // ENGINE's business (linkPair picks the legal closest bank hub) —
    // an assembly-minted range from the first-found hub was off-room at
    // the border bank and shed a paying member (owner 2026-08-24).
    const place = `outpost:${l.id}`;
    links.push({ id: l.id, at: place, room, x: l.x, y: l.y });
    const field = distanceField(s.terrain, { x: l.x, y: l.y });
    const distToSource: Record<string, number> = {};
    for (const src of s.sources) distToSource[src.id] = approachDist(field, src);
    // The port's mouth, stated by ONE lens (spec 56: four range-2 scans
    // deadlocked v1's buffer forever — the predicate lives here alone).
    const hasContainer = (s.containers ?? []).some(
      c => Math.max(Math.abs(c.x - l.x), Math.abs(c.y - l.y)) <= 2
    );
    outposts.push({ place, distToSource, hasContainer });
  }

  // The NETWORK plan (owner 2026-08-24): links are scarce, so the
  // search allocates them — private mouths where a whole link is worth
  // one source, shared collection stations (the branching tree) where
  // it is not. Mouth-assigned sources get per-edge wire options; tree
  // members get their station; everyone else stays on bodies.
  const srcDistToBank: Record<string, number> = {};
  for (const src of s.sources) srcDistToBank[src.id] = approachDist(dist, src);
  const net = planNetwork(s, srcDistToBank);
  const wireOptions: ViewWireOption[] = [];
  for (const id of net.mouths) {
    const w = placementWireStations(s, id, "bank");
    if (w) wireOptions.push({ from: id, to: "bank", range: w.range, missingMouth: w.missingMouth, missingHub: w.missingHub, hubRoom: w.hubRoom });
  }
  if (s.controller) {
    const w = placementWireStations(s, "bank", "ctrl");
    if (w) wireOptions.push({ from: "bank", to: "ctrl", range: w.range, missingMouth: w.missingMouth, missingHub: w.missingHub, hubRoom: w.hubRoom });
  }
  const stationOptions: ViewStationOption[] = net.stations.map(st => ({
    id: st.id,
    sources: st.sources,
    range: st.range,
    missingHub: st.missingHub,
    hubRoom: st.hubRoom
  }));
  // A site within arm's reach of the bank IS the bank's place — its burn
  // meets the bank's supply with no transport stage; anywhere else it is
  // its own place the transport market must cover.
  const sites: ViewSite[] = s.sites.map(site => {
    const d = approachDist(dist, site);
    return {
      id: site.id,
      structure: site.structure,
      at: d <= 1 ? "bank" : `site:${site.id}`,
      dist: d,
      total: site.total,
      remaining: site.remaining,
      edge: site.edge
    };
  });
  // Paved routes carry their real path cost; an unresolvable endpoint
  // (erased element) simply drops the road from the view.
  const roads: { from: string; to: string; dist: number }[] = [];
  for (const r of s.roads) {
    const a = placeTile(s, r.from);
    const b = placeTile(s, r.to);
    if (!a || !b) continue;
    roads.push({ from: r.from, to: r.to, dist: approachDist(distanceField(s.terrain, a), b) });
  }

  // The estate: the scenario's staged base capacity plus what standing
  // extensions add; its radius is the FARTHEST refill stop — a spread
  // estate raises the heartbeat's price (roadmap Tier 1.2).
  const estateStops = [s.spawn, ...s.extensions];
  return {
    tick,
    bank: "bank",
    bankStock,
    bankBranch: s.bankBranch,
    bodyBudget: s.bodyBudget + EXTENSION_CAPACITY * s.extensions.length,
    spawnIds: ["spawn1"],
    estateRadius: Math.max(...estateStops.map(p => approachDist(dist, p))),
    sources: s.sources.map(src => ({
      id: src.id,
      spots: spotsAt(s.terrain, src),
      distToBank: approachDist(dist, src)
    })),
    controller: s.controller ? { id: "ctrl", distFromBank: approachDist(dist, s.controller) } : null,
    creeps,
    links,
    outposts,
    sites,
    roads,
    wireOptions,
    stationOptions,
    linkBudget: s.linkBudget
  };
}

export interface LabSave {
  scenario: Scenario;
  creeps: ViewCreep[];
  bankStock: number;
  tick: number;
  cp: number;
}

export function exportSave(save: LabSave): string {
  return JSON.stringify(save, null, 2);
}

export function importSave(text: string): LabSave {
  const raw = JSON.parse(text) as LabSave;
  if (!raw.scenario || !Array.isArray(raw.scenario.terrain) || raw.scenario.terrain.length === 0) {
    throw new Error("not a lab save: bad terrain");
  }
  const w = raw.scenario.terrain[0].length;
  if (w === 0 || raw.scenario.terrain.some(row => row.length !== w)) {
    throw new Error("not a lab save: ragged terrain");
  }
  if (!raw.scenario.spawn || !raw.scenario.bank || !Array.isArray(raw.scenario.sources)) {
    throw new Error("not a lab save: missing elements");
  }
  raw.scenario.links = raw.scenario.links ?? [];
  raw.scenario.sites = raw.scenario.sites ?? [];
  raw.scenario.extensions = raw.scenario.extensions ?? [];
  raw.scenario.containers = raw.scenario.containers ?? [];
  raw.scenario.bankBranch = raw.scenario.bankBranch ?? "pile";
  raw.scenario.roads = raw.scenario.roads ?? [];
  raw.scenario.linkBudget = raw.scenario.linkBudget ?? 6;
  return {
    scenario: raw.scenario,
    creeps: raw.creeps ?? [],
    bankStock: raw.bankStock ?? raw.scenario.bankStock,
    tick: raw.tick ?? 0,
    cp: raw.cp ?? 0
  };
}
