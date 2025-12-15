/**
 * @fileoverview Base class for all colony routines.
 *
 * RoomRoutine provides the foundational lifecycle and economic tracking
 * for colony operations. Each routine manages creeps, spawning, and
 * resource contracts using the Requirements/Outputs pattern.
 *
 * ## Lifecycle
 * Every routine follows this execution cycle each tick:
 * 1. RemoveDeadCreeps() - Cleanup dead creep references
 * 2. calcSpawnQueue()   - Determine what needs to spawn
 * 3. AddNewlySpawnedCreeps() - Register newly available creeps
 * 4. SpawnCreeps()      - Execute spawning requests
 * 5. calculateExpectedValue() - Compute economic metrics
 * 6. routine()          - Execute custom routine logic
 *
 * ## Economic Model
 * Routines declare explicit resource contracts:
 * - **Requirements**: What the routine needs (WORK parts, spawn time, etc.)
 * - **Outputs**: What the routine produces (energy, structures, etc.)
 *
 * This enables ROI calculation and market-driven coordination.
 *
 * @module core/RoomRoutine
 */

import { forEach, keys, sortBy } from "lodash";

/**
 * Defines a resource requirement or output for a routine.
 *
 * Used for spawn planning, resource allocation, and ROI calculations.
 *
 * @example
 * // Harvester routine requirements
 * const requirements: ResourceContract[] = [
 *   { type: 'work', size: 2 },      // 2 WORK parts
 *   { type: 'move', size: 1 },      // 1 MOVE part
 *   { type: 'spawn_time', size: 150 } // Spawn time cost
 * ];
 *
 * // Harvester routine outputs
 * const outputs: ResourceContract[] = [
 *   { type: 'energy', size: 10 }    // ~10 energy/tick
 * ];
 */
export interface ResourceContract {
  /** Resource type identifier (e.g., 'energy', 'work', 'carry', 'move', 'cpu') */
  type: string;
  /** Amount required/produced per tick or per run */
  size: number;
}

/**
 * Performance record for ROI tracking.
 *
 * Captures expected vs actual performance to enable adaptive decision-making.
 */
export interface PerformanceRecord {
  /** Game tick when this record was captured */
  tick: number;
  /** Expected value calculated before execution */
  expectedValue: number;
  /** Actual value achieved during execution */
  actualValue: number;
  /** Cost incurred (spawn energy, CPU, etc.) */
  cost: number;
}

/**
 * Abstract base class for colony room routines.
 *
 * Provides creep management, spawning, serialization, and economic tracking.
 * Subclasses implement specific behaviors (mining, construction, logistics).
 *
 * @example
 * class MyRoutine extends RoomRoutine {
 *   name = 'myRoutine';
 *
 *   constructor(pos: RoomPosition) {
 *     super(pos, { worker: [] });
 *     this.requirements = [{ type: 'work', size: 1 }];
 *     this.outputs = [{ type: 'energy', size: 5 }];
 *   }
 *
 *   routine(room: Room): void {
 *     // Custom logic here
 *   }
 *
 *   calcSpawnQueue(room: Room): void {
 *     // Determine what to spawn
 *   }
 * }
 */
export abstract class RoomRoutine {
  /** Unique name identifying this routine type */
  abstract name: string;

  /** Position this routine operates around (e.g., source, controller) */
  protected _position: RoomPosition;

  /** Map of role names to creep IDs assigned to this routine */
  protected creepIds: { [role: string]: Id<Creep>[] };

  /** Queue of creeps waiting to be spawned */
  spawnQueue: { body: BodyPartConstant[]; pos: RoomPosition; role: string }[];

  /** Resource requirements for this routine to operate */
  protected requirements: ResourceContract[] = [];

  /** Resource outputs this routine produces */
  protected outputs: ResourceContract[] = [];

  /** Calculated expected value for current tick */
  protected expectedValue: number = 0;

  /** Historical performance records for ROI analysis */
  protected performanceHistory: PerformanceRecord[] = [];

