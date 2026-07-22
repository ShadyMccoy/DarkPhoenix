/**
 * extension-sim/automaton - the owner's circuit-automaton hypothesis
 * (2026-07-22): "I don't see how circuit patrol could lose because we
 * could always simply empty the extensions that are next on the circuit"
 * and "1:1 on the tender is overkill. In a dense geometry, it can move,
 * fill up a couple extensions and then move again."
 *
 * Arms: on the circuit layouts (spine corridors / flower 6-packs), compare
 * the prior champion (greedy + near-reload + 1:1) against the automaton
 * (lane-patrol + CIRCUIT-ALIGNED draw order) at three CARRY:MOVE ratios.
 * Fatigue recovers while standing to transfer, so a heavy body's rest
 * ticks hide inside the standing ticks dense geometry forces anyway - and
 * under the 50-part cap, shed MOVE buys CARRY: 25C25M holds 1250 but
 * 33C17M holds 1650 and 40C10M 2000.
 *
 *   npx ts-node -P tsconfig.test.json scripts/extension-sim/automaton.ts
 */
import { DrawOrder, Layout, Scenario, TenderPolicy, flowerLayout, simulate, spineLayout } from "./engine";

interface Body {
  name: string;
  carry: number;
  move: number;
}

interface Preset {
  name: string;
  rcl: number;
  exts: number;
  spawns: number;
  bodies: Body[];
}

// Bodies fit the tier's energy budget (rcl6: 2300) or the 50-part cap.
const PRESETS: Preset[] = [
  {
    name: "rcl6",
    rcl: 6,
    exts: 40,
    spawns: 1,
    bodies: [
      { name: "1:1 16C16M(800)", carry: 16, move: 16 },
      { name: "2:1 20C10M(1000)", carry: 20, move: 10 },
      { name: "4:1 24C6M(1200)", carry: 24, move: 6 }
    ]
  },
  {
    name: "rcl7",
    rcl: 7,
    exts: 50,
    spawns: 2,
    bodies: [
      { name: "1:1 25C25M(1250)", carry: 25, move: 25 },
      { name: "2:1 33C17M(1650)", carry: 33, move: 17 },
      { name: "4:1 40C10M(2000)", carry: 40, move: 10 }
    ]
  },
  {
    name: "rcl8",
    rcl: 8,
    exts: 60,
    spawns: 3,
    bodies: [
      { name: "1:1 25C25M(1250)", carry: 25, move: 25 },
      { name: "2:1 33C17M(1650)", carry: 33, move: 17 },
      { name: "4:1 40C10M(2000)", carry: 40, move: 10 }
    ]
  }
];

const TICKS = 5000;

function run(layout: Layout, p: Preset, drawOrder: DrawOrder, tenderPolicy: TenderPolicy, body: Body): string {
  const s: Scenario = {
    layout,
    rcl: p.rcl,
    drawOrder,
    tenderPolicy,
    tenderCount: 1,
    tenderBody: { carry: body.carry, move: body.move },
    ticks: TICKS
  };
  const m = simulate(s);
  const refill = m.refillEvents > 0 ? `${m.meanRefillLatency.toFixed(0)}/${m.worstRefillLatency}t` : "never-full";
  return [
    layout.name.padEnd(7),
    drawOrder.padEnd(17),
    tenderPolicy.padEnd(14),
    body.name.padEnd(17),
    `util ${m.utilization.toFixed(3)}`,
    `endFill ${m.endFill.toFixed(3)}`,
    `refill ${refill}`,
    `duty ${m.tenderDuty.toFixed(2)}`,
    `wait ${m.energyWaitTicks}t`
  ].join("  ");
}

for (const p of PRESETS) {
  console.log(`\n=== ${p.name}: ${p.exts} ext @ ${p.spawns} spawn(s), 1 tender, ${TICKS}t ===`);
  for (const layout of [spineLayout(p.exts, p.spawns), flowerLayout(p.exts, p.spawns)]) {
    for (const body of p.bodies) {
      // Prior champion config as the bar.
      console.log(run(layout, p, "near-reload-first", "greedy-nearest", body));
      // The automaton: circuit-aligned drain + frontier-chasing patrol.
      console.log(run(layout, p, "circuit", "lane-patrol", body));
    }
    console.log("");
  }
}
