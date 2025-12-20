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

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return { passed, failed };
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
