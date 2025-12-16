/**
 * @fileoverview RoomPlanner - GOAP-based room operation planner.
 *
 * The RoomPlanner bridges the GOAP planning system to colony operations.
 * It observes the room state, maintains goals based on colony needs,
 * and uses GOAP planning to decide which operations to create/run.
 *
 * ## How It Works
 * 1. Observe: Build WorldState from room objects
 * 2. Plan: Use GOAP to select best action for highest priority goal
 * 3. Execute: Create/manage operations based on selected action
 *
 * ## World State Predicates
 * - hasSpawn: Room has a functional spawn
 * - hasSource: Room has at least one energy source
 * - hasController: Room has a controller to upgrade
 * - hasEnergyIncome: Room has mining operations producing energy
 * - spawnHasEnergy: Spawn has enough energy to spawn
 * - hasIdleCreeps: Room has creeps without assignments
 * - hasBootstrapOperation: Bootstrap routine is running
 * - hasMiningOperation: Energy mining routine is running
 * - controllerProgressing: Controller is being upgraded
 *
 * ## Actions
 * - createBootstrapOperation: Start bootstrap routine
 * - createMiningOperation: Start energy mining routine
 * - runBootstrap: Execute bootstrap operation
 * - runMining: Execute mining operation
 *
 * @module planning/RoomPlanner
 */

import { Agent, WorldState, Goal, Action } from "./GOAP";
import { RoomRoutine } from "../core/RoomRoutine";
import { Bootstrap } from "../routines/Bootstrap";
import { EnergyMining } from "../routines/EnergyMining";

// ============================================================================
// World State Keys
// ============================================================================

export const STATE_HAS_SPAWN = "hasSpawn";
export const STATE_HAS_SOURCE = "hasSource";
export const STATE_HAS_CONTROLLER = "hasController";
export const STATE_HAS_ENERGY_INCOME = "hasEnergyIncome";
export const STATE_SPAWN_HAS_ENERGY = "spawnHasEnergy";
export const STATE_HAS_IDLE_CREEPS = "hasIdleCreeps";
export const STATE_HAS_BOOTSTRAP_OP = "hasBootstrapOperation";
export const STATE_HAS_MINING_OP = "hasMiningOperation";
export const STATE_CONTROLLER_PROGRESSING = "controllerProgressing";
export const STATE_HAS_CREEPS = "hasCreeps";
export const STATE_RCL_ABOVE_1 = "rclAbove1";

// ============================================================================
// RoomPlanner
// ============================================================================

/**
 * GOAP-based room operation planner.
 *
 * Observes room state and uses goal-oriented planning to decide
 * which operations to create and run.
 */
export class RoomPlanner extends Agent {
  /** The room being planned */
  private room: Room;

  /** Active operations managed by this planner */
  private operations: Map<string, RoomRoutine> = new Map();

  /** Actions available to this planner */
  private actionRegistry: Map<string, Action> = new Map();

  /** Operation creation callbacks */
  private operationFactories: Map<string, () => RoomRoutine | null> = new Map();

  constructor(room: Room) {
    // Initialize with empty world state - will be populated by observe()
    super(new WorldState(new Map()));
    this.room = room;

    this.initializeActions();
    this.initializeGoals();
    this.initializeOperationFactories();
  }

  /**
   * Initializes the action registry with available planning actions.
   */
  private initializeActions(): void {
    // Action: Create bootstrap operation
    this.addAction(
      new Action(
        "createBootstrapOperation",
        new Map([
          [STATE_HAS_SPAWN, true],
          [STATE_HAS_CONTROLLER, true],
          [STATE_HAS_BOOTSTRAP_OP, false],
        ]),
        new Map([[STATE_HAS_BOOTSTRAP_OP, true]]),
        1 // Low cost - high priority to bootstrap
      )
    );
    this.actionRegistry.set("createBootstrapOperation", this.availableActions[0]);

    // Action: Create mining operation
    this.addAction(
      new Action(
        "createMiningOperation",
        new Map([
          [STATE_HAS_SOURCE, true],
          [STATE_HAS_SPAWN, true],
          [STATE_HAS_MINING_OP, false],
        ]),
        new Map([[STATE_HAS_MINING_OP, true]]),
        2
      )
    );
    this.actionRegistry.set("createMiningOperation", this.availableActions[1]);

    // Action: Run bootstrap (spawns jacks, delivers energy)
    this.addAction(
      new Action(
        "runBootstrap",
        new Map([[STATE_HAS_BOOTSTRAP_OP, true]]),
        new Map([
          [STATE_HAS_CREEPS, true],
          [STATE_SPAWN_HAS_ENERGY, true],
        ]),
        1
      )
    );
    this.actionRegistry.set("runBootstrap", this.availableActions[2]);

    // Action: Run mining (produces energy)
    this.addAction(
      new Action(
        "runMining",
        new Map([
          [STATE_HAS_MINING_OP, true],
          [STATE_HAS_CREEPS, true],
        ]),
        new Map([[STATE_HAS_ENERGY_INCOME, true]]),
        2
      )
    );
    this.actionRegistry.set("runMining", this.availableActions[3]);

    // Action: Upgrade controller (uses energy to progress RCL)
    this.addAction(
      new Action(
        "upgradeController",
        new Map([
          [STATE_HAS_CONTROLLER, true],
          [STATE_HAS_CREEPS, true],
          [STATE_SPAWN_HAS_ENERGY, true],
        ]),
        new Map([[STATE_CONTROLLER_PROGRESSING, true]]),
        3
      )
    );
    this.actionRegistry.set("upgradeController", this.availableActions[4]);
  }

