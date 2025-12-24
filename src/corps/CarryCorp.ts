/**
 * @fileoverview CarryCorp - Manages hauler creeps.
 *
 * CarryCorp is a transport service that moves energy from sources to destinations.
 * Hauling demand is determined by contracts:
 * - Buys energy from HarvestCorp (pickup at source locations)
 * - Sells delivered-energy to UpgradingCorp/SpawningCorp (deliver to their locations)
 *
 * The carry capacity needed is derived from contract quantities and distances.
 *
 * @module corps/CarryCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position } from "../market/Offer";
import { CREEP_LIFETIME, PLANNING_EPOCH } from "../planning/EconomicConstants";
import { HaulingCorpState } from "./CorpState";
import { projectHauling } from "../planning/projections";
import {
  Contract,
  isActive,
  canRequestCreep,
  requestCreep,
  replacementsNeeded
} from "../market/Contract";
import { getMarket } from "../market/Market";

/** Transport fee per energy unit (base cost before margin) */
const TRANSPORT_FEE_PER_ENERGY = 0.05;

/** Default carry capacity per hauler for planning */
const DEFAULT_CARRY_CAPACITY = 200;

/** Average round-trip distance estimate when no contracts exist */
const DEFAULT_ROUND_TRIP = 40;

/**
 * Serialized state specific to CarryCorp
 */
export interface SerializedCarryCorp extends SerializedCorp {
  spawnId: string;
}

/**
 * CarryCorp manages hauler creeps that move energy around.
 *
 * Hauling demand is derived from contracts:
 * - Energy contracts tell us how much to move
 * - Contract travelTime tells us distance
 * - targetHaulers = total energy / (capacity × deliveries per epoch)
 */
