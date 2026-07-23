/**
 * @fileoverview Trunk-road A/Z segmentation (owner directive 2026-07-22:
 * "the road should be split into A and Z construction sites ... A as an
 * aggregate is a project from the home, the Z is an aggregate for a
 * builder+hauler from the source mine, roughly proportionally split according
 * to energy flow").
 *
 * THE LEAK THIS RETIRES: a trunk road is placed as N per-tile construction
 * sites (roads don't hold the build queue), so the flow graph gets N
 * construction sinks and the solver emits ONE micro hauler-edge per (source,
 * tile) pair - 20 sub-0.3-CARRY edges from a single source, measured
 * t72505602 (P2 34/44 routes, P4 inflated ~18% by construction-sink parts).
 * They never materialize as distinct creeps (per-source carry aggregation),
 * but they fragment the plan, the P2/P4 ledger reads, and the solver's work.
 *
 * THE MODEL: a trunk is a corridor from the SOURCE (tiles3 index 0, the mine
 * end) to HOME (the depot/storage end). Two crews build it from opposite
 * ends and meet in the middle, each owning the share of the road its energy
 * can push:
 *   - Z (source end): the source's own mine energy funds a builder+hauler; it
 *     builds the first f_Z share of the remaining work from its end.
 *   - A (home end): the home pool crew (bank-funded tankers) builds the rest.
 * f_Z = sourceRate / (sourceRate + homeSupply) - proportional to energy flow.
 *
 * This module is PURE (no Game/Memory) so the split is unit-pinned; the
 * adapter feeds it the route tiles and the two supply rates.
 *
 * @module economy/roadSegments
 */

/** One standing trunk-road construction tile: its position and unbuilt work. */
export interface RoadTile {
  x: number;
  y: number;
  roomName: string;
  /** progressTotal - progress at last sight (energy still to build here). */
  remaining: number;
}

/** The two aggregate segments a trunk road splits into. */
export interface RoadSegmentSplit {
  /** Source-end tiles (built by the source's builder+hauler). */
  z: RoadTile[];
  /** Home-end tiles (built by the home pool crew from the bank). */
  a: RoadTile[];
  /** The energy-flow fraction assigned to Z (source share). */
  fZ: number;
}

/**
 * Split a trunk road's standing tiles (ordered SOURCE -> HOME, index 0 nearest
 * the mine) into Z (source-end) and A (home-end) segments proportional to the
 * energy each end supplies:
 *
 *   f_Z = sourceRate / (sourceRate + homeSupply)
 *
 * The source builds the first f_Z share of the REMAINING WORK from its end
 * (not tile count - a swamp tile costs more, so work is the honest measure of
 * "how far can this end's energy reach"); the home crew builds the residual.
 * Walking cumulative remaining from the source end, a tile joins Z until the
 * running Z work would EXCEED its target share, then A takes the rest - so the
 * boundary tile lands on whichever side keeps Z at-or-under its energy share
 * (Z never over-commits past what the source can feed).
 *
 * Degenerate inputs collapse sensibly: homeSupply <= 0 -> the source owns the
 * whole road (f_Z = 1, nothing for a bankrupt home to build); sourceRate <= 0
 * -> the home owns it all (f_Z = 0); a single tile is indivisible and goes to
 * the end whose share is larger. Empty input -> empty segments.
 */
export function splitRoadByEnergyFlow(tiles: RoadTile[], sourceRate: number, homeSupply: number): RoadSegmentSplit {
  const src = Math.max(0, sourceRate);
  const home = Math.max(0, homeSupply);
  const denom = src + home;
  // Neither end supplies energy: nothing can build it - all to home by
  // convention (the pool crew is the general contractor of last resort).
  const fZ = denom <= 1e-9 ? 0 : src / denom;

  if (tiles.length === 0) return { z: [], a: [], fZ };
  // A single tile is indivisible: give it to the end with the larger share.
  if (tiles.length === 1) return fZ >= 0.5 ? { z: [tiles[0]], a: [], fZ } : { z: [], a: [tiles[0]], fZ };

  const totalRemaining = tiles.reduce((s, t) => s + Math.max(0, t.remaining), 0);
  if (totalRemaining <= 1e-9) {
    // No work left anywhere (all sites at 0): split by COUNT at f_Z so the
    // aggregate positions still bracket the corridor for the crews.
    const zCount = Math.round(fZ * tiles.length);
    return { z: tiles.slice(0, zCount), a: tiles.slice(zCount), fZ };
  }

  const zTarget = fZ * totalRemaining;
  const z: RoadTile[] = [];
  const a: RoadTile[] = [];
  let zWork = 0;
  for (const tile of tiles) {
    const w = Math.max(0, tile.remaining);
    // A tile joins Z while doing so keeps Z's work at or under its energy
    // share (the source never commits past what its mine can feed). Once the
    // running total would exceed the share, this and every later tile - all
    // NEARER home - belong to the home crew.
    if (a.length === 0 && zWork + w <= zTarget + 1e-9) {
      z.push(tile);
      zWork += w;
    } else {
      a.push(tile);
    }
  }
  // Guard the all-or-nothing ends: if rounding put every tile in one bucket
  // but both ends genuinely supply energy, hand the single boundary tile to
  // the empty end so both crews have a segment to own (a road built from both
  // ends needs two ends).
  if (src > 1e-9 && home > 1e-9) {
    if (z.length === 0) z.push(a.shift()!); // source funded but got nothing: take the mine-most tile
    else if (a.length === 0) a.unshift(z.pop()!); // home funded but got nothing: take the home-most tile
  }
  return { z, a, fZ };
}

