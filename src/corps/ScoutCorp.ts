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
import { Offer, Position, createOfferId } from "../market/Offer";
import {
  SCOUT_COST,
  STALE_THRESHOLD,
  MAX_SCOUT_DISTANCE,
  MAX_INTEL_VALUE,
  VALUE_PER_STALE_TICK,
  SCOUT_BUDGET_PER_CYCLE,
  SCOUT_PLANNING_INTERVAL,
} from "./CorpConstants";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";

/**
 * Serialized state specific to ScoutCorp
 */
export interface SerializedScoutCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastPurchaseTick: number;
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

  /** Last tick we purchased scouts in the market */
  private lastPurchaseTick: number = 0;

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
   * Scout buys move-ticks from SpawningCorp at planning intervals.
   *
   * Budget: ~500 energy per planning cycle (every 5000 ticks).
   * At 50 energy per scout, this allows up to 10 scouts per cycle.
   * Only buys if there are stale rooms to explore.
   */
  buys(): Offer[] {
    const currentTick = Game.time;

    // Only buy at planning intervals
    if (currentTick - this.lastPurchaseTick < SCOUT_PLANNING_INTERVAL) {
      return [];
    }

    // Check if there are stale rooms to scout
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    const staleRoomCount = this.countStaleRooms(spawn.room.name);
    if (staleRoomCount === 0) {
      return [];
    }

    // Calculate how many scouts we can buy with budget
    // Budget = 500 energy, scout cost = 50 energy
    const scoutsNeeded = Math.min(staleRoomCount, Math.floor(SCOUT_BUDGET_PER_CYCLE / SCOUT_COST));

    if (scoutsNeeded <= 0) {
      return [];
    }

    // Each scout = 1 MOVE part = 1500 move-ticks (lifetime)
    const moveTicksPerScout = CREEP_LIFETIME;
    const totalMoveTicks = scoutsNeeded * moveTicksPerScout;

    // Price: we're willing to pay up to budget for the scouts
    const pricePerMoveTick = SCOUT_BUDGET_PER_CYCLE / totalMoveTicks;

    // Mark that we've made a purchase request this cycle
    this.lastPurchaseTick = currentTick;

    return [{
      id: createOfferId(this.id, "move-ticks", currentTick),
      corpId: this.id,
      type: "buy",
      resource: "move-ticks",
      quantity: totalMoveTicks,
      price: pricePerMoveTick * totalMoveTicks,
      duration: CREEP_LIFETIME,
      location: this.getPosition()
    }];
  }

  /**
   * Count how many stale rooms are available for scouting.
   */
  private countStaleRooms(startRoom: string): number {
    if (!Memory.roomIntel) {
      Memory.roomIntel = {};
    }

    let staleCount = 0;
    const visited = new Set<string>();
    const queue: { roomName: string; distance: number }[] = [
      { roomName: startRoom, distance: 0 },
    ];
    visited.add(startRoom);

    while (queue.length > 0) {
      const { roomName, distance } = queue.shift()!;

      if (roomName !== startRoom) {
        if (!this.blockedRooms.has(roomName)) {
          const intel = Memory.roomIntel[roomName];
          const age = intel ? Game.time - intel.lastVisit : Infinity;
          if (age >= STALE_THRESHOLD) {
            staleCount++;
          }
        }
      }

      if (distance >= MAX_SCOUT_DISTANCE) continue;

      const exits = Game.map.describeExits(roomName);
      if (!exits) continue;

      for (const direction in exits) {
        const adjacentRoom = exits[direction as ExitKey];
        if (!adjacentRoom) continue;
        if (visited.has(adjacentRoom)) continue;

        const status = Game.map.getRoomStatus(adjacentRoom);
        if (status.status === "closed") continue;

        visited.add(adjacentRoom);
        queue.push({ roomName: adjacentRoom, distance: distance + 1 });
      }
    }

    return staleCount;
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
   * Main work loop - pick up market-spawned scouts and run their behavior.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Pick up any creeps spawned for us by SpawningCorp
    this.pickUpSpawnedCreeps();

    // Get spawn for home room reference
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    // Run creep behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runCreep(creep, spawn.room.name);
      }
    }
  }

  /**
   * Pick up creeps that were spawned by SpawningCorp for this corp.
   * SpawningCorp sets memory.corpId to the buyer's ID.
   * Each scout gets assigned a unique target room.
   */
  private pickUpSpawnedCreeps(): void {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && !this.creepNames.includes(name)) {
        this.creepNames.push(name);

        // Assign a unique target room to this scout
        const target = this.findStaleRoomExcluding(spawn.room.name, this.getAssignedTargets());
        if (target) {
          creep.memory.targetRoom = target;
          console.log(`[Scout] Picked up market-spawned scout ${name}, assigned to ${target}`);
        } else {
          console.log(`[Scout] Picked up market-spawned scout ${name}, no stale rooms available`);
        }
      }
    }
  }

  /**
   * Get list of rooms already assigned to other scouts.
   */
  private getAssignedTargets(): Set<string> {
    const assigned = new Set<string>();
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep?.memory.targetRoom) {
        assigned.add(creep.memory.targetRoom);
      }
    }
    return assigned;
  }

  /**
   * Find a stale room, excluding rooms already assigned to other scouts.
   *
   * TODO: Use the node graph for faster room lookup instead of BFS.
   * The node graph already has room adjacency info and can quickly find
   * the oldest nearby room. Scouts should greedily pick rooms based on
   * staleness, searching from their current position (not spawn).
   */
  private findStaleRoomExcluding(startRoom: string, excludeRooms: Set<string>): string | null {
    if (!Memory.roomIntel) {
      Memory.roomIntel = {};
    }

    const visited = new Set<string>();
    const queue: { roomName: string; distance: number }[] = [
      { roomName: startRoom, distance: 0 },
    ];
    visited.add(startRoom);

    while (queue.length > 0) {
      const { roomName, distance } = queue.shift()!;

      if (roomName !== startRoom) {
        if (this.blockedRooms.has(roomName)) continue;
        if (excludeRooms.has(roomName)) continue;

        const intel = Memory.roomIntel[roomName];
        const age = intel ? Game.time - intel.lastVisit : Infinity;

        if (age >= STALE_THRESHOLD) {
          return roomName;
        }
      }

      if (distance >= MAX_SCOUT_DISTANCE) continue;

      const exits = Game.map.describeExits(roomName);
      if (!exits) continue;

      for (const direction in exits) {
        const adjacentRoom = exits[direction as ExitKey];
        if (!adjacentRoom) continue;
        if (visited.has(adjacentRoom)) continue;

        const status = Game.map.getRoomStatus(adjacentRoom);
        if (status.status === "closed") continue;

        visited.add(adjacentRoom);
        queue.push({ roomName: adjacentRoom, distance: distance + 1 });
      }
    }

    return null;
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
   * Each scout has its own target room stored in memory.
   */
  private runCreep(creep: Creep, homeRoom: string): void {
    const targetRoom = creep.memory.targetRoom as string | undefined;

    // If we're in the target room, record intel and find new target
    if (targetRoom && creep.room.name === targetRoom && targetRoom !== homeRoom) {
      const value = this.recordRoomIntel(creep.room);
      this.recordRevenue(value);
      console.log(`[Scout] ${creep.name} recorded intel for ${targetRoom} (value: ${value.toFixed(2)})`);

      // Find next target from current room, excluding other scouts' targets
      const excludeRooms = this.getAssignedTargets();
      excludeRooms.delete(targetRoom); // Allow reassigning our old target to ourselves
      const newTarget = this.findStaleRoomExcluding(creep.room.name, excludeRooms)
        || this.findStaleRoomExcluding(homeRoom, excludeRooms);

      if (newTarget) {
        creep.memory.targetRoom = newTarget;
      } else {
        // No more stale rooms, return home
        creep.memory.targetRoom = homeRoom;
      }
    }

    // If we have no target or are at target, find one
    const currentTarget = creep.memory.targetRoom as string | undefined;
    if (!currentTarget || currentTarget === creep.room.name) {
      const excludeRooms = this.getAssignedTargets();
      const newTarget = this.findStaleRoomExcluding(homeRoom, excludeRooms);

      if (newTarget) {
        creep.memory.targetRoom = newTarget;
      } else {
        // No stale rooms, just wait
        return;
      }
    }

    // Move toward target room using direct room pathfinding
    const finalTarget = creep.memory.targetRoom as string;
    if (creep.room.name !== finalTarget) {
      const targetPos = new RoomPosition(25, 25, finalTarget);
      const result = creep.moveTo(targetPos, {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 10,
      });
      if (result === ERR_NO_PATH) {
        // Mark room as blocked and find new target
        console.log(`[Scout] ${creep.name} can't reach ${finalTarget}, marking as blocked`);
        this.blockedRooms.add(finalTarget);
        const excludeRooms = this.getAssignedTargets();
        creep.memory.targetRoom = this.findStaleRoomExcluding(homeRoom, excludeRooms) || undefined;
      } else if (result !== OK && result !== ERR_TIRED) {
        console.log(`[Scout] ${creep.name} moveTo failed: ${result}, target: ${finalTarget}`);
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
   * Serialize for persistence.
   */
  serialize(): SerializedScoutCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      creepNames: this.creepNames,
      lastPurchaseTick: this.lastPurchaseTick,
      blockedRooms: Array.from(this.blockedRooms),
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedScoutCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastPurchaseTick = data.lastPurchaseTick || 0;
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
