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
// SIDE-BY-SIDE COMPARISON: 1:1 vs 2:1 vs 2:1+Roads
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ HAULER COMPARISON: 1:1 vs 2:1 vs 2:1+Roads                  │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Round trip calculations:
// - Empty CARRY doesn't generate fatigue, so empty haulers move at full speed
// - 1:1 no roads:  D (empty) + D (loaded) + 2 = 2D + 2
// - 2:1 no roads:  D (empty, full speed) + 2D (loaded, half speed) + 2 = 3D + 2
// - 2:1 w/ roads:  D (empty) + D (loaded, roads compensate) + 2 = 2D + 2

const roundTrip_1to1 = 2 * DISTANCE + 2;       // 62 at D=30
const roundTrip_2to1_noRoad = 3 * DISTANCE + 2; // 92 at D=30 (half speed when loaded)
const roundTrip_2to1_road = 2 * DISTANCE + 2;   // 62 at D=30 (roads restore full speed)

console.log("Round trip times (empty CARRY = full speed):");
console.log(`  1:1 no roads:  D + D + 2 = ${roundTrip_1to1} ticks`);
console.log(`  2:1 no roads:  D + 2D + 2 = ${roundTrip_2to1_noRoad} ticks (half speed loaded)`);
console.log(`  2:1 w/ roads:  D + D + 2 = ${roundTrip_2to1_road} ticks (roads restore speed)\n`);

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 1: 1:1 NO ROADS (already calculated above)
// ─────────────────────────────────────────────────────────────────────────────
const scenario_1to1 = {
  name: "1:1 No Roads",
  minerWork: MINER_WORK,
  minerMove: MINER_MOVE,
  minerCost: MINER_COST,
  roundTrip: roundTrip_1to1,
  carryParts: carryPartsNeeded,
  haulerMoveParts: carryPartsNeeded,  // 1:1 ratio
  haulerCostPerCarry: CARRY_COST + MOVE_COST,  // 100
  upgradeWork: upgradeWorkParts,
  upgradeCarry: upgradeCarryParts,
  upgradeMove: upgradeCarryParts,  // 1:1
  totalSpawnOverhead: totalSpawnOverhead,
  netUpgrade: netOutput,
  efficiency: efficiency,
  roadMaintenance: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 2: 2:1 NO ROADS (slower when loaded)
// ─────────────────────────────────────────────────────────────────────────────

// CARRY parts needed for 2:1 no roads (longer round trip)
const carryParts_2to1_noRoad = harvestPerTick * roundTrip_2to1_noRoad / 50;
const haulerCost_2to1 = CARRY_COST + MOVE_COST / 2;  // 75 per CARRY

// Miner still needs to walk at half speed when loaded with WORK parts? No, miner walks empty
// Actually miner walks with WORK parts (fatigue generating), so needs enough MOVE
// On plains: 5 WORK = 10 fatigue/tick, needs 5 MOVE to stay at 1 tile/tick
// But we could go slower... let's use 3 MOVE (same as 1:1 scenario for simplicity)

// Calculate hauler overhead for 2:1 no roads
const haulerOverhead_2to1_noRoad = (carryParts_2to1_noRoad * haulerCost_2to1) / LIFETIME;

// Energy for upgrading
const energyForUpgrading_2to1 = harvestPerTick - minerSpawnOverhead - haulerOverhead_2to1_noRoad;

// Upgrade haulers also 2:1 (slower)
const upgradeRoundTrip_2to1_noRoad = 3 * DISTANCE + 2;
const upgradeHaulCost_2to1 = (upgradeRoundTrip_2to1_noRoad / 50) * haulerCost_2to1 / LIFETIME;
const upgradeTotalCost_2to1 = upgradeHaulCost_2to1 + upgradeWorkCostPerTick + 1;
const upgradeRate_2to1_noRoad = energyForUpgrading_2to1 / upgradeTotalCost_2to1;

const upgradeCarry_2to1_noRoad = upgradeRate_2to1_noRoad * upgradeRoundTrip_2to1_noRoad / 50;
const upgradeHaulOverhead_2to1 = (upgradeCarry_2to1_noRoad * haulerCost_2to1) / LIFETIME;
const upgradeWorkOverhead_2to1 = (upgradeRate_2to1_noRoad * WORK_COST) / LIFETIME;
const totalSpawnOverhead_2to1 = minerSpawnOverhead + haulerOverhead_2to1_noRoad + upgradeHaulOverhead_2to1 + upgradeWorkOverhead_2to1;

const scenario_2to1_noRoad = {
  name: "2:1 No Roads",
  minerWork: MINER_WORK,
  minerMove: MINER_MOVE,
  minerCost: MINER_COST,
  roundTrip: roundTrip_2to1_noRoad,
  carryParts: carryParts_2to1_noRoad,
  haulerMoveParts: carryParts_2to1_noRoad / 2,
  haulerCostPerCarry: haulerCost_2to1,
  upgradeWork: upgradeRate_2to1_noRoad,
  upgradeCarry: upgradeCarry_2to1_noRoad,
  upgradeMove: upgradeCarry_2to1_noRoad / 2,
  totalSpawnOverhead: totalSpawnOverhead_2to1,
  netUpgrade: upgradeRate_2to1_noRoad,
  efficiency: (upgradeRate_2to1_noRoad / harvestPerTick) * 100,
  roadMaintenance: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 3: 2:1 WITH ROADS (full speed both ways)
// ─────────────────────────────────────────────────────────────────────────────

// Miner with roads: can use fewer MOVE (2:1 ratio on roads)
const roadMinerMoveParts = Math.ceil(MINER_WORK / 2);  // 3 MOVE for 5 WORK on roads
const roadMinerCost = MINER_WORK * WORK_COST + roadMinerMoveParts * MOVE_COST;

// Haulers with roads: 2:1 CARRY:MOVE, full speed
const carryParts_2to1_road = harvestPerTick * roundTrip_2to1_road / 50;  // same as 1:1

// Calculate road traffic and decay
const roadTiles = 2 * DISTANCE;
const roadHaulerBodyParts = carryParts_2to1_road * 1.5;  // CARRY + MOVE parts
const haulerTripsPerTick = 1 / roundTrip_2to1_road;
const sourceRouteTrafficPerTick = haulerTripsPerTick * 2 * roadHaulerBodyParts;

// Upgrade route traffic (estimated, will refine after calculating upgrade rate)
const estUpgradeCarry = upgradeCarryParts;  // use 1:1 estimate
const upgradeRouteTrafficPerTick = (1 / roundTrip_2to1_road) * 2 * (estUpgradeCarry * 1.5);

// Decay calculation
const baseDecayPerTick = ROAD_DECAY_RATE / 1000;  // 0.1 hits/tick
const sourceDecay = baseDecayPerTick * (1 + sourceRouteTrafficPerTick);
const controllerDecay = baseDecayPerTick * (1 + upgradeRouteTrafficPerTick);

const sourceLifetime = ROAD_MAX_HITS / sourceDecay;
const controllerLifetime = ROAD_MAX_HITS / controllerDecay;

const sourceMaintCost = DISTANCE * ROAD_ENERGY_COST / sourceLifetime;
const controllerMaintCost = DISTANCE * ROAD_ENERGY_COST / controllerLifetime;
const totalRoadMaint = sourceMaintCost + controllerMaintCost;

// Roads spawn costs
const roadMinerOverhead = roadMinerCost / LIFETIME;
const roadHaulerOverhead = (carryParts_2to1_road * haulerCost_2to1) / LIFETIME;

// Energy for upgrading with roads
const roadEnergyForUpgrading = harvestPerTick - roadMinerOverhead - roadHaulerOverhead - totalRoadMaint;
const roadUpgradeHaulCostPerTick = (roundTrip_2to1_road / 50) * haulerCost_2to1 / LIFETIME;
const roadUpgradeTotalCostPerEnergyTick = roadUpgradeHaulCostPerTick + upgradeWorkCostPerTick + 1;
const roadActualUpgradeRate = roadEnergyForUpgrading / roadUpgradeTotalCostPerEnergyTick;

const roadActualUpgradeCarry = roadActualUpgradeRate * roundTrip_2to1_road / 50;
const roadActualUpgradeHaulOverhead = (roadActualUpgradeCarry * haulerCost_2to1) / LIFETIME;
const roadActualUpgradeWorkOverhead = (roadActualUpgradeRate * WORK_COST) / LIFETIME;
const roadTotalSpawnOverhead = roadMinerOverhead + roadHaulerOverhead + roadActualUpgradeHaulOverhead + roadActualUpgradeWorkOverhead;

const scenario_2to1_road = {
  name: "2:1 + Roads",
  minerWork: MINER_WORK,
  minerMove: roadMinerMoveParts,
  minerCost: roadMinerCost,
  roundTrip: roundTrip_2to1_road,
  carryParts: carryParts_2to1_road,
  haulerMoveParts: carryParts_2to1_road / 2,
  haulerCostPerCarry: haulerCost_2to1,
  upgradeWork: roadActualUpgradeRate,
  upgradeCarry: roadActualUpgradeCarry,
  upgradeMove: roadActualUpgradeCarry / 2,
  totalSpawnOverhead: roadTotalSpawnOverhead,
  netUpgrade: roadActualUpgradeRate,
  efficiency: (roadActualUpgradeRate / harvestPerTick) * 100,
  roadMaintenance: totalRoadMaint,
  roadTiles: roadTiles,
  sourceLifetime: sourceLifetime,
  controllerLifetime: controllerLifetime,
};

// ─────────────────────────────────────────────────────────────────────────────
// THREE-WAY COMPARISON OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

const s1 = scenario_1to1;
const s2 = scenario_2to1_noRoad;
const s3 = scenario_2to1_road;

console.log("                         1:1 No Road    2:1 No Road    2:1 + Roads");
console.log("                         ───────────    ───────────    ───────────");
console.log("");
console.log("HAULER CONFIG:");
console.log(`  Round trip             ${s1.roundTrip} ticks       ${s2.roundTrip} ticks       ${s3.roundTrip} ticks`);
console.log(`  CARRY:MOVE ratio       1:1            2:1            2:1`);
console.log(`  Cost per CARRY         ${s1.haulerCostPerCarry}             ${s2.haulerCostPerCarry}             ${s3.haulerCostPerCarry}`);
console.log("");
console.log("SOURCE→SPAWN HAULING:");
console.log(`  CARRY parts            ${s1.carryParts.toFixed(1)}           ${s2.carryParts.toFixed(1)}           ${s3.carryParts.toFixed(1)}`);
console.log(`  MOVE parts             ${s1.haulerMoveParts.toFixed(1)}           ${s2.haulerMoveParts.toFixed(1)}            ${s3.haulerMoveParts.toFixed(1)}`);
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
const scenarios = [s1, s2, s3];
const best = scenarios.reduce((a, b) => a.efficiency > b.efficiency ? a : b);
console.log(`  WINNER: ${best.name} at ${best.efficiency.toFixed(1)}% efficiency ✓\n`);

// Body parts comparison
console.log("BODY PARTS:");
for (const s of scenarios) {
  const totalW = s.minerWork + s.upgradeWork;
  const totalC = s.carryParts + s.upgradeCarry;
  const totalM = s.minerMove + s.haulerMoveParts + s.upgradeMove;
  console.log(`  ${s.name.padEnd(14)} ${totalW.toFixed(1)}W + ${totalC.toFixed(1)}C + ${totalM.toFixed(1)}M = ${(totalW + totalC + totalM).toFixed(1)} parts`);
}
console.log("");
