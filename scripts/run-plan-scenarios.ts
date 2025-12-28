#!/usr/bin/env ts-node

/**
 * ChainPlanner Scenario Test Runner
 *
 * Run planning scenarios from JSON configuration files to iterate on
 * the ChainPlanner algorithm without needing a live Screeps server.
 *
 * Usage:
 *   npm run plan:scenario              # Run all scenarios
 *   npm run plan:scenario single       # Run scenarios matching "single"
 *   npm run plan:scenario:verbose      # Verbose output
 *   npm run plan:scenario:list         # List available scenarios
 */

import * as fs from "fs";
import * as path from "path";
import {
  ScenarioRunner,
  Scenario,
  parseScenario,
  ScenarioResult
} from "../src/planning/ScenarioRunner";

// ANSI colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Load all scenario files from the scenarios directory
 */
function loadScenarios(scenariosDir: string): Scenario[] {
  const scenarios: Scenario[] = [];

  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json"));
  files.sort(); // Sort by filename for consistent ordering

  for (const file of files) {
    const filePath = path.join(scenariosDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(content);
      const scenario = parseScenario(json);
      scenarios.push(scenario);
    } catch (err) {
      console.error(colorize(`Error loading ${file}: ${err}`, "red"));
    }
  }

  return scenarios;
}

/**
 * List available scenarios
 */
function listScenarios(scenarios: Scenario[]): void {
  console.log("");
  console.log(colorize("Available Planning Scenarios:", "bright"));
  console.log("");

  for (const scenario of scenarios) {
    console.log(`  ${colorize(scenario.name, "cyan")}`);
    console.log(`    ${colors.dim}${scenario.purpose}${colors.reset}`);
    console.log("");
  }
}

/**
 * Run scenarios and print results
 */
function runScenarios(
  scenarios: Scenario[],
  verbose: boolean
): { passed: number; failed: number } {
  const runner = new ScenarioRunner();
  const results: ScenarioResult[] = [];

  console.log("");
  console.log(colorize("Running Planning Scenarios...", "bright"));
  console.log("");

  for (const scenario of scenarios) {
    console.log(`  Running: ${colorize(scenario.name, "cyan")}...`);

    const result = runner.runScenario(scenario);
    results.push(result);

    if (verbose || !result.passed) {
      console.log(result.report);
    } else {
      // Brief summary
      const chainInfo = `${result.viableChains.length} viable chains`;
      const timeInfo = `${result.executionTime}ms`;
      const status = result.passed
        ? colorize("PASS", "green")
        : colorize("FAIL", "red");

      console.log(`    ${status} - ${chainInfo} (${timeInfo})`);
    }

    if (!result.passed) {
      console.log(colorize("    Failures:", "red"));
      for (const failure of result.failures) {
        console.log(`      - ${failure}`);
      }
    }
    console.log("");
  }

  // Print summary
  console.log(runner.printSummary(results));

  // Print efficiency scorecard
  printEfficiencyScorecard(results);

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return { passed, failed };
}

/**
 * Print efficiency scorecard comparing all scenarios
 */
