/**
 * @fileoverview refillCircuit - the spawn network's BUS ROUTE.
 *
 * Owner directive (2026-07-10): refillers should follow a fixed circuit of
 * stops - same path every lap, simply skipping stops that are full - instead
 * of re-picking targets ad hoc (the old ID-ordered "belt" rotation toured the
 * cluster in spatially random order, walking right past adjacent empties;
 * nearest-first re-picking dithers). And the DRAW side cooperates: spawnCreep
 * accepts an energyStructures order, so spawning drains stops in the same
 * circuit order - holes appear as a contiguous run the bus sweeps, not
 * scattered potholes.
 *
 * The tour: a nearest-neighbor chain over spawn+extensions starting from the
 * anchor (the depot/spawn - where a refiller reloads). With the clustered
 * placement policy (extensions grow as one mass around the spawn) this is a
 * short, stable loop. The order is deterministic for a given structure set;
 * it recomputes only when the set changes (id-hash check).
 *
 * Pure functions; callers do the Game lookups.
 *
 * @module corps/refillCircuit
 */

export interface CircuitStop {
  id: string;
  x: number;
  y: number;
}

/** Chebyshev distance - creeps move diagonally at the same cost. */
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Order stops into a stable tour: nearest-neighbor chain from the anchor,
 * then a bounded 2-opt improvement pass (owner directive 2026-07-10: the
 * tender's set path should be a reasonable traveling-salesperson solution -
 * the shortest loop through its stops, within reason). NN gives a decent
 * greedy tour; 2-opt uncrosses it, which removes the classic NN pathology of
 * doubling back. O(n^2) per improvement round, n <= 60 (spawns+extensions),
 * rounds capped, recomputed only on structure-set changes - negligible cost
 * for a tour walked thousands of times.
 */
export function computeCircuit(stops: CircuitStop[], anchor: { x: number; y: number }): string[] {
  const byId = new Map(stops.map(s => [s.id, s]));
  const remaining = [...stops].sort((a, b) => a.id.localeCompare(b.id));
  const tour: CircuitStop[] = [];
  let at = anchor;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = cheb(at, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    tour.push(next);
    at = next;
  }

  // 2-opt: while any edge pair crosses, reverse the segment between them.
  // Closed loop including the return-to-anchor leg (the bus laps forever).
  const loop = [{ id: "__anchor__", x: anchor.x, y: anchor.y }, ...tour];
  let improved = true;
  let rounds = 0;
  while (improved && rounds < 25) {
    improved = false;
    rounds++;
    for (let i = 0; i < loop.length - 1; i++) {
      for (let j = i + 2; j < loop.length; j++) {
        const a = loop[i];
        const b = loop[i + 1];
        const c = loop[j];
        const d = loop[(j + 1) % loop.length];
        if (cheb(a, b) + cheb(c, d) > cheb(a, c) + cheb(b, d)) {
          // Reverse loop[i+1..j].
          let lo = i + 1;
          let hi = j;
          while (lo < hi) {
            const tmp = loop[lo];
            loop[lo] = loop[hi];
            loop[hi] = tmp;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return loop.filter(s => s.id !== "__anchor__").map(s => byId.get(s.id)!.id);
}

/** Cheap change-detector for the structure set backing a cached circuit. */
export function circuitSignature(stops: CircuitStop[]): string {
  return stops
    .map(s => s.id)
    .sort()
    .join(",");
}

/**
 * The next stop a refiller should serve: the first NEEDY stop at or after
 * `fromIndex` in circuit order (wrapping). Returns its circuit index, or null
 * when every stop is full. Pure: `needy` maps stop id -> needs energy.
 */
export function nextStop(circuit: string[], fromIndex: number, needy: (id: string) => boolean): number | null {
  if (circuit.length === 0) return null;
  for (let i = 0; i < circuit.length; i++) {
    const idx = (fromIndex + i) % circuit.length;
    if (needy(circuit[idx])) return idx;
  }
  return null;
}

/**
 * Room-cached circuit over spawn + extensions, anchored at the first spawn.
 * Recomputes when the structure set changes (new extension built/destroyed).
 */
export function roomCircuit(room: Room): string[] {
  // Harness stubs (and edge worlds) may lack the room API; no circuit then.
  if (!room || typeof room.find !== "function") return [];
  const structures = room.find(FIND_MY_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION
  }) as (StructureSpawn | StructureExtension)[];
  const stops: CircuitStop[] = structures.map(s => ({ id: s.id, x: s.pos.x, y: s.pos.y }));
  const sig = circuitSignature(stops);
  const cached = room.memory.refillCircuit;
  if (cached && cached.sig === sig) return cached.tour;

  const spawn = structures.find(s => s.structureType === STRUCTURE_SPAWN);
  const anchor = spawn ? { x: spawn.pos.x, y: spawn.pos.y } : { x: 25, y: 25 };
  const tour = computeCircuit(stops, anchor);
  room.memory.refillCircuit = { sig, tour };
  return tour;
}

/**
 * The spawnCreep energyStructures order: circuit order, so spawning drains
 * stops in the same sequence the bus refills them.
 */
export function drawOrder(room: Room): (StructureSpawn | StructureExtension)[] {
  const tour = roomCircuit(room);
  const out: (StructureSpawn | StructureExtension)[] = [];
  for (const id of tour) {
    const s = Game.getObjectById(id as Id<StructureSpawn | StructureExtension>);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Spatial extension clusters (owner 2026-07-10, the extension-corp direction):
 * extensions chained within CLUSTER_LINK_RANGE of each other form one refill
 * unit; the spawn joins its nearest cluster. A single tender physically cannot
 * beat the refill SLA across split clusters (measured on the legacy-layout
 * snapshot: the far cluster's deadline lost to a 20-tile walk every drain), so
 * the tender corp fields one tender PER cluster and each serves only its own.
 * Sorted by centroid for stable tender assignment across ticks.
 */
const CLUSTER_LINK_RANGE = 4;

export function extensionClusters(room: Room): (StructureSpawn | StructureExtension)[][] {
  const members = room.find(FIND_MY_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN
  }) as (StructureSpawn | StructureExtension)[];
  if (members.length === 0) return [];

  // Union-find by chained proximity.
  const parent = members.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i].pos;
      const b = members[j].pos;
      if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= CLUSTER_LINK_RANGE) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, (StructureSpawn | StructureExtension)[]>();
  for (let i = 0; i < members.length; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(members[i]);
    groups.set(root, list);
  }
  const centroid = (g: (StructureSpawn | StructureExtension)[]): number =>
    g.reduce((sum, s) => sum + s.pos.x + s.pos.y, 0) / g.length;
  return [...groups.values()].sort((a, b) => centroid(a) - centroid(b));
}
