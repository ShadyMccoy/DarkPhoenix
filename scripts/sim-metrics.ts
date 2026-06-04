#!/usr/bin/env ts-node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * sim-metrics - run the compiled bot in the in-process Screeps engine and
 * report how its economy develops (creeps, RCL, controller progress, GCL).
 *
 * This is the quality gate for economic work: run it before and after a change
 * to see whether the colony bootstraps faster / reaches higher RCL, and to
 * compare behaviour across different room designs.
 *
 * Usage:
 *   npm run sim:metrics                 # default scenario, default ticks
 *   npm run sim:metrics -- --ticks 3000
 *   npm run sim:metrics -- --scenario single-2src
 *   npm run sim:metrics -- --all        # run every scenario and compare
 *   npm run sim:metrics -- --list
 *
 * Build first (npm run build) so dist/main.js is current.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadLayout, RoomLayout } from "../test/integration/loadLayout";

// screeps-server-mockup ships no type definitions, so require it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const DIST_MAIN_JS = "dist/main.js";

interface BotPlacement {
  room: string;
  x: number;
  y: number;
}

interface Scenario {
  name: string;
  description: string;
  /** Build the world. Return the room+coords where the bot's spawn goes. */
  build: (world: any) => Promise<BotPlacement>;
}

// ---------------------------------------------------------------------------
// Scenarios - different room designs to compare
// ---------------------------------------------------------------------------

/** All-plain single room with N sources around a central controller/spawn. */
function plainRoom(room: string, sources: Array<{ x: number; y: number }>): RoomLayout {
  return {
    room,
    terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
    objects: [
      { type: "controller", x: 25, y: 10 },
      ...sources.map((s) => ({ type: "source", x: s.x, y: s.y })),
    ],
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "stub",
    description: "Default mockup 3x3 world (9 rooms, sources + controllers).",
    build: async (world) => {
      await world.stubWorld();
      return { room: "W0N1", x: 25, y: 25 };
    },
  },
  {
    name: "single-2src",
    description: "One all-plain room, 2 sources, controller. Classic starter room.",
    build: async (world) => {
      await loadLayout(world, plainRoom("W0N0", [
        { x: 10, y: 40 },
        { x: 40, y: 40 },
      ]));
      return { room: "W0N0", x: 25, y: 25 };
    },
  },
  {
    name: "single-1src",
    description: "One all-plain room, a single source. Stress-tests low income.",
    build: async (world) => {
      await loadLayout(world, plainRoom("W0N0", [{ x: 25, y: 40 }]));
      return { room: "W0N0", x: 25, y: 25 };
    },
  },
];

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface Sample {
  tick: number;
  creeps: number;
  rcl: number;
  progress: number;
  spawnEnergy: number;
  gcl: number;
}

interface RunResult {
  scenario: string;
  samples: Sample[];
  peakCreeps: number;
  finalRcl: number;
  finalProgress: number;
  finalGcl: number;
  ticksToFirstProgress: number | null;
  errorCount: number;
}

async function runScenario(scenario: Scenario, ticks: number, sampleEvery: number): Promise<RunResult> {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("server", `metrics-${port}`);
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const placement = await scenario.build(server.world);

  const modules = { main: readFileSync(DIST_MAIN_JS).toString() };
  const player = await server.world.addBot({
    username: "player",
    room: placement.room,
    x: placement.x,
    y: placement.y,
    modules,
  });

  let errorCount = 0;
  player.on("console", (logs: string[]) => {
    for (const line of logs || []) {
      if (/error|cannot read|is not a function|TypeError|undefined is not/i.test(line)) {
        errorCount += 1;
      }
    }
  });

  await server.start();

  const samples: Sample[] = [];
  let peakCreeps = 0;
  let ticksToFirstProgress: number | null = null;

  for (let t = 1; t <= ticks; t += 1) {
    await server.tick();

    if (t % sampleEvery === 0 || t === ticks) {
      const objs = await server.world.roomObjects(placement.room);
      const creeps = objs.filter((o: any) => o.type === "creep").length;
      const ctrl = objs.find((o: any) => o.type === "controller");
      const spawn = objs.find((o: any) => o.type === "spawn");
      const progress = ctrl?.progress ?? 0;
      peakCreeps = Math.max(peakCreeps, creeps);
      if (ticksToFirstProgress === null && progress > 0) {
        ticksToFirstProgress = t;
      }
      samples.push({
        tick: t,
        creeps,
        rcl: ctrl?.level ?? 0,
        progress,
        spawnEnergy: spawn?.store?.energy ?? 0,
        gcl: (await player.gcl) ?? 0,
      });
    }
  }

  const last = samples[samples.length - 1];
  await server.stop();

  return {
    scenario: scenario.name,
    samples,
    peakCreeps,
    finalRcl: last?.rcl ?? 0,
    finalProgress: last?.progress ?? 0,
    finalGcl: last?.gcl ?? 0,
    ticksToFirstProgress,
    errorCount,
  };
}

function printTimeline(result: RunResult): void {
  console.log(`\n--- ${result.scenario} ---`);
  console.log("  tick  creeps  RCL  progress  spawnE  GCL");
  for (const s of result.samples) {
    console.log(
      `  ${String(s.tick).padStart(4)}  ${String(s.creeps).padStart(6)}  ` +
        `${String(s.rcl).padStart(3)}  ${String(s.progress).padStart(8)}  ` +
        `${String(s.spawnEnergy).padStart(6)}  ${String(s.gcl).padStart(3)}`
    );
  }
  if (result.errorCount > 0) {
    console.log(`  (!) ${result.errorCount} bot error log lines`);
  }
}

function printComparison(results: RunResult[]): void {
  console.log("\n=== Comparison ===");
  console.log("scenario        peakCreeps  finalRCL  finalProgress  finalGCL  firstProgress@  errors");
  for (const r of results) {
    console.log(
      `${r.scenario.padEnd(15)} ${String(r.peakCreeps).padStart(10)}  ` +
        `${String(r.finalRcl).padStart(8)}  ${String(r.finalProgress).padStart(13)}  ` +
        `${String(r.finalGcl).padStart(8)}  ${String(r.ticksToFirstProgress ?? "never").padStart(14)}  ` +
        `${String(r.errorCount).padStart(6)}`
    );
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };

  if (args.includes("--list")) {
    console.log("Available scenarios:");
    for (const s of SCENARIOS) {
      console.log(`  ${s.name.padEnd(14)} ${s.description}`);
    }
    return;
  }

  const ticks = parseInt(getArg("ticks", "2000"), 10);
  const sampleEvery = parseInt(getArg("sample", "100"), 10);
  const runAll = args.includes("--all");
  const wanted = getArg("scenario", "stub");

  const toRun = runAll ? SCENARIOS : SCENARIOS.filter((s) => s.name === wanted);
  if (toRun.length === 0) {
    console.error(`Unknown scenario "${wanted}". Use --list to see options.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Running ${toRun.length} scenario(s) for ${ticks} ticks (sample every ${sampleEvery})...`);

  const results: RunResult[] = [];
  for (const scenario of toRun) {
    const result = await runScenario(scenario, ticks, sampleEvery);
    printTimeline(result);
    results.push(result);
  }

  if (results.length > 1) {
    printComparison(results);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("sim-metrics failed:", err);
    process.exit(1);
  });
