/**
 * @fileoverview ScoutCorp - Auxiliary corp for room exploration.
 *
 * @module corps/ScoutCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import {
  MAX_INTEL_VALUE,
  MAX_SCOUTS,
  MAX_SCOUT_DISTANCE,
  MIN_SCOUT_RCL,
  SCOUT_SPAWN_COOLDOWN,
  STALE_THRESHOLD,
  VALUE_PER_STALE_TICK
} from "./CorpConstants";
import { Position } from "../types/Position";
import { SpawningCorp } from "./SpawningCorp";
import { isSourceKeeperRoom } from "../utils/RoomDiscovery";
import { travelTo } from "./movement";

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
  private lastPurchaseTick = 0;
  private blockedRooms: Set<string> = new Set();

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("scout", nodeId, customId);
    this.spawnId = spawnId;
  }

  /** The home spawn this corp requests scouts from (kind dispatch needs it). */
  public getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Rebind to the commission's CURRENT spawn. The spawn id is commission-owned
   * state: a persisted corp outlives spawns (measured live: an immortal
   * upgrade/construction corp carried a dead spawn's id for good, so
   * collectDemands dropped its demands forever - 0 upgraders/builders while
   * the plan begged for them). Every kind's materialize() refreshes this.
   */
  public setSpawnId(spawnId: string): void {
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

  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const homeRoom = spawn.room.name;
    const creeps = this.getActiveCreeps();

    // Record intel for EVERY room we currently have vision of - any room in
    // Game.rooms means we see it (a creep there, or we own it), not just rooms a
    // scout creep is visiting. Without this, a remote room we are already MINING
    // never gets its controller recorded until a dedicated scout reaches it, so
    // the planner cannot value its source as reservable (3000) and leaves it at
    // the unreserved 1500. Throttled to rooms whose intel is missing or stale (a
    // continuously-mined room is re-recorded once per STALE_THRESHOLD), so it stays
    // cheap. recordRoomIntel stamps lastVisit, keeping the room fresh in between.
    for (const roomName in Game.rooms) {
      const intel = Memory.roomIntel?.[roomName];
      if (!intel || Game.time - intel.lastVisit >= STALE_THRESHOLD) {
        this.recordRoomIntel(Game.rooms[roomName]);
      }
    }

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
    const queue: { roomName: string; distance: number }[] = [{ roomName: startRoom, distance: 0 }];
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
        // Keepers kill scouts and SK sources are never mined anyway - neither
        // target SK rooms nor route the BFS through them (the lattice is
        // sparse; going around costs one hop).
        if (isSourceKeeperRoom(adjacentRoom)) continue;

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
      console.log(`[Scout] ${creep.name} recorded intel for ${targetRoom} (value: ${value.toFixed(2)})`);

      const excludeRooms = this.getAssignedTargets();
      excludeRooms.delete(targetRoom);
      const newTarget =
        this.findStaleRoomExcluding(creep.room.name, excludeRooms) ||
        this.findStaleRoomExcluding(homeRoom, excludeRooms);

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
      const result = travelTo(creep, targetPos, {
        visualizePathStyle: { stroke: "#00ff00" },
        reusePath: 10
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
    const sourcePositions = sources.map(s => ({ x: s.pos.x, y: s.pos.y }));
    // Real ids, index-aligned with sourcePositions: the node-resource refresh
    // uses them so a source keeps ONE flow id across vision flips (see
    // RoomIntel.sourceIds - the duplicate-miner-after-an-invader fix).
    const sourceIds = sources.map(s => s.id);

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
      sourceIds,
      mineralType,
      mineralPos,
      controllerLevel,
      controllerPos,
      controllerOwner,
      controllerReservation,
      hostileCreepCount: hostileCreeps.length,
      hostileStructureCount: hostileStructures.length,
      isSafe
    };

    // The defund marks belong to the hostileRooms() vision pass (spec 12:
    // stamp / bound / all-clear) and the raid meter to the harvest site
    // (spec 13). A full re-record must carry all of them over - dropping the
    // marks lifted a live defund whenever vision ended the same tick, and
    // dropping the meter would erase up to 130k of raid-debt history.
    if (oldIntel?.hostileUntil !== undefined) {
      Memory.roomIntel[room.name].hostileUntil = oldIntel.hostileUntil;
    }
    if (oldIntel?.invaderReservedUntil !== undefined) {
      Memory.roomIntel[room.name].invaderReservedUntil = oldIntel.invaderReservedUntil;
    }
    if (oldIntel?.raidDebt !== undefined) {
      Memory.roomIntel[room.name].raidDebt = oldIntel.raidDebt;
    }
    if (oldIntel?.lastRaidSeen !== undefined) {
      Memory.roomIntel[room.name].lastRaidSeen = oldIntel.lastRaidSeen;
    }

    return value;
  }

  public getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Check if scouts are needed and queue spawn orders.
   * Returns true if a spawn was requested.
   */
  public requestSpawnsIfNeeded(spawningCorp: SpawningCorp, tick: number): boolean {
    // Check cooldown since last spawn request
    if (tick - this.lastPurchaseTick < SCOUT_SPAWN_COOLDOWN) {
      return false;
    }

    // Check if we have enough scouts. Count both live scouts AND orders already
    // queued by this corp that have not spawned yet - otherwise, while a scout
    // order waits in the spawn queue, every cooldown would queue another one and
    // flood the spawn with duplicate scouts.
    const currentScouts = this.getCreepCount() + spawningCorp.countPendingOrdersFrom(this.id);
    if (currentScouts >= MAX_SCOUTS) {
      return false;
    }

    // Check if there are stale rooms to scout
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return false;

    // Don't scout while the home economy is still bootstrapping. At RCL 1 the
    // room has only 300 energy capacity and a single weak energy carrier, so a
    // 50-energy scout (plus the spawn time it occupies) directly starves the
    // miners/haulers/upgraders needed to reach RCL 2. Scouting is a luxury that
    // must wait until the core economy can sustain it.
    if ((spawn.room.controller?.level ?? 1) < MIN_SCOUT_RCL) {
      return false;
    }

    const homeRoom = spawn.room.name;
    const staleRoom = this.findStaleRoomExcluding(homeRoom, this.getAssignedTargets());
    if (!staleRoom) {
      return false; // No rooms need scouting
    }

    // Spawn directly via the executor. Scouts are tightly gated (RCL >= 2,
    // MAX_SCOUTS, cooldown, stale-room check) so they do not meaningfully
    // compete with the economy; routing them through the value scheduler would
    // add complexity for no benefit.
    const spawned = spawningCorp.executeSpawn("scout", this.id, 50, tick);
    if (!spawned) return false;

    this.lastPurchaseTick = tick;
    console.log(`[Scout] Spawned scout for ${homeRoom}`);
    return true;
  }

  public serialize(): SerializedScoutCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      lastPurchaseTick: this.lastPurchaseTick,
      blockedRooms: Array.from(this.blockedRooms)
    };
  }

  public deserialize(data: SerializedScoutCorp): void {
    super.deserialize(data);
    this.lastPurchaseTick = data.lastPurchaseTick || 0;
    this.blockedRooms = new Set(data.blockedRooms || []);
  }
}
