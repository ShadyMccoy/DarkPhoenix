/* eslint-disable no-console */
/**
 * base-lab/sim-bridge - measure a base-lab GEOMETRY's refill in the extension
 * sim.
 *
 * base-lab plans a real-terrain base (highways = hauler routes, alveolar
 * extension field) and measures the PLACEMENT (compactness, outskirts depth in
 * tiles). This bridge feeds that exact geometry - walls, core, spawns,
 * extensions, highways-as-reserved - into the extension sim and reads back the
 * REFILL (latency in ticks). So the dead-space bias finally gets priced in the
 * metric that matters: does pushing extensions out to the dead-end suburbs cost
 * refill latency, or is it free?
 *
 * Run:
 *   npx ts-node -P tsconfig.test.json scripts/base-lab/sim-bridge.ts [fixture] \
 *       [--rcl 8] [--ticks 1500] [--carry 25] [--move 25] [--target 60]
 */
import { SIZE, packTile, isWall, type Pt } from "./geometry";
import { BasePlan, RCL8_EXTENSIONS, defaultFixture, loadFixture, planBase } from "./plan";
import { Layout, Pos, Scenario, simulate } from "../extension-sim/engine";

const unpack = (tile: number): Pos => ({ x: tile % SIZE, y: Math.floor(tile / SIZE) });

/** Every wall tile of the room, as sim obstacles. */
function wallTiles(terrain: string[]): Pos[] {
  const out: Pos[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (isWall(terrain, x, y)) out.push({ x, y });
    }
  }
  return out;
}

/**
 * The tender's duct lattice, paved: every walkable tile adjacent to a placed
 * extension (where the tender stands to fill / travels between fills). In a
 * real base you pave the filler lanes; roads halve the loaded-move fatigue, so
 * this is what a MOVE-shed CARRY-heavy body needs to travel its deadhead at
 * speed. Paving the ducts (which chain back to the core) also paves the
 * storage->frontier deadhead.
 */
function ductRoads(plan: BasePlan): Pos[] {
  const roads = new Set<number>();
  const extSet = new Set(plan.extensions.map(e => packTile(e.x, e.y)));
  for (const e of plan.extensions) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = e.x + dx;
        const ny = e.y + dy;
        if (isWall(plan.input.terrain, nx, ny)) continue;
        const t = packTile(nx, ny);
        if (extSet.has(t) || !plan.reachSet.has(t)) continue; // ducts only, not structure tiles
        roads.add(t);
      }
    }
  }
  return [...roads].map(unpack);
}

/** Translate a base-lab plan into a sim Layout on the 50x50 board: the core is
 * the reload anchor (storage), the core pocket's spawns drain, the alveolar
 * field is the extensions, the highways are reserved lanes, and the terrain
 * walls are obstacles the tender must route around. */
function toSimLayout(plan: BasePlan, roadsMode: string): Layout {
  const spawns: Pt[] = plan.spawns.length > 0 ? plan.spawns : [{ x: plan.spawn.x + 1, y: plan.spawn.y }];
  return {
    name: `${plan.input.name}-alveoli`,
    size: SIZE,
    storage: { x: plan.spawn.x, y: plan.spawn.y },
    spawns,
    extensions: plan.extensions,
    roads: roadsMode === "ducts" ? ductRoads(plan) : [],
    reserved: [...plan.highways].map(unpack),
    walls: wallTiles(plan.input.terrain)
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flagVal = (name: string, dflt: string): string => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const valueFlags = new Set(["--rcl", "--ticks", "--carry", "--move", "--target", "--bias", "--roads"]);
  const positional = args.find((a, i) => !a.startsWith("--") && !(i > 0 && valueFlags.has(args[i - 1])));

  const rcl = Number(flagVal("--rcl", "8"));
  const ticks = Number(flagVal("--ticks", "1500"));
  const carry = Number(flagVal("--carry", "25"));
  const move = Number(flagVal("--move", "25"));
  const roadsMode = flagVal("--roads", "ducts"); // "ducts" (pave the filler lanes) | "none"
  const target = Number(flagVal("--target", String(RCL8_EXTENSIONS)));
  const biases = flagVal("--bias", "0,1,2,3")
    .split(",")
    .map(Number)
    .filter(b => !Number.isNaN(b));
  const fixture = positional ?? defaultFixture();
  const input = loadFixture(fixture);

  console.log(
    `\n=== sim-bridge: ${input.name} @ RCL${rcl}, ${carry}C${move}M x1 tender, roads:${roadsMode}, ${ticks}t ===\n` +
      `sweeping --dead-bias; PLACEMENT gauges (base-lab) next to REFILL (sim)\n`
  );
  console.log(
    ["bias", "ext", "compact", "outskirts", "onEdge", "refill mean/worst", "util", "endFill"]
      .map((h, i) => h.padEnd([5, 5, 8, 10, 7, 20, 7, 7][i]))
      .join("")
  );

  for (const deadBias of biases) {
    const plan = planBase(input, { target, fillMode: "alveoli", deadBias });
    const layout = toSimLayout(plan, roadsMode);
    const scenario: Scenario = {
      layout,
      rcl,
      drawOrder: "near-reload-first",
      tenderPolicy: "greedy-nearest",
      tenderCount: 1,
      tenderBody: { carry, move },
      ticks
    };
    const m = simulate(scenario);
    const refill = m.refillEvents > 0 ? `${m.meanRefillLatency.toFixed(0)}/${m.worstRefillLatency}t` : "never-full";
    console.log(
      [
        String(deadBias).padEnd(5),
        String(plan.extPlaced).padEnd(5),
        plan.meanExtDist.toFixed(1).padEnd(8),
        plan.meanExtDead.toFixed(1).padEnd(10),
        String(plan.extOnAccess).padEnd(7),
        refill.padEnd(20),
        m.utilization.toFixed(3).padEnd(7),
        m.endFill.toFixed(3).padEnd(7)
      ].join("")
    );
  }
  console.log(
    "\ncompact = mean ext travel-dist from core (tiles); outskirts = mean dead-end depth from nearest artery (tiles);\n" +
      "refill = ticks from a drain back to full. The question: does higher outskirts depth cost refill latency?"
  );
}

main();
