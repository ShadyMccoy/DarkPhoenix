/**
 * @fileoverview RealHaulingCorp - Manages actual hauler creeps.
 *
 * Haulers pick up dropped energy from mining sites and deliver it
 * to spawns (for energy) and the controller area (for upgraders).
 *
 * @module corps/RealHaulingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId, HAUL_PER_CARRY } from "../market/Offer";
import { analyzeSource, getMinableSources } from "../analysis/SourceAnalysis";
import { buildHaulerBody, HaulerBodyResult } from "../spawn/BodyBuilder";
import { SourceMine } from "../types/SourceMine";
import { CREEP_LIFETIME, CARRY_CAPACITY } from "../planning/EconomicConstants";
import { HaulingCorpState } from "./CorpState";
import { projectHauling } from "../planning/projections";

/** Transport fee per energy unit (base cost before margin) */
const TRANSPORT_FEE_PER_ENERGY = 0.05;

/** Default carry capacity for planning */
const DEFAULT_CARRY_CAPACITY = 200;

/**
 * Serialized state specific to RealHaulingCorp
 */
export interface SerializedRealHaulingCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  sourceData: { sourceId: string; flow: number; distanceToSpawn: number }[];
  lastAcquisitionPrice: number;
  targetHaulers: number;
}

/**
 * RealHaulingCorp manages hauler creeps that move energy around.
 *
 * Haulers:
 * - Pick up dropped energy from the ground
 * - Deliver to spawn if spawn needs energy
 * - Otherwise deliver near controller for upgraders
 *
 * Body composition is dynamically calculated based on:
 * - Energy flow rate from sources
 * - Distance from sources to spawn (round-trip time)
 */
