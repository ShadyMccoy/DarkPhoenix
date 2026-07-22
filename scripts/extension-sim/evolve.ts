/**
 * extension-sim/evolve - layout evolution (owner 2026-07-22: "I want to
 * evolve some best designs. We can let it hill climb and tinker with
 * randomizations against the top ranked ones").
 *
 * (mu+lambda) hill-climb per RCL preset: seed with the hand generators plus
 * random blobs, keep the top MU designs, breed LAMBDA mutants per
 * generation by moving 1-3 structures (extensions AND spawns - both are
 * genome; the storage is the fixed reload anchor), re-rank, repeat.
 * Fitness is the saturated sim at the 1-tender stress point (fleet x2
 * washes out all layout signal - sweep 2026-07-22), near-reload-first draw
 * order (the adopted direction), scored lexicographically:
 *
 *   [ energy-wait ticks, 1-endFill, mean refill latency, worst latency ]
 *
 * At RCL6 the first two tie at perfect for every serviceable layout (the
 * sweep's "cannot lose" result), so latency is the live gradient.
 *
 * Deterministic: seeded LCG for all randomness; the sim itself has none.
 *
 *   npx ts-node -P tsconfig.test.json scripts/extension-sim/evolve.ts \
 *       [--gens 30] [--ticks 2400] [--preset rcl6|rcl7|rcl8]
 *
 * NOTE: optimizes REFILL ONLY. Real placement must also serve creep exit
 * paths, controller/source geometry, ramparts - this finds the refill
 * shape those constraints then bend.
 */
import {
  Layout,
  Metrics,
  Pos,
  STORAGE,
  Scenario,
  allServiceable,
  chebyshev,
  flowerLayout,
  organicLayout,
  simulate,
  spineLayout
} from "./engine";

interface Preset {
  name: string;
  rcl: number;
  exts: number;
  spawns: number;
  /** The tender the tier can actually field (owner: "we can build bigger
   * tenders at higher RCL"). RCL6's 2300 caps a 1:1 at 16C16M (1600);
   * RCL7+ affords the MAX_CREEP_SIZE body 25C25M (2500) - 1250 capacity,
   * the permanent ceiling: even at RCL8 one load covers just 6 of the
   * 200-cap extensions, so reload cadence never stops mattering. */
  tenderBody: { carry: number; move: number };
}

const PRESETS: Preset[] = [
  { name: "rcl6", rcl: 6, exts: 40, spawns: 1, tenderBody: { carry: 16, move: 16 } },
  { name: "rcl7", rcl: 7, exts: 50, spawns: 2, tenderBody: { carry: 25, move: 25 } },
  { name: "rcl8", rcl: 8, exts: 60, spawns: 3, tenderBody: { carry: 25, move: 25 } }
];

const SIZE = 30;
const MU = 4; // elites kept
const LAMBDA = 12; // mutants per generation

const argvNum = (flag: string, dflt: number): number => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const argvStr = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const GENS = argvNum("--gens", 30);
const TICKS = argvNum("--ticks", 2400);
const ONLY = argvStr("--preset");

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface Genome {
  spawns: Pos[];
  extensions: Pos[];
}

const key = (p: Pos): string => `${p.x},${p.y}`;

function takenSet(g: Genome): Set<string> {
  return new Set<string>([key(STORAGE), ...g.spawns.map(key), ...g.extensions.map(key)]);
}

/** Valid = in bounds, no overlaps, and every structure (spawns included -
 * they refill too) keeps a reachable adjacent walkable tile. */
function valid(g: Genome): boolean {
  const all = [...g.spawns, ...g.extensions];
  const taken = takenSet(g);
  if (taken.size !== all.length + 1) return false; // overlap
  if (all.some(p => p.x < 1 || p.y < 1 || p.x >= SIZE - 1 || p.y >= SIZE - 1)) return false;
  return allServiceable(taken, all, SIZE);
}

function toLayout(g: Genome, name: string): Layout {
  return { name, storage: STORAGE, spawns: g.spawns, extensions: g.extensions, roads: [] };
}

type Cost = [number, number, number, number];

function evaluate(g: Genome, p: Preset): { cost: Cost; m: Metrics } {
  const s: Scenario = {
    layout: toLayout(g, "candidate"),
    rcl: p.rcl,
    drawOrder: "near-reload-first",
    tenderPolicy: "greedy-nearest",
    tenderCount: 1,
    tenderBody: p.tenderBody,
    ticks: TICKS
  };
  const m = simulate(s);
  // A room that never re-reached full within the window has refillEvents 0 -
  // that is WORSE than any finite latency, not better: penalize with the
  // window length.
  const mean = m.refillEvents > 0 ? m.meanRefillLatency : TICKS;
  const worst = m.refillEvents > 0 ? m.worstRefillLatency : TICKS;
  return { cost: [m.energyWaitTicks, 1 - m.endFill, mean, worst], m };
}

