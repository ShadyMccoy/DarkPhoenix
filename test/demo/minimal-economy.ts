/**
 * Minimal Economy: 1 Source, 1 Spawn, 1 Upgrader
 *
 * The simplest complete economy loop, all at equal distances.
 *
 *          SOURCE
 *            /\
 *           /  \
 *         D/    \D
 *         /      \
 *      SPAWN----CONTROLLER
 *            D
 *
 * Energy flow:
 *   Source → (hauler) → Spawn → (upgrader) → Controller
 *
 * Run: npx ts-node -P tsconfig.test.json test/demo/minimal-economy.ts
 */

// Configuration
const DISTANCE = 30;  // Equal distance between all three points

// Body part costs
const WORK_COST = 100;
const CARRY_COST = 50;
const MOVE_COST = 50;

// Road constants
const ROAD_ENERGY_COST = 300;  // energy to build one road tile
const ROAD_MAX_HITS = 5000;    // road durability on plains
const ROAD_DECAY_RATE = 100;   // hits lost per 1000 ticks on plains
const ROAD_TICKS_LIFETIME = (ROAD_MAX_HITS / ROAD_DECAY_RATE) * 1000;  // 50,000 ticks
const ROAD_MAINT_PER_TICK = ROAD_ENERGY_COST / ROAD_TICKS_LIFETIME;  // 0.006/tick per tile

// Creep specs
const MINER_WORK = 5;
const MINER_MOVE = 3;
const MINER_COST = MINER_WORK * WORK_COST + MINER_MOVE * MOVE_COST;  // 650

const HAULER_CARRY = 10;
const HAULER_MOVE = 10;
const HAULER_COST = HAULER_CARRY * CARRY_COST + HAULER_MOVE * MOVE_COST;  // 1000
const HAULER_CAPACITY = HAULER_CARRY * 50;  // 500

const UPGRADER_WORK = 5;
const UPGRADER_CARRY = 1;
const UPGRADER_MOVE = 3;
const UPGRADER_COST = UPGRADER_WORK * WORK_COST + UPGRADER_CARRY * CARRY_COST + UPGRADER_MOVE * MOVE_COST;  // 700

const LIFETIME = 1500;
const SOURCE_CAPACITY = 3000;
const SOURCE_REGEN = 300;

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║         MINIMAL ECONOMY: Source → Spawn → Controller       ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

console.log(`Configuration: All points ${DISTANCE} tiles apart\n`);

// ============================================================================
// SUPPLY SIDE: What the source produces
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SUPPLY SIDE: Mining                                         │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Miner travels from spawn to source
const minerTravelTime = DISTANCE;
const minerEffectiveTime = LIFETIME - minerTravelTime;
const minerRegenCycles = Math.floor(minerEffectiveTime / SOURCE_REGEN);
const grossHarvest = minerRegenCycles * SOURCE_CAPACITY;
const harvestPerTick = grossHarvest / LIFETIME;

console.log("Miner:");
console.log(`  Body: ${MINER_WORK}W ${MINER_MOVE}M = ${MINER_COST} energy`);
console.log(`  Travel to source: ${minerTravelTime} ticks`);
console.log(`  Effective mining time: ${minerEffectiveTime} ticks`);
console.log(`  Regen cycles captured: ${minerRegenCycles}`);
console.log(`  Gross harvest: ${grossHarvest} energy/lifetime`);
console.log(`  Harvest rate: ${harvestPerTick.toFixed(2)} energy/tick\n`);