export class RealHaulingCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Names of creeps owned by this corp */
  private creepNames: string[] = [];

  /** Last tick we attempted to spawn */
  private lastSpawnAttempt: number = 0;

  /** Cached source analysis data */
  private sourceData: { sourceId: string; flow: number; distanceToSpawn: number }[] = [];

  /** Cached analyzed source mines */
  private sourceMines: Map<string, SourceMine> = new Map();

  /** Last acquisition price paid for energy (from miners) */
  private lastAcquisitionPrice: number = 0.1;

  /** Target number of haulers (computed during planning) */
  private targetHaulers: number = 2;

  constructor(nodeId: string, spawnId: string) {
    super("hauling", nodeId);
    this.spawnId = spawnId;
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
    let actualCarryCapacity = 0;
    let actualTotalTTL = 0;
    let activeCreepCount = 0;

    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep) {
        actualCarryCapacity += creep.store.getCapacity();
        actualTotalTTL += creep.ticksToLive ?? CREEP_LIFETIME;
        activeCreepCount++;
      }
    }

    // Get spawn position
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const spawnPosition = spawn
      ? { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName }
      : null;

    // Determine source and destination positions
    // Source: average of all source positions (or spawn if no sources)
    // Destination: spawn or controller
    const sourcePos = this.getAverageSourcePosition() ?? spawnPosition ?? this.getPosition();
    const destPos = this.getDestinationPosition() ?? spawnPosition ?? this.getPosition();

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
      activeCreepCount,
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
   * Get average position of all sources (for source pickup location).
   */
  private getAverageSourcePosition(): Position | null {
    if (this.sourceData.length === 0) return null;

    // For simplicity, use the first source's position
    const firstSource = Game.getObjectById(this.sourceData[0].sourceId as Id<Source>);
    if (firstSource) {
      return { x: firstSource.pos.x, y: firstSource.pos.y, roomName: firstSource.pos.roomName };
    }
    return null;
  }

  /**
   * Get destination position (controller for upgrading, or spawn).
   */
  private getDestinationPosition(): Position | null {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return null;

    // Prefer controller if available
    const controller = spawn.room.controller;
    if (controller) {
      return { x: controller.pos.x, y: controller.pos.y, roomName: controller.pos.roomName };
    }

    return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
  }

  /**
   * Plan hauling operations. Called periodically to compute targets.
   * Analyzes sources and distances to determine optimal hauler count.
   */
  plan(tick: number): void {
    super.plan(tick);

    // Ensure source data is populated
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      this.analyzeSources(spawn.room, spawn);
    }

    // Calculate total haul demand: Σ(flow × distance)
    const totalHaulDemand = this.sourceData.reduce((sum, source) => {
      return sum + (source.flow * source.distanceToSpawn);
    }, 0);

    // Each hauler provides ~4 CARRY parts × HAUL_PER_CARRY capacity
    const capacityPerHauler = 4 * HAUL_PER_CARRY;
    this.targetHaulers = Math.max(1, Math.ceil(totalHaulDemand / capacityPerHauler));
  }

  /**
   * Hauling corp buys carry-ticks from SpawningCorp and energy from miners.
   *
   * EXECUTION LOGIC (uses targets from planning):
   * - If current haulers < target, request 1 more
   */
  buys(): Offer[] {
    const offers: Offer[] = [];

    // Count current live haulers
    const currentHaulers = this.creepNames.filter(n => Game.creeps[n]).length;

    // Request 1 hauler if below target
    if (currentHaulers < this.targetHaulers) {
      const standardHaulerCapacity = 4 * HAUL_PER_CARRY;
      const pricePerHaul = TRANSPORT_FEE_PER_ENERGY * (1 + this.getMargin());

      offers.push({
        id: createOfferId(this.id, "carry-ticks", Game.time),
        corpId: this.id,
        type: "buy",
        resource: "carry-ticks",
        quantity: standardHaulerCapacity,
        price: pricePerHaul * standardHaulerCapacity,
        duration: CREEP_LIFETIME,
        location: this.getPosition()
      });
    }

    // Buy energy from miners - long-term contract
    const activeCreeps = this.creepNames.filter(n => Game.creeps[n]).length;
    if (activeCreeps > 0) {
      // Calculate long-term energy needs based on hauler capacity
      const TICKS_PER_DELIVERY = 50;
      const energyCapacity = this.creepNames.reduce((sum, name) => {
        const creep = Game.creeps[name];
        if (!creep) return sum;
        const ttl = creep.ticksToLive ?? CREEP_LIFETIME;
        const capacity = creep.store.getCapacity();
        const deliveriesRemaining = Math.floor(ttl / TICKS_PER_DELIVERY);
        return sum + (capacity * deliveriesRemaining);
      }, 0);

      // Subtract already-committed energy from buy contracts to prevent double-ordering
      const committedEnergy = this.getCommittedBuyQuantity("energy", Game.time);
      const energyNeeded = energyCapacity - committedEnergy;

      if (energyNeeded > 0) {
        const maxBuyPricePerUnit = this.lastAcquisitionPrice * 1.5;

        offers.push({
          id: createOfferId(this.id, "energy", Game.time),
          corpId: this.id,
          type: "buy",
          resource: "energy",
          quantity: energyNeeded,
          price: maxBuyPricePerUnit * energyNeeded, // Total price
          duration: CREEP_LIFETIME,
          location: this.getPosition()
        });
      }
    }

    return offers;
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
   * Update acquisition price when buying from miners.
   */
  setAcquisitionPrice(price: number): void {
    this.lastAcquisitionPrice = price;
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
   * Main work loop - pick up assigned creeps and run their behavior.
   * Spawning is handled by SpawningCorp via the market.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Pick up newly assigned creeps (spawned by SpawningCorp with our corpId)
    this.pickupAssignedCreeps();

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get spawn (for room reference and source analysis)
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      return;
    }

    const room = spawn.room;

    // Analyze sources if not cached
    if (this.sourceData.length === 0) {
      this.analyzeSources(room, spawn);
    }

    // Run hauler behavior for all creeps
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runHauler(creep, room, spawn);
      }
    }
  }

  /**
   * Scan for creeps that were spawned for this corp and add them to our roster.
   * Also picks up maintenance haulers spawned by SpawningCorp with matching nodeId.
   */
  private pickupAssignedCreeps(): void {
    const TICKS_PER_DELIVERY = 50;

    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      // Match by exact corpId OR by nodeId (for maintenance haulers from SpawningCorp)
      const matchesCorpId = creep.memory.corpId === this.id;
      const matchesNodeId = creep.memory.corpId === this.nodeId;

      if ((matchesCorpId || matchesNodeId) && !this.creepNames.includes(name)) {
        this.creepNames.push(name);

        // Record expected lifetime production for amortized pricing
        if (!creep.memory.isMaintenanceHauler) {
          const capacity = creep.store.getCapacity();
          const expectedDeliveries = Math.floor(CREEP_LIFETIME / TICKS_PER_DELIVERY);
          const expectedDeliveredEnergy = capacity * expectedDeliveries;
          this.recordExpectedProduction(expectedDeliveredEnergy);
        }

        const haulerType = creep.memory.isMaintenanceHauler ? "maintenance" : "regular";
        const carryParts = creep.getActiveBodyparts(CARRY);
        console.log(`[Hauling] Picked up ${haulerType} hauler ${name} (${carryParts} CARRY)`);
      }
    }
  }

  /**
   * Analyze all minable sources in the room to determine hauling requirements.
   * Excludes source keeper sources which require armored operations.
   */
  private analyzeSources(room: Room, spawn: StructureSpawn): void {
    const sources = getMinableSources(room);

    for (const source of sources) {
      const mine = analyzeSource(source, spawn.pos);
      this.sourceMines.set(source.id, mine);
      this.sourceData.push({
        sourceId: source.id,
        flow: mine.flow,
        distanceToSpawn: mine.distanceToSpawn,
      });
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

    // If nothing to pick up, move towards minable sources (where miners drop)
    const sources = getMinableSources(room);
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
    return this.creepNames.filter((n) => Game.creeps[n]).length;
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedRealHaulingCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      creepNames: this.creepNames,
      lastSpawnAttempt: this.lastSpawnAttempt,
      sourceData: this.sourceData,
      lastAcquisitionPrice: this.lastAcquisitionPrice,
      targetHaulers: this.targetHaulers,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedRealHaulingCorp): void {
    super.deserialize(data);
    this.creepNames = data.creepNames || [];
    this.lastSpawnAttempt = data.lastSpawnAttempt || 0;
    this.sourceData = data.sourceData || [];
    this.lastAcquisitionPrice = data.lastAcquisitionPrice || 0.1;
    this.targetHaulers = data.targetHaulers || 2;
  }
}

/**
 * Create a RealHaulingCorp for a room.
 */
export function createRealHaulingCorp(
  room: Room,
  spawn: StructureSpawn
): RealHaulingCorp {
  const nodeId = `${room.name}-hauling`;
  return new RealHaulingCorp(nodeId, spawn.id);
}
