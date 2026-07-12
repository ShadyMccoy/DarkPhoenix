/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game } from "../mock";
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";

const FIND_MY_SPAWNS = 112;
const FIND_STRUCTURES = 107;
const FIND_MY_STRUCTURES = 108;

/**
 * The extension tender (a local mover) only asks for a creep once there's a depot
 * to draw from and extensions to fill, and it runs exactly one (oversized) tender
 * per room. Without a depot the haulers still fill the network themselves, so no
 * tender is wanted.
 */
function room(opts: { depot?: boolean; extensions?: number }): any {
  const spawnPos = {
    x: 25, y: 25, roomName: "W0N0",
    findInRange: (type: number) =>
      type === FIND_STRUCTURES && opts.depot ? [{ structureType: "container", pos: { x: 24, y: 25 } }] : []
  };
  const spawn = { id: "spawn1", pos: spawnPos, store: { getFreeCapacity: () => 0 } };
  const extensions = Array.from({ length: opts.extensions ?? 0 }, (_, i) => ({
    structureType: "extension",
    pos: { x: 20 + i, y: 20 },
    store: { getFreeCapacity: () => 50 }
  }));
  return {
    name: "W0N0",
    find: (type: number, o?: any) => {
      if (type === FIND_MY_SPAWNS) return [spawn];
      if (type === FIND_MY_STRUCTURES) {
        const all = [spawn, ...extensions];
        return o?.filter ? all.filter(o.filter) : all;
      }
      return [];
    },
    _spawn: spawn
  };
}

describe("ExtensionTenderCorp spawn demand (local mover)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).FIND_MY_SPAWNS = FIND_MY_SPAWNS;
    (global as any).FIND_STRUCTURES = FIND_STRUCTURES;
    (global as any).FIND_MY_STRUCTURES = FIND_MY_STRUCTURES;
    (global as any).STRUCTURE_EXTENSION = "extension";
    (global as any).STRUCTURE_SPAWN = "spawn";
    (global as any).STRUCTURE_CONTAINER = "container";
    Game.creeps = {};
  });

  // corpFor mutates the shared mock Game.getObjectById; restore it (and creeps) so
  // later test files (e.g. getSpawnDemand.test.ts) don't inherit a room without
  // .memory. The mock Game is a singleton, so setupGlobals alone won't reset it.
  afterEach(() => {
    Game.getObjectById = () => null;
    Game.creeps = {};
  });

  const ctx = { energyCapacity: 800, tick: 100 };

  function corpFor(r: any): ExtensionTenderCorp {
    Game.getObjectById = (id: string) => (id === "spawn1" ? { ...r._spawn, room: r } : null) as any;
    return new ExtensionTenderCorp("W0N0-tender", "spawn1");
  }

  it("asks for NOTHING when there is no depot (haulers still fill the network)", () => {
    const corp = corpFor(room({ depot: false, extensions: 5 }));
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });

  it("asks for NOTHING when there are no extensions to fill", () => {
    const corp = corpFor(room({ depot: true, extensions: 0 }));
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });

  it("asks for NOTHING before the room has a miner (income before infrastructure)", () => {
    const corp = corpFor(room({ depot: true, extensions: 5 }));
    Game.creeps = {}; // no miner yet
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });

  it("asks for ONE non-blocking, oversized tender when a depot, extensions and a miner exist", () => {
    const r = room({ depot: true, extensions: 5 });
    const corp = corpFor(r);
    Game.creeps = { m1: { room: { name: "W0N0" }, memory: { corpId: "mining-abc", workType: "harvest" }, spawning: false } } as any;
    const demand = corp.getSpawnDemand(ctx as any);
    expect(demand).to.have.length(1);
    expect(demand[0].role).to.equal("tanker");
    expect(demand[0].blocking, "infrastructure, must not hold the spawn ahead of producers").to.equal(false);
    expect(demand[0].bodyParam, "sized to refill the whole extension set (+spawn)").to.equal(6);
  });

  // SLA fleet sizing (commit 540289d): the target is max(clusters, coverage) —
  // in this world 2 (the spawn sits in its own cluster, and a 550 bank over a
  // 400-carry body needs two tenders to cover a full drain in one wave).
  it("asks for a second tender while SLA coverage is short", () => {
    const r = room({ depot: true, extensions: 5 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { corpId: "mining-abc", workType: "harvest" }, spawning: false },
      t1: { room: { name: "W0N0" }, memory: { corpId: corp.id, workType: "tank" }, spawning: false }
    } as any;
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(1);
  });

  it("asks for nothing once the SLA fleet is fielded", () => {
    const r = room({ depot: true, extensions: 5 });
    const corp = corpFor(r);
    Game.creeps = {
      m1: { room: { name: "W0N0" }, memory: { corpId: "mining-abc", workType: "harvest" }, spawning: false },
      t1: { room: { name: "W0N0" }, memory: { corpId: corp.id, workType: "tank" }, spawning: false },
      t2: { room: { name: "W0N0" }, memory: { corpId: corp.id, workType: "tank" }, spawning: false }
    } as any;
    expect(corp.getSpawnDemand(ctx as any)).to.have.length(0);
  });
});