  /**
   * Creates a new routine instance.
   *
   * @param position - The position this routine operates around
   * @param creepIds - Initial map of role names to assigned creep IDs
   */
  constructor(
    position: RoomPosition,
    creepIds: { [role: string]: Id<Creep>[] }
  ) {
    this._position = position;
    this.creepIds = creepIds;
    this.spawnQueue = [];
  }

  /**
   * Gets the position this routine operates around.
   */
  get position(): RoomPosition {
    return this._position;
  }

  // ============================================================================
  // Requirements/Outputs API
  // ============================================================================

  /**
   * Gets the resource requirements for this routine.
   *
   * Override in subclasses to define what the routine needs to operate.
   *
   * @returns Array of resource contracts defining inputs
   */
  getRequirements(): ResourceContract[] {
    return this.requirements;
  }

  /**
   * Gets the resource outputs for this routine.
   *
   * Override in subclasses to define what the routine produces.
   *
   * @returns Array of resource contracts defining outputs
   */
  getOutputs(): ResourceContract[] {
    return this.outputs;
  }

  /**
   * Calculates expected value of running this routine.
   *
   * Default implementation: sum of outputs - sum of requirements.
   * Override in subclasses for custom valuation logic.
   *
   * @returns Expected value (positive = net gain, negative = net cost)
   */
  protected calculateExpectedValue(): number {
    const outputValue = this.outputs.reduce((sum, o) => sum + o.size, 0);
    const inputCost = this.requirements.reduce((sum, r) => sum + r.size, 0);
    return outputValue - inputCost;
  }

  /**
   * Gets the current expected value of this routine.
   */
  getExpectedValue(): number {
    return this.expectedValue;
  }

  // ============================================================================
  // Performance Tracking
  // ============================================================================

  /**
   * Records actual performance for ROI tracking.
   *
   * Call after routine execution with actual results to build
   * performance history for adaptive decision-making.
   *
   * @param actualValue - The actual value achieved
   * @param cost - The cost incurred
   */
  protected recordPerformance(actualValue: number, cost: number): void {
    this.performanceHistory.push({
      tick: Game.time,
      expectedValue: this.expectedValue,
      actualValue,
      cost,
    });

    // Bound memory usage by keeping only recent history
    if (this.performanceHistory.length > 100) {
      this.performanceHistory = this.performanceHistory.slice(-100);
    }
  }

  /**
   * Calculates average ROI from performance history.
   *
   * ROI = (actualValue - cost) / cost
   *
   * @returns Average ROI across recorded history (0 if no history)
   */
  getAverageROI(): number {
    if (this.performanceHistory.length === 0) return 0;

    const totalROI = this.performanceHistory.reduce((sum, record) => {
      if (record.cost === 0) return sum;
      const roi = (record.actualValue - record.cost) / record.cost;
      return sum + roi;
    }, 0);

    return totalROI / this.performanceHistory.length;
  }

  /**
   * Gets performance history for analysis.
   *
   * @returns Copy of performance history array
   */
  getPerformanceHistory(): PerformanceRecord[] {
    return [...this.performanceHistory];
  }

  // ============================================================================
  // Serialization
  // ============================================================================

  /**
   * Serializes routine state for memory persistence.
   *
   * Override in subclasses to include additional state.
   *
   * @returns Serializable object representing routine state
   */
  serialize(): any {
    return {
      name: this.name,
      position: this.position,
      creepIds: this.creepIds,
      requirements: this.requirements,
      outputs: this.outputs,
      expectedValue: this.expectedValue,
      performanceHistory: this.performanceHistory.slice(-20), // Only persist recent
    };
  }

  /**
   * Restores routine state from serialized data.
   *
   * Override in subclasses to restore additional state.
   *
   * @param data - Serialized state from serialize()
   */
  deserialize(data: any): void {
    this.name = data.name;
    this._position = new RoomPosition(
      data.position.x,
      data.position.y,
      data.position.roomName
    );
    this.creepIds = data.creepIds;
    if (data.requirements) this.requirements = data.requirements;
    if (data.outputs) this.outputs = data.outputs;
    if (data.expectedValue) this.expectedValue = data.expectedValue;
    if (data.performanceHistory)
      this.performanceHistory = data.performanceHistory;
  }

