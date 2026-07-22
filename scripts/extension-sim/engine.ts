/**
 * extension-sim/engine - a table-top mockup of the Screeps spawn/extension/
 * tender loop, faithful to the vendored engine on exactly the rules the
 * refill question hinges on (each verified against @screeps/engine dist):
 *
 * - createCreep charges energy at spawn START; DEFAULT draw order is spawns
 *   then extensions each sorted by distance FROM THE SPAWN
 *   (processor/intents/spawns/_charge-energy.js oldEnergyHandling); an
 *   explicit energyStructures list drains VERBATIM in the order given
 *   (newEnergyHandling).
 * - Spawning takes CREEP_SPAWN_TIME (3) ticks per part; max body 50 parts.
 * - Extension capacity by RCL: {<=6: 50, 7: 100, 8: 200}; spawn holds 300.
 * - transfer, withdraw and move are SEPARATE intent types with no mutual
 *   exclusion - all three may execute in one tick (creeps/intents.js
 *   creepActions; priorities exclude only combat/work overlaps). transfer
 *   executes BEFORE withdraw in the intent order, so a same-tick relay uses
 *   the PRE-withdraw carry.
 * - Fatigue: a move is legal only at fatigue 0; a successful move adds
 *   weight * terrainFatigue (plain 2, road 1) where weight counts non-MOVE
 *   parts, CARRY only while backing carried energy (ceil(carried/50)); each
 *   MOVE recovers 2 fatigue per tick (_add-fatigue.js + _recalc-body).
 *
 * Structures block movement; pathing is BFS on the small grid. Everything
 * else (towers, links, other creeps) is out of scope - this is the refill
 * mini-game, not a room sim.
 */

export const SPAWN_CAP = 300;
export const SPAWN_TIME_PER_PART = 3;
export const MAX_CREEP_SIZE = 50;
export const EXT_CAP: Record<number, number> = { 6: 50, 7: 100, 8: 200 };
export const CARRY_CAPACITY = 50;
export const PLAIN_FATIGUE = 2;
export const ROAD_FATIGUE = 1;

export interface Pos {
  x: number;
  y: number;
}

const key = (p: Pos): string => `${p.x},${p.y}`;
export const chebyshev = (a: Pos, b: Pos): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export interface EnergyStructure {
  id: string;
  kind: "spawn" | "extension";
  pos: Pos;
  cap: number;
  energy: number;
}

export interface SpawnSite extends EnergyStructure {
  kind: "spawn";
  busyUntil: number; // tick the current build finishes (0 = free)
}

export interface Tender {
  pos: Pos;
  carryParts: number;
  moveParts: number;
  carried: number;
  fatigue: number;
  /** patrol strategies keep a cursor into their route */
  routeIdx: number;
  // metrics
  transferTicks: number;
  moveTicks: number;
  restTicks: number;
  idleTicks: number;
}

export interface World {
  size: number;
  rcl: number;
  storage: Pos; // infinite energy; unwalkable
  roads: Set<string>;
  spawns: SpawnSite[];
  extensions: EnergyStructure[];
  tenders: Tender[];
  tick: number;
  /** The layout's patrol circuit (lane), for circuit-aligned draw order. */
  circuit?: Pos[];
}

export interface Layout {
  name: string;
  storage: Pos;
  spawns: Pos[];
  extensions: Pos[];
  roads: Pos[];
  /** suggested tender patrol route (standing/driving tiles), for lane strategies */
  lane?: Pos[];
}

/** Draw-order policy: which structures a spawn drains, in order.
 * "circuit" aligns the drain with the tender's patrol circuit (owner: "we
 * could always simply empty the extensions that are next on the circuit
 * ... like a little automaton") - structures rank by the first circuit
 * tile they are adjacent to, so the drained frontier always lies directly
 * ahead of a tender walking the circuit. */
export type DrawOrder = "engine-default" | "near-reload-first" | "far-first" | "circuit";

/** Tender micro policy. Both transfer opportunistically every tick. */
export type TenderPolicy = "greedy-nearest" | "lane-patrol";

