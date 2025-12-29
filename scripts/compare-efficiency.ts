#!/usr/bin/env ts-node

/**
 * Efficiency Comparison Script
 *
 * Compares economic efficiency across planning scenarios showing:
 * - Supply (gross energy/tick)
 * - Best variant for each route (mining mode + hauler ratio)
 * - Efficiency score (net/gross %)
 * - Cost breakdown (Harvesters, Haulers, Decay, Infrastructure)
 *
 * Uses the EdgeVariant system to evaluate all viable configurations
 * and select the optimal one based on constraints.
 */

import * as fs from "fs";
import * as path from "path";
import { parseScenario, Scenario, RouteDefinition } from "../test/planning/ScenarioRunner";
import {
  EdgeVariant,
  TerrainProfile,
  VariantConstraints,
  generateEdgeVariants,
  selectBestVariant,
  createHarvesterConfig,
  createHaulerConfig,
  calculateRoundTripTicks,
  calculateDecayCost,
  calculateHaulerMetrics,
  calculateHarvesterCostPerTick,
  CREEP_LIFETIME,
  SOURCE_REGEN_TICKS,
} from "../src/framework/EdgeVariant";

// =============================================================================
// Analysis Types
// =============================================================================

interface SourceAnalysis {
  sourceId: string;
  grossPerTick: number;
  distance: number;
  terrain: TerrainProfile;
  bestVariant: EdgeVariant | null;
  allVariants: EdgeVariant[];
  // Legacy fields for scenarios without routes
  harvestCost: number;
  haulCost: number;
  decayCost: number;
  miningSpots: number;
}

interface ScenarioAnalysis {
  name: string;
  supply: number;
  harvestCost: number;
  haulCost: number;
  decayCost: number;
  infraCost: number;
  claimerCost: number;
  netEnergy: number;
  efficiency: number;
  avgDistance: number;
  sources: SourceAnalysis[];
  hasRoutes: boolean;
  bestVariantSummary: string;
}

// =============================================================================
// Distance Calculation
// =============================================================================

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

// =============================================================================
// Legacy Analysis (scenarios without route definitions)
// =============================================================================

function analyzeLegacySource(
  resource: any,
  homeRoom: string,
  nodeRoomName: string,
  spawnPos: { x: number; y: number },
  controllerPos: { x: number; y: number },
  miningSpots: number,
  minerCarry: number
): SourceAnalysis {
  const MINER_BASE_COST = 5 * 100 + 3 * 50; // 5W 3M = 650
  const CARRY_PART_COST = 50;
  const HAULER_COST_PER_CARRY = 100;
  const CARRY_CAPACITY = 50;
  const MINE_RATE = 10;

  const capacity = resource.capacity ?? 3000;
  const grossPerTick = capacity / 300;
  const roomDist = estimateRoomDist(homeRoom, nodeRoomName);

  // Distance calculations (Chebyshev for in-room)
  const spawnToSource =
    roomDist * 50 +
    Math.max(
      Math.abs(resource.position.x - spawnPos.x),
      Math.abs(resource.position.y - spawnPos.y)
    );

  const sourceToController =
    roomDist * 50 +
    Math.max(
      Math.abs(resource.position.x - controllerPos.x),
      Math.abs(resource.position.y - controllerPos.y)
    );

  // Harvest cost
  const minerBodyCost = MINER_BASE_COST + minerCarry * CARRY_PART_COST;
  const harvestCost =
    minerBodyCost / CREEP_LIFETIME +
    ((spawnToSource * 2) / CREEP_LIFETIME) * grossPerTick;

  // Haul cost (assumes 1 tick/tile = roads)
  const roundTrip = sourceToController * 2 + 2;
  const energyPerTick = CARRY_CAPACITY / roundTrip;
  const carryPartsNeeded = grossPerTick / energyPerTick;
  const haulCost = (carryPartsNeeded * HAULER_COST_PER_CARRY) / CREEP_LIFETIME;

  // Decay cost
  let decayCost = 0;
  if (miningSpots > 0) {
    const fillTime = (minerCarry * CARRY_CAPACITY) / MINE_RATE;
    const pileExistsTime = Math.max(0, roundTrip - fillTime);
    const decayPerPile = pileExistsTime / roundTrip;
    decayCost = miningSpots * decayPerPile;
  }

  return {
    sourceId: `source-${resource.position.x}-${resource.position.y}`,
    grossPerTick,
    harvestCost,
    haulCost,
    decayCost,
    distance: sourceToController,
    miningSpots,
    terrain: { road: sourceToController, plain: 0, swamp: 0 }, // Assume roads
    bestVariant: null,
    allVariants: [],
  };
}

// =============================================================================
// Route-based Analysis (scenarios with terrain profiles)
// =============================================================================

function findRouteForSource(
  sourceId: string,
  routes: RouteDefinition[]
): RouteDefinition | undefined {
  // Exact match first
  const exact = routes.find((r) => r.from === sourceId);
  if (exact) return exact;

  // Try matching by position (e.g., "10-25" matches route "source-10-25")
  const positionPart = sourceId.replace("source-", "");
  return routes.find((r) => r.from.endsWith(positionPart));
}

