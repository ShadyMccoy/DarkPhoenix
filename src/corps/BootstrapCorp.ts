/**
 * @fileoverview BootstrapCorp - Rare fallback for starvation recovery.
 *
 * BootstrapCorp is a last-resort emergency system that ONLY activates when
 * the colony is truly starved (no creeps + low energy for extended time).
 * It creates simple jack creeps (WORK, CARRY, MOVE) to recover the colony.
 *
 * Design:
 * - RARE FALLBACK: Only activates after BOOTSTRAP_STARVATION_THRESHOLD ticks
 *   of starvation (no creeps + low energy)
 * - NO CONTRACTS: Does not participate in the market system
 * - YIELDS IMMEDIATELY: Returns 0 ROI as soon as other corps have creeps
 * - MINIMAL FOOTPRINT: Only spawns 1-2 jacks to recover, then goes dormant
 *
 * @module corps/BootstrapCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import {
  JACK_BODY,
  JACK_COST,
  SPAWN_COOLDOWN,
} from "./CorpConstants";

/**
 * Ticks the spawn must be stuck (no creeps, low energy) before bootstrap activates.
 * This ensures bootstrap is truly a rare fallback, not a regular occurrence.
 */
const BOOTSTRAP_STARVATION_THRESHOLD = 5;

/**
 * Energy threshold below which we consider the spawn potentially starving.
 * Combined with no creeps and time threshold to trigger bootstrap.
 */
const BOOTSTRAP_ENERGY_THRESHOLD = 300;

/**
 * Maximum bootstrap jacks - just 1-2 to recover, not a permanent workforce.
 * Once real corps take over, bootstrap should go dormant.
 */
const BOOTSTRAP_MAX_JACKS = 2;

/**
 * Serialized state specific to BootstrapCorp
 */
export interface SerializedBootstrapCorp extends SerializedCorp {
  spawnId: string;
  sourceId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  /** Tick when starvation was first detected (no creeps + low energy) */
  starvationStartTick: number;
}

/**
 * BootstrapCorp is a rare fallback for starvation recovery.
 *
 * This corp:
 * - ONLY activates after extended starvation (no creeps + low energy for 100+ ticks)
 * - Has NO contracts - operates outside the market system
 * - Spawns minimal jack creeps (1-2) just to recover
 * - Goes dormant immediately when other corps have creeps
 * - Self-sufficient: picks up dropped energy, harvests, delivers to spawn
 */
export class BootstrapCorp extends Corp {
  /** ID of the spawn this corp uses */
  private spawnId: string;

  /** ID of the source to harvest */
  private sourceId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  /** Tick when starvation was first detected */
  private starvationStartTick: number = 0;

  constructor(nodeId: string, spawnId: string, sourceId: string, customId?: string) {
    super("bootstrap", nodeId, customId);
    this.spawnId = spawnId;
    this.sourceId = sourceId;
  }

  /**
   * Get the spawn position as the corp's location.
   */
  getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    // Fallback position
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Main work loop - spawn creeps and run their behavior.
   * Bootstrap only spawns when truly starved (no creeps for a while).
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get spawn and source
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const source = Game.getObjectById(this.sourceId as Id<Source>);

