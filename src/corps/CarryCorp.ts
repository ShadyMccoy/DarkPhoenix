/**
 * @fileoverview CarryCorp - Manages hauler creeps.
 *
 * CarryCorp is a transport service that moves energy from sources to destinations.
 *
 * @module corps/CarryCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import { CREEP_LIFETIME } from "../planning/EconomicConstants";
import { HaulerAssignment } from "../flow/FlowTypes";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";

/** Transport fee per energy unit (base cost before margin) */
const TRANSPORT_FEE_PER_ENERGY = 0.05;

/**
 * Decide which local sink a CarryCorp should deliver its next load to, balancing
 * deliveries across the node's sinks in proportion to the flow solver's
 * allocations (each assignment's flowRate). `delivered` is the running count of
 * loads sent to each sink so far. Pure so it can be unit tested directly.
 *
 * Sinks are classified by their flow `toId`: a "controller-*" destination is the
 * controller; anything else (spawn/extension network) is treated as the spawn.
 */
export type LocalSink = "spawn" | "controller" | "construction";

export function pickSinkByAllocation(
  assignments: { toId: string; flowRate: number }[],
  delivered: { [sink: string]: number }
): LocalSink {
  const flows: Record<LocalSink, number> = { spawn: 0, controller: 0, construction: 0 };
  for (const a of assignments) {
    if (a.toId.startsWith("controller-")) flows.controller += a.flowRate;
    else if (a.toId.startsWith("construction-")) flows.construction += a.flowRate;
    else flows.spawn += a.flowRate;
  }

  // Pick whichever sink with positive allocated flow is furthest behind its
  // share so far. This distributes loads in proportion to the flow solver's
  // per-sink allocations (which already encode spawn > construction > minimal
  // controller via priorities).
  let best: LocalSink = "spawn";
  let bestScore = Infinity;
  let anyPositive = false;
  for (const sink of ["spawn", "controller", "construction"] as const) {
    if (flows[sink] <= 0) continue;
    anyPositive = true;
    const score = (delivered[sink] ?? 0) / flows[sink];
    if (score < bestScore) {
      bestScore = score;
      best = sink;
    }
  }
  return anyPositive ? best : "spawn";
}

/**
 * Serialized state specific to CarryCorp
 */
export interface SerializedCarryCorp extends SerializedCorp {
  spawnId: string;
  /** Flow-based hauler assignments (from FlowEconomy) */
  haulerAssignments?: HaulerAssignment[];
}

/**
 * CarryCorp manages hauler creeps that move energy around.
 */
