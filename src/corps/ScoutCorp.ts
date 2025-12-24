/**
 * @fileoverview ScoutCorp - Auxiliary corp for room exploration.
 *
 * ScoutCorp creates minimal scouts (1 MOVE part) that explore rooms
 * to gather intel. The value comes from updating stale room data.
 *
 * NOTE: This is an auxiliary corp - it participates in the market for
 * creep spawning (buys move-ticks) but does NOT participate in the
 * main energy->RCL production chain planned by ChainPlanner.
 *
 * Design:
 * - Very cheap creeps (50 energy for 1 MOVE)
 * - Visits rooms that haven't been seen recently
 * - Records room intel (sources, minerals, hostiles, etc.)
 * - Revenue is internal (intel value), not sold to other corps
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
import {
  Contract,
  CreepSpec,
  isActive,
  canRequestCreep,
  requestCreep,
  replacementsNeeded
} from "../market/Contract";
import { getMarket } from "../market/Market";

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
 *
 * This corp:
 * - Buys move-ticks from SpawningCorp via contracts
 * - Explores nearby rooms that haven't been visited
 * - Records intel about sources, minerals, hostiles, etc.
 * - Earns internal revenue based on how stale the intel was
 */
export class ScoutCorp extends Corp {
  /** ID of the spawn this corp uses */
  private spawnId: string;

  /** Last tick we purchased scouts in the market */
  private lastPurchaseTick: number = 0;

  /** Rooms that are blocked/unreachable */
  private blockedRooms: Set<string> = new Set();

  constructor(nodeId: string, spawnId: string) {
    super("scout", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Get active creeps assigned to this corp from contracts.
   * Reads from buy contracts where we purchased spawning capacity.
   */
  private getActiveCreeps(): Creep[] {
    const market = getMarket();
    const creeps: Creep[] = [];
    const seen = new Set<string>();

    for (const localContract of this.contracts) {
      if (localContract.buyerId !== this.id) continue;
      if (localContract.resource !== "spawning") continue;
      if (!isActive(localContract, Game.time)) continue;

      const contract = market.getContract(localContract.id) ?? localContract;
      for (const creepName of contract.creepIds) {
        if (seen.has(creepName)) continue;
        seen.add(creepName);

        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          creeps.push(creep);
        }
      }
    }

    return creeps;
  }

  /**
   * Scout doesn't sell anything in the market system.
   * Intel value is recorded as internal revenue, not traded.
   */
  sells(): Offer[] {
    return [];
  }

  /**
   * Scout buys spawning capacity from SpawningCorp at planning intervals.
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
    const scoutsNeeded = Math.min(staleRoomCount, Math.floor(SCOUT_BUDGET_PER_CYCLE / SCOUT_COST));

    if (scoutsNeeded <= 0) {
      return [];
    }

    // Each scout = 1 MOVE part = 50 energy
    const totalEnergy = scoutsNeeded * SCOUT_COST;

    // Price: we're willing to pay up to budget for the scouts
    const pricePerEnergy = SCOUT_BUDGET_PER_CYCLE / totalEnergy;

    // Mark that we've made a purchase request this cycle
    this.lastPurchaseTick = currentTick;

    // Creep specification for scouts
    const creepSpec: CreepSpec = {
      role: "scout",
      moveParts: 1
    };

    return [{
      id: createOfferId(this.id, "spawning", currentTick),
      corpId: this.id,
      type: "buy",
      resource: "spawning",
      quantity: totalEnergy,
      price: pricePerEnergy * totalEnergy,
      duration: CREEP_LIFETIME,
      location: this.getPosition(),
      creepSpec
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
   * @deprecated Use execute() for contract-driven execution
   */
  work(tick: number): void {
    this.execute(this.contracts, tick);
  }

  /**
   * Execute work to fulfill contracts.
   * Contracts drive the work - creeps assigned to contracts do scouting.
   */
  execute(contracts: Contract[], tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const homeRoom = spawn.room.name;
    const market = getMarket();

    // Get buy contracts for spawning (we buy from SpawningCorp)
    const buyContracts = contracts.filter(
      c => c.buyerId === this.id && c.resource === "spawning" && isActive(c, tick)
    );

    // Execute scouting for creeps assigned to our buy contracts
    for (const contract of buyContracts) {
      const marketContract = market.getContract(contract.id) ?? contract;

      // Request creeps using the option mechanism
      this.requestCreepsForContract(marketContract);

      for (const creepName of marketContract.creepIds) {
        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          // Assign target room if not set
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
    }
  }

  /**
   * Request creeps from a spawn contract using the option mechanism.
   */
  private requestCreepsForContract(contract: Contract): void {
    if (contract.creepIds.length === 0 && canRequestCreep(contract)) {
      requestCreep(contract);
      return;
    }

    const numReplacements = replacementsNeeded(contract, (creepId) => {
      const creep = Game.creeps[creepId];
      return creep?.ticksToLive;
    });

    for (let i = 0; i < numReplacements; i++) {
      if (!requestCreep(contract)) break;
    }
  }

  /**
   * Get list of rooms already assigned to other scouts.
   */
  private getAssignedTargets(): Set<string> {
    const assigned = new Set<string>();
    for (const creep of this.getActiveCreeps()) {
      if (creep.memory.targetRoom) {
        assigned.add(creep.memory.targetRoom);
      }
    }
    return assigned;
  }

  /**
   * Find a stale room, excluding rooms already assigned to other scouts.
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
   */
  private findStaleRoom(startRoom: string): string | null {
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
   * Run behavior for a single scout creep.
   */
  private runCreep(creep: Creep, homeRoom: string): void {
    const targetRoom = creep.memory.targetRoom as string | undefined;

    // If we're in the target room, record intel and find new target
    if (targetRoom && creep.room.name === targetRoom && targetRoom !== homeRoom) {
      const value = this.recordRoomIntel(creep.room);
      this.recordRevenue(value);
      console.log(`[Scout] ${creep.name} recorded intel for ${targetRoom} (value: ${value.toFixed(2)})`);

      // Find next target from current room
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

    // If we have no target or are at target, find one
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

    // Move toward target room
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

  /**
   * Record intel about a room.
   */
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

  /**
   * Estimate ROI for scout operations.
   */
  estimateROI(): number {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return 0;

    const target = this.findStaleRoom(spawn.room.name);
    if (!target) return 0;

    return 0.01;
  }

  /**
   * Get number of active scout creeps from contracts.
   */
  getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedScoutCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      lastPurchaseTick: this.lastPurchaseTick,
      blockedRooms: Array.from(this.blockedRooms),
    };
  }

  /**
   * Deserialize from persistence.
   */
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