function better(a: Cost, b: Cost): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Random blob seed: structures placed at random valid tiles near storage. */
function randomGenome(p: Preset, rand: () => number): Genome {
  const g: Genome = { spawns: [], extensions: [] };
  const place = (list: Pos[], count: number): void => {
    let guard = 0;
    while (list.length < count && guard < 20000) {
      guard += 1;
      const cand = {
        x: STORAGE.x + Math.floor(rand() * 17) - 3,
        y: STORAGE.y + Math.floor(rand() * 17) - 8
      };
      if (cand.x < 1 || cand.y < 1 || cand.x >= SIZE - 1 || cand.y >= SIZE - 1) continue;
      list.push(cand);
      if (!valid(g)) list.pop();
    }
  };
  place(g.spawns, p.spawns);
  place(g.extensions, p.exts);
  return g;
}

/** Mutant: move 1-3 structures. Mostly local jitter (hill climb), sometimes
 * a fresh tile near storage (the tinkering randomization). */
function mutate(parent: Genome, rand: () => number): Genome | null {
  const g: Genome = {
    spawns: parent.spawns.map(p => ({ ...p })),
    extensions: parent.extensions.map(p => ({ ...p }))
  };
  const moves = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < moves; i += 1) {
    const all = [...g.spawns, ...g.extensions];
    const idx = Math.floor(rand() * all.length);
    const target = idx < g.spawns.length ? g.spawns[idx] : g.extensions[idx - g.spawns.length];
    if (rand() < 0.7) {
      target.x += Math.floor(rand() * 5) - 2;
      target.y += Math.floor(rand() * 5) - 2;
    } else {
      target.x = STORAGE.x + Math.floor(rand() * 17) - 3;
      target.y = STORAGE.y + Math.floor(rand() * 17) - 8;
    }
  }
  return valid(g) ? g : null;
}

function render(g: Genome): string {
  const all = [...g.spawns, ...g.extensions, STORAGE];
  const minX = Math.min(...all.map(p => p.x)) - 1;
  const maxX = Math.max(...all.map(p => p.x)) + 1;
  const minY = Math.min(...all.map(p => p.y)) - 1;
  const maxY = Math.max(...all.map(p => p.y)) + 1;
  const spawnKeys = new Set(g.spawns.map(key));
  const extKeys = new Set(g.extensions.map(key));
  const rows: string[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    let row = "";
    for (let x = minX; x <= maxX; x += 1) {
      const k = `${x},${y}`;
      row +=
        k === key(STORAGE) ? "O" : spawnKeys.has(k) ? "S" : extKeys.has(k) ? "E" : ".";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function evolve(p: Preset): void {
  const rand = lcg(0xd06f00d + p.rcl);
  const seeds: Genome[] = [];
  for (const layout of [organicLayout(p.exts, p.spawns), spineLayout(p.exts, p.spawns), flowerLayout(p.exts, p.spawns)]) {
    seeds.push({ spawns: layout.spawns, extensions: layout.extensions });
  }
  seeds.push(randomGenome(p, rand));

  let pool = seeds
    .filter(valid)
    .map(g => ({ g, ...evaluate(g, p) }))
    .sort((a, b) => (better(a.cost, b.cost) ? -1 : 1));
  pool = pool.slice(0, MU);

  console.log(`\n=== ${p.name}: ${p.exts} ext @ ${p.spawns} spawn(s), ${GENS} gens x ${LAMBDA} mutants, ${TICKS}t evals ===`);
  console.log(`gen 0 best: cost [${pool[0].cost.map(c => c.toFixed(2)).join(", ")}]`);

  for (let gen = 1; gen <= GENS; gen += 1) {
    for (let i = 0; i < LAMBDA; i += 1) {
      const parent = pool[Math.floor(rand() * Math.min(MU, pool.length))];
      const child = mutate(parent.g, rand);
      if (!child) continue;
      pool.push({ g: child, ...evaluate(child, p) });
    }
    pool.sort((a, b) => (better(a.cost, b.cost) ? -1 : 1));
    pool = pool.slice(0, MU);
    if (gen % 10 === 0 || gen === GENS) {
      console.log(`gen ${gen} best: cost [${pool[0].cost.map(c => c.toFixed(2)).join(", ")}]`);
    }
  }

  const best = pool[0];
  console.log(
    `winner: util ${best.m.utilization.toFixed(3)}  endFill ${best.m.endFill.toFixed(3)}  ` +
      `refill ${best.m.meanRefillLatency.toFixed(0)}/${best.m.worstRefillLatency}t  duty ${best.m.tenderDuty.toFixed(2)}`
  );
  console.log("legend: O storage, S spawn, E extension");
  console.log(render(best.g));
}

for (const p of PRESETS) {
  if (ONLY && p.name !== ONLY) continue;
  evolve(p);
}
