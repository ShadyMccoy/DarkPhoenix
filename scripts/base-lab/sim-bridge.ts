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
import { BasePlan, defaultFixture, loadFixture, planBase } from "./plan";
import { DrawOrder, Layout, Pos, Scenario, TenderPolicy, simulate } from "../extension-sim/engine";

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

/**
 * A CONTIGUOUS patrol circuit through the tender's working tiles - a DFS
 * Euler-tour over the duct tiles adjacent to the WORKING-SET extensions (the
 * nearest `workingExts`, i.e. the ones a legal creep actually drains; the
 * outskirt reservoirs are skipped). Every consecutive tile is 8-adjacent, so
 * the tender replays it with move(dir) - no per-tick PathFinder, the real CPU
 * cost of a roaming tender. Confined + contiguous, unlike the earlier
 * nearest-neighbour tour over ALL ducts that jumped around and starved.
 */
function circuit(plan: BasePlan, workingExts: number): Pos[] {
  const core = plan.spawn;
  const dcore = (x: number, y: number): number => Math.max(Math.abs(x - core.x), Math.abs(y - core.y));
  const terrain = plan.input.terrain;
  // Tiles the sim BLOCKS (storage, spawns, extensions) - the tender can't stand
  // on any of these, so they must not enter the circuit as standing tiles.
  const blocked = new Set<number>([
    packTile(plan.spawn.x, plan.spawn.y),
    ...plan.extensions.map(e => packTile(e.x, e.y)),
    ...plan.spawns.map(s => packTile(s.x, s.y))
  ]);

  const near = [...plan.extensions].sort((a, b) => dcore(a.x, a.y) - dcore(b.x, b.y)).slice(0, workingExts);
  const ductSet = new Set<number>();
  for (const e of near) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = e.x + dx;
        const ny = e.y + dy;
        if (isWall(terrain, nx, ny)) continue;
        const t = packTile(nx, ny);
        if (blocked.has(t) || !plan.reachSet.has(t)) continue;
        ductSet.add(t);
      }
    }
  }
  if (ductSet.size === 0) return [];

  // RADIAL single-visit order: each duct once, sorted by distance from the core
  // (tie-broken by angle for a spiral). Half the length of the DFS Euler tour
  // (no backtracks), and radial so reset-to-head after reload lands on the near
  // ring where near-reload-draw empties actually are. Consecutive tiles are not
  // guaranteed adjacent, so the tender paths short hops between them.
  return [...ductSet]
    .map(t => ({ x: t % SIZE, y: Math.floor(t / SIZE) }))
    .sort((a, b) => dcore(a.x, a.y) - dcore(b.x, b.y) || Math.atan2(a.y - core.y, a.x - core.x) - Math.atan2(b.y - core.y, b.x - core.x));
}

/** Translate a base-lab plan into a sim Layout on the 50x50 board: the core is
 * the reload anchor (storage), the core pocket's spawns drain, the alveolar
 * field is the extensions, the highways are reserved lanes, and the terrain
 * walls are obstacles the tender must route around. */
