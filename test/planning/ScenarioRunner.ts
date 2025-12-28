/**
 * @fileoverview Scenario-based test runner for ChainPlanner.
 *
 * This module provides a framework for running planning scenarios
 * from configuration files, enabling rapid iteration on the planning
 * algorithm with handcrafted test cases.
 *
 * Usage:
 *   npx ts-node test/scenarios/run-scenarios.ts [scenario-name]
 *
 * Scenarios are JSON files that define:
 * - Node configurations (spawns, sources, controllers)
 * - Expected outputs (viable chains, profit ranges)
 * - Comments explaining what each scenario tests
 */

import { Position } from "../../src/types/Position";
import { Node } from "../../src/nodes/Node";
import { Chain, calculateProfit, calculateChainROI } from "../../src/planning/Chain";
import { ChainPlanner } from "../../src/planning/ChainPlanner";
import { OfferCollector } from "../../src/planning/OfferCollector";
import { MintValues, createMintValues } from "../../src/colony/MintValues";
import {
  Fixture,
  FixtureNode,
  HydrationResult,
  hydrateFixture,
  resetIdCounter
} from "../../src/planning/FixtureHydration";
import { AnyCorpState } from "../../src/corps/CorpState";
import { projectAll, collectBuys, collectSells } from "../../src/planning/projections";

/**
 * Scenario definition extending Fixture with planning parameters
 */
export interface Scenario extends Fixture {
  /** Scenario name for identification */
  name: string;

  /** What this scenario tests */
  purpose: string;

  /** Expected results for validation */
  expectations?: ScenarioExpectations;

  /** Planning configuration overrides */
  config?: ScenarioConfig;
}

/**
 * Expected results for scenario validation
 */
export interface ScenarioExpectations {
  /** Minimum number of viable chains expected */
  minViableChains?: number;

  /** Maximum number of viable chains expected */
  maxViableChains?: number;

  /** Expected total profit range */
  profitRange?: { min: number; max: number };

  /** Specific chains expected (by corp types involved) */
  expectedChainPatterns?: string[][];

  /** Chains that should NOT be viable */
  invalidChainPatterns?: string[][];
}

/**
 * Planning configuration for a scenario
 */
export interface ScenarioConfig {
  /** Current tick for planning */
  tick?: number;

  /** Budget constraint for chain selection */
  budget?: number;

  /** Maximum chain depth */
  maxDepth?: number;

  /** Mint values override */
  mintValues?: Partial<MintValues>;

  /** Whether to use deterministic IDs */
  deterministicIds?: boolean;
}

/**
 * Result of running a scenario
 */
export interface ScenarioResult {
  /** Scenario that was run */
  scenario: Scenario;

  /** Hydrated nodes */
  nodes: Node[];

  /** All corp states */
  corpStates: AnyCorpState[];

  /** Viable chains found */
  viableChains: Chain[];

  /** Best chains selected within budget */
  bestChains: Chain[];

  /** Human-readable report */
  report: string;

  /** Whether expectations were met */
  passed: boolean;

  /** Failure reasons if any */
  failures: string[];

  /** Execution time in ms */
  executionTime: number;
}

/**
 * ScenarioRunner executes planning scenarios and validates results.
 */
export class ScenarioRunner {
  private defaultMintValues: MintValues;

  constructor() {
    // Default mint values for scenarios (simplified for testing)
    this.defaultMintValues = createMintValues({
      rcl_upgrade: 1.0,
      gcl_upgrade: 1.0,
      remote_source_tap: 0.5,
      container_built: 0.1
    });
  }

  /**
   * Run a single scenario and return results.
   */
  runScenario(scenario: Scenario): ScenarioResult {
    const startTime = Date.now();
    const failures: string[] = [];

    // Reset ID counter for deterministic results
    if (scenario.config?.deterministicIds !== false) {
      resetIdCounter();
    }

    // Hydrate the fixture
    const tick = scenario.config?.tick ?? 0;
    const hydrationResult = hydrateFixture(scenario, {
      currentTick: tick
    });

    const { nodes, corpStates, spawns } = hydrationResult;

    // Set up offer collector
    const collector = new OfferCollector();
    collector.collectFromCorpStates(corpStates, tick);

    // Set up mint values
    const mintValues = {
      ...this.defaultMintValues,
      ...(scenario.config?.mintValues ?? {})
    };

    // Create planner
    const planner = new ChainPlanner(
      collector,
      mintValues,
      scenario.config?.maxDepth ?? 10
    );
    planner.registerCorpStates(corpStates, tick);

    // Run planning
    const viableChains = planner.findViableChains(tick);
    const budget = scenario.config?.budget ?? Infinity;
    const bestChains = planner.findBestChains(tick, budget);

    // Generate report
    const report = this.generateScenarioReport(
      scenario,
      nodes,
      corpStates,
      viableChains,
      bestChains,
      tick
    );

    // Validate expectations
    if (scenario.expectations) {
      this.validateExpectations(
        scenario.expectations,
        viableChains,
        bestChains,
        failures
      );
    }

    const executionTime = Date.now() - startTime;

    return {
      scenario,
      nodes,
      corpStates,
      viableChains,
      bestChains,
      report,
      passed: failures.length === 0,
      failures,
      executionTime
    };
  }

