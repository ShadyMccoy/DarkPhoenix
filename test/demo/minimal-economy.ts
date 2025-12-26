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
// SIDE-BY-SIDE COMPARISON: Without Roads vs With Roads
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SIDE-BY-SIDE: No Roads vs Roads                             │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// ─────────────────────────────────────────────────────────────────────────────
// NO ROADS SCENARIO (already calculated above)
// ─────────────────────────────────────────────────────────────────────────────
const noRoads = {
  // Miner: 5W + 3M (need enough MOVE for plains)
  minerWork: MINER_WORK,
  minerMove: MINER_MOVE,
  minerCost: MINER_COST,

  // Haulers: 1:1 CARRY:MOVE
  carryParts: carryPartsNeeded,
  haulerMoveParts: carryPartsNeeded,  // 1:1 ratio
  haulerCostPerCarry: CARRY_COST + MOVE_COST,  // 100

  // Upgrader WORK + hauler CARRY for upgrade route
  upgradeWork: upgradeWorkParts,
  upgradeCarry: upgradeCarryParts,
  upgradeMove: upgradeCarryParts,  // 1:1 for upgrade haulers

  // Totals
  totalSpawnOverhead: totalSpawnOverhead,
  netUpgrade: netOutput,
  efficiency: efficiency,
  roadMaintenance: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// WITH ROADS SCENARIO
// ─────────────────────────────────────────────────────────────────────────────

// Miner with roads: 5W + 1M (only needs to walk once, roads give 2:1 when loaded)
// Actually miner walks empty, so still 1 tile/tick, but can use fewer MOVE parts
// With roads: ceil(WORK/2) MOVE parts for fatigue on roads
const roadMinerMove = Math.ceil(MINER_WORK / 2);  // 3 WORK generates 6 fatigue, need 3 MOVE? No wait...
// Actually on roads: each MOVE gives 2 fatigue reduction, WORK generates 2 fatigue
// So on roads: 1 MOVE per 1 WORK (but we can go 2:1 since roads double effectiveness)
// Miner is stationary, just needs to get there once. 1 MOVE per 2 WORK on roads.
const roadsMinorMove = Math.ceil(MINER_WORK / 2);  // 5W needs 3M on roads? Let's say 2M
const roadMinerMoveParts = 2;  // minimal MOVE to get to source on roads
const roadMinerCost = MINER_WORK * WORK_COST + roadMinerMoveParts * MOVE_COST;

// Haulers with roads: 2:1 CARRY:MOVE
const roadCarryPartCost = CARRY_COST + MOVE_COST / 2;  // 75 per CARRY part
const roadHaulerMoveParts = carryPartsNeeded / 2;

// Upgrader stays at controller, haulers bring energy
// Upgrader body: WORK parts + minimal CARRY/MOVE to pickup from container
// On roads: 2:1 ratio for the upgrade haulers
const roadUpgradeCarryParts = upgradeCarryParts;  // same throughput needed
const roadUpgradeMoveParts = upgradeCarryParts / 2;  // 2:1 on roads

// Calculate road traffic and decay
const roadTiles = 2 * DISTANCE;

// Source route: haulers going back and forth
// Body parts per hauler = CARRY + MOVE = 1.5 × CARRY (2:1 ratio)
const roadHaulerBodyParts = carryPartsNeeded * 1.5;
const haulerTripsPerTick = 1 / haulerRoundTrip;
const sourceRouteTrafficPerTick = haulerTripsPerTick * 2 * roadHaulerBodyParts;

// Controller route: upgrade haulers
const roadUpgradeHaulerParts = roadUpgradeCarryParts * 1.5;
const upgradeHaulerTripsPerTick = 1 / upgradeHaulRoundTrip;
const controllerRouteTrafficPerTick = upgradeHaulerTripsPerTick * 2 * roadUpgradeHaulerParts;

// Decay calculation
const baseDecayPerTick = ROAD_DECAY_RATE / 1000;  // 0.1 hits/tick
const sourceDecay = baseDecayPerTick * (1 + sourceRouteTrafficPerTick);
const controllerDecay = baseDecayPerTick * (1 + controllerRouteTrafficPerTick);

const sourceLifetime = ROAD_MAX_HITS / sourceDecay;
const controllerLifetime = ROAD_MAX_HITS / controllerDecay;

const sourceMaintCost = DISTANCE * ROAD_ENERGY_COST / sourceLifetime;
const controllerMaintCost = DISTANCE * ROAD_ENERGY_COST / controllerLifetime;
const totalRoadMaint = sourceMaintCost + controllerMaintCost;

// Roads spawn costs for mining/hauling (fixed costs)
const roadMinerOverhead = roadMinerCost / LIFETIME;
const roadHaulerOverhead = (carryPartsNeeded * roadCarryPartCost) / LIFETIME;

// Recalculate upgrade rate with roads (more energy available due to lower spawn costs)
const roadEnergyForUpgrading = harvestPerTick - roadMinerOverhead - roadHaulerOverhead - totalRoadMaint;
const roadUpgradeHaulCostPerTick = (upgradeHaulRoundTrip / 50) * roadCarryPartCost / LIFETIME;
const roadUpgradeTotalCostPerEnergyTick = roadUpgradeHaulCostPerTick + upgradeWorkCostPerTick + 1;
const roadActualUpgradeRate = roadEnergyForUpgrading / roadUpgradeTotalCostPerEnergyTick;

// Now calculate upgrade overhead with the NEW rate
const roadActualUpgradeCarry = roadActualUpgradeRate * upgradeHaulRoundTrip / 50;
const roadActualUpgradeHaulOverhead = (roadActualUpgradeCarry * roadCarryPartCost) / LIFETIME;
const roadActualUpgradeWorkOverhead = (roadActualUpgradeRate * WORK_COST) / LIFETIME;

// Total spawn overhead with correct values
const roadTotalSpawnOverhead = roadMinerOverhead + roadHaulerOverhead + roadActualUpgradeHaulOverhead + roadActualUpgradeWorkOverhead;
const roadTotalOverhead = roadTotalSpawnOverhead + totalRoadMaint;

// Final roads numbers
const roadNetUpgrade = roadActualUpgradeRate;
const roadFinalOverhead = harvestPerTick - roadNetUpgrade;  // Should equal roadTotalOverhead
const roadEfficiency = (roadNetUpgrade / harvestPerTick) * 100;

const roads = {
  minerWork: MINER_WORK,
  minerMove: roadMinerMoveParts,
  minerCost: roadMinerCost,

  carryParts: carryPartsNeeded,
  haulerMoveParts: roadHaulerMoveParts,
  haulerCostPerCarry: roadCarryPartCost,

  upgradeWork: roadActualUpgradeRate,
  upgradeCarry: roadActualUpgradeCarry,
  upgradeMove: roadActualUpgradeCarry / 2,  // 2:1 on roads

  totalSpawnOverhead: roadTotalSpawnOverhead,
  roadMaintenance: totalRoadMaint,
  totalOverhead: roadTotalOverhead,
  netUpgrade: roadNetUpgrade,
  efficiency: roadEfficiency,
};

// ─────────────────────────────────────────────────────────────────────────────
// SIDE-BY-SIDE OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

console.log("                              NO ROADS         WITH ROADS");
console.log("                              ─────────        ──────────");
console.log("");
console.log("MINER:");
console.log(`  Body                        ${noRoads.minerWork}W ${noRoads.minerMove}M             ${roads.minerWork}W ${roads.minerMove}M`);
console.log(`  Spawn cost                  ${noRoads.minerCost}              ${roads.minerCost}`);
console.log(`  Overhead                    ${(noRoads.minerCost/LIFETIME).toFixed(3)}/tick       ${(roads.minerCost/LIFETIME).toFixed(3)}/tick`);
console.log("");
console.log("HAULERS (source→spawn):");
console.log(`  CARRY parts                 ${noRoads.carryParts.toFixed(1)}             ${roads.carryParts.toFixed(1)}`);
console.log(`  MOVE parts                  ${noRoads.haulerMoveParts.toFixed(1)} (1:1)        ${roads.haulerMoveParts.toFixed(1)} (2:1)`);
console.log(`  Cost per CARRY              ${noRoads.haulerCostPerCarry}              ${roads.haulerCostPerCarry}`);
console.log(`  Overhead                    ${(noRoads.carryParts * noRoads.haulerCostPerCarry / LIFETIME).toFixed(3)}/tick       ${(roads.carryParts * roads.haulerCostPerCarry / LIFETIME).toFixed(3)}/tick`);
console.log("");
console.log("UPGRADING:");
console.log(`  WORK parts                  ${noRoads.upgradeWork.toFixed(1)}             ${roads.upgradeWork.toFixed(1)}`);
console.log(`  Haul CARRY parts            ${noRoads.upgradeCarry.toFixed(1)}             ${roads.upgradeCarry.toFixed(1)}`);
console.log(`  Haul MOVE parts             ${noRoads.upgradeMove.toFixed(1)} (1:1)        ${roads.upgradeMove.toFixed(1)} (2:1)`);
console.log("");
console.log("ROAD INFRASTRUCTURE:");
console.log(`  Tiles                       0                ${roadTiles}`);
console.log(`  Build cost                  0                ${roadTiles * ROAD_ENERGY_COST}`);
console.log(`  Source lifetime             -                ${sourceLifetime.toFixed(0)} ticks`);
console.log(`  Controller lifetime         -                ${controllerLifetime.toFixed(0)} ticks`);
console.log(`  Maintenance                 0.000/tick       ${totalRoadMaint.toFixed(3)}/tick`);
console.log("");
console.log("TOTALS:");
console.log(`  Spawn overhead              ${noRoads.totalSpawnOverhead.toFixed(3)}/tick       ${roads.totalSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Road maintenance            ${noRoads.roadMaintenance.toFixed(3)}/tick       ${roads.roadMaintenance.toFixed(3)}/tick`);
console.log(`  Total overhead              ${(noRoads.totalSpawnOverhead + noRoads.roadMaintenance).toFixed(3)}/tick       ${(roads.totalSpawnOverhead + roads.roadMaintenance).toFixed(3)}/tick`);
console.log("");
console.log("  ┌──────────────────────────────────────────────────────────┐");
console.log(`  │  Net to upgrading          ${noRoads.netUpgrade.toFixed(2)}/tick        ${roads.netUpgrade.toFixed(2)}/tick    │`);
console.log(`  │  Efficiency                ${noRoads.efficiency.toFixed(1)}%            ${roads.efficiency.toFixed(1)}%       │`);
console.log("  └──────────────────────────────────────────────────────────┘");
console.log("");

const diff = roads.netUpgrade - noRoads.netUpgrade;
const diffPct = roads.efficiency - noRoads.efficiency;
if (diff > 0) {
  console.log(`  Roads WIN by +${diff.toFixed(2)}/tick (+${diffPct.toFixed(1)} percentage points) ✓\n`);
} else {
  console.log(`  No roads WIN by ${(-diff).toFixed(2)}/tick (${(-diffPct).toFixed(1)} percentage points) ✓\n`);
}

// Body part summary
const noRoadsTotalWork = noRoads.minerWork + noRoads.upgradeWork;
const noRoadsTotalCarry = noRoads.carryParts + noRoads.upgradeCarry;
const noRoadsTotalMove = noRoads.minerMove + noRoads.haulerMoveParts + noRoads.upgradeMove;

const roadsTotalWork = roads.minerWork + roads.upgradeWork;
const roadsTotalCarry = roads.carryParts + roads.upgradeCarry;
const roadsTotalMove = roads.minerMove + roads.haulerMoveParts + roads.upgradeMove;

console.log("BODY PARTS TOTAL:");
console.log(`  WORK                        ${noRoadsTotalWork.toFixed(1)}             ${roadsTotalWork.toFixed(1)}`);
console.log(`  CARRY                       ${noRoadsTotalCarry.toFixed(1)}            ${roadsTotalCarry.toFixed(1)}`);
console.log(`  MOVE                        ${noRoadsTotalMove.toFixed(1)}            ${roadsTotalMove.toFixed(1)}`);
console.log(`  Total parts                 ${(noRoadsTotalWork + noRoadsTotalCarry + noRoadsTotalMove).toFixed(1)}            ${(roadsTotalWork + roadsTotalCarry + roadsTotalMove).toFixed(1)}`);
console.log("");