export interface Scenario {
  layout: Layout;
  rcl: number;
  drawOrder: DrawOrder;
  tenderPolicy: TenderPolicy;
  tenderCount: number;
  tenderBody: { carry: number; move: number };
  ticks: number;
}

export interface Metrics {
  ticks: number;
  spawnCount: number;
  partsSpawned: number;
  bodiesSpawned: number;
  /** ticks a free spawn could not START its (always-pending) order for energy */
  energyWaitTicks: number;
  spawnBusyTicks: number;
  utilization: number; // busy / (busy + wait); 1.0 = refill never gated
  partsPerTick: number;
  endFillSum: number;
  endFillCount: number;
  endFill: number; // mean energyAvailable/capacity at build finish
  refillLatencySum: number;
  refillEvents: number;
  meanRefillLatency: number; // drain event -> room back at full
  worstRefillLatency: number;
  tenderTransferTicks: number;
  tenderDuty: number; // transfer ticks / (tenders * ticks)
}

// ---------------------------------------------------------------------------
// World construction
// ---------------------------------------------------------------------------

export function buildWorld(s: Scenario): World {
  const extCap = EXT_CAP[Math.min(8, Math.max(6, s.rcl))];
  const world: World = {
    size: 30,
    rcl: s.rcl,
    storage: s.layout.storage,
    roads: new Set(s.layout.roads.map(key)),
    spawns: s.layout.spawns.map((pos, i) => ({
      id: `spawn${i}`,
      kind: "spawn",
      pos,
      cap: SPAWN_CAP,
      energy: SPAWN_CAP,
      busyUntil: 0
    })),
    extensions: s.layout.extensions.map((pos, i) => ({
      id: `ext${i}`,
      kind: "extension",
      pos,
      cap: extCap,
      energy: extCap
    })),
    tenders: [],
    tick: 0,
    circuit: s.layout.lane
  };
  // Tenders start parked by the storage, loaded.
  for (let i = 0; i < s.tenderCount; i += 1) {
    const spot = walkableNear(world, world.storage, i);
    world.tenders.push({
      pos: spot,
      carryParts: s.tenderBody.carry,
      moveParts: s.tenderBody.move,
      carried: s.tenderBody.carry * CARRY_CAPACITY,
      fatigue: 0,
      routeIdx: 0,
      transferTicks: 0,
      moveTicks: 0,
      restTicks: 0,
      idleTicks: 0
    });
  }
  return world;
}

function blocked(world: World, p: Pos): boolean {
  if (p.x < 0 || p.y < 0 || p.x >= world.size || p.y >= world.size) return true;
  if (key(p) === key(world.storage)) return true;
  if (world.spawns.some(sp => key(sp.pos) === key(p))) return true;
  if (world.extensions.some(e => key(e.pos) === key(p))) return true;
  return false;
}

function walkableNear(world: World, at: Pos, skip = 0): Pos {
  let skipped = 0;
  for (let r = 1; r < world.size; r += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = { x: at.x + dx, y: at.y + dy };
        if (!blocked(world, p)) {
          if (skipped >= skip) return p;
          skipped += 1;
        }
      }
    }
  }
  throw new Error("no walkable tile");
}

/** BFS next-step toward any tile within `range` of target. Returns null when
 * already in range or unreachable. 8-directional, structures block. */
