/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * Spec 14 phase 1 - room energy ledger. The stocks decisions read (warchest
 * balance, controller-side stock, feeder relay state) must be IN telemetry,
 * via the same lenses the decisions use ("200k in storage" must be readable
 * from a capture, not recalled by the owner). Null means "no such store",
 * never zero - a storage-less room and an empty storage are different facts.
 */
describe("Telemetry room energy ledger (segment 0, spec 14 phase 1)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.time = 100;
    Game.creeps = {};
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    // Lens constants used by controllerSideStock/controllerInputSpot.
    (global as any).FIND_STRUCTURES = 107;
    (global as any).FIND_DROPPED_RESOURCES = 106;
    // Site-progress export (core v6) scans construction sites per owned room;
    // define the constant HERE, not by leakage from other suites' globals
    // (standalone runs of this file had no definition and threw mid-export).
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).STRUCTURE_STORAGE = "storage";
    (global as any).STRUCTURE_LINK = "link";
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).TERRAIN_MASK_WALL = 1;
    // Bare-controller rooms take controllerInputSpot's terrain-scan branch,
    // which mints a RoomPosition for the chosen spot; its dropped-energy scan
    // must return empty.
    (global as any).RoomPosition = class {
      public constructor(public x: number, public y: number, public roomName: string) {}
      public findInRange(): any[] {
        return [];
      }
    };
  });

  /** A controller whose pos serves the lens's findInRange calls from fixtures. */
  const mkController = (structures: any[], dropped: any[]): any => {
    const pos: any = {
      x: 25,
      y: 25,
      findInRange: (find: number) => (find === (global as any).FIND_DROPPED_RESOURCES ? dropped : structures)
    };
    // The input-spot buffer branch reuses the container's own pos for the
    // dropped-resource scan; point it at the same stub.
    for (const s of structures) s.pos = pos;
    const controller: any = { my: true, level: 5, progress: 1, progressTotal: 2, pos };
    // Terrain for the input-spot fallback when no buffer structure exists.
    controller.room = { name: "test", getTerrain: () => ({ get: () => 0 }) };
    return controller;
  };

  it("exports storage balance, controller-side stock, and feeder state per owned room", () => {
    const container = { structureType: "container", store: { energy: 1500 } };
    Game.rooms = {
      W43N23: {
        name: "W43N23",
        controller: mkController([container], [{ resourceType: "energy", amount: 250 }]),
        storage: { my: true, store: { energy: 200000 } },
        memory: { controllerFeederActive: true },
        energyAvailable: 1800,
        energyCapacityAvailable: 1800,
        find: () => [] // nodes segment counts spawns per room
      }
    } as any;

    new Telemetry().update(undefined, [], undefined);
    const core = JSON.parse(RawMemory.segments[0]);

    expect(core.version).to.equal(7); // v5 spawn meter + agenda; v6 site progress (P8); v7 remoteGate
    const room = core.rooms[0];
    expect(room.storageEnergy).to.equal(200000);
    // 1500 in the controller-side container + 250 dropped at the input spot
    expect(room.controllerStock).to.equal(1750);
    expect(room.feederActive).to.equal(true);
  });

  it("exports my construction sites' progress sums (v6, ledger P8 'builders not building')", () => {
    const container = { structureType: "container", store: { energy: 0 } };
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        controller: mkController([container], []),
        memory: {},
        energyAvailable: 300,
        energyCapacityAvailable: 300,
        find: (t: number) =>
          t === 114 ? [{ progress: 500, progressTotal: 3000 }, { progress: 100, progressTotal: 5000 }] : []
      }
    } as any;

    new Telemetry().update(undefined, [], undefined);
    const room = JSON.parse(RawMemory.segments[0]).rooms[0];

    expect(room.siteProgress).to.equal(600);
    expect(room.siteTotal).to.equal(8000);
    expect(room.siteCount).to.equal(2);
  });

  it("reports null (not zero) when a room has no storage, and 0 stock for a bare controller", () => {
    Game.rooms = {
      W1N1: {
        name: "W1N1",
        controller: mkController([], []),
        memory: {},
        energyAvailable: 300,
        energyCapacityAvailable: 300,
        find: () => []
      }
    } as any;

    new Telemetry().update(undefined, [], undefined);
    const room = JSON.parse(RawMemory.segments[0]).rooms[0];

    expect(room.storageEnergy).to.equal(null);
    expect(room.controllerStock).to.equal(0);
    expect(room.feederActive).to.equal(false);
  });
});
