/**
 * @fileoverview Scout routine for world exploration.
 *
 * The Scout routine manages cheap MOVE-only creeps that explore
 * neighboring rooms, allowing the AI to extend its knowledge graph
 * beyond the home colony.
 *
 * ## Purpose
 * - Explore neighboring rooms to extend the skeleton graph
 * - Discover resources, threats, and expansion opportunities
 * - Low-priority operation that doesn't interfere with main colony
 *
 * ## Creep Role: Scout
 * - Body: [MOVE] (can be scaled with more MOVE parts)
 * - Cost: 50 energy per MOVE part
 * - Quantity: 1 (maintained)
 *
 * ## Behavior
 * 1. Find unexplored or least-recently-visited adjacent rooms
 * 2. Move to room exit
 * 3. Enter neighboring room
 * 4. Record room data in memory
 * 5. Continue to next unexplored room
 *
 * @module routines/Scout
 */

import { RoomRoutine } from "../core/RoomRoutine";

/** Minimum RCL required before scouts are spawned */
const MIN_RCL_FOR_SCOUTS = 3;

/** Time in ticks before a room is considered "stale" and worth revisiting */
const ROOM_STALE_TICKS = 10000;

/**
 * Scout routine for world exploration.
 *
 * Spawns and manages scout creeps to explore the world.
 *
 * @example
 * const scout = new Scout(room.controller.pos);
 * scout.runRoutine(room);
 */
export class Scout extends RoomRoutine {
  name = "scout";

  /** Current target room for scouting */
  private targetRoom: string | null = null;

  /**
   * Creates a new Scout routine.
   *
   * @param pos - Position to operate around (typically the spawn or controller)
   */
  constructor(pos: RoomPosition) {
    super(pos, { scout: [] });
    // Low priority - minimal requirements
    this.requirements = [{ type: "move", size: 1 }];
    this.outputs = [{ type: "intel", size: 1 }];
  }

  /**
   * Main scout logic executed each tick.
   *
   * Directs scout creeps to explore neighboring rooms.
   *
   * @param room - The home room
   */
  routine(room: Room): void {
    const scouts = this.creepIds.scout
      .map((id) => Game.getObjectById(id))
      .filter((scout): scout is Creep => scout != null);

    scouts.forEach((scout) => {
      this.runScout(scout, room);
    });
  }

  /**
   * Runs the logic for a single scout creep.
   *
   * @param scout - The scout creep
   * @param homeRoom - The home room
   */
  private runScout(scout: Creep, homeRoom: Room): void {
    // Initialize scout memory if needed
    if (!scout.memory.scoutTarget) {
      scout.memory.scoutTarget = this.findNextTarget(homeRoom) ?? undefined;
    }

    const targetRoomName = scout.memory.scoutTarget;

    // If no target, wait
    if (!targetRoomName) {
      scout.say("idle");
      return;
    }

    // If we're in the target room, record intel and find next target
    if (scout.room.name === targetRoomName) {
      this.recordRoomIntel(scout.room);
      scout.say("intel");

      // Find next target
      scout.memory.scoutTarget = this.findNextTarget(homeRoom) ?? undefined;
      return;
    }

    // Move toward target room
    const exitDir = Game.map.findExit(scout.room, targetRoomName);
    if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) {
      // Can't reach target, find new one
      scout.memory.scoutTarget = this.findNextTarget(homeRoom) ?? undefined;
      return;
    }

    const exit = scout.pos.findClosestByPath(exitDir);
    if (exit) {
      scout.say(">" + targetRoomName.slice(-2));
      scout.moveTo(exit, { reusePath: 20 });
    }
  }

  /**
   * Finds the next room to scout.
   *
   * Prioritizes:
   * 1. Completely unexplored rooms
   * 2. Rooms not visited in a long time
   * 3. Closest rooms first
   *
   * @param homeRoom - The home room to scout from
   * @returns Room name to scout, or null if none available
   */
  private findNextTarget(homeRoom: Room): string | null {
    // Get adjacent rooms
    const exits = Game.map.describeExits(homeRoom.name);
    if (!exits) return null;

    const adjacentRooms = Object.values(exits);

    // Initialize room intel memory if needed
    if (!Memory.roomIntel) {
      Memory.roomIntel = {};
    }

    // Score rooms by exploration priority
    const scored = adjacentRooms.map((roomName) => {
      const intel = Memory.roomIntel[roomName];
      let score = 0;

      if (!intel) {
        // Never explored - highest priority
        score = 1000;
      } else {
        // Score based on staleness
        const ticksSinceVisit = Game.time - (intel.lastVisit || 0);
        score = Math.min(ticksSinceVisit / ROOM_STALE_TICKS, 1) * 100;
      }

      return { roomName, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Return highest priority room that has some score
    const best = scored.find((s) => s.score > 0);
    return best ? best.roomName : null;
  }

  /**
   * Records intelligence data about a room.
   *
   * @param room - The room to record
   */
  private recordRoomIntel(room: Room): void {
    if (!Memory.roomIntel) {
      Memory.roomIntel = {};
    }

    const sources = room.find(FIND_SOURCES);
    const minerals = room.find(FIND_MINERALS);
    const controller = room.controller;
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    const hostileStructures = room.find(FIND_HOSTILE_STRUCTURES);

    Memory.roomIntel[room.name] = {
      lastVisit: Game.time,
      sourceCount: sources.length,
      sourcePositions: sources.map((s) => ({ x: s.pos.x, y: s.pos.y })),
      mineralType: minerals[0]?.mineralType || null,
      mineralPos: minerals[0]
        ? { x: minerals[0].pos.x, y: minerals[0].pos.y }
        : null,
      controllerLevel: controller?.level || 0,
      controllerOwner: controller?.owner?.username || null,
      controllerReservation: controller?.reservation?.username || null,
      hostileCreepCount: hostileCreeps.length,
      hostileStructureCount: hostileStructures.length,
      isSafe: hostileCreeps.length === 0 && hostileStructures.length === 0,
    };

    console.log(
      `[Scout] Recorded intel for ${room.name}: ${sources.length} sources, ` +
        `controller ${controller?.level || "none"}, ` +
        `${hostileCreeps.length} hostiles`
    );
  }

  /**
   * Calculates spawn queue for scout creeps.
   *
   * Only spawns scouts after reaching MIN_RCL_FOR_SCOUTS.
   * Maintains 1 scout creep.
   *
   * @param room - The room to spawn in
   */
  calcSpawnQueue(room: Room): void {
    const spawns = room.find(FIND_MY_SPAWNS);
    const spawn = spawns[0];
    if (!spawn) return;

    this.spawnQueue = [];

    // Don't spawn scouts until we have basic infrastructure
    if (!room.controller || room.controller.level < MIN_RCL_FOR_SCOUTS) {
      return;
    }

    // Maintain 1 scout
    if (this.creepIds.scout.length < 1) {
      this.spawnQueue.push({
        body: [MOVE, MOVE, MOVE, MOVE, MOVE], // 5 MOVE = 250 energy, fast scout
        pos: spawn.pos,
        role: "scout",
      });
    }
  }

  /**
   * Serializes routine state for memory persistence.
   */
  serialize(): any {
    return {
      ...super.serialize(),
      targetRoom: this.targetRoom,
    };
  }

  /**
   * Restores routine state from serialized data.
   */
  deserialize(data: any): void {
    super.deserialize(data);
    if (data.targetRoom) this.targetRoom = data.targetRoom;
  }
}