export function stepToward(world: World, from: Pos, target: Pos, range: number): Pos | null {
  if (chebyshev(from, target) <= range) return null;
  const visited = new Set<string>([key(from)]);
  const queue: { p: Pos; first: Pos | null }[] = [{ p: from, first: null }];
  while (queue.length > 0) {
    const { p, first } = queue.shift()!;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (dx === 0 && dy === 0) continue;
        const n = { x: p.x + dx, y: p.y + dy };
        const k = key(n);
        if (visited.has(k) || blocked(world, n)) continue;
        visited.add(k);
        const f = first ?? n;
        if (chebyshev(n, target) <= range) return f;
        queue.push({ p: n, first: f });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawn charging (verbatim engine semantics)
// ---------------------------------------------------------------------------

function drawStructures(world: World, spawn: SpawnSite, order: DrawOrder): EnergyStructure[] {
  const all: EnergyStructure[] = [...world.spawns, ...world.extensions];
  if (order === "engine-default") {
    // oldEnergyHandling: spawns (distance from the spawning spawn), then
    // extensions (same sort). Linear distance, as utils.comparatorDistance.
    const spawns = world.spawns.slice().sort((a, b) => chebyshev(a.pos, spawn.pos) - chebyshev(b.pos, spawn.pos));
    const exts = world.extensions
      .slice()
      .sort((a, b) => chebyshev(a.pos, spawn.pos) - chebyshev(b.pos, spawn.pos));
    return [...spawns, ...exts];
  }
  if (order === "circuit" && world.circuit && world.circuit.length > 0) {
    // Rank each structure by the FIRST circuit tile it is adjacent to; the
    // drain then marches along the circuit exactly as the tender does.
    // Structures off the circuit rank last (near-reload among themselves).
    const circuit = world.circuit;
    const rank = (e: EnergyStructure): number => {
      for (let i = 0; i < circuit.length; i += 1) {
        if (chebyshev(circuit[i], e.pos) <= 1) return i;
      }
      return circuit.length + chebyshev(e.pos, world.storage);
    };
    return all.slice().sort((a, b) => rank(a) - rank(b));
  }
  // energyStructures overrides: drain order is the list order, spawns included
  // wherever we put them (we put them first - they are next to the reload
  // path anyway and refilling the spawning spawn is free for the tender).
  const byReload = (a: EnergyStructure, b: EnergyStructure): number =>
    chebyshev(a.pos, world.storage) - chebyshev(b.pos, world.storage);
  const sorted = all.slice().sort(byReload);
  if (order === "far-first") sorted.reverse();
  return sorted;
}

/** Try to start a build of `parts` on `spawn`; returns true when charged.
 * Exported for the mechanics pins - the draw-order semantics ARE the
 * experiment's lever, so tests hit this seam directly. */
export function tryStartSpawn(world: World, spawn: SpawnSite, parts: number, order: DrawOrder): boolean {
  const cost = parts * CARRY_CAPACITY; // 1:1 C:M bodies at 50/part - the synthetic load
  const structs = drawStructures(world, spawn, order);
  const available = structs.reduce((s, e) => s + e.energy, 0);
  if (available < cost) return false;
  let remaining = cost;
  for (const st of structs) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, st.energy);
    st.energy -= take;
    remaining -= take;
  }
  spawn.busyUntil = world.tick + SPAWN_TIME_PER_PART * parts;
  return true;
}

// ---------------------------------------------------------------------------
// Tender micro
// ---------------------------------------------------------------------------

function weight(t: Tender): number {
  return Math.ceil(t.carried / CARRY_CAPACITY); // loaded CARRY only; MOVE never
}

function terrainFatigue(world: World, p: Pos): number {
  return world.roads.has(key(p)) ? ROAD_FATIGUE : PLAIN_FATIGUE;
}

function needy(world: World): EnergyStructure[] {
  return [...world.spawns, ...world.extensions].filter(e => e.energy < e.cap);
}

/** One tender tick: opportunistic transfer + withdraw + movement, all legal
 * in the same tick (engine intent order: transfer BEFORE withdraw). */
