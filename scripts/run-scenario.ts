#!/usr/bin/env ts-node
/**
 * Scenario Runner
 *
 * Runs simulation scenarios against the Screeps private server.
 * Usage: npx ts-node scripts/run-scenario.ts [scenario-name]
 */

import * as path from 'path';
import * as fs from 'fs';
import { createSimulator } from '../test/sim/ScreepsSimulator';

const SCENARIOS_DIR = path.join(__dirname, '..', 'test', 'sim', 'scenarios');

interface Prerequisites {
  connected: boolean;
  hasSpawn: boolean;
  hasController: boolean;
  hasSources: boolean;
  spawnCount: number;
  controllerCount: number;
  sourceCount: number;
}

async function checkPrerequisites(room = 'W0N0'): Promise<Prerequisites> {
  const prereqs: Prerequisites = {
    connected: false,
    hasSpawn: false,
    hasController: false,
    hasSources: false,
    spawnCount: 0,
    controllerCount: 0,
    sourceCount: 0,
  };

  try {
    const sim = createSimulator();
    await sim.connect();
    prereqs.connected = true;

    const objects = await sim.getRoomObjects(room);
    prereqs.spawnCount = objects.filter((o) => o.type === 'spawn').length;
    prereqs.controllerCount = objects.filter((o) => o.type === 'controller').length;
    prereqs.sourceCount = objects.filter((o) => o.type === 'source').length;

    prereqs.hasSpawn = prereqs.spawnCount > 0;
    prereqs.hasController = prereqs.controllerCount > 0;
    prereqs.hasSources = prereqs.sourceCount > 0;
  } catch (e) {
    // Connection failed
  }

  return prereqs;
}

async function listScenarios(): Promise<string[]> {
  const files = fs.readdirSync(SCENARIOS_DIR);
  return files
    .filter((f) => f.endsWith('.scenario.ts'))
    .map((f) => f.replace('.scenario.ts', ''));
}

async function runScenario(name: string): Promise<boolean> {
  const scenarioPath = path.join(SCENARIOS_DIR, `${name}.scenario.ts`);

  if (!fs.existsSync(scenarioPath)) {
    console.error(`Scenario not found: ${name}`);
    console.log('\nAvailable scenarios:');
    const scenarios = await listScenarios();
    scenarios.forEach((s) => console.log(`  - ${s}`));
    return false;
  }

  console.log(`\nRunning scenario: ${name}\n`);
  console.log('='.repeat(50));

  try {
    // Dynamic import
    const scenario = await import(scenarioPath);

    // Look for run function (convention: runXxxScenario)
    const runFn = Object.keys(scenario).find((k) => k.startsWith('run') && k.endsWith('Scenario'));
    const validateFn = Object.keys(scenario).find((k) => k.startsWith('validate'));

    if (!runFn) {
      console.error('No run function found in scenario');
      return false;
    }

    const metrics = await scenario[runFn]();

    if (validateFn) {
      console.log('='.repeat(50));
      return scenario[validateFn](metrics);
    }

    return true;
  } catch (error) {
    console.error('Scenario execution failed:', error);
    return false;
  }
}

async function runAllScenarios(): Promise<void> {
  const scenarios = await listScenarios();
  const results: Record<string, boolean> = {};

  // Check prerequisites first
  console.log('Checking server prerequisites...\n');
  const prereqs = await checkPrerequisites();

  console.log('Server Status:');
  console.log(`  Connected: ${prereqs.connected ? '✓' : '✗'}`);
  console.log(`  Spawns: ${prereqs.spawnCount}`);
  console.log(`  Controllers: ${prereqs.controllerCount}`);
  console.log(`  Sources: ${prereqs.sourceCount}`);
  console.log('');

  if (!prereqs.connected) {
    console.error('ERROR: Cannot connect to Screeps server.');
    console.error('Make sure the server is running: npm run sim:start');
    process.exit(1);
  }

  if (!prereqs.hasSpawn || !prereqs.hasController || !prereqs.hasSources) {
    console.log('WARNING: Server world is not properly initialized.');
    console.log('The room W0N0 is missing required game objects.');
    console.log('');
    console.log('To properly set up simulation tests, you need to:');
    console.log('1. Install screepsmod-mongo: Add "screepsmod-mongo" to server/config.yml mods');
    console.log('2. Import a map via CLI: utils.importMap("random_1x1")');
    console.log('3. Or use screeps-server-mockup for integration tests');
    console.log('');
    console.log('Continuing with tests (they will likely fail)...\n');
  }

  console.log(`Running ${scenarios.length} scenarios...\n`);

  for (const scenario of scenarios) {
    results[scenario] = await runScenario(scenario);
    console.log('\n');
  }

  console.log('='.repeat(50));
  console.log('\nSummary:');
  console.log('='.repeat(50));

  let passed = 0;
  let failed = 0;

  for (const [name, result] of Object.entries(results)) {
    const status = result ? '✓ PASS' : '✗ FAIL';
    console.log(`${status}  ${name}`);
    if (result) passed++;
    else failed++;
  }

  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Main
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help') {
  console.log(`
Screeps Scenario Runner

Usage:
  npx ts-node scripts/run-scenario.ts <scenario>   Run specific scenario
  npx ts-node scripts/run-scenario.ts --all        Run all scenarios
  npx ts-node scripts/run-scenario.ts --list       List available scenarios

Examples:
  npx ts-node scripts/run-scenario.ts bootstrap
  npx ts-node scripts/run-scenario.ts energy-flow
  npx ts-node scripts/run-scenario.ts --all
`);
  process.exit(0);
}

if (args[0] === '--list') {
  listScenarios().then((scenarios) => {
    console.log('Available scenarios:');
    scenarios.forEach((s) => console.log(`  - ${s}`));
  });
} else if (args[0] === '--all') {
  runAllScenarios();
} else {
  runScenario(args[0]).then((passed) => {
    process.exit(passed ? 0 : 1);
  });
}
