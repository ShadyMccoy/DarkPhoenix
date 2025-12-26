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

const haulerRoundTrip = DISTANCE * 2 + 10;  // +10 for pickup/dropoff
const haulerTripsPerLife = Math.floor(LIFETIME / haulerRoundTrip);
const haulerTotalCarried = haulerTripsPerLife * HAULER_CAPACITY;
const haulerThroughput = haulerTotalCarried / LIFETIME;

console.log("Hauler (Source → Spawn):");
console.log(`  Body: ${HAULER_CARRY}C ${HAULER_MOVE}M = ${HAULER_COST} energy`);
console.log(`  Capacity: ${HAULER_CAPACITY} energy`);
console.log(`  Round trip: ${haulerRoundTrip} ticks`);
console.log(`  Trips per lifetime: ${haulerTripsPerLife}`);
console.log(`  Total carried: ${haulerTotalCarried} energy/lifetime`);
console.log(`  Throughput: ${haulerThroughput.toFixed(2)} energy/tick\n`);

// How many haulers needed to keep up with harvest?
const haulersNeeded = Math.ceil(harvestPerTick / haulerThroughput);
const actualHaulerThroughput = haulersNeeded * haulerThroughput;
const haulerSpawnOverhead = (haulersNeeded * HAULER_COST) / LIFETIME;

console.log(`  Haulers needed to match harvest: ${haulersNeeded}`);
console.log(`  Actual throughput: ${actualHaulerThroughput.toFixed(2)} energy/tick`);
console.log(`  Spawn overhead: ${haulersNeeded} × ${HAULER_COST} / ${LIFETIME} = ${haulerSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// SPAWN: Energy arriving
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SPAWN: Energy Balance                                       │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

const energyArriving = Math.min(harvestPerTick, actualHaulerThroughput);
const spawnOverheadTotal = minerSpawnOverhead + haulerSpawnOverhead;

console.log("Energy arriving at spawn:");
console.log(`  From haulers: ${energyArriving.toFixed(2)} energy/tick\n`);

console.log("Spawn overhead (creep costs):");
console.log(`  Miner:   ${minerSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Haulers: ${haulerSpawnOverhead.toFixed(3)}/tick`);
console.log(`  ─────────────────────`);
console.log(`  Subtotal: ${spawnOverheadTotal.toFixed(3)}/tick\n`);

// ============================================================================
// UPGRADING: Spawn → Controller
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ UPGRADING: Spawn → Controller                               │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Upgrader travels from spawn to controller, works, returns for more energy
// Simplified: upgrader stays at controller, hauler brings energy
// Or: upgrader carries its own energy

const upgraderTravelTime = DISTANCE;
const upgraderEffectiveTime = LIFETIME - upgraderTravelTime;

// Upgrader with 1 CARRY makes round trips
const upgraderCarryCapacity = UPGRADER_CARRY * 50;  // 50 energy
const upgraderRoundTrip = DISTANCE * 2 + 5;  // walk there, work, walk back
const upgraderTripsPerLife = Math.floor(LIFETIME / upgraderRoundTrip);
const upgraderWorkPerTrip = upgraderCarryCapacity;  // uses all carried energy
const upgraderTotalWork = upgraderTripsPerLife * upgraderWorkPerTrip;
const upgraderWorkRate = upgraderTotalWork / LIFETIME;

console.log("Upgrader (carrying own energy):");
console.log(`  Body: ${UPGRADER_WORK}W ${UPGRADER_CARRY}C ${UPGRADER_MOVE}M = ${UPGRADER_COST} energy`);
console.log(`  Carry capacity: ${upgraderCarryCapacity} energy`);
console.log(`  Round trip: ${upgraderRoundTrip} ticks`);
console.log(`  Trips per lifetime: ${upgraderTripsPerLife}`);
console.log(`  Energy used for upgrading: ${upgraderTotalWork}/lifetime`);
console.log(`  Upgrade rate: ${upgraderWorkRate.toFixed(2)} energy/tick\n`);

// How much energy is available for upgrading?
const energyForUpgrading = energyArriving - spawnOverheadTotal;
const upgradersSupported = Math.floor(energyForUpgrading / (upgraderWorkRate + UPGRADER_COST / LIFETIME));
const upgraderSpawnOverhead = (upgradersSupported * UPGRADER_COST) / LIFETIME;
const actualUpgradeRate = upgradersSupported * upgraderWorkRate;

console.log("Upgrader allocation:");
console.log(`  Energy available: ${energyForUpgrading.toFixed(2)}/tick`);
console.log(`  Upgrader consumption: ${upgraderWorkRate.toFixed(2)}/tick (work) + ${(UPGRADER_COST/LIFETIME).toFixed(3)}/tick (spawn)`);
console.log(`  Upgraders supported: ${upgradersSupported}`);
console.log(`  Upgrade spawn overhead: ${upgraderSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Actual upgrade rate: ${actualUpgradeRate.toFixed(2)} energy/tick\n`);

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
console.log(`  │  Miner spawn cost:     ${minerSpawnOverhead.toFixed(2).padStart(8)}                    │`);
console.log(`  │  Hauler spawn cost:    ${haulerSpawnOverhead.toFixed(2).padStart(8)}  (${haulersNeeded} haulers)      │`);
console.log(`  │  Upgrader spawn cost:  ${upgraderSpawnOverhead.toFixed(2).padStart(8)}  (${upgradersSupported} upgraders)    │`);
console.log("  │  ──────────────────────────────────────────────────    │");
console.log(`  │  Total overhead:       ${totalSpawnOverhead.toFixed(2).padStart(8)}                    │`);
console.log(`  │  Net to upgrading:     ${netOutput.toFixed(2).padStart(8)}                    │`);
console.log("  └────────────────────────────────────────────────────────┘\n");

const efficiency = (netOutput / harvestPerTick) * 100;
console.log(`Overall Efficiency: ${efficiency.toFixed(1)}%`);
console.log(`  (${netOutput.toFixed(2)} upgrade work from ${harvestPerTick.toFixed(2)} gross harvest)\n`);

// Creep counts
console.log("Creep Requirements:");
console.log(`  Miners:    1`);
console.log(`  Haulers:   ${haulersNeeded}`);
console.log(`  Upgraders: ${upgradersSupported}`);
console.log(`  ─────────────────`);
console.log(`  Total:     ${1 + haulersNeeded + upgradersSupported}\n`);