function runTender(world: World, t: Tender, policy: TenderPolicy, lane: Pos[] | undefined): void {
  let acted = false;

  // TRANSFER (pre-withdraw carry, per engine intent order): any adjacent
  // needy structure, lowest-energy first.
  if (t.carried > 0) {
    const adj = needy(world)
      .filter(e => chebyshev(e.pos, t.pos) <= 1)
      .sort((a, b) => a.energy - b.energy)[0];
    if (adj) {
      const amount = Math.min(t.carried, adj.cap - adj.energy);
      adj.energy += amount;
      t.carried -= amount;
      t.transferTicks += 1;
      acted = true;
    }
  }

  // WITHDRAW: reload whenever standing by the storage with free capacity.
  const capacity = t.carryParts * CARRY_CAPACITY;
  if (t.carried < capacity && chebyshev(t.pos, world.storage) <= 1) {
    t.carried = capacity;
    // A fresh load restarts the sweep at the circuit HEAD: the circuit draw
    // order drains head-first, so the frontier is contiguous from the head -
    // resuming a stale mid-circuit cursor walks past fresh drains to finish
    // old tail sections (measured: rcl8 flower util 0.87 with the stale
    // cursor - the elevator problem).
    if (policy === "lane-patrol") t.routeIdx = 0;
    acted = true;
  }

  // MOVE: pick an objective.
  let target: Pos | null = null;
  let range = 1;
  if (t.carried === 0) {
    target = world.storage;
  } else if (policy === "greedy-nearest") {
    // Nearest REACHABLE needy structure: a sealed pocket must not deadlock
    // the tender on an unreachable nearest forever.
    const sorted = needy(world).sort(
      (a, b) => chebyshev(a.pos, t.pos) - chebyshev(b.pos, t.pos) || a.energy - b.energy
    );
    for (const cand of sorted) {
      if (chebyshev(cand.pos, t.pos) <= 1) break; // already in range; no move needed
      if (stepToward(world, t.pos, cand.pos, 1) !== null) {
        target = cand.pos;
        break;
      }
    }
  } else if (policy === "lane-patrol" && lane && lane.length > 0) {
    // The automaton (owner): chase the drained FRONTIER along the circuit.
    // Advance the cursor past circuit tiles with nothing needy adjacent -
    // walking a full section to reach the frontier is the loss the original
    // fixed-cursor patrol paid. Stand while anything adjacent needs filling
    // (a flower pack takes 6 standing ticks; fatigue recovers while
    // standing, which is what lets a CARRY-heavy body keep pace).
    const need = needy(world);
    if (need.length > 0) {
      const adjacentNeedy = need.some(e => chebyshev(e.pos, t.pos) <= 1);
      if (!adjacentNeedy) {
        for (let i = 0; i < lane.length; i += 1) {
          const idx = (t.routeIdx + i) % lane.length;
          if (need.some(e => chebyshev(e.pos, lane[idx]) <= 1)) {
            t.routeIdx = idx;
            break;
          }
        }
      }
      target = lane[t.routeIdx % lane.length];
      range = 0;
    }
  }

  let moved = false;
  if (target) {
    const step = stepToward(world, t.pos, target, range);
    if (step) {
      if (t.fatigue > 0) {
        t.restTicks += 1;
      } else {
        t.pos = step;
        // The move's fatigue nets the SAME tick's MOVE recovery (engine adds
        // weight*terrain and the MOVEs' -2 each within one processing pass).
        t.fatigue = Math.max(0, weight(t) * terrainFatigue(world, step) - 2 * t.moveParts);
        t.moveTicks += 1;
        moved = true;
        acted = true;
      }
    }
  }

  // Rest-tick recovery: 2 per MOVE, only on ticks the creep did not move
  // (the move tick's recovery is already netted above; applying both would
  // let a 2:1 body crawl at full speed).
  if (!moved && t.fatigue > 0) t.fatigue = Math.max(0, t.fatigue - 2 * t.moveParts);

  if (!acted) t.idleTicks += 1;
}

// ---------------------------------------------------------------------------
// The mini-game loop
// ---------------------------------------------------------------------------