export class CarryCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  constructor(nodeId: string, spawnId: string) {
    super("hauling", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Get all creeps assigned to this corp via contracts.
   * Creeps are tracked in contract.creepIds where this corp is the buyer.
   */
  private getAssignedCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const contract of this.contracts) {
      if (contract.buyerId === this.id) {
        for (const creepId of contract.creepIds) {
          const creep = Game.creeps[creepId];
          if (creep) {
            creeps.push(creep);
          }
        }
      }
    }
    return creeps;
  }

  /**
   * Hauling corp sells delivered-energy (the transport service).
   *
   * Delegates to projectHauling() for unified offer calculation.
   * Provides actual creep data via toCorpState() for runtime accuracy.
   */
  sells(): Offer[] {
    const state = this.toCorpState();
    const projection = projectHauling(state, Game.time);
    return projection.sells;
  }

  /**
   * Convert current runtime state to HaulingCorpState for projection.
   * Bridges runtime (actual creeps) to planning model (CorpState).
   */
  toCorpState(): HaulingCorpState {
    // Calculate actual carry capacity and TTL from live creeps
    const creeps = this.getAssignedCreeps();
    let actualCarryCapacity = 0;
    let actualTotalTTL = 0;

    for (const creep of creeps) {
      actualCarryCapacity += creep.store.getCapacity();
      actualTotalTTL += creep.ticksToLive ?? CREEP_LIFETIME;
    }

    // Get spawn position
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const spawnPosition = spawn
      ? { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName }
      : null;

    // Determine source and destination positions from contracts
    const sourcePos = this.getPickupPosition() ?? spawnPosition ?? this.getPosition();
    const destPos = this.getDeliveryPosition() ?? spawnPosition ?? this.getPosition();

    return {
      id: this.id,
      type: "hauling",
      nodeId: this.nodeId,
      miningCorpId: "mining-" + this.nodeId, // Placeholder - should be set properly
      spawningCorpId: this.spawnId,
      sourcePosition: sourcePos,
      destinationPosition: destPos,
      carryCapacity: DEFAULT_CARRY_CAPACITY,
      spawnPosition,
      // Runtime fields for actual creep data
      actualCarryCapacity,
      actualTotalTTL,
      activeCreepCount: creeps.length,
      // Economic state from Corp base class
      balance: this.balance,
      totalRevenue: this.totalRevenue,
      totalCost: this.totalCost,
      createdAt: this.createdAt,
      isActive: this.isActive,
      lastActivityTick: this.lastActivityTick,
      unitsProduced: this.unitsProduced,
      expectedUnitsProduced: this.expectedUnitsProduced,
      unitsConsumed: this.unitsConsumed,
      acquisitionCost: this.acquisitionCost,
      lastPlannedTick: this.lastPlannedTick,
      contracts: this.contracts
    };
  }

  /**
   * Get pickup position from contracts (where we buy energy).
   * Falls back to first source in room.
   */
  private getPickupPosition(): Position | null {
    // Look for energy contracts where we're the buyer
    for (const contract of this.contracts) {
      if (contract.buyerId === this.id && contract.resource === "energy") {
        // Contract has travelTime but not position - use room sources as fallback
        break;
      }
    }

    // Fallback: find sources in our room
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      const sources = spawn.room.find(FIND_SOURCES);
      if (sources.length > 0) {
        return { x: sources[0].pos.x, y: sources[0].pos.y, roomName: spawn.room.name };
      }
    }
    return null;
  }

  /**
   * Get delivery position from contracts (where we sell delivered-energy).
   * Falls back to controller or spawn.
   */
  private getDeliveryPosition(): Position | null {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return null;

    // Prefer controller if available (upgraders need energy there)
    const controller = spawn.room.controller;
    if (controller) {
      return { x: controller.pos.x, y: controller.pos.y, roomName: controller.pos.roomName };
    }

    return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
  }

  /**
   * Calculate target haulers from contracts.
   * Based on total energy to move and average round-trip distance.
   */
  private getTargetHaulers(): number {
    // Sum energy from all active energy contracts
    let totalEnergy = 0;
    let avgTravelTime = DEFAULT_ROUND_TRIP;
    let contractCount = 0;

    for (const contract of this.contracts) {
      if (contract.resource === "energy" && isActive(contract, Game.time)) {
        totalEnergy += contract.quantity;
        if (contract.travelTime > 0) {
          avgTravelTime = contract.travelTime;
          contractCount++;
        }
      }
    }

    if (totalEnergy === 0) {
      return 1; // Minimum 1 hauler
    }

    // Each hauler can do: capacity × (epoch / roundTripTime) deliveries
    const roundTrip = avgTravelTime * 2;
    const deliveriesPerEpoch = Math.floor(PLANNING_EPOCH / roundTrip);
    const energyPerHauler = DEFAULT_CARRY_CAPACITY * deliveriesPerEpoch;

    return Math.max(1, Math.ceil(totalEnergy / energyPerHauler));
  }

  /**
   * Plan hauling operations. No-op since demand comes from contracts.
   */
  plan(tick: number): void {
    super.plan(tick);
    // Hauling demand is derived from contracts in getTargetHaulers()
  }

  /**
   * Carry corp buys energy and spawn-capacity.
   *
   * Delegates to projectHauling() for unified offer calculation.
   */
  buys(): Offer[] {
    const state = this.toCorpState();
    const projection = projectHauling(state, Game.time);
    return projection.buys;
  }

  /**
   * Get transport cost per energy unit based on actual operations.
   */
  getTransportCostPerEnergy(): number {
    if (this.unitsProduced === 0) return TRANSPORT_FEE_PER_ENERGY;
    // Operating cost = total cost - acquisition cost (just our creep/movement costs)
    const operatingCost = this.totalCost - this.acquisitionCost;
    return operatingCost / this.unitsProduced;
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
    // Legacy - delegates to execute with contracts from this.contracts
    this.execute(this.contracts, tick);
  }

  /**
   * Execute work to fulfill contracts.
   * Contracts drive the work - creeps assigned to contracts do hauling.
   */
  execute(contracts: Contract[], tick: number): void {
    this.lastActivityTick = tick;

    // Get spawn for room reference
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      return;
    }

    const room = spawn.room;
    const market = getMarket();

    // Get buy contracts for spawning (we buy from SpawningCorp)
    const buyContracts = contracts.filter(
      c => c.buyerId === this.id && c.resource === "spawning" && isActive(c, tick)
    );

    // Execute hauling for creeps assigned to our buy contracts
    for (const contract of buyContracts) {
      // Get the market's authoritative contract copy
      const marketContract = market.getContract(contract.id) ?? contract;

      // Request creeps using the option mechanism
      this.requestCreepsForContract(marketContract);

      for (const creepName of marketContract.creepIds) {
        const creep = Game.creeps[creepName];
        if (creep && !creep.spawning) {
          this.runHauler(creep, room, spawn);
        }
      }
    }
  }

  /**
   * Request creeps from a spawn contract using the option mechanism.
   * Requests initial creeps or replacements for dying creeps.
   */
  private requestCreepsForContract(contract: Contract): void {
    // If we have no creeps yet, request initial creep
    if (contract.creepIds.length === 0 && canRequestCreep(contract)) {
      requestCreep(contract);
      return;
    }

    // Check if any creeps need replacements based on TTL vs travel time
    const numReplacements = replacementsNeeded(contract, (creepId) => {
      const creep = Game.creeps[creepId];
      return creep?.ticksToLive;
    });

    for (let i = 0; i < numReplacements; i++) {
      if (!requestCreep(contract)) break;
    }
  }

  /**
   * Run behavior for a hauler creep.
   *
   * State machine:
   * - If empty: find dropped energy and pick it up
   * - If carrying: deliver to spawn (if not full) or controller area
   *
   * Opportunistic: always pick up nearby dropped energy if we have capacity
   */
  private runHauler(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("deliver");
    }

    // Opportunistic: pick up nearby dropped energy while delivering
    if (creep.memory.working && creep.store.getFreeCapacity() > 0) {
      const nearbyDropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY,
      });
      if (nearbyDropped.length > 0) {
        creep.pickup(nearbyDropped[0]);
      }
    }

    if (creep.memory.working) {
      // Deliver energy
      this.deliverEnergy(creep, room, spawn);
    } else {
      // Pick up energy
      this.pickupEnergy(creep, room);
    }
  }

  /**
   * Pick up energy from the ground or containers.
   */
  private pickupEnergy(creep: Creep, room: Room): void {
    // First try dropped energy (pick up any amount)
    const dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY,
    });

    if (dropped.length > 0) {
      const target = creep.pos.findClosestByPath(dropped);
      if (target) {
        const result = creep.pickup(target);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // Then try containers
    const containers = room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
    }) as StructureContainer[];

    if (containers.length > 0) {
      const target = creep.pos.findClosestByPath(containers);
      if (target) {
        const result = creep.withdraw(target, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
    }

    // If nothing to pick up, move towards sources (where miners drop)
    const sources = room.find(FIND_SOURCES);
    if (sources.length > 0) {
      const source = creep.pos.findClosestByPath(sources);
      if (source && creep.pos.getRangeTo(source) > 3) {
        creep.moveTo(source, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
    }
  }

  /**
   * Deliver energy to spawn or directly to upgraders.
   */
  private deliverEnergy(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // Priority 1: Fill spawn and extensions
    const spawnStructures = room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        (s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION) &&
        (s as StructureSpawn | StructureExtension).store.getFreeCapacity(
          RESOURCE_ENERGY
        ) > 0,
    });

    if (spawnStructures.length > 0) {
      const target = creep.pos.findClosestByPath(spawnStructures);
      if (target) {
        const result = creep.transfer(target, RESOURCE_ENERGY);
        if (result === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
        } else if (result === OK) {
          // Track energy delivered for marginal cost calculation
          const transferred = Math.min(
            creep.store[RESOURCE_ENERGY],
            (target as StructureSpawn | StructureExtension).store.getFreeCapacity(RESOURCE_ENERGY)
          );
          this.recordProduction(transferred);
        }
        return;
      }
    }

    // Priority 2: Transfer directly to upgraders (prioritize the one with most free capacity)
    const upgraders = room.find(FIND_MY_CREEPS, {
      filter: (c) =>
        c.memory.workType === "upgrade" &&
        c.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });

    if (upgraders.length > 0) {
      // Sort by free capacity (descending) to prioritize upgraders that need energy most
      upgraders.sort(
        (a, b) =>
          b.store.getFreeCapacity(RESOURCE_ENERGY) -
          a.store.getFreeCapacity(RESOURCE_ENERGY)
      );
      const target = upgraders[0];
      const result = creep.transfer(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else if (result === OK) {
        // Track energy delivered
        const transferred = Math.min(
          creep.store[RESOURCE_ENERGY],
          target.store.getFreeCapacity(RESOURCE_ENERGY)
        );
        this.recordProduction(transferred);
      }
      return;
    }

    // Priority 3: If no upgraders need energy, drop near controller
    if (room.controller) {
      if (creep.pos.getRangeTo(room.controller) <= 3) {
        const dropped = creep.store[RESOURCE_ENERGY];
        creep.drop(RESOURCE_ENERGY);
        this.recordProduction(dropped);
      } else {
        creep.moveTo(room.controller, {
          visualizePathStyle: { stroke: "#ffffff" },
        });
      }
    }
  }

  /**
   * Get number of active hauler creeps.
   */
  getCreepCount(): number {
    return this.getAssignedCreeps().length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedCarryCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedCarryCorp): void {
    super.deserialize(data);
    // spawnId is set in constructor, no additional state to restore
  }
}

/**
 * Create a CarryCorp for a room.
 */
export function createCarryCorp(
  room: Room,
  spawn: StructureSpawn
): CarryCorp {
  const nodeId = `${room.name}-hauling`;
  return new CarryCorp(nodeId, spawn.id);
}
