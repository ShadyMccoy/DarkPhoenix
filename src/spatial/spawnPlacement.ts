/**
 * @fileoverview Spawn placement for a fresh room.
 *
 * The natural "a player would plant here" spot: the open plain tile (all 8
 * neighbours plain) nearest the centroid of the room's sources and
 * controller, clear of the objects themselves. Used by the real-map sim
 * harness today and by expansion (spec 06) when the bot claims rooms itself.
 *
 * Pure over a row-major terrain representation (50 strings of '.', '#', '~')
 * so it unit-tests without a live room; in-game callers build the rows from
 * Game.map.getRoomTerrain once per candidate room.
 *
 * @module spatial/spawnPlacement
 */

export interface RoomPoint {
  x: number;
  y: number;
}

/** Terrain rows from the live game API for a room. */
export function terrainRows(terrain: { get(x: number, y: number): number }): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 50; y++) {
    let row = "";
    for (let x = 0; x < 50; x++) {
      const t = terrain.get(x, y);
      row += t & 1 ? "#" : t & 2 ? "~" : ".";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The best spawn tile for a room, or null when no open plain tile exists
 * (pathological rooms; caller decides the fallback).
 *
 * `anchors` are the positions the spawn wants to be near (sources +
 * controller); `avoid` are positions the spawn must keep 2+ tiles clear of
 * (typically the same objects, so the spawn blocks no harvest/upgrade tile).
 */
export function pickSpawnSpot(terrain: string[], anchors: RoomPoint[], avoid: RoomPoint[] = anchors): RoomPoint | null {
  const cx = anchors.length ? anchors.reduce((s, o) => s + o.x, 0) / anchors.length : 25;
  const cy = anchors.length ? anchors.reduce((s, o) => s + o.y, 0) / anchors.length : 25;
  const plain = (x: number, y: number): boolean => x >= 0 && x < 50 && y >= 0 && y < 50 && terrain[y][x] === ".";

  let best: RoomPoint | null = null;
  let bestD = Infinity;
  for (let y = 3; y < 47; y++) {
    for (let x = 3; x < 47; x++) {
      if (!plain(x, y)) continue;
      let open = true;
      for (let dx = -1; dx <= 1 && open; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!plain(x + dx, y + dy)) {
            open = false;
            break;
          }
        }
      }
      if (!open || avoid.some(o => Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) < 2)) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * BFS walk distance (8-directional, walls impassable) from `from` to range 1
 * of `to`. Infinity when unreachable - the signal that a source sits behind a
 * wall (tunnel candidate) or the spot is sealed. Pure; used by the fixture
 * index and by placement sanity checks.
 */
export function walkDistance(terrain: string[], from: RoomPoint, to: RoomPoint): number {
  const passable = (x: number, y: number): boolean => x >= 0 && x < 50 && y >= 0 && y < 50 && terrain[y][x] !== "#";
  if (!passable(from.x, from.y)) return Infinity;
  const dist = new Map<number, number>([[from.y * 50 + from.x, 0]]);
  const queue: RoomPoint[] = [from];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    const d = dist.get(p.y * 50 + p.x)!;
    if (Math.max(Math.abs(p.x - to.x), Math.abs(p.y - to.y)) <= 1) return d;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (!passable(nx, ny) || dist.has(ny * 50 + nx)) continue;
        dist.set(ny * 50 + nx, d + 1);
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return Infinity;
}
