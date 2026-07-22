/**
 * extension-sim/run - the mini-game sweep (owner 2026-07-22): layouts x
 * draw orders x tender strategies x fleet sizes against a synthetic
 * max-size-body-every-time spawn load, at RCL 6/7/8 presets.
 *
 *   npx ts-node -P tsconfig.test.json scripts/extension-sim/run.ts
 *
 * Read the table by utilization first (1.0 = refill NEVER gated a spawn
 * start), then endFill and refill latency for the margin story.
 */
import {
  DrawOrder,
  Layout,
  Metrics,
  Scenario,
  TenderPolicy,
  flowerLayout,
  organicLayout,
  simulate,
  spineLayout
} from "./engine";

interface Preset {
  rcl: number;
  exts: number;
  spawns: number;
}

// RCL presets: extension count and spawn count per game rules.
const PRESETS: Preset[] = [
  { rcl: 6, exts: 40, spawns: 1 },
  { rcl: 7, exts: 50, spawns: 2 },
  { rcl: 8, exts: 60, spawns: 3 }
];

const TICKS = 5000;

function arms(p: Preset): { name: string; layout: Layout }[] {
  return [
    { name: "organic", layout: organicLayout(p.exts, p.spawns) },
    { name: "spine", layout: spineLayout(p.exts, p.spawns) },
    { name: "flower6", layout: flowerLayout(p.exts, p.spawns) }
  ];
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function row(p: Preset, layoutName: string, s: Scenario, m: Metrics): string {
  return [
    `rcl${p.rcl}`,
    layoutName.padEnd(7),
    s.drawOrder.padEnd(17),
    s.tenderPolicy.padEnd(14),
    `x${s.tenderCount}`,
    `util ${fmt(m.utilization, 3)}`,
    `parts/t ${fmt(m.partsPerTick, 3)}`,
    `endFill ${fmt(m.endFill, 3)}`,
    `refill ${fmt(m.meanRefillLatency, 0)}/${m.worstRefillLatency}t`,
    `duty ${fmt(m.tenderDuty, 2)}`,
    `wait ${m.energyWaitTicks}t`
  ].join("  ");
}

for (const p of PRESETS) {
  console.log(`\n=== RCL${p.rcl}: ${p.exts} extensions @ ${p.spawns} spawn(s), max-size body back-to-back, ${TICKS}t ===`);
  for (const { name, layout } of arms(p)) {
    for (const drawOrder of ["engine-default", "near-reload-first"] as DrawOrder[]) {
      for (const tenderPolicy of ["greedy-nearest", "lane-patrol"] as TenderPolicy[]) {
        if (tenderPolicy === "lane-patrol" && !layout.lane) continue;
        for (const tenderCount of [1, 2]) {
          const s: Scenario = {
            layout,
            rcl: p.rcl,
            drawOrder,
            tenderPolicy,
            tenderCount,
            tenderBody: { carry: 16, move: 16 },
            ticks: TICKS
          };
          console.log(row(p, name, s, simulate(s)));
        }
      }
    }
  }
}

// The control arm the sweep would otherwise bury: how much does draw order
// alone matter on the WORST layout at the tightest RCL?
console.log("\n=== draw-order isolation (rcl6 organic, 1 tender, greedy) ===");
for (const drawOrder of ["engine-default", "near-reload-first", "far-first"] as DrawOrder[]) {
  const s: Scenario = {
    layout: organicLayout(40, 1),
    rcl: 6,
    drawOrder,
    tenderPolicy: "greedy-nearest",
    tenderCount: 1,
    tenderBody: { carry: 16, move: 16 },
    ticks: TICKS
  };
  const m = simulate(s);
  console.log(
    `${drawOrder.padEnd(17)}  util ${fmt(m.utilization, 3)}  endFill ${fmt(m.endFill, 3)}  refill ${fmt(
      m.meanRefillLatency,
      0
    )}/${m.worstRefillLatency}t  wait ${m.energyWaitTicks}t`
  );
}