/** A per-tile construction site record (the project ledger's shape). */
export interface ConstructionRecord {
  id: string;
  x: number;
  y: number;
  roomName: string;
  structureType: string;
  remaining: number;
}

/** A trunk route's ordered tiles (SOURCE -> HOME) plus the mine's rate. */
export interface TrunkRouteTiles {
  /** Real game source id (no "source-" prefix) - the roadRoutes key. */
  sourceId: string;
  /** Tiles in build order, index 0 nearest the mine. */
  tiles: { x: number; y: number; roomName: string }[];
  /** The source's mine rate (e/t) - the energy the Z end can push. */
  sourceRate: number;
}

/** A construction sink to admit to the flow graph (aggregate OR passthrough). */
export interface AdmittedConstruction {
  id: string;
  x: number;
  y: number;
  roomName: string;
  remaining: number;
}

/** Positional key for matching a record to a route tile. */
const tileKey = (x: number, y: number, roomName: string): string => `${roomName}:${x},${y}`;

/**
 * Collapse each trunk road's per-tile construction sites into TWO aggregate
 * sinks - Z (source end) and A (home end) - split by energy flow
 * ({@link splitRoadByEnergyFlow}). Everything that is NOT a matched trunk-road
 * tile (extensions, containers, towers, in-room roads, and any trunk with a
 * single standing tile) passes through per-site unchanged.
 *
 * This is the fragmentation cure (owner 2026-07-22): a 20-tile trunk stops
 * being 20 sinks (-> 20 micro hauler-edges) and becomes 2 sinks -> one
 * source->Z edge (the source's builder+hauler) and one home A project (the
 * pool crew). The aggregate positions bracket the corridor - Z at the
 * mine-most standing tile, A at the home-most - so the adapter's spec-25
 * cluster test (nearer-source-than-hub) classifies Z to the source cluster
 * and A to the pool with no further change.
 *
 * Pure: the caller resolves routes/rates from Game and the home bank surplus.
 * Aggregate ids are deterministic (`road-{Z|A}-{sourceId}`) so a corp's
 * allocation is stable across ticks (a churned id would orphan its crew).
 */
export function aggregateTrunkRoadSinks(
  records: ConstructionRecord[],
  routes: TrunkRouteTiles[],
  homeSupply: number
): AdmittedConstruction[] {
  // route tile key -> { routeIdx, tileIdx } for source->home ordering.
  const tileIndex = new Map<string, { routeIdx: number; tileIdx: number }>();
  routes.forEach((route, routeIdx) => {
    route.tiles.forEach((t, tileIdx) => {
      // First writer wins if two routes share a tile (a shared trunk prefix):
      // the tile builds once, attributed to the first route - dedup, not
      // double-count.
      const key = tileKey(t.x, t.y, t.roomName);
      if (!tileIndex.has(key)) tileIndex.set(key, { routeIdx, tileIdx });
    });
  });

  const out: AdmittedConstruction[] = [];
  const matchedByRoute = new Map<number, { rec: ConstructionRecord; tileIdx: number }[]>();
  for (const rec of records) {
    const hit = rec.structureType === "road" ? tileIndex.get(tileKey(rec.x, rec.y, rec.roomName)) : undefined;
    if (!hit) {
      // Not a trunk-road tile: keep the per-site sink verbatim.
      out.push({ id: rec.id, x: rec.x, y: rec.y, roomName: rec.roomName, remaining: rec.remaining });
      continue;
    }
    const list = matchedByRoute.get(hit.routeIdx) ?? [];
    list.push({ rec, tileIdx: hit.tileIdx });
    matchedByRoute.set(hit.routeIdx, list);
  }

  for (const [routeIdx, matched] of matchedByRoute) {
    const route = routes[routeIdx];
    // A lone standing tile is not worth aggregating - keep it per-site (no
    // fragmentation to cure, and an aggregate of one is just the tile).
    if (matched.length < 2) {
      for (const { rec } of matched) {
        out.push({ id: rec.id, x: rec.x, y: rec.y, roomName: rec.roomName, remaining: rec.remaining });
      }
      continue;
    }
    matched.sort((p, q) => p.tileIdx - q.tileIdx); // source -> home
    const tiles: RoadTile[] = matched.map(({ rec }) => ({
      x: rec.x,
      y: rec.y,
      roomName: rec.roomName,
      remaining: rec.remaining
    }));
    const { z, a } = splitRoadByEnergyFlow(tiles, route.sourceRate, homeSupply);
    if (z.length > 0) {
      const src = z[0]; // mine-most standing tile
      out.push({
        id: `road-Z-${route.sourceId}`,
        x: src.x,
        y: src.y,
        roomName: src.roomName,
        remaining: z.reduce((s, t) => s + t.remaining, 0)
      });
    }
    if (a.length > 0) {
      const home = a[a.length - 1]; // home-most standing tile
      out.push({
        id: `road-A-${route.sourceId}`,
        x: home.x,
        y: home.y,
        roomName: home.roomName,
        remaining: a.reduce((s, t) => s + t.remaining, 0)
      });
    }
  }

  return out;
}
