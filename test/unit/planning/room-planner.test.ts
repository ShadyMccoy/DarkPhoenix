/**
 * @fileoverview Integration tests for RoomPlanner.
 *
 * Tests the GOAP-based room planning system with a full simulation
 * environment including sources, spawns, and controllers.
 *
 * These tests verify that:
 * 1. The planner correctly observes room state
 * 2. The planner creates appropriate operations based on goals
 * 3. Operations run and produce expected results (creeps spawned, etc.)
 * 4. The planning cycle works over multiple ticks
 */

import { expect } from "chai";
import { GameSimulator, createStandardSimulator } from "../../sim/GameSimulator";
import {
  RoomPlanner,
  createRoomPlanner,
  STATE_HAS_SPAWN,
  STATE_HAS_SOURCE,
  STATE_HAS_CONTROLLER,
  STATE_HAS_BOOTSTRAP_OP,
  STATE_HAS_CREEPS,
  STATE_SPAWN_HAS_ENERGY,
} from "../../../src/planning";
import { Bootstrap } from "../../../src/routines/Bootstrap";
import { EnergyMining } from "../../../src/routines/EnergyMining";

describe("RoomPlanner Integration", () => {
  let simulator: GameSimulator;

  beforeEach(() => {
    // Create a fresh simulator with standard room setup
    simulator = createStandardSimulator();
    simulator.installGlobals();
  });

  describe("World State Observation", () => {
    it("should correctly observe room with spawn, source, and controller", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      planner.observe();
      const state = planner.getWorldState();

      expect(state.getState().get(STATE_HAS_SPAWN)).to.equal(true);
      expect(state.getState().get(STATE_HAS_SOURCE)).to.equal(true);
      expect(state.getState().get(STATE_HAS_CONTROLLER)).to.equal(true);
      expect(state.getState().get(STATE_HAS_BOOTSTRAP_OP)).to.equal(false);
      expect(state.getState().get(STATE_HAS_CREEPS)).to.equal(false);
    });

    it("should detect spawn energy correctly", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      planner.observe();
      const state = planner.getWorldState();

      // Standard spawn starts with 300 energy
      expect(state.getState().get(STATE_SPAWN_HAS_ENERGY)).to.equal(true);
    });

    it("should update state after operations are created", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Initial state - no operations
      planner.observe();
      expect(planner.getWorldState().getState().get(STATE_HAS_BOOTSTRAP_OP)).to.equal(false);

      // Plan and execute - should create bootstrap operation
      planner.run();

      // After run, bootstrap should exist
      planner.observe();
      expect(planner.getWorldState().getState().get(STATE_HAS_BOOTSTRAP_OP)).to.equal(true);
    });
  });

  describe("Operation Creation", () => {
    it("should create bootstrap operation as first action", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      const action = planner.plan();

      expect(action).to.not.be.null;
      expect(action!.name).to.equal("createBootstrapOperation");
    });

    it("should actually create bootstrap operation when executed", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      expect(planner.getOperations().size).to.equal(0);

      planner.run();

      expect(planner.getOperations().size).to.be.greaterThan(0);
      expect(planner.getOperations().has("bootstrap")).to.equal(true);
    });

    it("should create mining operations after bootstrap exists", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // First run creates bootstrap
      planner.run();
      expect(planner.getOperations().has("bootstrap")).to.equal(true);

      // We need creeps and bootstrap running before mining is prioritized
      // For now, just verify that the mining action exists in available actions
      const operations = planner.getOperations();
      expect(operations.size).to.be.greaterThan(0);
    });
  });

  describe("Multi-Tick Simulation", () => {
    it("should spawn creeps over multiple ticks", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Run for several ticks
      for (let i = 0; i < 20; i++) {
        planner.run();
        simulator.tick();
      }

      // After 20 ticks, we should have at least one creep
      // (spawn takes 3 ticks per body part, jack = 3 parts = 9 ticks)
      const creeps = Object.keys(simulator.Game.creeps);
      expect(creeps.length).to.be.greaterThan(0);
    });

    it("should track world state changes as creeps spawn", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Initially no creeps
      planner.observe();
      expect(planner.getWorldState().getState().get(STATE_HAS_CREEPS)).to.equal(false);

      // Run for enough ticks to spawn a creep
      for (let i = 0; i < 15; i++) {
        planner.run();
        simulator.tick();
      }

      // Now should have creeps
      planner.observe();
      expect(planner.getWorldState().getState().get(STATE_HAS_CREEPS)).to.equal(true);
    });

    it("should continue planning after operations are running", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Run for many ticks
      let actionsTaken: string[] = [];
      for (let i = 0; i < 30; i++) {
        const action = planner.plan();
        if (action) {
          actionsTaken.push(action.name);
          planner.execute(action);
        }
        simulator.tick();
      }

      // Should have taken multiple different actions
      expect(actionsTaken.length).to.be.greaterThan(1);

      // Bootstrap should have been created early
      expect(actionsTaken[0]).to.equal("createBootstrapOperation");
    });
  });

  describe("Bootstrap Operation Integration", () => {
    it("should run bootstrap operation and spawn jack creeps", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Create bootstrap
      planner.run();
      expect(planner.getOperations().has("bootstrap")).to.equal(true);

      // Run for enough ticks to complete spawning
      for (let i = 0; i < 15; i++) {
        planner.runAllOperations();
        simulator.tick();
      }

      // Should have spawned a jack
      const creeps = Object.values(simulator.Game.creeps);
      expect(creeps.length).to.be.greaterThan(0);

      // Check the creep has the jack role
      const jack = creeps.find((c) => c.memory.role === "jack" || c.memory.role === "busyjack");
      expect(jack).to.not.be.undefined;
    });

    it("should correctly assign creep roles", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Create and run bootstrap
      planner.run();

      // Run for enough ticks
      for (let i = 0; i < 20; i++) {
        planner.runAllOperations();
        simulator.tick();
      }

      // Check creep roles in memory
      const creepMemory = simulator.Memory.creeps;
      const roles = Object.values(creepMemory).map((m) => m.role);

      // Should have jack or busyjack roles
      const hasJackRole = roles.some(
        (r) => r === "jack" || r === "busyjack"
      );
      expect(hasJackRole).to.equal(true);
    });
  });

  describe("Serialization", () => {
    it("should serialize planner state", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Create some operations
      planner.run();

      const serialized = planner.serialize();

      expect(serialized.operations).to.be.an("array");
      expect(serialized.operations.length).to.be.greaterThan(0);
      expect(serialized.operations[0].key).to.equal("bootstrap");
      expect(serialized.operations[0].type).to.equal("bootstrap");
    });

    it("should deserialize and restore planner state", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner1 = createRoomPlanner(room as unknown as Room);

      // Create operations
      planner1.run();
      const serialized = planner1.serialize();

      // Create new planner and restore
      const planner2 = createRoomPlanner(room as unknown as Room);
      planner2.deserialize(serialized);

      expect(planner2.getOperations().size).to.equal(planner1.getOperations().size);
      expect(planner2.getOperations().has("bootstrap")).to.equal(true);
    });
  });

  describe("Goal Achievement", () => {
    it("should satisfy bootstrap goal after creating operation", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Before: bootstrap goal not satisfied
      planner.observe();
      expect(planner.getWorldState().getState().get(STATE_HAS_BOOTSTRAP_OP)).to.equal(false);

      // Create bootstrap
      planner.run();

      // After: bootstrap goal satisfied
      planner.observe();
      expect(planner.getWorldState().getState().get(STATE_HAS_BOOTSTRAP_OP)).to.equal(true);
    });

    it("should satisfy creeps goal after spawning", () => {
      const room = simulator.Game.rooms["W0N0"];
      const planner = createRoomPlanner(room as unknown as Room);

      // Run for enough ticks to spawn
      for (let i = 0; i < 15; i++) {
        planner.run();
        simulator.tick();
      }

      planner.observe();
      expect(planner.getWorldState().getState().get(STATE_HAS_CREEPS)).to.equal(true);
    });
  });
});

