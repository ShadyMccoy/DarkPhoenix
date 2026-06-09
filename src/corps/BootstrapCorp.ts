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
  ANTI_DOWNGRADE_MIN_RCL,
  ANTI_DOWNGRADE_SAFE_TICKS,
  ANTI_DOWNGRADE_TRIGGER_TICKS,
  JACK_BODY,
  JACK_COST,
  SPAWN_COOLDOWN
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
  /** Names of anti-downgrade rescue jacks (job 2) */
  emergencyJackNames?: string[];
  lastSpawnAttempt: number;
  /** Tick the last anti-downgrade jack was dispatched */
  lastEmergencyAttempt?: number;
  /** Tick when starvation was first detected (no creeps + low energy) */
  starvationStartTick: number;
}

/**
 * BootstrapCorp keeps a room alive with self-sufficient jack creeps (harvest +
 * deliver/upgrade + recycle) for the two situations the flow economy cannot
 * cover on its own:
 *
 * 1. Starvation fallback (work): when a room has no working creeps it spawns
 *    1-2 jacks to recover, then goes dormant once the flow economy takes over.
 * 2. Anti-downgrade rescue (runAntiDowngrade): at RCL 2+ the flow economy
 *    starves the controller during construction, so when its downgrade timer
 *    runs low a single jack tops the controller back up and recycles itself.
 *
 * Both jobs use the same self-sufficient jack, but they track their creeps
 * separately (creepNames vs emergencyJackNames) so the two lifecycles never
 * interfere. The corp has no contracts and operates outside the market.
 */
export class BootstrapCorp extends Corp {
  /** ID of the spawn this corp uses */
  private spawnId: string;

  /** ID of the source to harvest */
  private sourceId: string;

  /** Names of starvation-fallback jacks (job 1) */
  private creepNames: string[] = [];

  /** Names of anti-downgrade rescue jacks (job 2) */
  private emergencyJackNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt = 0;

  /** Last tick we dispatched an anti-downgrade jack */
  private lastEmergencyAttempt = 0;

  /** Tick when starvation was first detected */
  private starvationStartTick = 0;

  public constructor(nodeId: string, spawnId: string, sourceId: string, customId?: string) {
    super("bootstrap", nodeId, customId);
    this.spawnId = spawnId;
    this.sourceId = sourceId;
  }

  /**
   * Get the spawn position as the corp's location.
   */
  public getPosition(): Position {
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
  public work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter(name => Game.creeps[name]);

    // Get spawn and source
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const source = Game.getObjectById(this.sourceId as Id<Source>);

    if (!spawn || !source) {
      return;
    }

    // Job 2 runs every tick, independent of the starvation-fallback flow below
    // (which has several early returns).
    this.runAntiDowngrade(spawn, source, tick);

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);
    const ourCreepNames = new Set(this.creepNames);
    const otherCreeps = allCreeps.filter(c => !ourCreepNames.has(c.name));

    // Count ACTUAL haulers (workType === "haul") and jacks (our creeps)
    // Don't count upgraders/builders that happen to have CARRY parts
    const actualHaulers = allCreeps.filter(c => c.memory.workType === "haul");
    const jackCount = this.creepNames.filter(n => Game.creeps[n]).length;
    const totalHaulers = actualHaulers.length + jackCount;

    // CRITICAL: If no haulers AND no jacks, bootstrap IMMEDIATELY
    const noHaulers = totalHaulers === 0;

    // Only yield to other corps if they have enough creeps to sustain (3+)
    // If there are just 1-2 struggling creeps, bootstrap should help
    if (otherCreeps.length >= 3 && !noHaulers) {
      this.starvationStartTick = 0;

      // The bootstrap is scaffolding. Only retire the jacks once the flow
      // economy is TRULY self-sufficient - it has both its own miners (flow
      // harvesters) AND haulers, so it can harvest and carry energy on its own.
      // Recycling on haulers alone collapsed the colony when no flow miners had
      // spawned (haulers with nothing to carry). If the flow loses either, the
      // checks above re-activate bootstrap automatically.
      const flowHaulers = actualHaulers.length;
      const flowMiners = otherCreeps.filter(c => c.memory.workType === "harvest").length;
      const flowEstablished = flowMiners >= 1 && flowHaulers >= 1;
      for (const name of this.creepNames) {
        const creep = Game.creeps[name];
        if (!creep || creep.spawning) continue;
        if (flowEstablished) {
          this.recycleJack(creep, spawn);
        } else {
          this.runCreep(creep, spawn, source);
        }
      }
      return;
    }

