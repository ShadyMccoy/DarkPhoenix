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
  console.log("");

  // Calculate metrics for each scenario
  interface ScenarioMetrics {
    name: string;
    sources: number;
    totalCapacity: number;
    roomDistance: number;
    profit: number;
    energyPerSource: number;
    chains: number;
  }

  const metrics: ScenarioMetrics[] = [];

  for (const result of viable) {
    // Count sources and total capacity
    let sources = 0;
    let totalCapacity = 0;
    let maxRoomDistance = 0;
    const homeRoom = result.scenario.nodes[0]?.roomName ?? "W1N1";

    for (const node of result.scenario.nodes) {
      for (const resource of node.resourceNodes) {
        if (resource.type === "source") {
          sources++;
          totalCapacity += resource.capacity ?? 3000;
          // Estimate room distance
          if (node.roomName !== homeRoom) {
            const dist = estimateRoomDist(homeRoom, node.roomName);
            if (dist > maxRoomDistance) maxRoomDistance = dist;
          }
        }
      }
    }

    // Sum profit from viable chains
    let totalProfit = 0;
    for (const chain of result.viableChains) {
      totalProfit += chain.mintValue - chain.totalCost;
    }

    metrics.push({
      name: result.scenario.name,
      sources,
      totalCapacity,
      roomDistance: maxRoomDistance,
      profit: totalProfit,
      energyPerSource: sources > 0 ? totalCapacity / sources : 0,
      chains: result.viableChains.length
    });
  }

  // Sort by total capacity (highest first)
  metrics.sort((a, b) => b.totalCapacity - a.totalCapacity);

  // Print table header
  console.log(
    padRight("Scenario", 25) +
    padRight("Sources", 9) +
    padRight("Capacity", 10) +
    padRight("E/Source", 10) +
    padRight("Distance", 10) +
    padRight("Profit", 10)
  );
  console.log("-".repeat(74));

  // Print each row
  for (const m of metrics) {
    const distStr = m.roomDistance > 0 ? `${m.roomDistance} rooms` : "local";
    console.log(
      padRight(m.name.substring(0, 24), 25) +
      padRight(String(m.sources), 9) +
      padRight(String(m.totalCapacity), 10) +
      padRight(String(m.energyPerSource), 10) +
      padRight(distStr, 10) +
      padRight(m.profit.toFixed(0), 10)
    );
  }

  console.log("");

  // Print comparison insights
  if (metrics.length >= 2) {
    const keeper = metrics.find((m) => m.name.toLowerCase().includes("keeper"));
    const normal = metrics.find((m) => m.sources === 2 && m.roomDistance === 0);

    if (keeper && normal) {
      const capacityRatio = keeper.totalCapacity / normal.totalCapacity;
      const sourceRatio = keeper.sources / normal.sources;
      console.log(colorize("Keeper vs Normal Room:", "cyan"));
      console.log(`  Capacity: ${capacityRatio.toFixed(1)}x (${keeper.totalCapacity} vs ${normal.totalCapacity})`);
      console.log(`  Sources:  ${sourceRatio.toFixed(1)}x (${keeper.sources} vs ${normal.sources})`);
      console.log(`  E/Source: ${keeper.energyPerSource} vs ${normal.energyPerSource} (+${((keeper.energyPerSource / normal.energyPerSource - 1) * 100).toFixed(0)}%)`);
      console.log("");
    }
  }
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