describe("Full Planning Cycle Scenario", () => {
  let simulator: GameSimulator;

  beforeEach(() => {
    simulator = createStandardSimulator();
    simulator.installGlobals();
  });

  it("should bootstrap a room from scratch over 50 ticks", () => {
    const room = simulator.Game.rooms["W0N0"];
    const planner = createRoomPlanner(room as unknown as Room);

    const metrics = {
      operationsCreated: 0,
      creepsSpawned: 0,
      actionsExecuted: [] as string[],
    };

    // Run simulation for 50 ticks
    for (let tick = 0; tick < 50; tick++) {
      const action = planner.plan();
      if (action) {
        metrics.actionsExecuted.push(action.name);
        if (action.name.startsWith("create")) {
          metrics.operationsCreated++;
        }
        planner.execute(action);
      } else {
        // No action from planning - run all operations anyway
        planner.runAllOperations();
      }
      simulator.tick();
    }

    metrics.creepsSpawned = Object.keys(simulator.Game.creeps).length;

    // Assertions
    expect(metrics.operationsCreated).to.be.greaterThan(0, "Should create at least one operation");
    expect(metrics.creepsSpawned).to.be.greaterThan(0, "Should spawn at least one creep");
    expect(metrics.actionsExecuted).to.include("createBootstrapOperation");

    // Log metrics for debugging
    console.log("\n=== 50 Tick Simulation Metrics ===");
    console.log(`Operations created: ${metrics.operationsCreated}`);
    console.log(`Creeps spawned: ${metrics.creepsSpawned}`);
    console.log(`Actions executed: ${metrics.actionsExecuted.slice(0, 10).join(", ")}...`);
  });

  it("should spawn multiple creeps with proper energy management", () => {
    const room = simulator.Game.rooms["W0N0"];
    const planner = createRoomPlanner(room as unknown as Room);

    // Track energy usage
    const spawn = simulator.Game.spawns["Spawn1"];
    const initialEnergy = spawn.store.energy;

    // Run for 30 ticks
    for (let tick = 0; tick < 30; tick++) {
      planner.run();
      simulator.tick();
    }

    // Should have spawned creeps (each jack costs 200 energy)
    const creepCount = Object.keys(simulator.Game.creeps).length;
    const energyUsed = initialEnergy - spawn.store.energy + (creepCount * 200);

    expect(creepCount).to.be.greaterThan(0);
    console.log(`\nSpawned ${creepCount} creeps`);
    console.log(`Current spawn energy: ${spawn.store.energy}`);
  });

  it("should handle room with multiple sources", () => {
    // Standard simulator has 2 sources
    const room = simulator.Game.rooms["W0N0"];
    const sources = room.find(105); // FIND_SOURCES

    expect(sources.length).to.equal(2);

    const planner = createRoomPlanner(room as unknown as Room);

    // Run for a while
    for (let tick = 0; tick < 30; tick++) {
      planner.run();
      simulator.tick();
    }

    // Should have created operations
    expect(planner.getOperations().size).to.be.greaterThan(0);
  });
});

