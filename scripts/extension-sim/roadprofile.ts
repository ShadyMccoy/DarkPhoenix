/**
 * extension-sim/roadprofile - partial pavement matched to the cargo-weight
 * profile (owner 2026-07-22: "building roads only on the earlier
 * extensions, where the tender is full - then on the second half with less
 * weight it recovers faster and doesn't even need the roads anymore").
 *
 * Mechanics: weight = ceil(carried/50) - only LOADED carry generates
 * fatigue, so the tender is heavy exactly on the early circuit (the
 * full-load deadhead from storage to the drained frontier) and light on
 * the late circuit. Roads on the first fraction of the lane should buy
 * (nearly) all of full pavement's speed at a fraction of the build+decay.
 *
 *   npx ts-node -P tsconfig.test.json scripts/extension-sim/roadprofile.ts
 */
import { Layout, Scenario, diagonalLayout, simulate } from "./engine";

/** Keep only the first `fraction` of the lane's pavement (generators push
 * roads in lane order, so slicing IS the early-circuit prefix). */
function withRoadFraction(l: Layout, fraction: number): Layout {
  const keep = Math.ceil(l.roads.length * fraction);
  return { ...l, name: `${l.name}@${Math.round(fraction * 100)}%`, roads: l.roads.slice(0, keep) };
}

function run(l: Layout, rcl: number, body: { carry: number; move: number }): string {
  const s: Scenario = {
    layout: l,
    rcl,
    drawOrder: "circuit",
    tenderPolicy: "lane-patrol",
    tenderCount: 1,
    tenderBody: body,
    ticks: 5000
  };
  const m = simulate(s);
  const refill = m.refillEvents > 0 ? `${m.meanRefillLatency.toFixed(0)}/${m.worstRefillLatency}t` : "never-full";
  return [
    l.name.padEnd(14),
    `${l.roads.length} road tiles (${l.roads.length * 300}e)`.padEnd(24),
    `${body.carry}C${body.move}M`.padEnd(8),
    `util ${m.utilization.toFixed(3)}`,
    `endFill ${m.endFill.toFixed(3)}`,
    `refill ${refill}`
  ].join("  ");
}

for (const preset of [
  { rcl: 6, exts: 40, spawns: 1, bodies: [{ carry: 20, move: 10 }, { carry: 24, move: 6 }] },
  { rcl: 8, exts: 60, spawns: 3, bodies: [{ carry: 33, move: 17 }, { carry: 40, move: 10 }] }
]) {
  console.log(`\n=== diagonal rcl${preset.rcl}, automaton, road fraction sweep ===`);
  const base = diagonalLayout(preset.exts, preset.spawns);
  for (const body of preset.bodies) {
    for (const f of [0, 0.5, 1]) console.log(run(withRoadFraction(base, f), preset.rcl, body));
    console.log("");
  }
}
