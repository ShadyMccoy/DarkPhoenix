/**
 * base-lab/geometry - pure, offline terrain geometry for the base-design lab.
 *
 * Everything here works on the canonical fixture terrain representation: a
 * string[] of 50 rows, '#'=wall, '~'=swamp, '.'=plain (loadLayout.ts /
 * capture-rooms.ts). No Game, no PathFinder, no engine - so the whole lab runs
 * as a plain `ts-node -P tsconfig.test.json` script.
 *
 * The a-priori route planner (ConstructionCorp.planTrunkPath) is NOT callable
 * offline (private + needs the PathFinder global), so we reimplement the same
 * idea here: weighted Dijkstra with plain=2 / swamp=10, matching PathFinder's
 * default costs. Good enough for a "where do the highways run" visualization.
 */
export const SIZE = 50;
export type Pt = { x: number; y: number };

export const packTile = (x: number, y: number): number => y * SIZE + x;

export function isWall(terrain: string[], x: number, y: number): boolean {
  return x < 0 || x >= SIZE || y < 0 || y >= SIZE || terrain[y][x] === "#";
}
export function isSwamp(terrain: string[], x: number, y: number): boolean {
  return !isWall(terrain, x, y) && terrain[y][x] === "~";
}
/** PathFinder-default move cost of entering a tile (plain 2, swamp 10). */
export function moveCost(terrain: string[], x: number, y: number): number {
  return isSwamp(terrain, x, y) ? 10 : 2;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1]
];

/** Minimal binary min-heap of (priority, packedTile). */
class MinHeap {
  private p: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.p.length;
  }
  push(priority: number, value: number): void {
    this.p.push(priority);
    this.v.push(value);
    let i = this.p.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.p[parent] <= this.p[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number {
    const top = this.v[0];
    const lastP = this.p.pop()!;
    const lastV = this.v.pop()!;
    if (this.p.length > 0) {
      this.p[0] = lastP;
      this.v[0] = lastV;
      let i = 0;
      const n = this.p.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let small = i;
        if (l < n && this.p[l] < this.p[small]) small = l;
        if (r < n && this.p[r] < this.p[small]) small = r;
        if (small === i) break;
        this.swap(i, small);
        i = small;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.p[a], this.p[b]] = [this.p[b], this.p[a]];
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
  }
}

/**
 * Weighted-Dijkstra route from `from` to range 1 of `to` (so the path ends
 * ADJACENT to the target - the way a creep services a source/controller
 * without standing on it). Returns the tile list including endpoints, or null
 * if unreachable. Costs are PathFinder defaults (plain 2, swamp 10).
 */
export function route(terrain: string[], from: Pt, to: Pt): Pt[] | null {
  const dist = new Float64Array(SIZE * SIZE).fill(Infinity);
  const prev = new Int32Array(SIZE * SIZE).fill(-1);
  const heap = new MinHeap();
  const start = packTile(from.x, from.y);
  dist[start] = 0;
  heap.push(0, start);

  const near = (x: number, y: number): boolean => Math.max(Math.abs(x - to.x), Math.abs(y - to.y)) <= 1;
  let endTile = -1;

  while (heap.size > 0) {
    const cur = heap.pop();
    const cx = cur % SIZE;
    const cy = (cur - cx) / SIZE;
    if (near(cx, cy)) {
      endTile = cur;
      break;
    }
    const cd = dist[cur];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isWall(terrain, nx, ny)) continue;
      const np = packTile(nx, ny);
      const nd = cd + moveCost(terrain, nx, ny);
      if (nd < dist[np]) {
        dist[np] = nd;
        prev[np] = cur;
        heap.push(nd, np);
      }
    }
  }

  if (endTile < 0) return null;
  const path: Pt[] = [];
  for (let t = endTile; t !== -1; t = prev[t]) {
    path.push({ x: t % SIZE, y: (t - (t % SIZE)) / SIZE });
  }
  return path.reverse();
}

/** Packed set of every tile reachable (8-dir, walls block) from `from`. */
export function reachable(terrain: string[], from: Pt): Set<number> {
  const seen = new Set<number>();
  if (isWall(terrain, from.x, from.y)) return seen;
  const queue: number[] = [packTile(from.x, from.y)];
  seen.add(queue[0]);
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const cx = cur % SIZE;
    const cy = (cur - cx) / SIZE;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (isWall(terrain, nx, ny)) continue;
      const np = packTile(nx, ny);
      if (seen.has(np)) continue;
      seen.add(np);
      queue.push(np);
    }
  }
  return seen;
}
