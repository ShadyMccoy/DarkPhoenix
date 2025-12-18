/**
 * @fileoverview ScoutCorp - Low ROI corp for room exploration.
 *
 * ScoutCorp creates minimal scouts (1 MOVE part) that explore rooms
 * to gather intel. The value comes from updating stale room data.
 *
 * Design:
 * - Very cheap creeps (50 energy for 1 MOVE)
 * - Visits rooms that haven't been seen recently
 * - Records room intel (sources, minerals, hostiles, etc.)
 * - Low ROI based on intel staleness
 *
 * @module corps/ScoutCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";

/** Body for a scout creep: just 1 MOVE = 50 energy */
const SCOUT_BODY: BodyPartConstant[] = [MOVE];

/** Cost of a scout creep */
const SCOUT_COST = 50;

/** Maximum scouts per scout corp */
const MAX_SCOUTS = 1;

/** Ticks between spawn attempts */
const SPAWN_COOLDOWN = 50;

/** How old room intel must be before it's worth updating (ticks) */
const STALE_THRESHOLD = 5000;

/** Maximum distance (in room exits) to search for stale rooms */
const MAX_SCOUT_DISTANCE = 5;

/** Maximum value for updating very old intel */
const MAX_INTEL_VALUE = 10;

/** Value multiplier per tick of staleness */
const VALUE_PER_STALE_TICK = 0.001;

/**
 * Serialized state specific to ScoutCorp
 */
export interface SerializedScoutCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  targetRoom: string | null;
  blockedRooms: string[];
}

/**
 * ScoutCorp manages scout creeps for room exploration.
 *
 * This corp:
 * - Spawns minimal scout creeps (1 MOVE)
 * - Explores nearby rooms that haven't been visited
 * - Records intel about sources, minerals, hostiles, etc.
 * - Earns small revenue based on how stale the intel was
 */
export class ScoutCorp extends Corp {
  /** ID of the spawn this corp uses */
  private spawnId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  /** Current target room for scouting */
  private targetRoom: string | null = null;

  /** Rooms that are blocked/unreachable */
  private blockedRooms: Set<string> = new Set();

