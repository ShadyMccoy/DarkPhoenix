//inject mocha globally to allow custom interface refer without direct import - bypass bundle issue
global._ = require('lodash');
global.mocha = require('mocha');
global.chai = require('chai');
global.sinon = require('sinon');
global.chai.use(require('sinon-chai'));

// Mock Screeps globals for testing
global.RoomPosition = class RoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }
    getRangeTo(pos) {
        return Math.abs(this.x - pos.x) + Math.abs(this.y - pos.y);
    }
};

global.PathFinder = {
    CostMatrix: class CostMatrix {
        constructor() {
            this._bits = new Uint8Array(2500);
        }
        get(x, y) {
            return this._bits[y * 50 + x];
        }
        set(x, y, val) {
            this._bits[y * 50 + x] = val;
        }
    }
};

global.FIND_SOURCES = 105;
global.FIND_MINERALS = 106;
global.LOOK_SOURCES = 'source';
global.OK = 0;

// Override ts-node compiler options
process.env.TS_NODE_PROJECT = 'tsconfig.test.json'