function printEfficiencyScorecard(results: ScenarioResult[]): void {
  // Filter to scenarios with viable chains
  const viable = results.filter((r) => r.viableChains.length > 0);
  if (viable.length === 0) return;

  console.log("");
  console.log(colorize("======================================================================", "bright"));
  console.log(colorize("EFFICIENCY SCORECARD", "bright"));
  console.log(colorize("======================================================================", "bright"));

  // Economic constants
  const CREEP_LIFESPAN = 1500;
  const MINER_COST = 5 * 100 + 1 * 50 + 3 * 50; // 5W 1C 3M = 700
  const HAULER_COST_PER_CARRY = 100; // 1C 1M = 100
  const CARRY_CAPACITY = 50;

  interface SourceEcon {
    distance: number;
    grossPerTick: number;
    miningCost: number;
    haulCost: number;
    netPerTick: number;
    efficiency: number;
  }

  interface ScenarioEcon {
    name: string;
    sources: SourceEcon[];
    totalGross: number;
    totalMining: number;
    totalHaul: number;
    totalNet: number;
    efficiency: number;
    roomDistance: number;
  }

  const scenarioEcons: ScenarioEcon[] = [];

  for (const result of viable) {
    const scenario = result.scenario;
    const homeRoom = scenario.nodes[0]?.roomName ?? "W1N1";

    // Find spawn position
    let spawnPos = { x: 25, y: 25 };
    let controllerPos = { x: 25, y: 40 };

    for (const node of scenario.nodes) {
      for (const resource of node.resourceNodes) {
        if (resource.type === "spawn") {
          spawnPos = resource.position;
        }
        if (resource.type === "controller") {
          controllerPos = resource.position;
        }
      }
    }

    const sources: SourceEcon[] = [];
    let maxRoomDist = 0;

    for (const node of scenario.nodes) {
      for (const resource of node.resourceNodes) {
        if (resource.type === "source") {
          const capacity = resource.capacity ?? 3000;
          const grossPerTick = capacity / 300; // energy per tick

          // Calculate distances
          const roomDist = estimateRoomDist(homeRoom, node.roomName);
          if (roomDist > maxRoomDist) maxRoomDist = roomDist;

          // Distance from spawn to source (for mining)
          const spawnToSource = roomDist * 50 +
            Math.max(Math.abs(resource.position.x - spawnPos.x),
                     Math.abs(resource.position.y - spawnPos.y));

          // Distance from source to controller (for hauling)
          const sourceToController = roomDist * 50 +
            Math.max(Math.abs(resource.position.x - controllerPos.x),
                     Math.abs(resource.position.y - controllerPos.y));

          // Mining cost: miner body / lifespan + travel overhead
          const miningCost = MINER_COST / CREEP_LIFESPAN +
            (spawnToSource * 2 / CREEP_LIFESPAN) * grossPerTick;

          // Hauling cost: need enough CARRY parts to move grossPerTick
          // Round trip ticks = distance * 2
          // Energy per trip = CARRY_CAPACITY * carryParts
          // Trips per life = CREEP_LIFESPAN / roundTrip
          // Need: grossPerTick * CREEP_LIFESPAN = trips * energyPerTrip
          const roundTrip = sourceToController * 2 + 2;
          const energyPerTick = CARRY_CAPACITY / roundTrip; // per CARRY part
          const carryPartsNeeded = grossPerTick / energyPerTick;
          const haulCost = (carryPartsNeeded * HAULER_COST_PER_CARRY) / CREEP_LIFESPAN;

          const netPerTick = grossPerTick - miningCost - haulCost;
          const efficiency = netPerTick / grossPerTick;

          sources.push({
            distance: sourceToController,
            grossPerTick,
            miningCost,
            haulCost,
            netPerTick,
            efficiency
          });
        }
      }
    }

    // Sum totals
    const totalGross = sources.reduce((s, src) => s + src.grossPerTick, 0);
    const totalMining = sources.reduce((s, src) => s + src.miningCost, 0);
    const totalHaul = sources.reduce((s, src) => s + src.haulCost, 0);
    const totalNet = sources.reduce((s, src) => s + src.netPerTick, 0);

    scenarioEcons.push({
      name: scenario.name,
      sources,
      totalGross,
      totalMining,
      totalHaul,
      totalNet,
      efficiency: totalGross > 0 ? totalNet / totalGross : 0,
      roomDistance: maxRoomDist
    });
  }

  // Sort by net energy (highest first)
  scenarioEcons.sort((a, b) => b.totalNet - a.totalNet);

  // Print summary table
  console.log("");
  console.log(
    padRight("Scenario", 22) +
    padRight("Src", 4) +
    padRight("Gross", 8) +
    padRight("Mining", 8) +
    padRight("Haul", 8) +
    padRight("Net", 8) +
    padRight("Eff", 7)
  );
  console.log("-".repeat(65));

  for (const e of scenarioEcons) {
    const distStr = e.roomDistance > 0 ? ` (${e.roomDistance}rm)` : "";
    console.log(
      padRight(e.name.substring(0, 21) + distStr, 22) +
      padRight(String(e.sources.length), 4) +
      padRight(e.totalGross.toFixed(1), 8) +
      padRight(e.totalMining.toFixed(2), 8) +
      padRight(e.totalHaul.toFixed(2), 8) +
      padRight(e.totalNet.toFixed(1), 8) +
      padRight((e.efficiency * 100).toFixed(0) + "%", 7)
    );
  }

  // Show detailed breakdown for interesting scenarios
  const keeper = scenarioEcons.find(s => s.name.toLowerCase().includes("keeper"));
  const twoSource = scenarioEcons.find(s => s.name.toLowerCase().includes("two source"));

  if (keeper) {
    console.log("");
    console.log(colorize(`--- ${keeper.name} Source Breakdown ---`, "cyan"));
    for (let i = 0; i < keeper.sources.length; i++) {
      const src = keeper.sources[i];
      console.log(
        `  Source ${i + 1}: ` +
        `dist=${src.distance.toFixed(0).padStart(3)}, ` +
        `gross=${src.grossPerTick.toFixed(1)}, ` +
        `mine=${src.miningCost.toFixed(2)}, ` +
        `haul=${src.haulCost.toFixed(2)}, ` +
        `net=${src.netPerTick.toFixed(2)}, ` +
        `eff=${(src.efficiency * 100).toFixed(0)}%`
      );
    }
  }

  // Comparison
  if (keeper && twoSource) {
    console.log("");
    console.log(colorize("--- Keeper vs Two Source Room ---", "cyan"));
    console.log(`  Gross energy: ${keeper.totalGross.toFixed(1)} vs ${twoSource.totalGross.toFixed(1)} (+${((keeper.totalGross / twoSource.totalGross - 1) * 100).toFixed(0)}%)`);
    console.log(`  Net energy:   ${keeper.totalNet.toFixed(1)} vs ${twoSource.totalNet.toFixed(1)} (+${((keeper.totalNet / twoSource.totalNet - 1) * 100).toFixed(0)}%)`);
    console.log(`  Efficiency:   ${(keeper.efficiency * 100).toFixed(0)}% vs ${(twoSource.efficiency * 100).toFixed(0)}%`);
  }
  console.log("");
}

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