function analyzeSourceWithVariants(
  resource: any,
  homeRoom: string,
  nodeRoomName: string,
  spawnPos: { x: number; y: number },
  route: RouteDefinition | undefined,
  config: any
): SourceAnalysis {
  const capacity = resource.capacity ?? 3000;
  const grossPerTick = capacity / SOURCE_REGEN_TICKS;
  const roomDist = estimateRoomDist(homeRoom, nodeRoomName);

  const spawnToSource =
    roomDist * 50 +
    Math.max(
      Math.abs(resource.position.x - spawnPos.x),
      Math.abs(resource.position.y - spawnPos.y)
    );

  // Get terrain from route or default to plains
  const terrain: TerrainProfile = route?.terrain ?? {
    road: 0,
    plain: Math.max(
      Math.abs(resource.position.x - spawnPos.x),
      Math.abs(resource.position.y - spawnPos.y)
    ) + roomDist * 50,
    swamp: 0,
  };

  const totalDistance = terrain.road + terrain.plain + terrain.swamp;

  // Build constraints
  const constraints: VariantConstraints = {
    spawnEnergy: config?.spawnEnergyCapacity ?? 800,
    canBuildContainer: config?.canBuildContainer ?? route?.hasContainer ?? false,
    canBuildLink: config?.canBuildLink ?? route?.hasLink ?? false,
    infrastructureBudget: config?.infrastructureBudget ?? 0,
    sourceCapacity: capacity,
    spawnToSourceDistance: spawnToSource,
  };

  // Generate all viable variants
  const allVariants = generateEdgeVariants(
    capacity,
    terrain,
    spawnToSource,
    constraints
  );

  // Select best variant
  const bestVariant = selectBestVariant(allVariants, constraints);

  return {
    sourceId: `source-${resource.position.x}-${resource.position.y}`,
    grossPerTick,
    distance: totalDistance,
    terrain,
    bestVariant,
    allVariants,
    harvestCost: bestVariant?.harvesterCost ?? 0,
    haulCost: bestVariant?.haulCost ?? 0,
    decayCost: bestVariant?.decayCost ?? 0,
    miningSpots: bestVariant?.miningSpots ?? 0,
  };
}

// =============================================================================
// Scenario Analysis
// =============================================================================

function analyzeScenario(scenario: Scenario): ScenarioAnalysis | null {
  const homeRoom = scenario.nodes[0]?.roomName ?? "W1N1";
  const config = scenario.config as any;

  // Get config values
  const miningSpots = config?.miningSpots ?? 0;
  const minerCarry = config?.minerCarry ?? 1;
  const claimerCost = config?.claimerCost ?? 0;
  const routes = config?.routes as RouteDefinition[] | undefined;
  const hasRoutes = routes !== undefined && routes.length > 0;

  // Find spawn and controller positions
  let spawnPos = { x: 25, y: 25 };
  let controllerPos = { x: 25, y: 40 };
  let hasController = false;

  for (const node of scenario.nodes) {
    for (const resource of node.resourceNodes) {
      if (resource.type === "spawn") {
        spawnPos = resource.position;
      }
      if (resource.type === "controller") {
        controllerPos = resource.position;
        hasController = true;
      }
    }
  }

  if (!hasController) return null;

  const sources: SourceAnalysis[] = [];

  for (const node of scenario.nodes) {
    for (const resource of node.resourceNodes) {
      if (resource.type === "source") {
        if (hasRoutes) {
          const sourceId = `source-${resource.position.x}-${resource.position.y}`;
          const route = findRouteForSource(sourceId, routes!);
          sources.push(
            analyzeSourceWithVariants(
              resource,
              homeRoom,
              node.roomName,
              spawnPos,
              route,
              config
            )
          );
        } else {
          sources.push(
            analyzeLegacySource(
              resource,
              homeRoom,
              node.roomName,
              spawnPos,
              controllerPos,
              miningSpots,
              minerCarry
            )
          );
        }
      }
    }
  }

  if (sources.length === 0) return null;

  // Aggregate costs
  const supply = sources.reduce((s, src) => s + src.grossPerTick, 0);
  const harvestCost = sources.reduce((s, src) => s + src.harvestCost, 0);
  const haulCost = sources.reduce((s, src) => s + src.haulCost, 0);
  const decayCost = sources.reduce((s, src) => s + src.decayCost, 0);
  const infraCost = sources.reduce(
    (s, src) => s + (src.bestVariant?.infrastructureCost ?? 0),
    0
  );
  const totalCost = harvestCost + haulCost + decayCost + infraCost + claimerCost;
  const netEnergy = supply - totalCost;
  const efficiency = supply > 0 ? (netEnergy / supply) * 100 : 0;
  const avgDistance =
    sources.length > 0
      ? sources.reduce((s, src) => s + src.distance, 0) / sources.length
      : 0;

  // Summarize best variants
  const variantSummaries = sources
    .filter((s) => s.bestVariant)
    .map((s) => s.bestVariant!.id);
  const bestVariantSummary =
    variantSummaries.length > 0 ? variantSummaries.join(", ") : "legacy";

  return {
    name: scenario.name,
    supply,
    harvestCost,
    haulCost,
    decayCost,
    infraCost,
    claimerCost,
    netEnergy,
    efficiency,
    avgDistance,
    sources,
    hasRoutes,
    bestVariantSummary,
  };
}