export function simulate(s: Scenario): Metrics {
  const world = buildWorld(s);
  const m: Metrics = {
    ticks: s.ticks,
    spawnCount: world.spawns.length,
    partsSpawned: 0,
    bodiesSpawned: 0,
    energyWaitTicks: 0,
    spawnBusyTicks: 0,
    utilization: 0,
    partsPerTick: 0,
    endFillSum: 0,
    endFillCount: 0,
    endFill: 0,
    refillLatencySum: 0,
    refillEvents: 0,
    meanRefillLatency: 0,
    worstRefillLatency: 0,
    tenderTransferTicks: 0,
    tenderDuty: 0
  };
  const totalCap = (): number =>
    world.spawns.reduce((x, e) => x + e.cap, 0) + world.extensions.reduce((x, e) => x + e.cap, 0);
  const totalEnergy = (): number =>
    world.spawns.reduce((x, e) => x + e.energy, 0) + world.extensions.reduce((x, e) => x + e.energy, 0);
  let drainOpenSince: number | null = null;

  const maxParts = Math.min(MAX_CREEP_SIZE, Math.floor(totalCap() / CARRY_CAPACITY));

  for (world.tick = 1; world.tick <= s.ticks; world.tick += 1) {
    // Spawns: synthetic load - a max-size body the moment the spawn is free.
    for (const sp of world.spawns) {
      if (sp.busyUntil >= world.tick) {
        m.spawnBusyTicks += 1;
        if (sp.busyUntil === world.tick) {
          m.endFillSum += totalEnergy() / totalCap();
          m.endFillCount += 1;
        }
        continue;
      }
      if (tryStartSpawn(world, sp, maxParts, s.drawOrder)) {
        m.partsSpawned += maxParts;
        m.bodiesSpawned += 1;
        m.spawnBusyTicks += 1;
        if (drainOpenSince === null) drainOpenSince = world.tick;
      } else {
        m.energyWaitTicks += 1;
      }
    }

    // Tenders.
    for (const t of world.tenders) runTender(world, t, s.tenderPolicy, s.layout.lane);

    // Refill-latency meter: a drain window closes when the room is FULL again.
    if (totalEnergy() >= totalCap()) {
      if (drainOpenSince !== null) {
        const latency = world.tick - drainOpenSince;
        m.refillLatencySum += latency;
        m.refillEvents += 1;
        if (latency > m.worstRefillLatency) m.worstRefillLatency = latency;
        drainOpenSince = null;
      }
    }
  }

  m.tenderTransferTicks = world.tenders.reduce((x, t) => x + t.transferTicks, 0);
  m.utilization = m.spawnBusyTicks / Math.max(1, m.spawnBusyTicks + m.energyWaitTicks);
  m.partsPerTick = m.partsSpawned / s.ticks;
  m.endFill = m.endFillCount > 0 ? m.endFillSum / m.endFillCount : 1;
  m.meanRefillLatency = m.refillEvents > 0 ? m.refillLatencySum / m.refillEvents : 0;
  m.tenderDuty = m.tenderTransferTicks / Math.max(1, world.tenders.length * s.ticks);
  return m;
}

// ---------------------------------------------------------------------------
// Layouts (30x30 board; storage mid-left, spawns to its east)
// ---------------------------------------------------------------------------

/** Deterministic LCG so "organic" is reproducible run to run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export const STORAGE: Pos = { x: 6, y: 15 };

function spawnRow(count: number): Pos[] {
  // Spawns sit OFF the tender lane (a structure on the lane severs it - the
  // engine blocks movement through structures), one row north, reachable
  // from the open plain above.
  return [
    { x: 10, y: 13 },
    { x: 16, y: 13 },
    { x: 22, y: 13 }
  ].slice(0, count);
}

/** Walkable tiles adjacent to each spawn, appended to patrol lanes so the
 * lane strategy also tops the spawns up (300 each). */
function spawnStops(spawns: Pos[]): Pos[] {
  return spawns.map(sp => ({ x: sp.x - 1, y: sp.y }));
}

/** Every placed structure must leave itself an adjacent walkable tile
 * REACHABLE from the storage's side, or the tender can drain it (the spawn
 * draw ignores walkability) but never refill it. BFS on the tentative
 * taken-set, seeded from EVERY walkable tile beside the storage (a layout
 * may legitimately occupy any particular neighbor). Exported: the layout
 * evolver uses the same validity rule for its mutants. */
export function allServiceable(taken: Set<string>, extensions: Pos[], size: number): boolean {
  const seen = new Set<string>();
  const queue: Pos[] = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const p = { x: STORAGE.x + dx, y: STORAGE.y + dy };
      if (p.x < 0 || p.y < 0 || p.x >= size || p.y >= size || taken.has(key(p))) continue;
      seen.add(key(p));
      queue.push(p);
    }
  }
  if (queue.length === 0) return false;
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const n = { x: p.x + dx, y: p.y + dy };
        const k = key(n);
        if (n.x < 0 || n.y < 0 || n.x >= size || n.y >= size || seen.has(k) || taken.has(k)) continue;
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return extensions.every(e => {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (seen.has(key({ x: e.x + dx, y: e.y + dy }))) return true;
      }
    }
    return false;
  });
}