  constructor(nodeId: string, spawnId: string) {
    super("scout", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Scout doesn't sell anything in the market system.
   */
  sells(): Offer[] {
    return [];
  }

  /**
   * Scout doesn't buy anything in the market system.
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
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Main work loop - spawn scouts and run their behavior.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get spawn
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    // Try to spawn if we need more scouts
    if (this.creepNames.length < MAX_SCOUTS) {
      this.trySpawn(spawn, tick);
    }

    // Run creep behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runCreep(creep, spawn.room.name);
      }
    }
  }

  /**
   * Attempt to spawn a new scout creep.
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
    if (spawn.store[RESOURCE_ENERGY] < SCOUT_COST) {
      return;
    }

    // Only spawn if we have a stale room to scout
    const target = this.findStaleRoom(spawn.room.name);
    if (!target) {
      return;
    }

    // Generate unique name
    const name = `scout-${this.id.slice(-6)}-${tick}`;

    // Attempt spawn
    const result = spawn.spawnCreep(SCOUT_BODY, name, {
      memory: {
        corpId: this.id,
        workType: "scout" as const,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.targetRoom = target;
      this.recordCost(SCOUT_COST);
      console.log(`[Scout] Spawned ${name} to explore ${target}`);
    }
  }

  /**
   * Find a stale room worth scouting using BFS.
   * Searches outward from the starting room to find the nearest stale room.
   * Returns the closest stale room, or null if none found within range.
   */
  private findStaleRoom(startRoom: string): string | null {
    // Initialize roomIntel if needed
    if (!Memory.roomIntel) {
      Memory.roomIntel = {};
    }

    // BFS to find nearest stale room
    const visited = new Set<string>();
    const queue: { roomName: string; distance: number }[] = [
      { roomName: startRoom, distance: 0 },
    ];
    visited.add(startRoom);

    while (queue.length > 0) {
      const { roomName, distance } = queue.shift()!;

      // Check if this room is stale (skip the start room)
      if (roomName !== startRoom) {
        // Skip blocked rooms
        if (this.blockedRooms.has(roomName)) continue;

        const intel = Memory.roomIntel[roomName];
        const age = intel ? Game.time - intel.lastVisit : Infinity;

        // If this room is stale enough, return it (BFS ensures it's the nearest)
        if (age >= STALE_THRESHOLD) {
          return roomName;
        }
      }

      // Don't expand beyond max distance
      if (distance >= MAX_SCOUT_DISTANCE) continue;

      // Expand to adjacent rooms
      const exits = Game.map.describeExits(roomName);
      if (!exits) continue;

      for (const direction in exits) {
        const adjacentRoom = exits[direction as ExitKey];
        if (!adjacentRoom) continue;
        if (visited.has(adjacentRoom)) continue;

        // Check room status (avoid inaccessible rooms)
        const status = Game.map.getRoomStatus(adjacentRoom);
        if (status.status === "closed") continue;

        visited.add(adjacentRoom);
        queue.push({ roomName: adjacentRoom, distance: distance + 1 });
      }
    }

    return null;
  }

  /**
   * Run behavior for a single scout creep.
   */
  private runCreep(creep: Creep, homeRoom: string): void {
    // If we're in the target room, record intel and find new target
    if (this.targetRoom && creep.room.name === this.targetRoom && this.targetRoom !== homeRoom) {
      const value = this.recordRoomIntel(creep.room);
      this.recordRevenue(value);
      console.log(`[Scout] ${creep.name} recorded intel for ${this.targetRoom} (value: ${value.toFixed(2)})`);

      // Find next target from current room (not just home)
      this.targetRoom = this.findStaleRoom(creep.room.name) || this.findStaleRoom(homeRoom);

      if (!this.targetRoom) {
        // No more stale rooms, return home
        this.targetRoom = homeRoom;
      }
    }

    // If we're home and have no target, find one
    if (!this.targetRoom || this.targetRoom === creep.room.name) {
      this.targetRoom = this.findStaleRoom(homeRoom);

      // If still no target, just wait
      if (!this.targetRoom) {
        return;
      }
    }

    // Move toward target room using direct room pathfinding
    if (creep.room.name !== this.targetRoom) {
      const targetPos = new RoomPosition(25, 25, this.targetRoom);
      const result = creep.moveTo(targetPos, {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 10,
      });
      if (result === ERR_NO_PATH) {
        // Mark room as blocked and find new target
        console.log(`[Scout] ${creep.name} can't reach ${this.targetRoom}, marking as blocked`);
        this.blockedRooms.add(this.targetRoom);
        this.targetRoom = this.findStaleRoom(homeRoom);
      } else if (result !== OK && result !== ERR_TIRED) {
        console.log(`[Scout] ${creep.name} moveTo failed: ${result}, target: ${this.targetRoom}`);
      }
    }
  }

  /**
   * Record intel about a room.
   * Returns the value of the intel based on how stale the old data was.
   */
  private recordRoomIntel(room: Room): number {
    if (!Memory.roomIntel) {
      Memory.roomIntel = {};
    }

    const oldIntel = Memory.roomIntel[room.name];
    const staleness = oldIntel ? Game.time - oldIntel.lastVisit : STALE_THRESHOLD;

    // Calculate value based on staleness
    const value = Math.min(staleness * VALUE_PER_STALE_TICK, MAX_INTEL_VALUE);

    // Gather source info
    const sources = room.find(FIND_SOURCES);
    const sourcePositions = sources.map((s) => ({ x: s.pos.x, y: s.pos.y }));

    // Gather mineral info
    const minerals = room.find(FIND_MINERALS);
    const mineral = minerals[0];
    const mineralType = mineral ? mineral.mineralType : null;
    const mineralPos = mineral ? { x: mineral.pos.x, y: mineral.pos.y } : null;

    // Gather controller info
    const controller = room.controller;
    const controllerLevel = controller ? controller.level : 0;
    const controllerPos = controller ? { x: controller.pos.x, y: controller.pos.y } : null;
    const controllerOwner = controller?.owner?.username ?? null;
    const controllerReservation = controller?.reservation?.username ?? null;

    // Gather hostile info
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES);

    // Determine safety
    const isSafe = hostileCreeps.length === 0 && hostileStructures.length === 0;

    // Record intel
    Memory.roomIntel[room.name] = {
      lastVisit: Game.time,
      sourceCount: sources.length,
      sourcePositions,
      mineralType,
      mineralPos,
      controllerLevel,
      controllerPos,
      controllerOwner,
      controllerReservation,
      hostileCreepCount: hostileCreeps.length,
      hostileStructureCount: hostileStructures.length,
      isSafe,
    };

    return value;
  }

  /**
   * Estimate ROI for scout operations.
   * Returns low ROI so other corps take priority.
   */
  estimateROI(): number {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return 0;

    // Check if there are any stale rooms to scout
    const target = this.findStaleRoom(spawn.room.name);
    if (!target) {
      return 0; // No stale rooms, no value
    }

    // Low but non-zero ROI
    return 0.01;
  }

  /**
   * Get number of active scout creeps.
   */
  getCreepCount(): number {
    return this.creepNames.filter((n) => Game.creeps[n]).length;
  }

  /**
   * Get current target room.
   */
  getTargetRoom(): string | null {
    return this.targetRoom;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedScoutCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      creepNames: this.creepNames,
      lastSpawnAttempt: this.lastSpawnAttempt,
      targetRoom: this.targetRoom,
      blockedRooms: Array.from(this.blockedRooms),
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedScoutCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.targetRoom = data.targetRoom || null;
    this.blockedRooms = new Set(data.blockedRooms || []);
  }
}

/**
 * Create a ScoutCorp for a room.
 */
export function createScoutCorp(room: Room): ScoutCorp | null {
  const spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length === 0) return null;

  const spawn = spawns[0];
  const nodeId = `${room.name}-scout`;
  return new ScoutCorp(nodeId, spawn.id);
}