  /**
   * Run multiple scenarios and return all results.
   */
  runScenarios(scenarios: Scenario[]): ScenarioResult[] {
    return scenarios.map((s) => this.runScenario(s));
  }

  /**
   * Generate a comprehensive report for a scenario run.
   */
  private generateScenarioReport(
    scenario: Scenario,
    nodes: Node[],
    corpStates: AnyCorpState[],
    viableChains: Chain[],
    bestChains: Chain[],
    tick: number
  ): string {
    const lines: string[] = [];
    const separator = "=".repeat(70);
    const thinSeparator = "-".repeat(70);

    // Header
    lines.push("");
    lines.push(separator);
    lines.push(`SCENARIO: ${scenario.name}`);
    lines.push(separator);
    lines.push("");
    lines.push(`Purpose: ${scenario.purpose}`);
    lines.push(`Description: ${scenario.description}`);
    lines.push("");

    // Node summary
    lines.push(thinSeparator);
    lines.push("NODES:");
    lines.push(thinSeparator);
    for (const node of nodes) {
      const resources = node.resources.map((r) => r.type).join(", ");
      lines.push(
        `  ${node.id}: ${node.roomName} (${node.peakPosition.x}, ${node.peakPosition.y})`
      );
      lines.push(`    Resources: ${resources || "(none)"}`);
    }
    lines.push("");

    // Corps summary
    lines.push(thinSeparator);
    lines.push("CORP STATES:");
    lines.push(thinSeparator);

    const projections = projectAll(corpStates, tick);
    const projectionsMap = new Map(
      projections.map((p, i) => [corpStates[i].id, p])
    );

    for (const state of corpStates) {
      lines.push(`  ${state.id}`);
      lines.push(`    Type: ${state.type}`);
      lines.push(`    Node: ${state.nodeId}`);

      // Show offers from projections
      const projection = projectionsMap.get(state.id);
      if (projection) {
        if (projection.sells.length > 0) {
          lines.push(
            `    Sells: ${projection.sells.map((o) => `${o.resource}@${o.price.toFixed(4)}`).join(", ")}`
          );
        }
        if (projection.buys.length > 0) {
          lines.push(
            `    Buys: ${projection.buys.map((o) => `${o.resource}@${o.price.toFixed(4)}`).join(", ")}`
          );
        }
      }
    }
    lines.push("");

    // Viable chains
    lines.push(thinSeparator);
    lines.push(`VIABLE CHAINS: ${viableChains.length} found`);
    lines.push(thinSeparator);

    if (viableChains.length === 0) {
      lines.push("  (No viable chains found)");
      lines.push("");
      lines.push("  Possible reasons:");
      lines.push("    - No goal corps (upgrading) with demand");
      lines.push("    - No supply chain from sources to goals");
      lines.push("    - Costs exceed mint value");
    } else {
      for (const chain of viableChains) {
        const profit = calculateProfit(chain);
        const roi = calculateChainROI(chain);
        const corpFlow = chain.segments.map((s) => s.corpType).join(" → ");

        lines.push("");
        lines.push(`  Chain: ${chain.id}`);
        lines.push(`    Flow: ${corpFlow}`);
        lines.push(`    Cost: ${chain.totalCost.toFixed(2)}`);
        lines.push(`    Mint: ${chain.mintValue.toFixed(2)}`);
        lines.push(`    Profit: ${profit.toFixed(2)}`);
        lines.push(`    ROI: ${(roi * 100).toFixed(1)}%`);
      }
    }
    lines.push("");

    // Best chains (within budget)
    if (bestChains.length > 0) {
      lines.push(thinSeparator);
      lines.push(`BEST CHAINS (within budget): ${bestChains.length} selected`);
      lines.push(thinSeparator);

      let totalProfit = 0;
      let totalCost = 0;

      for (const chain of bestChains) {
        const profit = calculateProfit(chain);
        totalProfit += profit;
        totalCost += chain.totalCost;
        lines.push(`  ${chain.id}: profit=${profit.toFixed(2)}`);
      }

      lines.push("");
      lines.push(`  Total Cost: ${totalCost.toFixed(2)}`);
      lines.push(`  Total Profit: ${totalProfit.toFixed(2)}`);
    }
    lines.push("");

    lines.push(separator);
    lines.push("");

    return lines.join("\n");
  }