// Miner spawn overhead (amortized)
const minerSpawnOverhead = MINER_COST / LIFETIME;
console.log(`  Spawn overhead: ${MINER_COST} / ${LIFETIME} = ${minerSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// HAULING: Source → Spawn
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ HAULING: Source → Spawn                                     │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Formula: CARRY_parts = S × (2D + 2) / 50
// Round trip = 2D + 2 (walking both ways + 1 tick pickup + 1 tick dropoff)
const haulerRoundTrip = DISTANCE * 2 + 2;

// Exact CARRY parts needed (no rounding!)
const carryPartsNeeded = harvestPerTick * haulerRoundTrip / 50;

// Spawn cost: each CARRY part needs 1 MOVE part (1:1 ratio for roads)
// Cost per CARRY part = CARRY_COST + MOVE_COST = 100
const carryPartCost = CARRY_COST + MOVE_COST;  // 100 energy per CARRY part
const haulerSpawnOverhead = (carryPartsNeeded * carryPartCost) / LIFETIME;

// For display: equivalent hauler count (fractional)
const equivalentHaulers = carryPartsNeeded / HAULER_CARRY;

console.log("Hauling (Source → Spawn):");
console.log(`  Round trip: 2×${DISTANCE} + 2 = ${haulerRoundTrip} ticks`);
console.log(`  Required throughput: ${harvestPerTick.toFixed(2)} energy/tick`);
console.log(`  CARRY parts needed: ${harvestPerTick.toFixed(2)} × ${haulerRoundTrip} / 50 = ${carryPartsNeeded.toFixed(2)}`);
console.log(`  Equivalent haulers: ${equivalentHaulers.toFixed(2)} (at ${HAULER_CARRY}C each)`);
console.log(`  Spawn cost: ${carryPartsNeeded.toFixed(2)} × ${carryPartCost} / ${LIFETIME} = ${haulerSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// SPAWN: Energy arriving
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SPAWN: Energy Balance                                       │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// With exact CARRY parts, throughput matches harvest exactly
const energyArriving = harvestPerTick;
const spawnOverheadTotal = minerSpawnOverhead + haulerSpawnOverhead;

console.log("Energy arriving at spawn:");
console.log(`  From haulers: ${energyArriving.toFixed(2)} energy/tick\n`);

console.log("Spawn overhead (creep costs):");
console.log(`  Miner:   ${minerSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Haulers: ${haulerSpawnOverhead.toFixed(3)}/tick (${carryPartsNeeded.toFixed(1)} CARRY parts)`);
console.log(`  ─────────────────────`);
console.log(`  Subtotal: ${spawnOverheadTotal.toFixed(3)}/tick\n`);

// ============================================================================
// UPGRADING: Spawn → Controller
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ UPGRADING: Spawn → Controller                               │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Upgrader model: WORK parts stationed at controller, haulers bring energy
// Each WORK part upgrades 1 energy/tick (when energy available)
// Upgrader body: need CARRY to pick up from container, MOVE to get there once

// Hauling to controller: same formula as source→spawn
// CARRY_parts = S × (2D + 2) / 50
const upgradeHaulDistance = DISTANCE;  // spawn → controller
const upgradeHaulRoundTrip = upgradeHaulDistance * 2 + 2;

// Energy available for upgrading (after mining/hauling overhead)
const energyForUpgrading = energyArriving - spawnOverheadTotal;

// For each 1 energy/tick of upgrading, we need:
//   - Hauling: (2D + 2) / 50 CARRY parts → cost = (2D + 2) / 50 × 100 / 1500 per tick
//   - Working: 1 WORK part → cost = 100 / 1500 per tick (simplified, ignoring MOVE/CARRY on upgrader)
const upgradeHaulCostPerTick = (upgradeHaulRoundTrip / 50) * carryPartCost / LIFETIME;
const upgradeWorkCostPerTick = WORK_COST / LIFETIME;  // per WORK part
const upgradeTotalCostPerEnergyTick = upgradeHaulCostPerTick + upgradeWorkCostPerTick + 1;  // +1 for the energy itself

// How much can we upgrade?
const actualUpgradeRate = energyForUpgrading / upgradeTotalCostPerEnergyTick;
const upgradeWorkParts = actualUpgradeRate;  // 1 WORK = 1 energy/tick
const upgradeCarryParts = actualUpgradeRate * upgradeHaulRoundTrip / 50;
const upgraderSpawnOverhead = (upgradeWorkParts * WORK_COST + upgradeCarryParts * carryPartCost) / LIFETIME;

console.log("Upgrading (Spawn → Controller):");
console.log(`  Haul distance: ${upgradeHaulDistance} tiles (round trip: ${upgradeHaulRoundTrip} ticks)`);
console.log(`  Energy available: ${energyForUpgrading.toFixed(2)}/tick`);
console.log(`  Cost per 1 energy/tick upgrade:`);
console.log(`    - Energy consumed: 1.000`);
console.log(`    - Haul cost: ${upgradeHaulCostPerTick.toFixed(3)}/tick (${(upgradeHaulRoundTrip/50).toFixed(2)} CARRY parts)`);
console.log(`    - Work cost: ${upgradeWorkCostPerTick.toFixed(3)}/tick (1 WORK part)`);
console.log(`    - Total: ${upgradeTotalCostPerEnergyTick.toFixed(3)}/tick`);
console.log(`  Upgrade rate: ${actualUpgradeRate.toFixed(2)} energy/tick`);
console.log(`  WORK parts: ${upgradeWorkParts.toFixed(2)}`);
console.log(`  CARRY parts (hauling): ${upgradeCarryParts.toFixed(2)}`);
console.log(`  Spawn overhead: ${upgraderSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// SUMMARY
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ ECONOMY SUMMARY                                             │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

const totalSpawnOverhead = minerSpawnOverhead + haulerSpawnOverhead + upgraderSpawnOverhead;
const netOutput = actualUpgradeRate;

console.log("Energy Flow (per tick):");
console.log("  ┌────────────────────────────────────────────────────────┐");
console.log(`  │  Gross Harvest:        ${harvestPerTick.toFixed(2).padStart(8)}                    │`);
console.log("  │  ──────────────────────────────────────────────────    │");
console.log(`  │  Miner spawn cost:     ${minerSpawnOverhead.toFixed(2).padStart(8)}  (${MINER_WORK}W)           │`);
console.log(`  │  Hauler spawn cost:    ${haulerSpawnOverhead.toFixed(2).padStart(8)}  (${carryPartsNeeded.toFixed(1)}C)          │`);
console.log(`  │  Upgrader spawn cost:  ${upgraderSpawnOverhead.toFixed(2).padStart(8)}  (${upgradeWorkParts.toFixed(1)}W + ${upgradeCarryParts.toFixed(1)}C) │`);
console.log("  │  ──────────────────────────────────────────────────    │");
console.log(`  │  Total overhead:       ${totalSpawnOverhead.toFixed(2).padStart(8)}                    │`);
console.log(`  │  Net to upgrading:     ${netOutput.toFixed(2).padStart(8)}                    │`);
console.log("  └────────────────────────────────────────────────────────┘\n");

const efficiency = (netOutput / harvestPerTick) * 100;
console.log(`Overall Efficiency: ${efficiency.toFixed(1)}%`);
console.log(`  (${netOutput.toFixed(2)} upgrade work from ${harvestPerTick.toFixed(2)} gross harvest)\n`);

// Body part totals
const totalWorkParts = MINER_WORK + upgradeWorkParts;
const totalCarryParts = carryPartsNeeded + upgradeCarryParts;
const totalMoveParts = MINER_MOVE + totalCarryParts;  // 1:1 for haulers, miners have fewer

console.log("Body Part Requirements (fractional):");
console.log(`  Mining:    ${MINER_WORK}W + ${MINER_MOVE}M`);
console.log(`  Hauling:   ${carryPartsNeeded.toFixed(1)}C + ${carryPartsNeeded.toFixed(1)}M (source→spawn)`);
console.log(`             ${upgradeCarryParts.toFixed(1)}C + ${upgradeCarryParts.toFixed(1)}M (spawn→controller)`);
console.log(`  Upgrading: ${upgradeWorkParts.toFixed(1)}W`);
console.log(`  ─────────────────`);
console.log(`  Total:     ${totalWorkParts.toFixed(1)}W + ${totalCarryParts.toFixed(1)}C + ${totalMoveParts.toFixed(1)}M\n`);

// ============================================================================
// EFFICIENCY CALCULATION FUNCTION
// ============================================================================

interface ScenarioResult {
  name: string;
  distance: number;
  roundTrip: number;
  carryParts: number;
  upgradeWork: number;
  upgradeCarry: number;
  totalSpawnOverhead: number;
  roadMaintenance: number;
  netUpgrade: number;
  efficiency: number;
}

function calculateScenarios(D: number, harvestRate: number): ScenarioResult[] {
  const minerOverhead = MINER_COST / LIFETIME;
  const cost_1to1 = CARRY_COST + MOVE_COST;  // 100 per CARRY
  const cost_2to1 = CARRY_COST + MOVE_COST / 2;  // 75 per CARRY
  const workCostPerTick = WORK_COST / LIFETIME;

  // Round trip times
  const rt_1to1 = 2 * D + 2;
  const rt_2to1_noRoad = 3 * D + 2;
  const rt_2to1_road = 2 * D + 2;

  const results: ScenarioResult[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: 1:1 No Roads
  // ─────────────────────────────────────────────────────────────────────────
  {
    const carryParts = harvestRate * rt_1to1 / 50;
    const haulerOverhead = (carryParts * cost_1to1) / LIFETIME;
    const energyForUpgrade = harvestRate - minerOverhead - haulerOverhead;

    const upgHaulCost = (rt_1to1 / 50) * cost_1to1 / LIFETIME;
    const upgTotalCost = upgHaulCost + workCostPerTick + 1;
    const upgRate = energyForUpgrade / upgTotalCost;
    const upgCarry = upgRate * rt_1to1 / 50;

    const totalOverhead = minerOverhead + haulerOverhead + (upgCarry * cost_1to1 + upgRate * WORK_COST) / LIFETIME;

    results.push({
      name: "1:1 No Roads",
      distance: D,
      roundTrip: rt_1to1,
      carryParts: carryParts,
      upgradeWork: upgRate,
      upgradeCarry: upgCarry,
      totalSpawnOverhead: totalOverhead,
      roadMaintenance: 0,
      netUpgrade: upgRate,
      efficiency: (upgRate / harvestRate) * 100,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: 2:1 No Roads (half speed loaded)
  // ─────────────────────────────────────────────────────────────────────────
  {
    const carryParts = harvestRate * rt_2to1_noRoad / 50;
    const haulerOverhead = (carryParts * cost_2to1) / LIFETIME;
    const energyForUpgrade = harvestRate - minerOverhead - haulerOverhead;

    const upgHaulCost = (rt_2to1_noRoad / 50) * cost_2to1 / LIFETIME;
    const upgTotalCost = upgHaulCost + workCostPerTick + 1;
    const upgRate = energyForUpgrade / upgTotalCost;
    const upgCarry = upgRate * rt_2to1_noRoad / 50;

    const totalOverhead = minerOverhead + haulerOverhead + (upgCarry * cost_2to1 + upgRate * WORK_COST) / LIFETIME;

    results.push({
      name: "2:1 No Roads",
      distance: D,
      roundTrip: rt_2to1_noRoad,
      carryParts: carryParts,
      upgradeWork: upgRate,
      upgradeCarry: upgCarry,
      totalSpawnOverhead: totalOverhead,
      roadMaintenance: 0,
      netUpgrade: upgRate,
      efficiency: (upgRate / harvestRate) * 100,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: 2:1 + Roads (full speed, but maintenance cost)
  // ─────────────────────────────────────────────────────────────────────────
  {
    const carryParts = harvestRate * rt_2to1_road / 50;

    // Road traffic and decay for source route
    const haulerBodyParts = carryParts * 1.5;  // CARRY + MOVE
    const tripsPerTick = 1 / rt_2to1_road;
    const sourceTraffic = tripsPerTick * 2 * haulerBodyParts;

    const baseDecay = ROAD_DECAY_RATE / 1000;
    const sourceDecay = baseDecay * (1 + sourceTraffic);
    const sourceLife = ROAD_MAX_HITS / sourceDecay;
    const sourceMaint = D * ROAD_ENERGY_COST / sourceLife;

    // Estimate controller route (iterate once for accuracy)
    const estUpgCarry = carryParts * 0.7;  // rough estimate
    const ctrlTraffic = tripsPerTick * 2 * (estUpgCarry * 1.5);
    const ctrlDecay = baseDecay * (1 + ctrlTraffic);
    const ctrlLife = ROAD_MAX_HITS / ctrlDecay;
    const ctrlMaint = D * ROAD_ENERGY_COST / ctrlLife;

    const totalMaint = sourceMaint + ctrlMaint;

    const haulerOverhead = (carryParts * cost_2to1) / LIFETIME;
    const roadMinerCost = MINER_WORK * WORK_COST + Math.ceil(MINER_WORK / 2) * MOVE_COST;
    const roadMinerOverhead = roadMinerCost / LIFETIME;

    const energyForUpgrade = harvestRate - roadMinerOverhead - haulerOverhead - totalMaint;

    const upgHaulCost = (rt_2to1_road / 50) * cost_2to1 / LIFETIME;
    const upgTotalCost = upgHaulCost + workCostPerTick + 1;
    const upgRate = energyForUpgrade / upgTotalCost;
    const upgCarry = upgRate * rt_2to1_road / 50;

    const totalOverhead = roadMinerOverhead + haulerOverhead + (upgCarry * cost_2to1 + upgRate * WORK_COST) / LIFETIME;

    results.push({
      name: "2:1 + Roads",
      distance: D,
      roundTrip: rt_2to1_road,
      carryParts: carryParts,
      upgradeWork: upgRate,
      upgradeCarry: upgCarry,
      totalSpawnOverhead: totalOverhead,
      roadMaintenance: totalMaint,
      netUpgrade: upgRate,
      efficiency: (upgRate / harvestRate) * 100,
    });
  }

  return results;
}

// ============================================================================
// MULTI-DISTANCE COMPARISON
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ EFFICIENCY BY DISTANCE: 1:1 vs 2:1 vs 2:1+Roads             │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

console.log("Round trip formulas (empty CARRY = full speed):");
console.log("  1:1 no roads:  2D + 2   (full speed both ways)");
console.log("  2:1 no roads:  3D + 2   (half speed when loaded)");
console.log("  2:1 + roads:   2D + 2   (roads restore full speed)\n");

const distances = [10, 20, 30, 50, 75, 100];

console.log("┌──────────┬────────────────────────────────────────────────────────────────────┐");
console.log("│ Distance │  1:1 No Roads       2:1 No Roads       2:1 + Roads      Winner    │");
console.log("├──────────┼────────────────────────────────────────────────────────────────────┤");

for (const D of distances) {
  // Calculate harvest rate for this distance (miner travel affects it)
  const minerTravelTime = D;
  const minerEffectiveTime = LIFETIME - minerTravelTime;
  const minerRegenCycles = Math.floor(minerEffectiveTime / SOURCE_REGEN);
  const grossHarvest = minerRegenCycles * SOURCE_CAPACITY;
  const harvestRate = grossHarvest / LIFETIME;

  const scenarios = calculateScenarios(D, harvestRate);
  const best = scenarios.reduce((a, b) => a.efficiency > b.efficiency ? a : b);

  const s1 = scenarios[0];
  const s2 = scenarios[1];
  const s3 = scenarios[2];

  const eff1 = s1.efficiency.toFixed(1).padStart(5) + "%";
  const eff2 = s2.efficiency.toFixed(1).padStart(5) + "%";
  const eff3 = s3.efficiency.toFixed(1).padStart(5) + "%";

  const winner = best.name === "1:1 No Roads" ? "1:1" :
                 best.name === "2:1 No Roads" ? "2:1" : "Roads";

  const marker1 = best.name === "1:1 No Roads" ? " ✓" : "  ";
  const marker2 = best.name === "2:1 No Roads" ? " ✓" : "  ";
  const marker3 = best.name === "2:1 + Roads" ? " ✓" : "  ";

  console.log(`│  D=${D.toString().padEnd(4)}  │  ${eff1}${marker1}            ${eff2}${marker2}            ${eff3}${marker3}       ${winner.padEnd(6)}   │`);
}

console.log("└──────────┴────────────────────────────────────────────────────────────────────┘\n");

// ============================================================================
// DETAILED BREAKDOWN AT D=30
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ DETAILED BREAKDOWN AT D=30                                  │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

const detailScenarios = calculateScenarios(30, harvestPerTick);
const s1 = detailScenarios[0];
const s2 = detailScenarios[1];
const s3 = detailScenarios[2];

console.log("                         1:1 No Road    2:1 No Road    2:1 + Roads");
console.log("                         ───────────    ───────────    ───────────");
console.log("");
console.log("HAULER CONFIG:");
console.log(`  Round trip             ${s1.roundTrip} ticks       ${s2.roundTrip} ticks       ${s3.roundTrip} ticks`);
console.log(`  CARRY:MOVE ratio       1:1            2:1            2:1`);
console.log(`  Cost per CARRY         100            75             75`);
console.log("");
console.log("SOURCE→SPAWN HAULING:");
console.log(`  CARRY parts            ${s1.carryParts.toFixed(1)}           ${s2.carryParts.toFixed(1)}           ${s3.carryParts.toFixed(1)}`);
console.log("");
console.log("UPGRADING:");
console.log(`  WORK parts             ${s1.upgradeWork.toFixed(1)}            ${s2.upgradeWork.toFixed(1)}            ${s3.upgradeWork.toFixed(1)}`);
console.log(`  Haul CARRY             ${s1.upgradeCarry.toFixed(1)}            ${s2.upgradeCarry.toFixed(1)}           ${s3.upgradeCarry.toFixed(1)}`);
console.log("");
console.log("COSTS:");
console.log(`  Spawn overhead         ${s1.totalSpawnOverhead.toFixed(3)}/tick    ${s2.totalSpawnOverhead.toFixed(3)}/tick    ${s3.totalSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Road maintenance       ${s1.roadMaintenance.toFixed(3)}/tick    ${s2.roadMaintenance.toFixed(3)}/tick    ${s3.roadMaintenance.toFixed(3)}/tick`);
console.log(`  Total overhead         ${(s1.totalSpawnOverhead + s1.roadMaintenance).toFixed(3)}/tick    ${(s2.totalSpawnOverhead + s2.roadMaintenance).toFixed(3)}/tick    ${(s3.totalSpawnOverhead + s3.roadMaintenance).toFixed(3)}/tick`);
console.log("");
console.log("  ┌─────────────────────────────────────────────────────────────────┐");
console.log(`  │  Net upgrading       ${s1.netUpgrade.toFixed(2)}/tick      ${s2.netUpgrade.toFixed(2)}/tick      ${s3.netUpgrade.toFixed(2)}/tick    │`);
console.log(`  │  Efficiency          ${s1.efficiency.toFixed(1)}%          ${s2.efficiency.toFixed(1)}%          ${s3.efficiency.toFixed(1)}%        │`);
console.log("  └─────────────────────────────────────────────────────────────────┘");
console.log("");

// Find winner
const allScenarios = [s1, s2, s3];
const best = allScenarios.reduce((a, b) => a.efficiency > b.efficiency ? a : b);
console.log(`  WINNER: ${best.name} at ${best.efficiency.toFixed(1)}% efficiency ✓\n`);

// ============================================================================
// SCALING ANALYSIS
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SCALING ANALYSIS                                            │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Calculate efficiency delta at each distance
console.log("Efficiency Gap Analysis:");
console.log("");
console.log("  Distance   1:1 vs 2:1 Gap    1:1 vs Roads Gap   Efficiency Loss/10tiles");
console.log("  ────────   ──────────────    ────────────────   ──────────────────────");

let prevEff: number | null = null;
for (const D of distances) {
  const minerEffTime = LIFETIME - D;
  const regenCycles = Math.floor(minerEffTime / SOURCE_REGEN);
  const grossHarvest = regenCycles * SOURCE_CAPACITY;
  const harvestRate = grossHarvest / LIFETIME;

  const scenarios = calculateScenarios(D, harvestRate);
  const gap_2to1 = scenarios[0].efficiency - scenarios[1].efficiency;
  const gap_roads = scenarios[0].efficiency - scenarios[2].efficiency;

  const effLoss = prevEff !== null ? (prevEff - scenarios[0].efficiency) : 0;
  prevEff = scenarios[0].efficiency;

  console.log(`    D=${D.toString().padEnd(4)}      +${gap_2to1.toFixed(1)}%             +${gap_roads.toFixed(1)}%               ${D > 10 ? "-" + effLoss.toFixed(1) + "%" : "  --"}`);
}
console.log("");

console.log("Key Findings:");
console.log("");
console.log("  ┌────────────────────────────────────────────────────────────────┐");
console.log("  │  1:1 No Roads ALWAYS wins for single-source economy           │");
console.log("  └────────────────────────────────────────────────────────────────┘");
console.log("");
console.log("  Why 1:1 beats 2:1 despite cheaper body parts:");
console.log("");
console.log("    The naive analysis compares:");
console.log("      1:1: (2D+2) × 100/50/1500 = (2D+2) × 0.00133 cost/energy");
console.log("      2:1: (3D+2) × 75/50/1500  = (3D+2) × 0.00100 cost/energy");
console.log("");
console.log("    This suggests 2:1 wins when D > 2. But this ignores:");
console.log("");
console.log("    1. ROUND TRIP TIME COMPOUNDS");
console.log("       - 2:1 needs 50% more CARRY parts to match throughput");
console.log("       - At D=30: 1:1 needs 9.9C, 2:1 needs 14.7C");
console.log("       - The 50% penalty in parts overwhelms 25% savings per part");
console.log("");
console.log("    2. UPGRADE ROUTE DOUBLES THE PENALTY");
console.log("       - Energy also needs hauling to controller");
console.log("       - 2:1 pays the 50% round trip penalty twice");
console.log("");
console.log("    3. THE MATH:");
console.log("       - 2:1 cost per CARRY: 75 (25% savings)");
console.log("       - 2:1 round trip: 3D+2 vs 2D+2 (50% longer)");
console.log("       - Net: 0.75 × 1.5 = 1.125 → 12.5% MORE expensive");
console.log("");
console.log("  Why Roads lose:");
console.log("");
console.log("    - Roads give 2:1 the same speed as 1:1 (2D+2 round trip)");
console.log("    - But road maintenance eats into savings");
console.log("    - At D=30: 0.51 energy/tick road cost vs 0.31 spawn savings");
console.log("    - Roads only win with SHARED routes (multiple sources)");
console.log("");

// Summary table
console.log("Decision Matrix:");
console.log("");
console.log("  ┌───────────────────┬─────────────────────────────────────────┐");
console.log("  │ Scenario          │ Recommended Strategy                    │");
console.log("  ├───────────────────┼─────────────────────────────────────────┤");
console.log("  │ Single source     │ 1:1 No Roads (always)                   │");
console.log("  │ 2+ sources, D<30  │ 1:1 No Roads (road cost > spawn cost)   │");
console.log("  │ 2+ sources, D>50  │ 2:1 + Roads (shared roads amortize)     │");
console.log("  │ SK room hauling   │ 2:1 + Roads (very long distances)       │");
console.log("  └───────────────────┴─────────────────────────────────────────┘");
console.log("");
