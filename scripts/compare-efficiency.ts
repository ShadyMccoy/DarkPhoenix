#!/usr/bin/env ts-node

/**
 * Efficiency Comparison Script
 *
 * Compares economic efficiency across planning scenarios showing:
 * - Supply (gross energy/tick)
 * - Efficiency score (net/gross %)
 * - Cost breakdown (Harvesters, Haulers, Decay)
 */

import * as fs from "fs";
import * as path from "path";
import { parseScenario, Scenario } from "../test/planning/ScenarioRunner";

// Economic constants
const CREEP_LIFESPAN = 1500;
const MINER_BASE_COST = 5 * 100 + 3 * 50; // 5W 3M = 650 (without CARRY)
const CARRY_PART_COST = 50;
const HAULER_COST_PER_CARRY = 100; // 1C 1M = 100
const CARRY_CAPACITY = 50;
const MINE_RATE = 10; // 5 WORK * 2 energy/tick = 10 energy/tick

interface SourceAnalysis {
  grossPerTick: number;
  harvestCost: number;
  haulCost: number;
  decayCost: number;
  distance: number;
  miningSpots: number;
}

interface ScenarioAnalysis {
  name: string;
  supply: number;
  harvestCost: number;
  haulCost: number;
  decayCost: number;
  claimerCost: number;
  netEnergy: number;
  efficiency: number;
  avgDistance: number;
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

  // Get mining spots from config (default 0 = container mining, no decay)
  // Early game with ground piles: 2-3 spots per source, each pile decays
  const miningSpots = (scenario.config as any)?.miningSpots ?? 0;

  // Miner CARRY parts (default 1, more = less decay time)
  const minerCarry = (scenario.config as any)?.minerCarry ?? 1;

  // Claimer cost for reserved remote rooms (2 CLAIM + 2 MOVE = 1300, 500 TTL = ~2.6/tick)
  const claimerCost = (scenario.config as any)?.claimerCost ?? 0;

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
        // Miner body: 5W + minerCarry*C + 3M
        const minerBodyCost = MINER_BASE_COST + (minerCarry * CARRY_PART_COST);
        const harvestCost = minerBodyCost / CREEP_LIFESPAN +
          (spawnToSource * 2 / CREEP_LIFESPAN) * grossPerTick;

        // Haul cost
        const roundTrip = sourceToController * 2 + 2;
        const energyPerTick = CARRY_CAPACITY / roundTrip;
        const carryPartsNeeded = grossPerTick / energyPerTick;
        const haulCost = (carryPartsNeeded * HAULER_COST_PER_CARRY) / CREEP_LIFESPAN;

        // Decay cost calculation:
        // - Miner fills CARRY in (minerCarry * 50 / 10) ticks before first drop
        // - Pile exists for (roundTrip - fillTime) ticks per hauler cycle
        // - But we have miningSpots piles (multiple miners or spots)
        // - Decay = max(0, roundTrip - fillTime) / roundTrip per pile
        let decayCost = 0;
        if (miningSpots > 0) {
          const fillTime = (minerCarry * CARRY_CAPACITY) / MINE_RATE;
          const pileExistsTime = Math.max(0, roundTrip - fillTime);
          const decayPerPile = pileExistsTime / roundTrip; // fraction of time pile exists
          decayCost = miningSpots * decayPerPile;
        }

        sources.push({
          grossPerTick,
          harvestCost,
          haulCost,
          decayCost,
          distance: sourceToController,
          miningSpots
        });
      }
    }
  }

  if (sources.length === 0) return null;

  const supply = sources.reduce((s, src) => s + src.grossPerTick, 0);
  const harvestCost = sources.reduce((s, src) => s + src.harvestCost, 0);
  const haulCost = sources.reduce((s, src) => s + src.haulCost, 0);
  const decayCost = sources.reduce((s, src) => s + src.decayCost, 0);
  const totalCost = harvestCost + haulCost + decayCost + claimerCost;
  const netEnergy = supply - totalCost;
  const efficiency = supply > 0 ? (netEnergy / supply) * 100 : 0;
  const avgDistance = sources.length > 0
    ? sources.reduce((s, src) => s + src.distance, 0) / sources.length
    : 0;

  return {
    name: scenario.name,
    supply,
    harvestCost,
    haulCost,
    decayCost,
    claimerCost,
    netEnergy,
    efficiency,
    avgDistance,
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
    const otherCost = a.decayCost + a.claimerCost;
    const otherPct = ((otherCost / a.supply) * 100).toFixed(0);

    // Build other label (decay/claimer)
    let otherLabel = "";
    if (a.decayCost > 0 && a.claimerCost > 0) {
      otherLabel = `${otherCost.toFixed(1)} (${otherPct}%)`;
    } else if (a.decayCost > 0) {
      otherLabel = `${a.decayCost.toFixed(1)} (${otherPct}%)`;
    } else if (a.claimerCost > 0) {
      otherLabel = `${a.claimerCost.toFixed(1)} (${otherPct}%)`;
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
  console.log("Supply = gross energy/tick from sources (1500 unreserved, 3000 reserved/owned)");
  console.log("Eff% = (Supply - Costs) / Supply");
  console.log("Harvesters/Haulers = spawn costs as energy/tick (% of supply)");
  console.log("Other = decay (1/tick per ground pile) + claimer (2.6/tick for reservation)");
  console.log("");
}

main();
