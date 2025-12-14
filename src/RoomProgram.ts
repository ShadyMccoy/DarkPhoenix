import { forEach, keys, sortBy } from "lodash";

// ============================================================================
// PORTED FROM SANTA BRANCH: Requirements/Outputs Pattern
// Enables explicit resource contracts and performance tracking for routines
// ============================================================================

/**
 * Defines a resource requirement or output for a routine.
 * Used for spawn planning and resource allocation decisions.
 */
export interface ResourceContract {
  type: string;   // e.g., 'energy', 'work', 'carry', 'move', 'cpu'
  size: number;   // Amount required/produced per tick or per run
}

/**
 * Performance record for ROI tracking.
 */
export interface PerformanceRecord {
  tick: number;
  expectedValue: number;
  actualValue: number;
  cost: number;
}

export abstract class RoomRoutine {
  abstract name: string;

  protected _position: RoomPosition;
  protected creepIds: { [role: string]: Id<Creep>[] };
  spawnQueue: { body: BodyPartConstant[], pos: RoomPosition, role: string }[];

  // NEW: Requirements/Outputs pattern from santa branch
  protected requirements: ResourceContract[] = [];
  protected outputs: ResourceContract[] = [];
  protected expectedValue: number = 0;
  protected performanceHistory: PerformanceRecord[] = [];

  constructor(position: RoomPosition, creepIds: { [role: string]: Id<Creep>[] }) {
    this._position = position;
    this.creepIds = creepIds;
    this.spawnQueue = [];
  }

  get position(): RoomPosition {
    return this._position;
  }

  // ============================================================================
  // Requirements/Outputs API
  // ============================================================================

  /**
   * Get the resource requirements for this routine.
   * Override in subclasses to define what the routine needs.
   */
  getRequirements(): ResourceContract[] {
    return this.requirements;
  }

  /**
   * Get the resource outputs for this routine.
   * Override in subclasses to define what the routine produces.
   */
  getOutputs(): ResourceContract[] {
    return this.outputs;
  }

  /**
   * Calculate expected value of running this routine.
   * Override in subclasses for custom valuation.
   */
  protected calculateExpectedValue(): number {
    // Default: sum of output sizes minus sum of requirement sizes
    const outputValue = this.outputs.reduce((sum, o) => sum + o.size, 0);
    const inputCost = this.requirements.reduce((sum, r) => sum + r.size, 0);
    return outputValue - inputCost;
  }

  /**
   * Get the current expected value of this routine.
   */
  getExpectedValue(): number {
    return this.expectedValue;
  }

  // ============================================================================
  // Performance Tracking
  // ============================================================================

  /**
   * Record actual performance for ROI tracking.
   * Call this after routine execution with actual results.
   */
  protected recordPerformance(actualValue: number, cost: number): void {
    this.performanceHistory.push({
      tick: Game.time,
      expectedValue: this.expectedValue,
      actualValue,
      cost
    });

    // Keep only last 100 entries to bound memory usage
    if (this.performanceHistory.length > 100) {
      this.performanceHistory = this.performanceHistory.slice(-100);
    }
  }

  /**
   * Calculate average ROI from performance history.
   * ROI = (actualValue - cost) / cost
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
   * Get performance history for analysis.
   */
  getPerformanceHistory(): PerformanceRecord[] {
    return [...this.performanceHistory];
  }

  // ============================================================================
  // Serialization (enhanced with new fields)
  // ============================================================================

  serialize(): any {
    return {
      name: this.name,
      position: this.position,
      creepIds: this.creepIds,
      requirements: this.requirements,
      outputs: this.outputs,
      expectedValue: this.expectedValue,
      performanceHistory: this.performanceHistory.slice(-20) // Only persist recent history
    };
  }

  deserialize(data: any): void {
    this.name = data.name;
    this._position = new RoomPosition(data.position.x, data.position.y, data.position.roomName);
    this.creepIds = data.creepIds;
    if (data.requirements) this.requirements = data.requirements;
    if (data.outputs) this.outputs = data.outputs;
    if (data.expectedValue) this.expectedValue = data.expectedValue;
    if (data.performanceHistory) this.performanceHistory = data.performanceHistory;
  }

  // ============================================================================
  // Core Routine Lifecycle
  // ============================================================================

  runRoutine(room: Room): void {
    this.RemoveDeadCreeps();
    this.calcSpawnQueue(room);
    this.AddNewlySpawnedCreeps(room);
    this.SpawnCreeps(room);

    // Calculate expected value before running
    this.expectedValue = this.calculateExpectedValue();

    this.routine(room);
  }

  abstract routine(room: Room): void;
  abstract calcSpawnQueue(room: Room): void;

  RemoveDeadCreeps(): void {
    forEach(keys(this.creepIds), (role) => {
      this.creepIds[role] = _.filter(this.creepIds[role], (creepId: Id<Creep>) => {
        return Game.getObjectById(creepId) != null;
      });
    });
  }

  AddNewlySpawnedCreeps(room: Room): void {
    if (this.spawnQueue.length == 0) return;

    forEach(keys(this.creepIds), (role) => {
      let idleCreeps = room.find(FIND_MY_CREEPS, {
        filter: (creep) => {
          return creep.memory.role == role && !creep.spawning;
        }
      });

      if (idleCreeps.length == 0) { return }

      let closestIdleCreep = sortBy(idleCreeps, (creep) => {
        return creep.pos.getRangeTo(this.position);
      })[0];

      this.AddNewlySpawnedCreep(role, closestIdleCreep);
    });
  }

  AddNewlySpawnedCreep(role: string, creep: Creep): void {
    console.log("Adding newly spawned creep to role " + role);
    this.creepIds[role].push(creep.id);
    creep.memory.role = "busy" + role;
  }

  SpawnCreeps(room: Room): void {
    if (this.spawnQueue.length == 0) return;

    let spawns = room.find(FIND_MY_SPAWNS, { filter: spawn => !spawn.spawning });
    if (spawns.length == 0) return;

    spawns = sortBy(spawns, spawn => spawn.pos.getRangeTo(this.position));
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
