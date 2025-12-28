#!/usr/bin/env ts-node

/**
 * Efficiency Comparison Script
 *
 * Compares economic efficiency across planning scenarios showing:
 * - Supply (gross energy/tick)
 * - Efficiency score (net/gross %)
 * - Cost breakdown (Harvesters, Haulers, Other)
 */

import * as fs from "fs";
import * as path from "path";
import { parseScenario, Scenario } from "../src/planning/ScenarioRunner";

// Economic constants
const CREEP_LIFESPAN = 1500;
const MINER_BODY_COST = 5 * 100 + 1 * 50 + 3 * 50; // 5W 1C 3M = 700
const HAULER_COST_PER_CARRY = 100; // 1C 1M = 100
const CARRY_CAPACITY = 50;

interface SourceAnalysis {
  grossPerTick: number;
  harvestCost: number;
  haulCost: number;
  distance: number;
}

interface ScenarioAnalysis {
  name: string;
  supply: number;
  harvestCost: number;
  haulCost: number;
  otherCost: number;
  netEnergy: number;
  efficiency: number;
  sources: SourceAnalysis[];
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

function analyzeScenario(scenario: Scenario): ScenarioAnalysis | null {
  const homeRoom = scenario.nodes[0]?.roomName ?? "W1N1";

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
        const capacity = resource.capacity ?? 3000;
        const grossPerTick = capacity / 300;

        const roomDist = estimateRoomDist(homeRoom, node.roomName);

        // Distance calculations
        const spawnToSource = roomDist * 50 +
          Math.max(Math.abs(resource.position.x - spawnPos.x),
                   Math.abs(resource.position.y - spawnPos.y));

        const sourceToController = roomDist * 50 +
          Math.max(Math.abs(resource.position.x - controllerPos.x),
                   Math.abs(resource.position.y - controllerPos.y));

        // Harvest cost: miner body / lifespan + travel overhead
        const harvestCost = MINER_BODY_COST / CREEP_LIFESPAN +
          (spawnToSource * 2 / CREEP_LIFESPAN) * grossPerTick;

        // Haul cost
        const roundTrip = sourceToController * 2 + 2;
        const energyPerTick = CARRY_CAPACITY / roundTrip;
        const carryPartsNeeded = grossPerTick / energyPerTick;
        const haulCost = (carryPartsNeeded * HAULER_COST_PER_CARRY) / CREEP_LIFESPAN;

        sources.push({
          grossPerTick,
          harvestCost,
          haulCost,
          distance: sourceToController
        });
      }
    }
  }

  if (sources.length === 0) return null;

  const supply = sources.reduce((s, src) => s + src.grossPerTick, 0);
  const harvestCost = sources.reduce((s, src) => s + src.harvestCost, 0);
  const haulCost = sources.reduce((s, src) => s + src.haulCost, 0);
  const otherCost = 0; // Reserved for future (upgraders, builders, etc.)
  const totalCost = harvestCost + haulCost + otherCost;
  const netEnergy = supply - totalCost;
  const efficiency = supply > 0 ? (netEnergy / supply) * 100 : 0;

  return {
    name: scenario.name,
    supply,
    harvestCost,
    haulCost,
    otherCost,
    netEnergy,
    efficiency,
    sources
  };
}

function loadScenarios(scenariosDir: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const files = fs.readdirSync(scenariosDir).filter(f => f.endsWith(".json"));
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

function padRight(str: string, len: number): string {
  return str.padEnd(len);
}

function padLeft(str: string, len: number): string {
  return str.padStart(len);
}

function main(): void {
  const scenariosDir = path.join(__dirname, "..", "test", "scenarios");
  const scenarios = loadScenarios(scenariosDir);

  const analyses = scenarios
    .map(s => analyzeScenario(s))
    .filter((a): a is ScenarioAnalysis => a !== null)
    .sort((a, b) => b.efficiency - a.efficiency);

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════════════════╗");
  console.log("║                      EFFICIENCY COMPARISON                               ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════╝");
  console.log("");

  // Header
  console.log(
    padRight("Scenario", 24) +
    padLeft("Supply", 8) +
    padLeft("Eff%", 7) +
    "  │  " +
    padRight("Harvesters", 14) +
    padRight("Haulers", 14) +
    padRight("Other", 12) +
    padLeft("Net", 7)
  );
  console.log("─".repeat(39) + "─┼──" + "─".repeat(47));

  for (const a of analyses) {
    const harvestPct = ((a.harvestCost / a.supply) * 100).toFixed(0);
    const haulPct = ((a.haulCost / a.supply) * 100).toFixed(0);
    const otherPct = ((a.otherCost / a.supply) * 100).toFixed(0);

    console.log(
      padRight(a.name.substring(0, 23), 24) +
      padLeft(a.supply.toFixed(1), 8) +
      padLeft(a.efficiency.toFixed(0) + "%", 7) +
      "  │  " +
      padRight(`${a.harvestCost.toFixed(2)} (${harvestPct}%)`, 14) +
      padRight(`${a.haulCost.toFixed(2)} (${haulPct}%)`, 14) +
      padRight(`${a.otherCost.toFixed(2)} (${otherPct}%)`, 12) +
      padLeft(a.netEnergy.toFixed(1), 7)
    );
  }

  console.log("");
  console.log("Supply = gross energy/tick from sources");
  console.log("Eff% = (Supply - Costs) / Supply");
  console.log("Harvest/Haul/Other = spawn costs as energy/tick (% of supply)");
  console.log("");
}

main();