  /**
   * Validate scenario expectations against results.
   */
  private validateExpectations(
    expectations: ScenarioExpectations,
    viableChains: Chain[],
    bestChains: Chain[],
    failures: string[]
  ): void {
    // Check viable chain count
    if (
      expectations.minViableChains !== undefined &&
      viableChains.length < expectations.minViableChains
    ) {
      failures.push(
        `Expected at least ${expectations.minViableChains} viable chains, got ${viableChains.length}`
      );
    }

    if (
      expectations.maxViableChains !== undefined &&
      viableChains.length > expectations.maxViableChains
    ) {
      failures.push(
        `Expected at most ${expectations.maxViableChains} viable chains, got ${viableChains.length}`
      );
    }

    // Check profit range
    if (expectations.profitRange) {
      const totalProfit = viableChains.reduce(
        (sum, c) => sum + calculateProfit(c),
        0
      );

      if (totalProfit < expectations.profitRange.min) {
        failures.push(
          `Expected min profit ${expectations.profitRange.min}, got ${totalProfit.toFixed(2)}`
        );
      }

      if (totalProfit > expectations.profitRange.max) {
        failures.push(
          `Expected max profit ${expectations.profitRange.max}, got ${totalProfit.toFixed(2)}`
        );
      }
    }

    // Check expected chain patterns
    if (expectations.expectedChainPatterns) {
      for (const pattern of expectations.expectedChainPatterns) {
        const found = viableChains.some((chain) => {
          const corpTypes = chain.segments.map((s) => s.corpType);
          return (
            pattern.length === corpTypes.length &&
            pattern.every((p, i) => p === corpTypes[i])
          );
        });

        if (!found) {
          failures.push(`Expected chain pattern not found: ${pattern.join(" → ")}`);
        }
      }
    }
  }

  /**
   * Print a summary of multiple scenario results.
   */
  printSummary(results: ScenarioResult[]): string {
    const lines: string[] = [];
    const separator = "=".repeat(70);

    lines.push("");
    lines.push(separator);
    lines.push("SCENARIO SUMMARY");
    lines.push(separator);
    lines.push("");

    let passed = 0;
    let failed = 0;

    for (const result of results) {
      const status = result.passed ? "✓ PASS" : "✗ FAIL";
      const chainCount = result.viableChains.length;
      lines.push(
        `${status}  ${result.scenario.name} (${chainCount} chains, ${result.executionTime}ms)`
      );

      if (!result.passed) {
        for (const failure of result.failures) {
          lines.push(`       └─ ${failure}`);
        }
        failed++;
      } else {
        passed++;
      }
    }

    lines.push("");
    lines.push(separator);
    lines.push(`Total: ${passed} passed, ${failed} failed`);
    lines.push(separator);
    lines.push("");

    return lines.join("\n");
  }
}

/**
 * Load a scenario from a JSON object
 */
export function parseScenario(json: unknown): Scenario {
  const obj = json as Record<string, unknown>;

  if (!obj.name || typeof obj.name !== "string") {
    throw new Error("Scenario must have a name");
  }

  if (!obj.nodes || !Array.isArray(obj.nodes)) {
    throw new Error("Scenario must have nodes array");
  }

  return {
    name: obj.name as string,
    purpose: (obj.purpose as string) ?? "",
    description: (obj.description as string) ?? "",
    nodes: obj.nodes as FixtureNode[],
    expectations: obj.expectations as ScenarioExpectations | undefined,
    config: obj.config as ScenarioConfig | undefined
  };
}

/**
 * Create a simple scenario programmatically
 */
export function createScenario(
  name: string,
  purpose: string,
  nodes: FixtureNode[],
  expectations?: ScenarioExpectations,
  config?: ScenarioConfig
): Scenario {
  return {
    name,
    purpose,
    description: purpose,
    nodes,
    expectations,
    config
  };
}
