/**
 * Energy Flow Scenario Test
 *
 * Tests the energy harvesting and distribution system:
 * - Miners harvesting from sources
 * - Carriers moving energy
 * - Energy reaching spawn/extensions
 */

import { createSimulator } from '../ScreepsSimulator';

interface EnergyFlowMetrics {
  ticksToStableHarvesting: number;
  harvestersActive: number;
  carriersActive: number;
  energyPerTick: number[];
  averageEnergyFlow: number;
}

export async function runEnergyFlowScenario(): Promise<EnergyFlowMetrics> {
  const sim = createSimulator();
  await sim.connect();

  console.log('\n=== Energy Flow Scenario ===\n');

  const room = 'W0N0';
  const startTick = await sim.getTick();
  const energySnapshots: number[] = [];
  let lastEnergy = 0;

  const metrics: EnergyFlowMetrics = {
    ticksToStableHarvesting: -1,
    harvestersActive: 0,
    carriersActive: 0,
    energyPerTick: [],
    averageEnergyFlow: 0,
  };

  // Let colony stabilize first (skip first 200 ticks if mature colony)
  console.log('Analyzing energy flow over 200 ticks...\n');

  await sim.runSimulation(200, {
    snapshotInterval: 10,
    rooms: [room],
    onTick: async (tick, state) => {
      const objects = state.rooms[room] || [];

      // Find spawn to check energy
      const spawn = objects.find((o) => o.type === 'spawn');
      const currentEnergy = (spawn?.store as { energy?: number })?.energy || 0;

      // Track energy delta
      const energyDelta = currentEnergy - lastEnergy;
      energySnapshots.push(energyDelta);
      lastEnergy = currentEnergy;

      // Count workers by role (approximated by body parts)
      const creeps = objects.filter((o) => o.type === 'creep');
      const harvesters = creeps.filter((c) => {
        const body = c.body as { type: string }[];
        return body?.filter((p) => p.type === 'work').length >= 2;
      });
      const carriers = creeps.filter((c) => {
        const body = c.body as { type: string }[];
        const carryParts = body?.filter((p) => p.type === 'carry').length || 0;
        const workParts = body?.filter((p) => p.type === 'work').length || 0;
        return carryParts >= 2 && workParts === 0;
      });

      metrics.harvestersActive = Math.max(metrics.harvestersActive, harvesters.length);
      metrics.carriersActive = Math.max(metrics.carriersActive, carriers.length);

      // Check for stable harvesting (consistent positive energy flow)
      if (
        metrics.ticksToStableHarvesting === -1 &&
        energySnapshots.length >= 5
      ) {
        const recent = energySnapshots.slice(-5);
        const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (avgRecent > 0) {
          metrics.ticksToStableHarvesting = tick - startTick;
          console.log(`[Tick ${tick}] Stable energy flow achieved!`);
        }
      }

      // Progress logging
      if ((tick - startTick) % 50 === 0) {
        const avgFlow =
          energySnapshots.length > 0
            ? energySnapshots.reduce((a, b) => a + b, 0) / energySnapshots.length
            : 0;
        console.log(
          `[Tick ${tick}] Harvesters: ${harvesters.length}, Carriers: ${carriers.length}, Avg Flow: ${avgFlow.toFixed(1)}`
        );
      }
    },
  });

  // Calculate final metrics
  metrics.energyPerTick = energySnapshots;
  metrics.averageEnergyFlow =
    energySnapshots.length > 0
      ? energySnapshots.reduce((a, b) => a + b, 0) / energySnapshots.length
      : 0;

  console.log('\n=== Energy Flow Results ===');
  console.log(`Ticks to stable harvesting: ${metrics.ticksToStableHarvesting}`);
  console.log(`Max harvesters: ${metrics.harvestersActive}`);
  console.log(`Max carriers: ${metrics.carriersActive}`);
  console.log(`Average energy flow: ${metrics.averageEnergyFlow.toFixed(2)}/tick`);

  return metrics;
}

export function validateEnergyFlow(metrics: EnergyFlowMetrics): boolean {
  const checks = [
    {
      name: 'At least 1 harvester active',
      passed: metrics.harvestersActive >= 1,
    },
    {
      name: 'Positive average energy flow',
      passed: metrics.averageEnergyFlow > 0,
    },
    {
      name: 'Stable harvesting within 150 ticks',
      passed: metrics.ticksToStableHarvesting > 0 && metrics.ticksToStableHarvesting <= 150,
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

if (require.main === module) {
  runEnergyFlowScenario()
    .then((metrics) => {
      const passed = validateEnergyFlow(metrics);
      process.exit(passed ? 0 : 1);
    })
    .catch((err) => {
      console.error('Scenario failed:', err);
      process.exit(1);
    });
}