  /**
   * Initializes goals for the room planner.
   */
  private initializeGoals(): void {
    // Goal: Have bootstrap operation running (highest priority for new rooms)
    this.addGoal(
      new Goal(
        new Map([[STATE_HAS_BOOTSTRAP_OP, true]]),
        100 // Highest priority
      )
    );

    // Goal: Have creeps in the room
    this.addGoal(
      new Goal(
        new Map([[STATE_HAS_CREEPS, true]]),
        90
      )
    );

    // Goal: Keep spawn filled with energy
    this.addGoal(
      new Goal(
        new Map([[STATE_SPAWN_HAS_ENERGY, true]]),
        80
      )
    );

    // Goal: Have energy income (mining operations)
    this.addGoal(
      new Goal(
        new Map([[STATE_HAS_ENERGY_INCOME, true]]),
        70
      )
    );

    // Goal: Controller progressing
    this.addGoal(
      new Goal(
        new Map([[STATE_CONTROLLER_PROGRESSING, true]]),
        60
      )
    );

    // Goal: Have mining operations set up
    this.addGoal(
      new Goal(
        new Map([[STATE_HAS_MINING_OP, true]]),
        50
      )
    );
  }

  /**
   * Initializes factories for creating operations.
   */
  private initializeOperationFactories(): void {
    this.operationFactories.set("createBootstrapOperation", () => {
      if (!this.room.controller) return null;
      return new Bootstrap(this.room.controller.pos);
    });

    this.operationFactories.set("createMiningOperation", () => {
      const sources = this.room.find(FIND_SOURCES);
      if (sources.length === 0) return null;

      // Create mining operation for first source without one
      for (const source of sources) {
        const hasOp = Array.from(this.operations.values()).some(
          (op) => op instanceof EnergyMining && op.position.getRangeTo(source.pos) < 2
        );
        if (!hasOp) {
          const mining = new EnergyMining(source.pos);
          mining.setSourceMine(this.createSourceMineConfig(source));
          return mining;
        }
      }
      return null;
    });
  }

  /**
   * Creates SourceMine configuration for a source.
   */
  private createSourceMineConfig(source: Source): {
    sourceId: Id<Source>;
    HarvestPositions: RoomPosition[];
    distanceToSpawn: number;
    flow: number;
  } {
    const harvestPositions = this.room
      .lookForAtArea(
        LOOK_TERRAIN,
        source.pos.y - 1,
        source.pos.x - 1,
        source.pos.y + 1,
        source.pos.x + 1,
        true
      )
      .filter((pos) => pos.terrain === "plain" || pos.terrain === "swamp")
      .map((pos) => new RoomPosition(pos.x, pos.y, this.room.name));

    const spawns = this.room.find(FIND_MY_SPAWNS);
    const closestSpawn = spawns.length > 0 ? spawns[0] : null;
    const distanceToSpawn = closestSpawn
      ? closestSpawn.pos.getRangeTo(source.pos)
      : 50;

    return {
      sourceId: source.id,
      HarvestPositions: harvestPositions,
      distanceToSpawn,
      flow: 10,
    };
  }

  /**
   * Observes the room and updates the world state.
   */
  observe(): void {
    const state = new Map<string, boolean>();

    // Check for spawns
    const spawns = this.room.find(FIND_MY_SPAWNS);
    state.set(STATE_HAS_SPAWN, spawns.length > 0);

    // Check spawn energy
    const spawnEnergy = spawns.length > 0 ? spawns[0].store.getUsedCapacity(RESOURCE_ENERGY) : 0;
    state.set(STATE_SPAWN_HAS_ENERGY, spawnEnergy >= 200); // Enough for basic creep

    // Check for sources
    const sources = this.room.find(FIND_SOURCES);
    state.set(STATE_HAS_SOURCE, sources.length > 0);

    // Check for controller
    state.set(STATE_HAS_CONTROLLER, this.room.controller !== undefined);
    state.set(
      STATE_RCL_ABOVE_1,
      (this.room.controller?.level ?? 0) > 1
    );

    // Check for creeps
    const creeps = this.room.find(FIND_MY_CREEPS);
    state.set(STATE_HAS_CREEPS, creeps.length > 0);

    // Check for idle creeps (creeps without busy prefix)
    const idleCreeps = creeps.filter(
      (c) => !c.memory.role?.startsWith("busy")
    );
    state.set(STATE_HAS_IDLE_CREEPS, idleCreeps.length > 0);

    // Check for operations
    state.set(STATE_HAS_BOOTSTRAP_OP, this.operations.has("bootstrap"));
    state.set(STATE_HAS_MINING_OP, this.hasAnyMiningOperation());

    // Check energy income (do we have active harvesters?)
    const harvesters = creeps.filter(
      (c) => c.memory.role === "busyharvester" || c.memory.role === "harvester"
    );
    state.set(STATE_HAS_ENERGY_INCOME, harvesters.length > 0);

    // Check controller progress (is anyone upgrading?)
    state.set(STATE_CONTROLLER_PROGRESSING, this.isControllerBeingUpgraded());

    // Update the agent's world state
    this.worldState = new WorldState(state);
  }

