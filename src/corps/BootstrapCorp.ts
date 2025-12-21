/**
 * @fileoverview BootstrapCorp - Fallback corp for basic colony operation.
 *
 * BootstrapCorp is the "last resort" corp that activates when nothing else
 * is viable. It creates simple jack creeps (WORK, CARRY, MOVE) that harvest
 * energy and bring it back to the spawn.
 *
 * Design:
 * - Very low ROI (essentially 0) so other corps take priority
 * - Creates minimal creeps to keep the colony alive
 * - Self-sufficient: doesn't depend on other corps
 *
 * @module corps/BootstrapCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";
import {
  JACK_BODY,
  JACK_COST,
  MAX_JACKS,
  SPAWN_COOLDOWN,
} from "./CorpConstants";

/**
 * Serialized state specific to BootstrapCorp
 */
export interface SerializedBootstrapCorp extends SerializedCorp {
  spawnId: string;
  sourceId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
}

/**
 * BootstrapCorp manages simple jack creeps for basic colony operation.
 *
 * This corp:
 * - Spawns jack creeps (WORK, CARRY, MOVE) at lowest priority
 * - Picks up dropped energy from the ground (prioritized if closer)
 * - Harvests energy from the nearest source
 * - Returns energy to the spawn
 * - Self-sufficient, doesn't need other corps
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

  constructor(nodeId: string, spawnId: string, sourceId: string) {
    super("bootstrap", nodeId);
    this.spawnId = spawnId;
    this.sourceId = sourceId;
  }

  /**
   * Bootstrap doesn't sell anything in the market system.
   * It operates outside the normal economic flow.
   */
  sells(): Offer[] {
    return [];
  }

  /**
   * Bootstrap doesn't buy anything in the market system.
   */
  buys(): Offer[] {
    return [];
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

    // Try to spawn if we need more creeps
    if (this.creepNames.length < MAX_JACKS) {
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

    // Check energy
    if (spawn.store[RESOURCE_ENERGY] < JACK_COST) {
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
      // Deliver energy to spawn
      if (spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.transfer(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(spawn, { visualizePathStyle: { stroke: "#ffaa00" } });
        } else {
          // Record revenue when we successfully transfer
          const transferred = Math.min(
            creep.store[RESOURCE_ENERGY],
            spawn.store.getFreeCapacity(RESOURCE_ENERGY)
          );
          // Very low "revenue" - bootstrap is not about profit
          this.recordRevenue(transferred * 0.001);
        }
      } else {
        // Spawn is full - just wait nearby
        if (creep.pos.getRangeTo(spawn) > 3) {
          creep.moveTo(spawn);
        }
      }
    } else {
      // Look for dropped energy on the ground first
      const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });

      // Prioritize picking up dropped energy if it's closer than the source
      if (droppedEnergy) {
        const distToDropped = creep.pos.getRangeTo(droppedEnergy);
        const distToSource = creep.pos.getRangeTo(source);

        // Pick up dropped energy if it's closer or very near
        if (distToDropped <= 1) {
          creep.pickup(droppedEnergy);
          return;
        } else if (distToDropped < distToSource) {
          creep.moveTo(droppedEnergy, { visualizePathStyle: { stroke: "#00ff00" } });
          return;
        }
      }

      // Harvest from source
      if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
    }
  }

  /**
   * Estimate ROI for bootstrap operations.
   * Returns 0 if there are any other creeps in the room (non-bootstrap creeps),
   * allowing other corps to take priority.
   */
  estimateROI(): number {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return 0;

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);

    // Get names of our bootstrap creeps
    const ourCreepNames = new Set(this.creepNames);

    // Check if there are any other creeps (not belonging to this bootstrap)
    const otherCreeps = allCreeps.filter((c) => !ourCreepNames.has(c.name));

    // If there are any other creeps in the room, return 0 ROI
    if (otherCreeps.length > 0) {
      return 0;
    }

    // Very low ROI when we're the only option (but non-zero so we still work)
    return 0.001;
  }

  /**
   * Check if bootstrap should be active.
   * Bootstrap activates when the spawn has less than 300 energy
   * OR when we have no other creeps.
   */
  shouldActivate(): boolean {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return false;

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);

    // Get names of our bootstrap creeps
    const ourCreepNames = new Set(this.creepNames);

    // Check if there are any other creeps (not belonging to this bootstrap)
    const otherCreeps = allCreeps.filter((c) => !ourCreepNames.has(c.name));

    // Don't activate if there are other creeps in the room
    if (otherCreeps.length > 0) return false;

    // Activate if we have no creeps at all
    if (allCreeps.length === 0) return true;

    // Activate if we have less than our target jacks
    if (this.creepNames.filter((n) => Game.creeps[n]).length < MAX_JACKS) {
      return true;
    }

    return false;
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
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedBootstrapCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
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
