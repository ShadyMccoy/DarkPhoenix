#!/usr/bin/env ts-node
/**
 * Quick demo of the GameMock system
 * Run with: npx ts-node test/sim/mock-demo.ts
 */

import { createMockGame, addMockCreep, FIND, OK } from './GameMock';

console.log('=== GameMock Demo ===\n');

// Create a mock game
const { Game, Memory } = createMockGame({
  rooms: ['W0N0', 'W1N0'],
  tick: 100,
});

console.log(`Game tick: ${Game.time}`);
console.log(`Rooms: ${Object.keys(Game.rooms).join(', ')}`);
console.log(`Spawn: ${Object.keys(Game.spawns).join(', ')}`);

// Add some creeps
const harvester = addMockCreep(Game, Memory, {
  name: 'Harvester1',
  room: 'W0N0',
  body: ['work', 'work', 'carry', 'move'],
  pos: { x: 10, y: 10 },
  memory: { role: 'harvester', sourceId: 'src1' },
});

const carrier = addMockCreep(Game, Memory, {
  name: 'Carrier1',
  room: 'W0N0',
  body: ['carry', 'carry', 'carry', 'move', 'move', 'move'],
  pos: { x: 25, y: 25 },
  memory: { role: 'carrier' },
});

console.log(`\nCreeps created: ${Object.keys(Game.creeps).length}`);
console.log(`- ${harvester.name}: ${harvester.body.map(p => p.type).join(',')}`);
console.log(`- ${carrier.name}: ${carrier.body.map(p => p.type).join(',')}`);

// Check store capacities
console.log(`\nHarvester carry capacity: ${harvester.store.getCapacity()}`);
console.log(`Carrier carry capacity: ${carrier.store.getCapacity()}`);

// Memory is synced
console.log(`\nMemory.creeps: ${JSON.stringify(Memory.creeps, null, 2)}`);

// Test getObjectById
const found = Game.getObjectById<typeof harvester>('creep_Harvester1');
console.log(`\ngetObjectById test: ${found ? 'PASS' : 'FAIL'} (found ${found?.name})`);

// Room info
const room = Game.rooms['W0N0'];
console.log(`\nRoom W0N0:`);
console.log(`  Controller level: ${room.controller?.level}`);
console.log(`  Energy available: ${room.energyAvailable}`);

// Spawn info
const spawn = Game.spawns['Spawn1'];
console.log(`\nSpawn1:`);
console.log(`  Energy: ${spawn.store.energy}`);
console.log(`  Position: (${spawn.pos.x}, ${spawn.pos.y})`);

console.log('\n=== All tests passed! ===');
