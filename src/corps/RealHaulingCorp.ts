/**
 * @fileoverview RealHaulingCorp - Manages actual hauler creeps.
 *
 * Haulers pick up dropped energy from mining sites and deliver it
 * to spawns (for energy) and the controller area (for upgraders).
 *
 * @module corps/RealHaulingCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";
import { SPAWN_COOLDOWN } from "./CorpConstants";
import { analyzeSource, getMinableSources } from "../analysis/SourceAnalysis";
import { buildHaulerBody, HaulerBodyResult } from "../spawn/BodyBuilder";
import { SourceMine } from "../types/SourceMine";

/** Transport fee per energy unit (base cost before margin) */
const TRANSPORT_FEE_PER_ENERGY = 0.05;

/**
 * Serialized state specific to RealHaulingCorp
 */
export interface SerializedRealHaulingCorp extends SerializedCorp {
  spawnId: string;
  creepNames: string[];
  lastSpawnAttempt: number;
  sourceData: { sourceId: string; flow: number; distanceToSpawn: number }[];
  lastAcquisitionPrice: number;
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

  constructor(nodeId: string, spawnId: string) {
    super("hauling", nodeId);
    this.spawnId = spawnId;
  }

  /**
   * Hauling corp sells energy at delivery points.
   * Price = acquisition cost + transport cost + margin
   */
  sells(): Offer[] {
    const activeCreeps = this.creepNames.filter(n => Game.creeps[n]).length;
    if (activeCreeps === 0) return [];

    // Calculate capacity available for delivery
    const carryCapacity = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store.getCapacity() : 0);
    }, 0);

    // Calculate sell price: acquisition cost + transport fee + margin
    const transportCost = this.getTransportCostPerEnergy();
    const totalCostPerEnergy = this.lastAcquisitionPrice + transportCost;
    const sellPrice = this.getPrice(totalCostPerEnergy);

    return [{
      id: createOfferId(this.id, "delivered-energy", Game.time),
      corpId: this.id,
      type: "sell",
      resource: "delivered-energy",
      quantity: carryCapacity, // What we can deliver per trip
      price: sellPrice,
      duration: 100,
      location: this.getPosition()
    }];
  }

  /**
   * Hauling corp buys energy from miners at source locations.
   */
  buys(): Offer[] {
    const activeCreeps = this.creepNames.filter(n => Game.creeps[n]).length;
    if (activeCreeps === 0) return [];

    // Calculate how much energy we want to buy
    const carryCapacity = this.creepNames.reduce((sum, name) => {
      const creep = Game.creeps[name];
      return sum + (creep ? creep.store.getCapacity() : 0);
    }, 0);

    // We'll pay up to our sell price minus transport cost and margin
    // This creates natural arbitrage - only profitable routes get served
    const maxBuyPrice = this.lastAcquisitionPrice * 1.5; // Willing to pay up to 50% more

    return [{
      id: createOfferId(this.id, "energy", Game.time),
      corpId: this.id,
      type: "buy",
      resource: "energy",
      quantity: carryCapacity,
      price: maxBuyPrice,
      duration: 100,
      location: this.getPosition()
    }];
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
   * Main work loop - spawn haulers and run their behavior.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    // Clean up dead creeps
    this.creepNames = this.creepNames.filter((name) => Game.creeps[name]);

    // Get spawn
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      return;
    }

    const room = spawn.room;

    // Analyze sources if not cached
    if (this.sourceData.length === 0) {
      this.analyzeSources(room, spawn);
    }

    // Calculate optimal hauler configuration
    const { body, cost, maxHaulers } = this.calculateHaulerConfig(spawn);

    if (body.length === 0) {
      return; // Can't build any haulers with current energy
    }

    // Try to spawn if we need more haulers
    if (this.creepNames.length < maxHaulers) {
      this.trySpawn(spawn, tick, body, cost);
    }

    // Run hauler behavior
    for (const name of this.creepNames) {
      const creep = Game.creeps[name];
      if (creep && !creep.spawning) {
        this.runHauler(creep, room, spawn);
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
   * Calculate optimal hauler body and count based on source data and dropped energy.
   *
   * The calculation considers:
   * - Total energy flow from all sources
   * - Average distance for round trips
   * - Available spawn energy capacity
   * - Dropped energy backlog (scales up haulers when energy is piling up)
   *
   * @returns Body configuration and max haulers needed
   */
  private calculateHaulerConfig(spawn: StructureSpawn): {
    body: BodyPartConstant[];
    cost: number;
    maxHaulers: number;
  } {
    if (this.sourceData.length === 0) {
      return { body: [], cost: 0, maxHaulers: 0 };
    }

    const room = spawn.room;

    // Calculate total hauling needs from steady-state source flow
    let totalCarryNeeded = 0;
    let maxDistance = 0;

    for (const source of this.sourceData) {
      const roundTrip = 2 * source.distanceToSpawn;
      totalCarryNeeded += source.flow * roundTrip;
      maxDistance = Math.max(maxDistance, source.distanceToSpawn);
    }

    // Add 20% buffer for path variability and pickup/dropoff time
    totalCarryNeeded = Math.ceil(totalCarryNeeded * 1.2);

    // Factor in dropped energy backlog - this is the key to scaling up
    // When energy piles up on the ground, we need more hauling capacity
    const droppedEnergy = room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY,
    }).reduce((sum, r) => sum + r.amount, 0);

    // Each 500 dropped energy adds ~1 hauler trip worth of demand
    // This creates natural scaling: backlog → more haulers → backlog clears
    const backlogFactor = droppedEnergy / 500;

    // Build hauler body based on average distance and total flow
    const totalFlow = this.sourceData.reduce((sum, s) => sum + s.flow, 0);
    const avgDistance = Math.ceil(
      this.sourceData.reduce((sum, s) => sum + s.distanceToSpawn, 0) /
        this.sourceData.length
    );

    const energyCapacity = spawn.room.energyCapacityAvailable;
    const bodyResult = buildHaulerBody(totalFlow, avgDistance, energyCapacity);

    if (bodyResult.carryCapacity === 0) {
      return { body: [], cost: 0, maxHaulers: 0 };
    }

    // Calculate how many haulers needed to handle total carry requirements
    const baseHaulersNeeded = Math.ceil(totalCarryNeeded / bodyResult.carryCapacity);

    // Add haulers for backlog clearance (capped to prevent runaway spawning)
    const backlogHaulers = Math.min(Math.ceil(backlogFactor), 3);
    const haulersNeeded = baseHaulersNeeded + backlogHaulers;

    // Cap at reasonable maximum to prevent over-spawning
    const maxHaulers = Math.min(haulersNeeded, 8);

    return {
      body: bodyResult.body,
      cost: bodyResult.cost,
      maxHaulers,
    };
  }

  /**
   * Attempt to spawn a new hauler creep.
   *
   * @param spawn - The spawn to use
   * @param tick - Current game tick
   * @param body - Body parts array from calculateHaulerConfig
   * @param cost - Energy cost of the body
   */
  private trySpawn(
    spawn: StructureSpawn,
    tick: number,
    body: BodyPartConstant[],
    cost: number
  ): void {
    if (tick - this.lastSpawnAttempt < SPAWN_COOLDOWN) {
      return;
    }

    if (spawn.spawning) {
      return;
    }

    if (spawn.store[RESOURCE_ENERGY] < cost) {
      return;
    }

    const name = `hauler-${spawn.room.name}-${tick}`;

    const result = spawn.spawnCreep(body, name, {
      memory: {
        corpId: this.id,
        workType: "haul",
        working: false,
      },
    });

    this.lastSpawnAttempt = tick;

    if (result === OK) {
      this.creepNames.push(name);
      this.recordCost(cost);
      const carryParts = body.filter((p) => p === CARRY).length;
      console.log(
        `[Hauling] Spawned ${name} with ${carryParts} CARRY parts (cost: ${cost})`
      );
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
        if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
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
        if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
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
          // Revenue recorded through market transactions
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