function estimateRoomDist(roomA: string, roomB: string): number {
  const parseRoom = (name: string): { x: number; y: number } | null => {
    const match = name.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return null;
    const x = match[1] === "W" ? -parseInt(match[2]) : parseInt(match[2]);
    const y = match[3] === "N" ? -parseInt(match[4]) : parseInt(match[4]);
    return { x, y };
  };
  const a = parseRoom(roomA);
  const b = parseRoom(roomB);
  if (!a || !b) return 0;
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Main entry point
 */
function main(): void {
  const args = process.argv.slice(2);

  // Parse arguments
  const verbose = args.includes("--verbose") || args.includes("-v");
  const listOnly = args.includes("--list") || args.includes("-l");
  const filter = args.find((a) => !a.startsWith("-"));

  // Find scenarios directory
  const scenariosDir = path.join(__dirname, "..", "test", "scenarios");

  if (!fs.existsSync(scenariosDir)) {
    console.error(colorize(`Scenarios directory not found: ${scenariosDir}`, "red"));
    process.exit(1);
  }

  // Load scenarios
  let scenarios = loadScenarios(scenariosDir);

  if (scenarios.length === 0) {
    console.error(colorize("No scenarios found!", "red"));
    process.exit(1);
  }

  // Filter if specified
  if (filter) {
    const filterLower = filter.toLowerCase();
    scenarios = scenarios.filter(
      (s) =>
        s.name.toLowerCase().includes(filterLower) ||
        s.purpose.toLowerCase().includes(filterLower)
    );

    if (scenarios.length === 0) {
      console.error(colorize(`No scenarios match filter: ${filter}`, "yellow"));
      process.exit(1);
    }
  }

  // List or run
  if (listOnly) {
    listScenarios(scenarios);
  } else {
    console.log(
      colorize(
        `\n========== CHAINPLANNER SCENARIO TEST RUNNER ==========\n`,
        "bright"
      )
    );
    console.log(`Found ${scenarios.length} scenario(s) to run`);
    if (filter) {
      console.log(`Filter: "${filter}"`);
    }
    console.log(`Verbose: ${verbose}`);

    const { passed, failed } = runScenarios(scenarios, verbose);

    // Exit with error code if any failed
    if (failed > 0) {
      process.exit(1);
    }
  }
}

// Run
main();