    // Check for starvation condition: few creeps AND low energy (in room)
    const isStarving = spawn.room.energyAvailable < BOOTSTRAP_ENERGY_THRESHOLD && otherCreeps.length < 3;

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
        console.log(
          `[Bootstrap] Starvation detected, waiting ${BOOTSTRAP_STARVATION_THRESHOLD} ticks before activating`
        );
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
    const shouldSpawn =
      ticksStarving >= BOOTSTRAP_STARVATION_THRESHOLD ||
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
   * Retire a jack: deliver any carried energy, then recycle it at the spawn to
   * recover part of its body cost.
   */
  private recycleJack(creep: Creep, spawn: StructureSpawn): void {
    if (creep.store[RESOURCE_ENERGY] > 0) {
      // Dump remaining energy into the spawn network on the way out.
      if (creep.transfer(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
      }
      return;
    }
    if (creep.pos.isNearTo(spawn)) {
      spawn.recycleCreep(creep);
    } else {
      creep.moveTo(spawn, { visualizePathStyle: { stroke: "#888888" } });
    }
  }

  /**
   * Job 2: rescue the controller from downgrading.
   *
   * While the flow economy is building, it deliberately starves the controller,
   * so its downgrade timer falls. When it drops below the trigger we dispatch a
   * single self-sufficient jack to top the controller back up; once the timer is
   * safe again the jack recycles itself. This is independent of the
   * starvation-fallback jacks (creepNames) and runs at every RCL >= MIN_RCL.
   */
  private runAntiDowngrade(spawn: StructureSpawn, source: Source, tick: number): void {
    this.emergencyJackNames = this.emergencyJackNames.filter(n => Game.creeps[n]);

    const controller = spawn.room.controller;
    if (!controller || !controller.my || controller.level < ANTI_DOWNGRADE_MIN_RCL) {
      return;
    }

    const atRisk = controller.ticksToDowngrade < ANTI_DOWNGRADE_TRIGGER_TICKS;
    const safe = controller.ticksToDowngrade >= ANTI_DOWNGRADE_SAFE_TICKS;

    // Dispatch one rescue jack when the timer is low and none is already on it.
    if (
      atRisk &&
      this.emergencyJackNames.length === 0 &&
      tick - this.lastEmergencyAttempt >= SPAWN_COOLDOWN &&
      !spawn.spawning &&
      spawn.room.energyAvailable >= JACK_COST
    ) {
      const name = `antidowngrade-${this.id.slice(-6)}-${tick}`;
      const result = spawn.spawnCreep(JACK_BODY, name, {
        memory: { corpId: this.id, workType: "upgrade" as const, working: false }
      });
      this.lastEmergencyAttempt = tick;
      if (result === OK) {
        this.emergencyJackNames.push(name);
        this.recordCost(JACK_COST);
      }
    }

    for (const name of this.emergencyJackNames) {
      const creep = Game.creeps[name];
      if (!creep || creep.spawning) continue;
      this.runEmergencyJack(creep, spawn, source, controller, safe);
    }
  }

  /**
   * Behaviour of an anti-downgrade rescue jack: harvest until full, upgrade the
   * controller to push its timer up, and recycle once the timer is safe and the
   * jack has emptied its last load.
   */
  private runEmergencyJack(
    creep: Creep,
    spawn: StructureSpawn,
    source: Source,
    controller: StructureController,
    safe: boolean
  ): void {
    if (safe && creep.store[RESOURCE_ENERGY] === 0) {
      this.recycleJack(creep, spawn);
      return;
    }

    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
    }

    if (creep.memory.working) {
      if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, { range: 3, visualizePathStyle: { stroke: "#ff8888" } });
      }
    } else {
      if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
        creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
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
        working: false
      }
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
  private runCreep(creep: Creep, spawn: StructureSpawn, source: Source): void {
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
        filter: s =>
          (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
          (s as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY) > 0
      }) as StructureSpawn | StructureExtension | null;

      if (target) {
        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
        } else {
          // Record revenue when we successfully transfer
          const transferred = Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY));
          // Very low "revenue" - bootstrap is not about profit
          this.recordRevenue(transferred * 0.001);
        }
      } else {
        // Spawn and extensions are full - put surplus energy into the
        // controller so the colony still makes RCL progress during bootstrap,
        // rather than idling. This makes bootstrap a complete minimal economy.
        const controller = creep.room.controller;
        if (controller && controller.my) {
          if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, { range: 3, visualizePathStyle: { stroke: "#88ff88" } });
          }
        } else if (creep.pos.getRangeTo(spawn) > 3) {
          creep.moveTo(spawn);
        }
      }
    } else {
      // Priority 1: Pick up dropped energy
      const droppedEnergy = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY
      });

      if (droppedEnergy) {
        if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
          creep.moveTo(droppedEnergy, { range: 1, visualizePathStyle: { stroke: "#00ff00" } });
        }
        return;
      }

      // Priority 2: Withdraw from containers with energy
      const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0
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
  public estimateROI(): number {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return 0;

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);
    const ourCreepNames = new Set(this.creepNames);
    const otherCreeps = allCreeps.filter(c => !ourCreepNames.has(c.name));

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
  public shouldActivate(): boolean {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return false;

    const room = spawn.room;
    const allCreeps = room.find(FIND_MY_CREEPS);
    const ourCreepNames = new Set(this.creepNames);
    const otherCreeps = allCreeps.filter(c => !ourCreepNames.has(c.name));

    // Only yield if other corps have enough creeps (3+) to sustain
    if (otherCreeps.length >= 3) return false;

    // If we have bootstrap creeps, continue working (to finish recovery)
    if (this.creepNames.filter(n => Game.creeps[n]).length > 0) {
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
  public getCreepCount(): number {
    return this.creepNames.filter(n => Game.creeps[n]).length;
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedBootstrapCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      sourceId: this.sourceId,
      creepNames: this.creepNames,
      emergencyJackNames: this.emergencyJackNames,
      lastSpawnAttempt: this.lastSpawnAttempt,
      lastEmergencyAttempt: this.lastEmergencyAttempt,
      starvationStartTick: this.starvationStartTick
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedBootstrapCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.emergencyJackNames = data.emergencyJackNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.lastEmergencyAttempt = data.lastEmergencyAttempt || 0;
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

  // Prefer the nearest source by path, but fall back to range if no path is
  // found (e.g. before roads/containers exist, or in restricted terrain).
  // findClosestByPath returning null must not leave the room without a
  // bootstrap economy.
  const source = spawn.pos.findClosestByPath(sources) ?? spawn.pos.findClosestByRange(sources);
  if (!source) return null;

  const nodeId = `${room.name}-bootstrap`;
  return new BootstrapCorp(nodeId, spawn.id, source.id);
}