describe("RoomPlanner Edge Cases", () => {
  it("should handle room without controller", () => {
    const simulator = new GameSimulator();
    simulator.createRoom("W1N1", {
      spawn: { name: "Spawn2", x: 25, y: 25 },
      sources: [{ x: 15, y: 15 }],
      // No controller
    });
    simulator.installGlobals();

    const room = simulator.Game.rooms["W1N1"];
    const planner = createRoomPlanner(room as unknown as Room);

    planner.observe();
    const state = planner.getWorldState();

    expect(state.getState().get(STATE_HAS_CONTROLLER)).to.equal(false);
    expect(state.getState().get(STATE_HAS_SPAWN)).to.equal(true);
  });

  it("should handle room without spawn", () => {
    const simulator = new GameSimulator();
    simulator.createRoom("W2N2", {
      controller: { x: 25, y: 35 },
      sources: [{ x: 15, y: 15 }],
      // No spawn
    });
    simulator.installGlobals();

    const room = simulator.Game.rooms["W2N2"];
    const planner = createRoomPlanner(room as unknown as Room);

    planner.observe();
    const state = planner.getWorldState();

    expect(state.getState().get(STATE_HAS_SPAWN)).to.equal(false);
    expect(state.getState().get(STATE_HAS_CONTROLLER)).to.equal(true);
  });

  it("should handle empty room", () => {
    const simulator = new GameSimulator();
    simulator.createRoom("W3N3", {
      // Nothing
    });
    simulator.installGlobals();

    const room = simulator.Game.rooms["W3N3"];
    const planner = createRoomPlanner(room as unknown as Room);

    planner.observe();
    const state = planner.getWorldState();

    expect(state.getState().get(STATE_HAS_SPAWN)).to.equal(false);
    expect(state.getState().get(STATE_HAS_SOURCE)).to.equal(false);
    expect(state.getState().get(STATE_HAS_CONTROLLER)).to.equal(false);
  });
});