    if (!spawn || !source) {
      return;
    }

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);
    const ourCreepNames = new Set(this.creepNames);
    const otherCreeps = allCreeps.filter((c) => !ourCreepNames.has(c.name));

    // Count ACTUAL haulers (workType === "haul") and jacks (our creeps)
    // Don't count upgraders/builders that happen to have CARRY parts
    const actualHaulers = allCreeps.filter((c) => c.memory.workType === "haul");
    const jackCount = this.creepNames.filter((n) => Game.creeps[n]).length;
    const totalHaulers = actualHaulers.length + jackCount;

    // CRITICAL: If no haulers AND no jacks, bootstrap IMMEDIATELY
    const noHaulers = totalHaulers === 0;

    // Only yield to other corps if they have enough creeps to sustain (3+)
    // If there are just 1-2 struggling creeps, bootstrap should help
    if (otherCreeps.length >= 3 && !noHaulers) {
      this.starvationStartTick = 0;
      // Still run our existing creeps until they die
      for (const name of this.creepNames) {
        const creep = Game.creeps[name];
        if (creep && !creep.spawning) {
          this.runCreep(creep, spawn, source);
        }
      }
      return;
    }

    // Check for starvation condition: few creeps AND low energy (in room)
    const isStarving = spawn.room.energyAvailable < BOOTSTRAP_ENERGY_THRESHOLD &&
                       otherCreeps.length < 3;

    // No haulers = immediate activation, bypass all checks
    if (noHaulers) {
      // Force starvation state to trigger spawn
      if (this.starvationStartTick === 0 || this.starvationStartTick > tick - BOOTSTRAP_STARVATION_THRESHOLD) {
        console.log(`[Bootstrap] No haulers detected! Activating immediately.`);
        this.starvationStartTick = tick - BOOTSTRAP_STARVATION_THRESHOLD - 1;
      }
    } else if (isStarving) {
      // Start or continue starvation timer
      if (this.starvationStartTick === 0) {
        this.starvationStartTick = tick;
        console.log(`[Bootstrap] Starvation detected, waiting ${BOOTSTRAP_STARVATION_THRESHOLD} ticks before activating`);
      }
    } else if (allCreeps.length > 0) {
      // We have bootstrap creeps working, don't reset timer
      // But if spawn has enough energy and our creeps are alive, we're recovering
    } else {
      // Not starving (spawn has energy but no creeps) - give other corps a chance
      this.starvationStartTick = 0;
    }

    // Only spawn if we've been starving long enough
    const ticksStarving = this.starvationStartTick > 0 ? tick - this.starvationStartTick : 0;
    const shouldSpawn = ticksStarving >= BOOTSTRAP_STARVATION_THRESHOLD ||
                        noHaulers ||
                        (this.creepNames.length > 0 && this.creepNames.length < BOOTSTRAP_MAX_JACKS);

    if (shouldSpawn && this.creepNames.length < BOOTSTRAP_MAX_JACKS) {
      this.trySpawn(spawn, tick);
    }

    // Run creep behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runCreep(creep, spawn, source);
      }
    }
  }

  /**
   * Attempt to spawn a new jack creep.
   */
  private trySpawn(spawn: StructureSpawn, tick: number): void {
    // Respect cooldown
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    // Check if spawn is busy
    if (spawn.spawning) {
      return;
    }

    // Check energy (use room energy to include extensions)
    if (spawn.room.energyAvailable < JACK_COST) {
      return;
    }

    // Generate unique name
    const name = `jack-${this.id.slice(-6)}-${tick}`;

    // Attempt spawn
    const result = spawn.spawnCreep(JACK_BODY, name, {
      memory: {
        corpId: this.id,
        workType: "harvest" as const,
        working: false,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(JACK_COST);
      console.log(`[Bootstrap] Spawned ${name}`);
    }
  }

  /**
   * Run behavior for a single jack creep.
   *
   * Simple state machine:
   * - If carrying energy: return to spawn
   * - If empty: go harvest
   */
  private runCreep(
    creep: Creep,
    spawn: StructureSpawn,
    source: Source
  ): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("🔄 harvest");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("⚡ deliver");
    }

    if (creep.memory.working) {
      // Find closest spawn or extension that needs energy
      const target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s) =>
          (s.structureType === STRUCTURE_SPAWN ||
           s.structureType === STRUCTURE_EXTENSION) &&
          (s as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0
      }) as StructureSpawn | StructureExtension | null;

      if (target) {
        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
        } else {
          // Record revenue when we successfully transfer
          const transferred = Math.min(
            creep.store[RESOURCE_ENERGY],
            target.store.getFreeCapacity(RESOURCE_ENERGY)
          );
          // Very low "revenue" - bootstrap is not about profit
          this.recordRevenue(transferred * 0.001);
        }
      } else {
        // Everything full - wait near spawn
        if (creep.pos.getRangeTo(spawn) > 3) {
          creep.moveTo(spawn);
        }
      }
    } else {
      // Priority 1: Pick up dropped energy
      const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });

      if (droppedEnergy) {
        if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
          creep.moveTo(droppedEnergy, { range: 1, visualizePathStyle: { stroke: "#00ff00" } });
        }
        return;
      }

      // Priority 2: Withdraw from containers with energy
      const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: (s) =>
          s.structureType === STRUCTURE_CONTAINER &&
          s.store[RESOURCE_ENERGY] > 0
      }) as StructureContainer | null;

      if (container) {
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(container, { range: 1, visualizePathStyle: { stroke: "#00ff00" } });
        }
        return;
      }

      // Priority 3: Harvest from source (only if no energy to collect)
      if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
    }
  }

  /**
   * Estimate ROI for bootstrap operations.
   * Returns 0 unless we're in a starvation condition - bootstrap should
   * almost never be the preferred option.
   */
  estimateROI(): number {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return 0;

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);
    const ourCreepNames = new Set(this.creepNames);
    const otherCreeps = allCreeps.filter((c) => !ourCreepNames.has(c.name));

    // If other corps have enough creeps (3+), bootstrap has no value
    if (otherCreeps.length >= 3) {
      return 0;
    }

    // If we're not in starvation mode yet, return 0 to let other corps try first
    if (this.starvationStartTick === 0) {
      return 0;
    }

    // Only return a tiny ROI if we're actively recovering from starvation
    // This allows bootstrap to work but yields immediately when other corps can take over
    return 0.0001;
  }

  /**
   * Check if bootstrap should be active.
   * Bootstrap is a rare fallback - only activates after being starved for a while.
   */
  shouldActivate(): boolean {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return false;

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);
    const ourCreepNames = new Set(this.creepNames);
    const otherCreeps = allCreeps.filter((c) => !ourCreepNames.has(c.name));

    // Only yield if other corps have enough creeps (3+) to sustain
    if (otherCreeps.length >= 3) return false;

    // If we have bootstrap creeps, continue working (to finish recovery)
    if (this.creepNames.filter((n) => Game.creeps[n]).length > 0) {
      return true;
    }

    // Only activate if we've been starving long enough
    // The actual starvation tracking happens in work(), this just checks
    // if we're in an active starvation recovery state
    return this.starvationStartTick > 0;
  }

  /**
   * Get number of active jack creeps.
   */
  getCreepCount(): number {
    return this.creepNames.filter((n) => Game.creeps[n]).length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedBootstrapCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      sourceId: this.sourceId,
      creepNames: this.creepNames,
      lastSpawnAttempt: this.lastSpawnAttempt,
      starvationStartTick: this.starvationStartTick,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedBootstrapCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.starvationStartTick = data.starvationStartTick || 0;
  }
}

/**
 * Create a BootstrapCorp for a room.
 *
 * Finds the spawn and nearest source automatically.
 */
export function createBootstrapCorp(room: Room): BootstrapCorp | null {
  const spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length === 0) return null;

  const spawn = spawns[0];
  const sources = room.find(FIND_SOURCES);
  if (sources.length === 0) return null;

  // Find nearest source to spawn
  const source = spawn.pos.findClosestByPath(sources);
  if (!source) return null;

  const nodeId = `${room.name}-bootstrap`;
  return new BootstrapCorp(nodeId, spawn.id, source.id);
}
