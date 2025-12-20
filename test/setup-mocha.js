//inject mocha globally to allow custom interface refer without direct import - bypass bundle issue
global._ = require('lodash');
global.mocha = require('mocha');
global.chai = require('chai');
global.sinon = require('sinon');
global.chai.use(require('sinon-chai'));

// Override ts-node compiler options
process.env.TS_NODE_PROJECT = 'tsconfig.test.json'

// ============================================================================
// Set up Screeps global constants BEFORE any test files are loaded
// This is required because Real* corps use these constants at module load time
// ============================================================================

// Body part constants
global.WORK = 'work';
global.CARRY = 'carry';
global.MOVE = 'move';
global.ATTACK = 'attack';
global.RANGED_ATTACK = 'ranged_attack';
global.HEAL = 'heal';
global.TOUGH = 'tough';
global.CLAIM = 'claim';

// Resource constants
global.RESOURCE_ENERGY = 'energy';

// Return codes
global.OK = 0;
global.ERR_NOT_IN_RANGE = -9;
global.ERR_NOT_ENOUGH_ENERGY = -6;
global.ERR_BUSY = -4;
global.ERR_INVALID_TARGET = -7;
global.ERR_NOT_OWNER = -1;
global.ERR_NO_PATH = -2;
global.ERR_NAME_EXISTS = -3;
global.ERR_FULL = -8;
global.ERR_GCL_NOT_ENOUGH = -15;

// Find constants
global.FIND_SOURCES = 105;
global.FIND_MINERALS = 106;
global.FIND_STRUCTURES = 107;
global.FIND_MY_SPAWNS = 112;
global.FIND_MY_CREEPS = 106;
global.FIND_HOSTILE_CREEPS = 103;

// Structure constants
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_STORAGE = 'storage';
global.STRUCTURE_CONTAINER = 'container';
global.STRUCTURE_CONTROLLER = 'controller';

// Look constants
global.LOOK_SOURCES = 'source';
global.LOOK_STRUCTURES = 'structure';
global.LOOK_CREEPS = 'creep';
global.LOOK_RESOURCES = 'resource';

// Terrain constants
global.TERRAIN_MASK_WALL = 1;
global.TERRAIN_MASK_SWAMP = 2;

// Default Game and Memory objects (will be overridden by individual tests)
global.Game = {
  creeps: {},
  rooms: {},
  spawns: {},
  time: 0,
  map: { getRoomTerrain: () => ({ get: () => 0 }) },
  getObjectById: () => null
};
global.Memory = { creeps: {}, rooms: {} };