// =============================================================================
// Scenario Loading
// =============================================================================

function loadScenarios(scenariosDir: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const files = fs.readdirSync(scenariosDir).filter((f) => f.endsWith(".json"));
  files.sort();

  for (const file of files) {
    const filePath = path.join(scenariosDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(content);
      scenarios.push(parseScenario(json));
    } catch (err) {
      // Skip invalid files
    }
  }
  return scenarios;
}

// =============================================================================
// Display Helpers
// =============================================================================

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

function padLeft(str: string, len: number): string {
  return str.padStart(len);
}

// =============================================================================
// Main Output
// =============================================================================

function main(): void {
  const scenariosDir = path.join(__dirname, "..", "test", "scenarios");
  const scenarios = loadScenarios(scenariosDir);

  const analyses = scenarios
    .map((s) => analyzeScenario(s))
    .filter((a): a is ScenarioAnalysis => a !== null)
    .sort((a, b) => b.efficiency - a.efficiency);

  console.log("");
  console.log(
    "╔══════════════════════════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║                           EFFICIENCY COMPARISON                                      ║"
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════════════════════════════╝"
  );
  console.log("");

  // Header
  console.log(
    padRight("Scenario", 26) +
      padLeft("Dist", 5) +
      padLeft("Supply", 7) +
      padLeft("Eff%", 6) +
      "  │ " +
      padRight("Harvesters", 13) +
      padRight("Haulers", 13) +
      padRight("Other", 13) +
      padLeft("Net", 6)
  );
  console.log("─".repeat(44) + "─┼─" + "─".repeat(45));

  for (const a of analyses) {
    const harvestPct = ((a.harvestCost / a.supply) * 100).toFixed(0);
    const haulPct = ((a.haulCost / a.supply) * 100).toFixed(0);
    const otherCost = a.decayCost + a.claimerCost + a.infraCost;
    const otherPct = ((otherCost / a.supply) * 100).toFixed(0);

    // Build other label (decay/claimer/infra)
    let otherLabel = "";
    if (otherCost > 0) {
      otherLabel = `${otherCost.toFixed(1)} (${otherPct}%)`;
    } else {
      otherLabel = `0.0 (0%)`;
    }

    console.log(
      padRight(a.name.substring(0, 25), 26) +
        padLeft(a.avgDistance.toFixed(0), 5) +
        padLeft(a.supply.toFixed(1), 7) +
        padLeft(a.efficiency.toFixed(0) + "%", 6) +
        "  │ " +
        padRight(`${a.harvestCost.toFixed(2)} (${harvestPct}%)`, 13) +
        padRight(`${a.haulCost.toFixed(2)} (${haulPct}%)`, 13) +
        padRight(otherLabel, 13) +
        padLeft(a.netEnergy.toFixed(1), 6)
    );
  }

  console.log("");

  // Show variant analysis for scenarios with routes
  const routeScenarios = analyses.filter((a) => a.hasRoutes);
  if (routeScenarios.length > 0) {
    console.log(
      "╔══════════════════════════════════════════════════════════════════════════════════════╗"
    );
    console.log(
      "║                           VARIANT ANALYSIS                                           ║"
    );
    console.log(
      "╚══════════════════════════════════════════════════════════════════════════════════════╝"
    );
    console.log("");

    for (const a of routeScenarios) {
      console.log(`${a.name}:`);
      for (const src of a.sources) {
        if (src.allVariants.length > 0) {
          console.log(`  ${src.sourceId} (${src.terrain.road}r/${src.terrain.plain}p/${src.terrain.swamp}s):`);

          // Show top 3 variants
          const topVariants = src.allVariants.slice(0, 3);
          for (const v of topVariants) {
            const isBest = v === src.bestVariant ? " ★" : "";
            console.log(
              `    ${padRight(v.id, 16)} ${v.efficiency.toFixed(1)}% eff` +
                ` (h:${v.harvesterCost.toFixed(2)} t:${v.haulCost.toFixed(2)} d:${v.decayCost.toFixed(2)})${isBest}`
            );
          }
        }
      }
      console.log("");
    }
  }

  console.log("Legend:");
  console.log("  Supply = gross energy/tick from sources");
  console.log("  Eff% = (Supply - Costs) / Supply");
  console.log("  Harvesters = miner spawn cost amortized (% of supply)");
  console.log("  Haulers = hauler spawn cost amortized (% of supply)");
  console.log("  Other = decay + claimer + infrastructure costs");
  console.log("");
  console.log("Variant IDs: <mining>-<carry>c-<ratio>");
  console.log("  Mining: drop | container | link");
  console.log("  Carry: 0-4 (harvester CARRY parts)");
  console.log("  Ratio: 2:1 (road) | 1:1 (plain) | 1:2 (swamp)");
  console.log("  Terrain: Xr/Yp/Zs = X road, Y plain, Z swamp tiles");
  console.log("");
}

main();