/** Scattered placement within radius 2-7 of the first spawn - the "it grew
 * this way" control arm. Each placement is rejected if it would strand any
 * extension without a serviceable (reachable-walkable) adjacent tile. */
export function organicLayout(extCount: number, spawnCount: number, seed = 7): Layout {
  const rand = lcg(seed);
  const spawns = spawnRow(spawnCount);
  const taken = new Set<string>([key(STORAGE), ...spawns.map(key)]);
  const extensions: Pos[] = [];
  let attempts = 0;
  while (extensions.length < extCount && attempts < 10000) {
    attempts += 1;
    const a = rand() * Math.PI * 2;
    const r = 2 + rand() * 5;
    const p = { x: Math.round(spawns[0].x + Math.cos(a) * r), y: Math.round(spawns[0].y + Math.sin(a) * r) };
    if (p.x < 1 || p.y < 1 || p.x > 28 || p.y > 28 || taken.has(key(p))) continue;
    taken.add(key(p));
    if (!allServiceable(taken, [...extensions, p], 30)) {
      taken.delete(key(p));
      continue;
    }
    extensions.push(p);
  }
  return { name: "organic", storage: STORAGE, spawns, extensions, roads: [] };
}

/** Double-flanked corridors: walkable road lanes running east from beside the
 * storage, extensions packed one deep on both sides. The west lane tile is
 * storage-adjacent, so the tender reloads WITHOUT leaving the corridor, and
 * drive-by filling touches a fresh extension every tick. Spawns sit two rows
 * north, off-lane (a structure on the lane would sever it); patrol lanes get
 * explicit spawn stops appended. */
export function spineLayout(extCount: number, spawnCount: number): Layout {
  const spawns = spawnRow(spawnCount);
  const taken = new Set<string>([key(STORAGE), ...spawns.map(key)]);
  const extensions: Pos[] = [];
  const roads: Pos[] = [];
  const lane: Pos[] = [];
  for (const y of [15, 18, 21]) {
    for (let x = 7; x < 28 && extensions.length < extCount; x += 1) {
      const laneTile = { x, y };
      roads.push(laneTile);
      lane.push(laneTile);
      for (const dy of [-1, 1]) {
        if (extensions.length >= extCount) break;
        const p = { x, y: y + dy };
        if (taken.has(key(p))) continue;
        taken.add(key(p));
        extensions.push(p);
      }
    }
    if (extensions.length >= extCount) break;
  }
  return { name: "spine", storage: STORAGE, spawns, extensions, roads, lane: [...lane, ...spawnStops(spawns)] };
}

/** Six-packs threaded on a through-lane: ring of 8 around each lane tile
 * minus the two lane neighbors (an unbroken 8-ring seals its own center).
 * Pack centers every 4 tiles keep a walkable seam between rings; the tender
 * parks at a center and fills 6 without moving. */
export function flowerLayout(extCount: number, spawnCount: number): Layout {
  const spawns = spawnRow(spawnCount);
  const taken = new Set<string>([key(STORAGE), ...spawns.map(key)]);
  const extensions: Pos[] = [];
  const roads: Pos[] = [];
  const lane: Pos[] = [];
  for (const y of [15, 19]) {
    for (let x = 7; x < 28; x += 1) {
      const laneTile = { x, y };
      if (!taken.has(key(laneTile))) roads.push(laneTile);
    }
    for (let cx = 9; cx < 27 && extensions.length < extCount; cx += 4) {
      lane.push({ x: cx, y });
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 1]) {
          if (extensions.length >= extCount) break;
          const p = { x: cx + dx, y: y + dy };
          if (taken.has(key(p))) continue;
          taken.add(key(p));
          extensions.push(p);
        }
      }
    }
    if (extensions.length >= extCount) break;
  }
  return { name: "flower6", storage: STORAGE, spawns, extensions, roads, lane: [...lane, ...spawnStops(spawns)] };
}
