/**
 * scenario.ts — the lab's staged world and its assembly into the engine's
 * EconomyView. Pure and DOM-free: the unit suite drives this file headless,
 * and its scenario files double as engine fixtures (graph-lab requirement
 * #3: round-trip through the editor, checked in, deterministic replays).
 *
 * Assembly is the pure world-assembly step of lab requirement #2: the map
 * is INPUT — real path distances derive here — and the engine still
 * searches ledger space only.
 */
import { EconomyView, ViewCreep } from "../../src/engine/view";

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

export interface Scenario {
  name: string;
  /** SIZE rows of SIZE chars: '.' plain, '#' wall, '~' swamp. */
  terrain: string[];
  spawn: XY;
  /** The designated bank tile — the founding kernel's first branch. */
  bank: XY;
  controller: XY | null;
  sources: ScenarioSource[];
  bankStock: number;
  bodyBudget: number;
  /** Staged initial fleet (cascade B/C worlds stage living creeps). */
  creeps: ViewCreep[];
}

export function emptyTerrain(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < SIZE; y++) rows.push(PLAIN.repeat(SIZE));
  return rows;
}

export function cellAt(terrain: string[], x: number, y: number): string {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return WALL;
  return terrain[y].charAt(x);
}

export function setCell(terrain: string[], x: number, y: number, ch: string): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  terrain[y] = terrain[y].slice(0, x) + ch + terrain[y].slice(x + 1);
}

/**
 * Weighted distance field from one tile over 8-directional movement (the
 * game's geometry), walls blocking, swamp at its cost. Small grid, plain
 * Dijkstra — derived at assembly time, never persisted (piece 4).
 */
export function distanceField(terrain: string[], from: XY): number[][] {
  const dist: number[][] = [];
  for (let y = 0; y < SIZE; y++) dist.push(new Array<number>(SIZE).fill(Infinity));
  if (cellAt(terrain, from.x, from.y) === WALL) return dist;
  dist[from.y][from.x] = 0;
  const queue: XY[] = [from];
  const done: boolean[][] = [];
  for (let y = 0; y < SIZE; y++) done.push(new Array<boolean>(SIZE).fill(false));
  while (queue.length > 0) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) {
      if (dist[queue[i].y][queue[i].x] < dist[queue[bi].y][queue[bi].x]) bi = i;
    }
    const cur = queue.splice(bi, 1)[0];
    if (done[cur.y][cur.x]) continue;
    done[cur.y][cur.x] = true;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const ch = cellAt(terrain, nx, ny);
        if (ch === WALL) continue;
        const nd = dist[cur.y][cur.x] + MOVE_COST[ch];
        if (nd < dist[ny][nx]) {
          dist[ny][nx] = nd;
          queue.push({ x: nx, y: ny });
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

/** Best adjacent approach distance: a source or controller's route cost to the bank. */
function approachDist(dist: number[][], p: XY): number {
  let best = Infinity;
  for (const n of neighbors(p)) {
    if (n.x < 0 || n.y < 0 || n.x >= SIZE || n.y >= SIZE) continue;
    best = Math.min(best, dist[n.y][n.x]);
  }
  return Number.isFinite(best) ? Math.max(best, 1) : SIZE;
}

/** The pure world-assembly step: staged map in, EconomyView out. */
export function assemble(s: Scenario, creeps: ViewCreep[], bankStock: number, tick: number): EconomyView {
  const dist = distanceField(s.terrain, s.bank);
  return {
    tick,
    bank: "bank",
    bankStock,
    bodyBudget: s.bodyBudget,
    spawnIds: ["spawn1"],
    estateRadius: approachDist(dist, s.spawn),
    sources: s.sources.map(src => ({
      id: src.id,
      spots: spotsAt(s.terrain, src),
      distToBank: approachDist(dist, src)
    })),
    controller: s.controller ? { id: "ctrl", distFromBank: approachDist(dist, s.controller) } : null,
    creeps
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
  if (!raw.scenario || !Array.isArray(raw.scenario.terrain) || raw.scenario.terrain.length !== SIZE) {
    throw new Error("not a lab save: bad terrain");
  }
  if (!raw.scenario.spawn || !raw.scenario.bank || !Array.isArray(raw.scenario.sources)) {
    throw new Error("not a lab save: missing elements");
  }
  return {
    scenario: raw.scenario,
    creeps: raw.creeps ?? [],
    bankStock: raw.bankStock ?? raw.scenario.bankStock,
    tick: raw.tick ?? 0,
    cp: raw.cp ?? 0
  };
}
