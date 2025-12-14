/**
 * Bootstrap Scenario Test
 *
 * Tests the initial colony bootstrap behavior:
 * - Spawning first creeps
 * - Energy harvesting
 * - Basic colony setup
 */

import { createSimulator, ScreepsSimulator } from '../ScreepsSimulator';

interface BootstrapMetrics {
  ticksToFirstCreep: number;
  ticksToFirstContainer: number;
  creepCountAt100Ticks: number;
  energyHarvestedAt100Ticks: number;
}

export async function runBootstrapScenario(): Promise<BootstrapMetrics> {
  const sim = createSimulator();
  await sim.connect();

  console.log('\n=== Bootstrap Scenario ===\n');

  const metrics: BootstrapMetrics = {
    ticksToFirstCreep: -1,
    ticksToFirstContainer: -1,
    creepCountAt100Ticks: 0,
    energyHarvestedAt100Ticks: 0,
  };

  const startTick = await sim.getTick();
  const room = 'W0N0';

  // Run for 100 ticks, checking state periodically
  await sim.runSimulation(100, {
    snapshotInterval: 5,
    rooms: [room],
    onTick: async (tick, state) => {
      const objects = state.rooms[room] || [];

      // Count creeps
      const creeps = objects.filter((o) => o.type === 'creep');
      const containers = objects.filter((o) => o.type === 'container');

      // Track first creep
      if (metrics.ticksToFirstCreep === -1 && creeps.length > 0) {
        metrics.ticksToFirstCreep = tick - startTick;
        console.log(`[Tick ${tick}] First creep spawned!`);
      }

      // Track first container
      if (metrics.ticksToFirstContainer === -1 && containers.length > 0) {
        metrics.ticksToFirstContainer = tick - startTick;
        console.log(`[Tick ${tick}] First container built!`);
      }

      // Log progress
      if ((tick - startTick) % 20 === 0) {
        console.log(
          `[Tick ${tick}] Creeps: ${creeps.length}, Containers: ${containers.length}`
        );
      }
    },
  });

  // Final metrics
  metrics.creepCountAt100Ticks = await sim.countObjects(room, 'creep');

  // Get harvested energy from memory if tracked
  const memory = (await sim.getMemory()) as { stats?: { energyHarvested?: number } };
  metrics.energyHarvestedAt100Ticks = memory.stats?.energyHarvested || 0;

  console.log('\n=== Bootstrap Results ===');
  console.log(`Ticks to first creep: ${metrics.ticksToFirstCreep}`);
  console.log(`Ticks to first container: ${metrics.ticksToFirstContainer}`);
  console.log(`Creeps at 100 ticks: ${metrics.creepCountAt100Ticks}`);
  console.log(`Energy harvested: ${metrics.energyHarvestedAt100Ticks}`);

  return metrics;
}

// Assertions for test validation
export function validateBootstrap(metrics: BootstrapMetrics): boolean {
  const checks = [
    {
      name: 'First creep within 10 ticks',
      passed: metrics.ticksToFirstCreep > 0 && metrics.ticksToFirstCreep <= 10,
    },
    {
      name: 'At least 3 creeps by tick 100',
      passed: metrics.creepCountAt100Ticks >= 3,
    },
  ];

  console.log('\n=== Validation ===');
  let allPassed = true;

  for (const check of checks) {
    const status = check.passed ? '✓' : '✗';
    console.log(`${status} ${check.name}`);
    if (!check.passed) allPassed = false;
  }

  return allPassed;
}

// Run if executed directly
if (require.main === module) {
  runBootstrapScenario()
    .then((metrics) => {
      const passed = validateBootstrap(metrics);
      process.exit(passed ? 0 : 1);
    })
    .catch((err) => {
      console.error('Scenario failed:', err);
      process.exit(1);
    });
}