  /**
   * Checks if any mining operation exists.
   */
  private hasAnyMiningOperation(): boolean {
    for (const op of this.operations.values()) {
      if (op instanceof EnergyMining) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if controller is being upgraded.
   */
  private isControllerBeingUpgraded(): boolean {
    if (!this.room.controller) return false;
    // Simplified: check if we have jacks with energy near controller
    const creeps = this.room.find(FIND_MY_CREEPS);
    return creeps.some(
      (c) =>
        c.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
        c.pos.getRangeTo(this.room.controller!.pos) <= 3
    );
  }

  /**
   * Plans and returns the next action to execute.
   */
  plan(): Action | null {
    this.observe();
    return this.selectAction();
  }

  /**
   * Executes an action by creating or running operations.
   */
  execute(action: Action): void {
    // Check if this is an operation creation action
    const factory = this.operationFactories.get(action.name);
    if (factory) {
      const operation = factory();
      if (operation) {
        const opKey = this.getOperationKey(operation);
        this.operations.set(opKey, operation);
        console.log(`[RoomPlanner] Created operation: ${opKey}`);
      }
      return;
    }

    // Otherwise, it's a run action - execute relevant operations
    if (action.name === "runBootstrap") {
      const bootstrap = this.operations.get("bootstrap");
      if (bootstrap) {
        bootstrap.runRoutine(this.room);
      }
    } else if (action.name === "runMining") {
      for (const [key, op] of this.operations) {
        if (op instanceof EnergyMining) {
          op.runRoutine(this.room);
        }
      }
    } else if (action.name === "upgradeController") {
      // Controller upgrade is handled by bootstrap/jack creeps
      const bootstrap = this.operations.get("bootstrap");
      if (bootstrap) {
        bootstrap.runRoutine(this.room);
      }
    }
  }

  /**
   * Runs the full planning cycle: observe, plan, execute.
   */
  run(): void {
    const action = this.plan();
    if (action) {
      console.log(`[RoomPlanner] Selected action: ${action.name}`);
      this.execute(action);
    } else {
      // No action needed - run all operations anyway
      this.runAllOperations();
    }
  }

  /**
   * Runs all operations regardless of planning.
   */
  runAllOperations(): void {
    for (const operation of this.operations.values()) {
      operation.runRoutine(this.room);
    }
  }

  /**
   * Gets a unique key for an operation.
   */
  private getOperationKey(operation: RoomRoutine): string {
    if (operation instanceof Bootstrap) {
      return "bootstrap";
    }
    if (operation instanceof EnergyMining) {
      return `mining_${operation.position.x}_${operation.position.y}`;
    }
    return `operation_${Date.now()}`;
  }

  /**
   * Gets all active operations.
   */
  getOperations(): Map<string, RoomRoutine> {
    return new Map(this.operations);
  }

  /**
   * Gets the current world state for inspection.
   */
  getWorldState(): WorldState {
    return this.worldState;
  }

  /**
   * Serializes the planner state for persistence.
   */
  serialize(): {
    operations: Array<{ key: string; type: string; data: any }>;
  } {
    const operations: Array<{ key: string; type: string; data: any }> = [];

    for (const [key, op] of this.operations) {
      operations.push({
        key,
        type: op.name,
        data: op.serialize(),
      });
    }

    return { operations };
  }

  /**
   * Deserializes the planner state from persistence.
   */
  deserialize(data: { operations: Array<{ key: string; type: string; data: any }> }): void {
    this.operations.clear();

    for (const opData of data.operations) {
      let operation: RoomRoutine | null = null;

      if (opData.type === "bootstrap" && this.room.controller) {
        operation = new Bootstrap(this.room.controller.pos);
        operation.deserialize(opData.data);
      } else if (opData.type === "energy mining" && this.room.controller) {
        operation = new EnergyMining(this.room.controller.pos);
        operation.deserialize(opData.data);
      }

      if (operation) {
        this.operations.set(opData.key, operation);
      }
    }
  }
}

/**
 * Factory to create a RoomPlanner for a room.
 */
export function createRoomPlanner(room: Room): RoomPlanner {
  return new RoomPlanner(room);
}