  // ============================================================================
  // Core Routine Lifecycle
  // ============================================================================

  /**
   * Executes the complete routine lifecycle for one tick.
   *
   * This is the main entry point called by the game loop.
   *
   * @param room - The room this routine operates in
   */
  runRoutine(room: Room): void {
    this.RemoveDeadCreeps();
    this.calcSpawnQueue(room);
    this.AddNewlySpawnedCreeps(room);
    this.SpawnCreeps(room);

    // Calculate expected value before running
    this.expectedValue = this.calculateExpectedValue();

    this.routine(room);
  }

  /**
   * Executes the routine's main logic.
   *
   * Must be implemented by subclasses with specific behavior.
   *
   * @param room - The room this routine operates in
   */
  abstract routine(room: Room): void;

  /**
   * Calculates the spawn queue for this routine.
   *
   * Must be implemented by subclasses to determine what creeps to spawn.
   *
   * @param room - The room this routine operates in
   */
  abstract calcSpawnQueue(room: Room): void;

  /**
   * Removes dead creeps from the creepIds tracking.
   *
   * Called at the start of each tick to clean up stale references.
   */
  RemoveDeadCreeps(): void {
    forEach(keys(this.creepIds), (role) => {
      this.creepIds[role] = _.filter(
        this.creepIds[role],
        (creepId: Id<Creep>) => {
          return Game.getObjectById(creepId) != null;
        }
      );
    });
  }

  /**
   * Registers newly spawned creeps that match roles in the spawn queue.
   *
   * Finds idle creeps with matching roles and assigns them to this routine.
   *
   * @param room - The room to search for idle creeps
   */
  AddNewlySpawnedCreeps(room: Room): void {
    if (this.spawnQueue.length == 0) return;

    forEach(keys(this.creepIds), (role) => {
      let idleCreeps = room.find(FIND_MY_CREEPS, {
        filter: (creep) => {
          return creep.memory.role == role && !creep.spawning;
        },
      });

      if (idleCreeps.length == 0) {
        return;
      }

      let closestIdleCreep = sortBy(idleCreeps, (creep) => {
        return creep.pos.getRangeTo(this.position);
      })[0];

      this.AddNewlySpawnedCreep(role, closestIdleCreep);
    });
  }

  /**
   * Registers a single newly spawned creep to this routine.
   *
   * @param role - The role to assign the creep
   * @param creep - The creep to register
   */
  AddNewlySpawnedCreep(role: string, creep: Creep): void {
    console.log("Adding newly spawned creep to role " + role);
    this.creepIds[role].push(creep.id);
    creep.memory.role = "busy" + role;
  }

  /**
   * Attempts to spawn creeps from the spawn queue.
   *
   * Uses the closest available spawn to the routine's position.
   *
   * @param room - The room containing spawns
   */
  SpawnCreeps(room: Room): void {
    if (this.spawnQueue.length == 0) return;

    let spawns = room.find(FIND_MY_SPAWNS, {
      filter: (spawn) => !spawn.spawning,
    });
    if (spawns.length == 0) return;

    spawns = sortBy(spawns, (spawn) => spawn.pos.getRangeTo(this.position));
    let spawn = spawns[0];

    const result = spawn.spawnCreep(
      this.spawnQueue[0].body,
      spawn.name + Game.time,
      { memory: { role: this.spawnQueue[0].role } }
    );

    if (result === OK) {
      this.spawnQueue.shift();
    } else if (result !== ERR_NOT_ENOUGH_ENERGY && result !== ERR_BUSY) {
      console.log(`Spawn failed with error: ${result}, removing from queue`);
      this.spawnQueue.shift();
    }
  }
}
