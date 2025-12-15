#!/usr/bin/env ts-node
/**
 * Debug script to check simulator state
 */

import { createSimulator } from '../test/sim/ScreepsSimulator';

async function main() {
  const sim = createSimulator();
  await sim.connect();

  const room = 'W1N1';

  console.log('\n=== Checking room state ===\n');

  // Get room objects
  const objects = await sim.getRoomObjects(room);
  console.log(`Total objects in ${room}: ${objects.length}`);

  // Group by type
  const byType: Record<string, number> = {};
  for (const obj of objects) {
    byType[obj.type] = (byType[obj.type] || 0) + 1;
  }
  console.log('Objects by type:', byType);

  // Check spawns specifically
  const spawns = objects.filter((o) => o.type === 'spawn');
  console.log('\nSpawns:', spawns.length);
  for (const spawn of spawns) {
    console.log(`  - ${(spawn as any).name} at (${spawn.x}, ${spawn.y}), user: ${(spawn as any).user}, energy: ${JSON.stringify((spawn as any).store)}`);
  }

  // Check terrain at spawn location
  const terrain = await sim.getTerrain(room);
  console.log('\nTerrain sample (first 100 chars):', terrain.substring(0, 100));

  // Check if our code is running - try to read Memory
  try {
    const memory = await sim.getMemory();
    console.log('\nMemory keys:', Object.keys(memory as object));
  } catch (e) {
    console.log('\nCould not read memory:', e);
  }

  // Check current tick
  const tick = await sim.getTick();
  console.log('\nCurrent tick:', tick);
}

main().catch(console.error);
