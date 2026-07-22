/**
 * extension-sim/boards - render the design gallery with measured stats
 * (owner 2026-07-22: "Can you show me some small asciis of the best
 * designs?"). Also verifies the diagonal pattern's arithmetic (6 extension
 * neighbors per lane tile, ~3 fresh per step) and runs the key arms on it.
 *
 *   npx ts-node -P tsconfig.test.json scripts/extension-sim/boards.ts
 */
import {
  Layout,
  Scenario,
  chebyshev,
  diagonalLayout,
  flowerLayout,
  renderLayout,
  simulate,
  spineLayout
} from "./engine";

function laneGeometry(l: Layout): string {
  if (!l.lane || l.lane.length < 2) return "no lane";
  const extAt = new Set(l.extensions.map(p => `${p.x},${p.y}`));
  const adj = (tile: { x: number; y: number }) =>
    l.extensions.filter(e => chebyshev(e, tile) <= 1);
  let neighborSum = 0;
  let freshSum = 0;
  let steps = 0;
  for (let i = 1; i < l.lane.length; i += 1) {
    const prev = adj(l.lane[i - 1]).map(p => `${p.x},${p.y}`);
    const here = adj(l.lane[i]);
    if (chebyshev(l.lane[i], l.lane[i - 1]) !== 1) continue; // stops/jumps
    neighborSum += here.length;
    freshSum += here.filter(p => !prev.includes(`${p.x},${p.y}`)).length;
    steps += 1;
  }
  void extAt;
  return `${(neighborSum / Math.max(1, steps)).toFixed(1)} ext-neighbors/lane tile, ${(freshSum / Math.max(1, steps)).toFixed(1)} fresh/step`;
}

function measure(l: Layout, rcl: number, spawns: number, body: { carry: number; move: number }, auto: boolean): string {
  const s: Scenario = {
    layout: l,
    rcl,
    drawOrder: auto ? "circuit" : "near-reload-first",
    tenderPolicy: auto ? "lane-patrol" : "greedy-nearest",
    tenderCount: 1,
    tenderBody: body,
    ticks: 5000
  };
  const m = simulate(s);
  const refill = m.refillEvents > 0 ? `${m.meanRefillLatency.toFixed(0)}/${m.worstRefillLatency}t` : "never-full";
  return `${auto ? "automaton" : "greedy   "} ${body.carry}C${body.move}M  util ${m.utilization.toFixed(3)}  endFill ${m.endFill.toFixed(3)}  refill ${refill}`;
}

const GALLERY: { title: string; layout: Layout; rcl: number; spawns: number; arms: { body: { carry: number; move: number }; auto: boolean }[] }[] = [
  {
    title: "DIAGONAL rcl6 (40 ext, 1 spawn)",
    layout: diagonalLayout(40, 1),
    rcl: 6,
    spawns: 1,
    arms: [
      { body: { carry: 16, move: 16 }, auto: false },
      { body: { carry: 20, move: 10 }, auto: true },
      { body: { carry: 21, move: 7 }, auto: true }
    ]
  },
  {
    title: "DIAGONAL rcl8 (60 ext, 3 spawns)",
    layout: diagonalLayout(60, 3),
    rcl: 8,
    spawns: 3,
    arms: [
      { body: { carry: 25, move: 25 }, auto: false },
      { body: { carry: 33, move: 17 }, auto: true },
      { body: { carry: 36, move: 12 }, auto: true },
      { body: { carry: 40, move: 10 }, auto: true }
    ]
  },
  {
    title: "SPINE rcl6 (the corridor)",
    layout: spineLayout(40, 1),
    rcl: 6,
    spawns: 1,
    arms: [
      { body: { carry: 16, move: 16 }, auto: false },
      { body: { carry: 20, move: 10 }, auto: true }
    ]
  },
  {
    title: "FLOWER rcl6 (6-packs)",
    layout: flowerLayout(40, 1),
    rcl: 6,
    spawns: 1,
    arms: [
      { body: { carry: 16, move: 16 }, auto: false },
      { body: { carry: 20, move: 10 }, auto: true }
    ]
  }
];

for (const g of GALLERY) {
  console.log(`\n=== ${g.title} ===`);
  console.log(`lane geometry: ${laneGeometry(g.layout)}`);
  for (const arm of g.arms) console.log("  " + measure(g.layout, g.rcl, g.spawns, arm.body, arm.auto));
  console.log(renderLayout(g.layout));
}