function toSimLayout(plan: BasePlan, roadsMode: string, workingExts: number): Layout {
  const spawns: Pt[] = plan.spawns.length > 0 ? plan.spawns : [{ x: plan.spawn.x + 1, y: plan.spawn.y }];
  return {
    name: `${plan.input.name}-alveoli`,
    size: SIZE,
    storage: { x: plan.spawn.x, y: plan.spawn.y },
    spawns,
    extensions: plan.extensions,
    roads: roadsMode === "ducts" ? ductRoads(plan) : [],
    reserved: [...plan.highways].map(unpack),
    walls: wallTiles(plan.input.terrain),
    lane: circuit(plan, workingExts) // used by lane-patrol / circuit-loop; ignored by greedy/outbound
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flagVal = (name: string, dflt: string): string => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const valueFlags = new Set(["--rcl", "--ticks", "--carry", "--move", "--target", "--bias", "--roads", "--commute", "--policy", "--tenders", "--draw"]);
  const positional = args.find((a, i) => !a.startsWith("--") && !(i > 0 && valueFlags.has(args[i - 1])));

  const rcl = Number(flagVal("--rcl", "8"));
  const ticks = Number(flagVal("--ticks", "1500"));
  const carry = Number(flagVal("--carry", "25"));
  const move = Number(flagVal("--move", "25"));
  const roadsMode = flagVal("--roads", "ducts"); // "ducts" (pave the filler lanes) | "none"
  const commuteSlack = Number(flagVal("--commute", "1.5"));
  const policy = flagVal("--policy", "greedy-nearest") as TenderPolicy; // greedy-nearest | outbound-sweep | outbound-ration | circuit-loop
  // circuit patrols need circuit-aligned draw (drain marches along the lane);
  // default the draw order to match the policy unless overridden.
  const drawDefault = policy === "circuit-loop" || policy === "lane-patrol" ? "circuit" : "near-reload-first";
  const drawOrder = flagVal("--draw", drawDefault) as DrawOrder;
  const tenders = Number(flagVal("--tenders", "1"));

  // Real per-RCL loadout: extension count, spawn count, tower/lab count all
  // scale with RCL - so RCL6/7 sim their true small grids, not the RCL8 one.
  const RCL_PRESET: Record<number, { ext: number; spawns: number; towers: number; labs: number }> = {
    6: { ext: 40, spawns: 1, towers: 2, labs: 3 },
    7: { ext: 50, spawns: 2, towers: 3, labs: 6 },
    8: { ext: 60, spawns: 3, towers: 6, labs: 10 }
  };
  const preset = RCL_PRESET[rcl] ?? RCL_PRESET[8];
  const target = Number(flagVal("--target", String(preset.ext)));

  // Spawnability guard: a tender can't cost more than the room's total energy
  // capacity (tenders are pre-placed in the sim, so it won't catch this itself).
  const EXT_CAP_BY_RCL: Record<number, number> = { 6: 50, 7: 100, 8: 200 };
  const gridCap = preset.ext * (EXT_CAP_BY_RCL[rcl] ?? 200) + preset.spawns * 300;
  const tenderCost = (carry + move) * 50;
  // Working set = extensions a legal creep actually drains (the rest are
  // reservoirs); the circuit only needs to cover these.
  const maxParts = Math.min(50, Math.floor(gridCap / 50));
  const workingExts = Math.min(preset.ext, Math.ceil((preset.spawns * maxParts * 50) / (EXT_CAP_BY_RCL[rcl] ?? 200)));
  if (tenderCost > gridCap) {
    console.log(
      `WARNING: ${carry}C${move}M costs ${tenderCost}e but the RCL${rcl} grid holds only ${gridCap}e - ` +
        `NOT spawnable (max ~${Math.floor(gridCap / 50)} parts). Results below are for an impossible creep.`
    );
  }
  const biases = flagVal("--bias", "0,1,2,3")
    .split(",")
    .map(Number)
    .filter(b => !Number.isNaN(b));
  const fixture = positional ?? defaultFixture();
  const input = loadFixture(fixture);

  console.log(
    `\n=== sim-bridge: ${input.name} @ RCL${rcl} (${preset.ext} ext, ${preset.spawns} spawn), ${carry}C${move}M x${tenders}, ${policy}, roads:${roadsMode}, ${ticks}t ===\n` +
      `sweeping --dead-bias; PLACEMENT gauges (base-lab) next to REFILL (sim)\n`
  );
  console.log(
    ["bias", "ext", "compact", "outskirts", "onEdge", "refill mean/worst", "util", "endFill", "drained", "reservoir"]
      .map((h, i) => h.padEnd([5, 5, 8, 10, 7, 20, 7, 9, 9, 9][i]))
      .join("")
  );

  for (const deadBias of biases) {
    const plan = planBase(input, {
      target,
      fillMode: "alveoli",
      deadBias,
      commuteSlack,
      spawns: preset.spawns,
      towers: preset.towers,
      labs: preset.labs
    });
    const layout = toSimLayout(plan, roadsMode, workingExts);
    const scenario: Scenario = {
      layout,
      rcl,
      drawOrder,
      tenderPolicy: policy,
      tenderCount: tenders,
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
        m.endFill.toFixed(3).padEnd(9),
        String(m.drainedExtensions).padEnd(9),
        String(m.reservoirExtensions).padEnd(9)
      ].join("")
    );
  }
  console.log(
    "\ncompact = mean ext travel-dist from core (tiles); outskirts = mean dead-end depth from nearest artery (tiles);\n" +
      "refill = ticks from a drain back to full; drained = ext that ever hit <=50% (the working set);\n" +
      "reservoir = ext that stayed >=90% full all run (outskirts a legal 50-part creep never reaches)."
  );
}

main();
