/**
 * @fileoverview ScoutCorp - Auxiliary corp for room exploration.
 *
 * @module corps/ScoutCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import {
  STALE_THRESHOLD,
  MAX_SCOUT_DISTANCE,
  MAX_INTEL_VALUE,
  VALUE_PER_STALE_TICK,
  MAX_SCOUTS,
  SCOUT_SPAWN_COOLDOWN,
} from "./CorpConstants";
import { SpawningCorp } from "./SpawningCorp";

/**
 * Serialized state specific to ScoutCorp
 */
export interface SerializedScoutCorp extends SerializedCorp {
  spawnId: string;
  lastPurchaseTick: number;
  blockedRooms: string[];
}

/**
 * ScoutCorp manages scout creeps for room exploration.
 */
export class ScoutCorp extends Corp {
  private spawnId: string;
  private lastPurchaseTick: number = 0;
  private blockedRooms: Set<string> = new Set();

  constructor(nodeId: string, spawnId: string) {
    super("scout", nodeId);
    this.spawnId = spawnId;
  }

  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "scout" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const homeRoom = spawn.room.name;
    const creeps = this.getActiveCreeps();

    for (const creep of creeps) {
      if (!creep.memory.targetRoom) {
        const target = this.findStaleRoomExcluding(homeRoom, this.getAssignedTargets());
        if (target) {
          creep.memory.targetRoom = target;
          console.log(`[Scout] Assigned ${creep.name} to ${target}`);
        }
      }
      this.runCreep(creep, homeRoom);
    }
  }

  private getAssignedTargets(): Set<string> {
    const assigned = new Set<string>();
    for (const creep of this.getActiveCreeps()) {
      if (creep.memory.targetRoom) {
        assigned.add(creep.memory.targetRoom);
      }
    }
    return assigned;
  }

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

  private runCreep(creep: Creep, homeRoom: string): void {
    const targetRoom = creep.memory.targetRoom as string | undefined;

    if (targetRoom && creep.room.name === targetRoom && targetRoom !== homeRoom) {
      const value = this.recordRoomIntel(creep.room);
      this.recordRevenue(value);
      console.log(`[Scout] ${creep.name} recorded intel for ${targetRoom} (value: ${value.toFixed(2)})`);

      const excludeRooms = this.getAssignedTargets();
      excludeRooms.delete(targetRoom);
      const newTarget = this.findStaleRoomExcluding(creep.room.name, excludeRooms)
        || this.findStaleRoomExcluding(homeRoom, excludeRooms);

      if (newTarget) {
        creep.memory.targetRoom = newTarget;
      } else {
        creep.memory.targetRoom = homeRoom;
      }
    }

    const currentTarget = creep.memory.targetRoom as string | undefined;
    if (!currentTarget || currentTarget === creep.room.name) {
      const excludeRooms = this.getAssignedTargets();
      const newTarget = this.findStaleRoomExcluding(homeRoom, excludeRooms);

      if (newTarget) {
        creep.memory.targetRoom = newTarget;
      } else {
        return;
      }
    }

    const finalTarget = creep.memory.targetRoom as string;
    if (creep.room.name !== finalTarget) {
      const targetPos = new RoomPosition(25, 25, finalTarget);
      const result = creep.moveTo(targetPos, {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 10,
      });
      if (result === ERR_NO_PATH) {
        console.log(`[Scout] ${creep.name} can't reach ${finalTarget}, marking as blocked`);
        this.blockedRooms.add(finalTarget);
        const excludeRooms = this.getAssignedTargets();
        creep.memory.targetRoom = this.findStaleRoomExcluding(homeRoom, excludeRooms) || undefined;
      }
    }
  }

  private recordRoomIntel(room: Room): number {
    if (!Memory.roomIntel) {
      Memory.roomIntel = {};
    }

    const oldIntel = Memory.roomIntel[room.name];
    const staleness = oldIntel ? Game.time - oldIntel.lastVisit : STALE_THRESHOLD;
    const value = Math.min(staleness * VALUE_PER_STALE_TICK, MAX_INTEL_VALUE);

    const sources = room.find(FIND_SOURCES);
    const sourcePositions = sources.map((s) => ({ x: s.pos.x, y: s.pos.y }));

    const minerals = room.find(FIND_MINERALS);
    const mineral = minerals[0];
    const mineralType = mineral ? mineral.mineralType : null;
    const mineralPos = mineral ? { x: mineral.pos.x, y: mineral.pos.y } : null;

    const controller = room.controller;
    const controllerLevel = controller ? controller.level : 0;
    const controllerPos = controller ? { x: controller.pos.x, y: controller.pos.y } : null;
    const controllerOwner = controller?.owner?.username ?? null;
    const controllerReservation = controller?.reservation?.username ?? null;

    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES);
    const isSafe = hostileCreeps.length === 0 && hostileStructures.length === 0;

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

  getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Check if scouts are needed and queue spawn orders.
   * Returns true if a spawn was requested.
   */
  requestSpawnsIfNeeded(spawningCorp: SpawningCorp, tick: number): boolean {
    // Check cooldown since last spawn request
    if (tick - this.lastPurchaseTick < SCOUT_SPAWN_COOLDOWN) {
      return false;
    }

    // Check if we have enough scouts
    const currentScouts = this.getCreepCount();
    if (currentScouts >= MAX_SCOUTS) {
      return false;
    }

    // Check if there are stale rooms to scout
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return false;

    const homeRoom = spawn.room.name;
    const staleRoom = this.findStaleRoomExcluding(homeRoom, this.getAssignedTargets());
    if (!staleRoom) {
      return false; // No rooms need scouting
    }

    // Queue spawn order
    spawningCorp.queueSpawnOrder({
      buyerCorpId: this.id,
      creepType: "scout",
      workTicksRequested: 0, // Scouts don't have WORK parts
      queuedAt: tick,
    });

    this.lastPurchaseTick = tick;
    console.log(`[Scout] Requested scout spawn for ${homeRoom}`);
    return true;
  }

  serialize(): SerializedScoutCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      lastPurchaseTick: this.lastPurchaseTick,
      blockedRooms: Array.from(this.blockedRooms),
    };
  }

  deserialize(data: SerializedScoutCorp): void {
    super.deserialize(data);
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