export class CarryCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Creeps we've already recorded expected production for (session-only) */
  private accountedCreeps: Set<string> = new Set();

  /**
   * Flow-based hauler assignments from FlowEconomy.
   * Each assignment specifies a source → sink route with CARRY requirements.
   */
  private haulerAssignments: HaulerAssignment[] = [];

  /**
   * Count of loads committed to each local sink ("spawn"/"controller"), used to
   * balance deliveries in proportion to the flow solver's per-sink allocations.
   * In-memory only - approximate balancing that resets on a global reset is fine.
   */
  private sinkDelivered: { [sink: string]: number } = {};

  constructor(nodeId: string, spawnId: string, customId?: string) {
    super("hauling", nodeId, customId);
    this.spawnId = spawnId;
  }

  /**
   * Get all creeps assigned to this corp.
   */
  private getAssignedCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if ((creep.memory.corpId === this.id || creep.memory.corpId === this.nodeId) &&
          creep.memory.workType === "haul" && !creep.spawning) {
        creeps.push(creep);

        if (!this.accountedCreeps.has(name)) {
          this.accountedCreeps.add(name);
          const carryCapacity = creep.store.getCapacity();
          const expectedDeliveries = carryCapacity * CREEP_LIFETIME / 50; // Estimate
          this.recordExpectedProduction(expectedDeliveries);
        }
      }
    }
    return creeps;
  }

  /**
   * Get transport cost per energy unit based on actual operations.
   */
  getTransportCostPerEnergy(): number {
    if (this.unitsProduced === 0) return TRANSPORT_FEE_PER_ENERGY;
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
   * Main work loop - run hauler creeps.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const creeps = this.getAssignedCreeps();

    for (const creep of creeps) {
      this.runHauler(creep, room, spawn);
    }
  }

  /**
   * Run behavior for a hauler creep.
   */
  private runHauler(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.memory.deliverSinkId = undefined;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      // Commit this load to a sink, balancing the node's local sinks in
      // proportion to the flow solver's per-sink allocations.
      creep.memory.deliverSinkId = this.chooseDeliverySink();
      creep.say(creep.memory.deliverSinkId === "controller" ? "→ctrl" : "→spawn");
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
      this.deliverEnergy(creep, room, spawn);
    } else {
      this.pickupEnergy(creep, room);
    }
  }

  // ===========================================================================
  // FLEET COORDINATION - Belt/Bus Circulation System
  // ===========================================================================

  /**
   * Get the canonical list of all spawn/extension structures in this room.
   * Sorted by ID for consistent ordering across all ticks and haulers.
   * This is the "route" that haulers circulate through.
   */
  private getSpawnZoneStructures(room: Room): (StructureSpawn | StructureExtension)[] {
    const structures = room.find(FIND_MY_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_SPAWN ||
        s.structureType === STRUCTURE_EXTENSION,
    }) as (StructureSpawn | StructureExtension)[];

    // Sort by ID for consistent ordering
    return structures.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Assign a persistent slot to a hauler.
   * The slot determines their starting position in the structure rotation.
   * Persisted in creep memory to survive across ticks.
   *
   * Key: New haulers get the first UNUSED slot, not based on age sorting.
   * This prevents slot conflicts when creeps die and new ones spawn.
   */
  private getHaulerSlot(creep: Creep): number {
    // Check if already assigned
    if (creep.memory.haulerSlot !== undefined) {
      return creep.memory.haulerSlot;
    }

    // Find all slots already taken by other haulers
    const allHaulers = this.getAssignedCreeps();
    const takenSlots = new Set<number>();
    for (const hauler of allHaulers) {
      if (hauler.name !== creep.name && hauler.memory.haulerSlot !== undefined) {
        takenSlots.add(hauler.memory.haulerSlot);
      }
    }

    // Assign first available slot (0, 1, 2, ...)
    let slot = 0;
    while (takenSlots.has(slot)) {
      slot++;
    }

    creep.memory.haulerSlot = slot;
    return slot;
  }

  /**
   * Get the current delivery target for a hauler using persistent assignment.
   *
   * Belt System Logic:
   * 1. Each hauler has a persistent slot (0, 1, 2, ...)
   * 2. They target structure at index (slot + deliveryRotation) % structureCount
   * 3. After successful delivery OR when target is full, increment deliveryRotation
   * 4. Each hauler advances through THEIR OWN sequence, preventing convergence
   *
   * Key insight: When a target is full, each hauler advances their OWN rotation
   * rather than all searching for the same "next available" structure.
   * This keeps haulers spread out like a conveyor belt.
   */
  private getCirculationTarget(
    creep: Creep,
    structures: (StructureSpawn | StructureExtension)[]
  ): StructureSpawn | StructureExtension | null {
    if (structures.length === 0) return null;

    const slot = this.getHaulerSlot(creep);
    const count = structures.length;

    // Try up to 'count' rotations to find a structure that needs energy
    // Each hauler advances through their OWN sequence, maintaining spacing
    for (let attempts = 0; attempts < count; attempts++) {
      const rotation = creep.memory.deliveryRotation ?? 0;
      const targetIndex = (slot + rotation) % count;
      const target = structures[targetIndex];

      if (target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        // Found a target that needs energy - use it
        creep.memory.deliveryTargetId = target.id;
        return target;
      }

      // Target is full - advance THIS hauler's rotation to their next structure
      // This is key: each hauler moves through their own sequence
      creep.memory.deliveryRotation = (rotation + 1) % count;
    }

    // All structures full - return null to allow fallback to workers/controller
    // Reset rotation so we start fresh when things drain
    creep.memory.deliveryRotation = 0;
    delete creep.memory.deliveryTargetId;
    return null;
  }

  /**
   * Record a successful delivery and rotate to next structure in sequence.
   * Called after a successful transfer to advance the circulation.
   */
  private advanceCirculation(creep: Creep, structureCount: number): void {
    const current = creep.memory.deliveryRotation ?? 0;
    creep.memory.deliveryRotation = (current + 1) % structureCount;
    delete creep.memory.deliveryTargetId; // Clear so next tick recalculates
  }

  /**
   * Check if a hauler is already close to their target (within transfer range).
   * Used to anticipate arrival and prepare for delivery.
   */
  private isAtDeliveryTarget(creep: Creep): boolean {
    if (!creep.memory.deliveryTargetId) return false;
    const target = Game.getObjectById(creep.memory.deliveryTargetId as Id<Structure>);
    return target ? creep.pos.getRangeTo(target) <= 1 : false;
  }

  /**
   * Get the source this CarryCorp's haulers should serve.
   * With per-source CarryCorps, each corp has exactly one source from its hauler assignment.
   * Falls back to round-robin distribution for legacy room-based corps.
   */
  private getAssignedSource(creep: Creep, sources: Source[]): Source | null {
    // Per-source CarryCorp: use the source from hauler assignment
    if (this.haulerAssignments.length > 0) {
      const assignment = this.haulerAssignments[0];
      // Extract source game ID from flow source ID (e.g., "source-abc123" → "abc123")
      const sourceGameId = assignment.fromId.replace("source-", "");

      // Check if this is an intel-based source (remote room without vision)
      if (sourceGameId.startsWith("intel-")) {
        // Intel source: parse position from ID format "intel-ROOMNAME-X-Y"
        const match = sourceGameId.match(/^intel-([EW]\d+[NS]\d+)-(\d+)-(\d+)$/);
        if (match) {
          const [, roomName, x, y] = match;
          // Store position for navigation even without source object
          creep.memory.assignedSourcePos = { x: parseInt(x), y: parseInt(y), roomName };
        }
        return null; // No live source object for intel sources
      }

      const source = Game.getObjectById(sourceGameId as Id<Source>);
      if (source) {
        creep.memory.assignedSourceId = source.id;
        return source;
      }
    }

    // Fallback: legacy round-robin distribution (for transition period)
    if (sources.length === 0) return null;

    if (creep.memory.assignedSourceId) {
      const assigned = Game.getObjectById(creep.memory.assignedSourceId as Id<Source>);
      if (assigned) return assigned;
      delete creep.memory.assignedSourceId;
    }

    const allHaulers = this.getAssignedCreeps();
    const myIndex = allHaulers.findIndex(c => c.name === creep.name);
    const sourceIndex = myIndex >= 0 ? myIndex % sources.length : 0;
    const assignedSource = sources[sourceIndex];

    creep.memory.assignedSourceId = assignedSource.id;
    return assignedSource;
  }

  /**
   * Pick up energy from the ground or containers.
   * Haulers are assigned to specific sources to prevent thrashing.
   */
  private pickupEnergy(creep: Creep, room: Room): void {
    const sources = room.find(FIND_SOURCES);
    const assignedSource = this.getAssignedSource(creep, sources);

    // Get target position (from source object or intel position)
    let targetPos: RoomPosition | null = null;
    if (assignedSource) {
      targetPos = assignedSource.pos;
    } else if (creep.memory.assignedSourcePos) {
      const pos = creep.memory.assignedSourcePos;
      targetPos = new RoomPosition(pos.x, pos.y, pos.roomName);
    }

    // If target is in a different room, navigate there first
    if (targetPos && targetPos.roomName !== creep.room.name) {
      creep.moveTo(targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // Use creep's current room for searching (important for remote rooms)
    const searchRoom = creep.room;

    // First try dropped energy near assigned source (within range 5)
    const dropped = searchRoom.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => {
        if (r.resourceType !== RESOURCE_ENERGY) return false;
        // If we have a target position, prefer energy near it
        if (targetPos) {
          return r.pos.getRangeTo(targetPos) <= 5;
        }
        return true;
      },
    });

    if (dropped.length > 0) {
      // Pick the largest pile near our source instead of closest
      const target = dropped.reduce((best, curr) =>
        curr.amount > best.amount ? curr : best
      );
      const result = creep.pickup(target);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // If no dropped energy near assigned source, check containers near it
    const containers = searchRoom.find(FIND_STRUCTURES, {
      filter: (s) => {
        if (s.structureType !== STRUCTURE_CONTAINER) return false;
        if ((s as StructureContainer).store[RESOURCE_ENERGY] === 0) return false;
        if (targetPos) {
          return s.pos.getRangeTo(targetPos) <= 3;
        }
        return true;
      },
    }) as StructureContainer[];

    if (containers.length > 0) {
      const target = containers[0]; // Take first container near source
      const result = creep.withdraw(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // If nothing to pick up, move towards assigned source (where miners drop)
    if (targetPos && creep.pos.getRangeTo(targetPos) > 3) {
      creep.moveTo(targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Deliver energy to spawn, extensions, or workers.
   * Uses circulation-based distribution for belt/bus behavior.
   * At RCL 2 with construction sites, prioritizes dropping near sources.
   */
  private deliverEnergy(creep: Creep, room: Room, _spawn: StructureSpawn): void {
    // Route this load to the sink it was committed to. If that sink can't take
    // it right now (e.g. spawn full, or no controller), fall back to the other.
    const sink = creep.memory.deliverSinkId ?? "spawn";

    if (sink === "construction") {
      if (this.deliverToConstruction(creep, room)) return;
      // No builders/sites right now - fall back to spawn, then controller.
      if (this.deliverToSpawn(creep, room)) return;
      this.deliverToController(creep, room);
      return;
    }

    if (sink === "controller") {
      if (this.deliverToController(creep, room)) return;
      this.deliverToSpawn(creep, room);
      return;
    }

    if (this.deliverToSpawn(creep, room)) return;
    this.deliverToController(creep, room);
  }

  /**
   * Deliver to construction: hand energy to a builder creep that needs it (the
   * builder then carries it to the site and builds). Returns false when there
   * are no construction sites in the room.
   */
  private deliverToConstruction(creep: Creep, room: Room): boolean {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) return false;

    const builders = room.find(FIND_MY_CREEPS, {
      filter: (c) => c.memory.workType === "build" && c.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (builders.length > 0) {
      builders.sort((a, b) => b.store.getFreeCapacity(RESOURCE_ENERGY) - a.store.getFreeCapacity(RESOURCE_ENERGY));
      const target = builders[0];
      if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      } else {
        this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY)));
      }
      return true;
    }

    // No builder to receive yet: drop energy adjacent to the nearest site so a
    // builder can grab it when it arrives.
    const site = creep.pos.findClosestByPath(sites);
    if (!site) return false;
    if (creep.pos.getRangeTo(site) <= 2) {
      const dropped = creep.store[RESOURCE_ENERGY];
      creep.drop(RESOURCE_ENERGY);
      this.recordProduction(dropped);
    } else {
      creep.moveTo(site, { visualizePathStyle: { stroke: "#ffaa00" } });
    }
    return true;
  }

  /**
   * Choose which local sink to deliver the current load to, in proportion to the
   * flow solver's per-sink allocations (flowRate). This is the heart of the
   * node's local energy balancing.
   */
  private chooseDeliverySink(): LocalSink {
    const pick = pickSinkByAllocation(this.haulerAssignments, this.sinkDelivered);
    this.sinkDelivered[pick] = (this.sinkDelivered[pick] ?? 0) + 1;
    return pick;
  }

  /**
   * Deliver to the spawn/extension network via the circulation system.
   * Returns false when there is no spawn structure that needs energy.
   */
  private deliverToSpawn(creep: Creep, room: Room): boolean {
    const allSpawnStructures = this.getSpawnZoneStructures(room);
    if (allSpawnStructures.length === 0) return false;

    const target = this.getCirculationTarget(creep, allSpawnStructures);
    if (!target) return false; // all full

    const result = creep.transfer(target, RESOURCE_ENERGY);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
    } else if (result === OK) {
      const transferred = Math.min(
        creep.store[RESOURCE_ENERGY],
        target.store.getFreeCapacity(RESOURCE_ENERGY)
      );
      this.recordProduction(transferred);
      this.advanceCirculation(creep, allSpawnStructures.length);
    } else if (result === ERR_FULL) {
      this.advanceCirculation(creep, allSpawnStructures.length);
    }
    return true;
  }

  /**
   * Deliver to the controller's consumers: an upgrader container, then the
   * upgrader/builder creeps directly, then dropping adjacent to the controller.
   * Returns false when the room has no controller.
   */
  private deliverToController(creep: Creep, room: Room): boolean {
    const controller = room.controller;
    if (!controller) return false;

    // Upgrader container near the controller.
    const containers = room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        s.pos.getRangeTo(controller) <= 4 &&
        (s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    }) as StructureContainer[];
    if (containers.length > 0) {
      const target = containers[0];
      if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else {
        this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY)));
      }
      return true;
    }

    // Upgraders/builders near the controller that need energy.
    const workers = room.find(FIND_MY_CREEPS, {
      filter: (c) =>
        (c.memory.workType === "upgrade" || c.memory.workType === "build") &&
        c.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
        c.pos.getRangeTo(controller) <= 5,
    });
    if (workers.length > 0) {
      workers.sort((a, b) => b.store.getFreeCapacity(RESOURCE_ENERGY) - a.store.getFreeCapacity(RESOURCE_ENERGY));
      const target = workers[0];
      const result = creep.transfer(target, RESOURCE_ENERGY);
      if (result === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffffff" } });
      } else if (result === OK) {
        this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY)));
      }
      return true;
    }

    // No container/worker yet: drop the load next to the controller so the
    // stationary upgrader can pick it up.
    if (creep.pos.getRangeTo(controller) <= 3) {
      const dropped = creep.store[RESOURCE_ENERGY];
      creep.drop(RESOURCE_ENERGY);
      this.recordProduction(dropped);
    } else {
      creep.moveTo(controller, { visualizePathStyle: { stroke: "#ffffff" } });
    }
    return true;
  }

  /**
   * Get number of active hauler creeps.
   */
  getCreepCount(): number {
    return this.getAssignedCreeps().length;
  }

  /**
   * Get the spawn ID this corp spawns from.
   */
  getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Declare this corp's spawn demand for the scheduler.
   *
   * A source's hauler carries its harvested energy to the spawn/controller. The
   * first hauler is "blocking" - without it the paired miner's energy is
   * stranded - and produces income. The hauler is sized (CARRY:MOVE pairs) to
   * the flow-solved carry-part requirement; it can be spawned small and scaled.
   */
  getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const assignments = this.getHaulerAssignments();
    if (assignments.length === 0) return [];

    // Total CARRY parts the flow needs for ALL of this source's routes combined
    // (spawn + controller + construction). One hauler usually can't sustain them
    // all - especially long routes - so we ferry the energy with as many haulers
    // as the carry demand requires.
    const carryNeeded = Math.ceil(assignments.reduce((sum, a) => sum + a.carryParts, 0));
    if (carryNeeded <= 0) return [];

    const PART_PAIR_COST = 100; // 1 CARRY + 1 MOVE
    const maxCarryPerHauler = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / PART_PAIR_COST), 25));
    const targetHaulers = Math.max(1, Math.ceil(carryNeeded / maxCarryPerHauler));

    const current = this.getCreepCount();
    if (current >= targetHaulers) return [];

    // Size this hauler to its share of the remaining carry need (capped by what
    // the room can afford in one body).
    const remainingCarry = carryNeeded - current * maxCarryPerHauler;
    const desiredCarry = Math.max(1, Math.min(maxCarryPerHauler, remainingCarry));
    const desiredCost = desiredCarry * PART_PAIR_COST;
    const minCost = PART_PAIR_COST; // 1 CARRY + 1 MOVE

    return [{
      buyerCorpId: this.id,
      role: "hauler",
      value: 90 + Math.min(carryNeeded, 20),
      // The first hauler is blocking (the source's energy is stranded without
      // any carrier); additional haulers are scaling capacity (non-blocking).
      blocking: current === 0,
      producesIncome: true,
      desiredCost,
      minCost,
      since: 0,
      bodyParam: desiredCarry,
      haulerRatio: assignments[0].haulerRatio,
    }];
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set hauler assignments from FlowEconomy.
   * Each assignment describes a route from source to sink with CARRY requirements.
   */
  setHaulerAssignments(assignments: HaulerAssignment[]): void {
    this.haulerAssignments = assignments;
  }

  /**
   * Get all hauler assignments for this corp.
   */
  getHaulerAssignments(): HaulerAssignment[] {
    return this.haulerAssignments;
  }

  /**
   * Check if this corp has flow-based assignments.
   */
  hasFlowAssignments(): boolean {
    return this.haulerAssignments.length > 0;
  }

  /**
   * Get total CARRY parts needed from flow assignments.
   */
  getTotalCarryPartsNeeded(): number {
    return this.haulerAssignments.reduce((sum, h) => sum + h.carryParts, 0);
  }

  /**
   * Get total flow rate from all assignments.
   */
  getTotalFlowRate(): number {
    return this.haulerAssignments.reduce((sum, h) => sum + h.flowRate, 0);
  }

  /**
   * Get the assignment for a specific source (by game ID).
   * Returns the route a hauler should take from this source.
   */
  getAssignmentForSource(sourceGameId: string): HaulerAssignment | undefined {
    const sourceFlowId = `source-${sourceGameId}`;
    return this.haulerAssignments.find(h => h.fromId === sourceFlowId);
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedCarryCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      haulerAssignments: this.haulerAssignments.length > 0 ? this.haulerAssignments : undefined,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedCarryCorp): void {
    super.deserialize(data);
    this.haulerAssignments = data.haulerAssignments ?? [];
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
