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
import { pickRuntToRecycle, spawnIdleAndMaxed, driveRecycle } from "./recycle";

// Re-exported so existing call sites/tests can import it from CarryCorp.
export { pickRuntToRecycle };

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
export type LocalSink = "spawn" | "controller";

/**
 * Free capacity (energy) in the spawn network at or above which a hauler diverts
 * to refill it before anything else. The spawn + extensions are the colony's
 * most important sink - nothing can be spawned without them - but their flow
 * allocation is only the small staffing overhead, so a purely proportional split
 * lets the high-volume controller starve them. One extension's worth of free
 * space is enough to act on; smaller dribbles are left to the proportional split.
 */
const SPAWN_PRIORITY_FREE_CAPACITY = 50;

/**
 * Choose which local sink to commit a load to. The spawn network has strict
 * priority: whenever it has real free capacity, fill it first regardless of the
 * proportional allocation (the spawn is critical but small, so it tops up fast
 * and the surplus then flows on to construction/controller). Otherwise fall back
 * to the flow-proportional split. Pure so it can be unit tested directly.
 */
export function pickDeliverySink(
  spawnFreeCapacity: number,
  assignments: { toId: string; flowRate: number }[],
  delivered: { [sink: string]: number }
): LocalSink {
  if (spawnFreeCapacity >= SPAWN_PRIORITY_FREE_CAPACITY) return "spawn";
  return pickSinkByAllocation(assignments, delivered);
}

export function pickSinkByAllocation(
  assignments: { toId: string; flowRate: number }[],
  delivered: { [sink: string]: number }
): LocalSink {
  // Haulers serve only the spawn network and the controller. Construction is
  // deliberately excluded - feeding builders is the construction tankers' job, not
  // the haulers' - so a construction route never pulls a hauler off its circuit.
  const flows: Record<LocalSink, number> = { spawn: 0, controller: 0 };
  for (const a of assignments) {
    if (a.toId.startsWith("controller-")) flows.controller += a.flowRate;
    else if (a.toId.startsWith("construction-")) continue;
    else flows.spawn += a.flowRate;
  }

  // Pick whichever sink with positive allocated flow is furthest behind its
  // share so far, distributing loads in proportion to the flow solver's per-sink
  // allocations.
  let best: LocalSink = "spawn";
  let bestScore = Infinity;
  let anyPositive = false;
  for (const sink of ["spawn", "controller"] as const) {
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

    this.flagRuntForRecycling(creeps, room, spawn);

    for (const creep of creeps) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
      } else {
        this.runHauler(creep, room, spawn);
      }
    }
  }

  /** CARRY parts a single hauler can be built with at the room's full capacity. */
  private maxCarryPerHauler(room: Room): number {
    return Math.max(1, Math.min(Math.floor(room.energyCapacityAvailable / 100), 25));
  }

  /**
   * Replace an undersized hauler with a full-size one, but only at zero cost:
   * when the room is maxed out (every store full) and the spawn would otherwise
   * idle. Spawning during bootstrap floors haulers at a modest size to keep the
   * spawn affordable; that leaves the fleet short of the planned CARRY once it
   * hits its target COUNT. Here - and only here, where the energy and the spawn
   * tick would otherwise go to waste - we retire the smallest runt so its corp
   * respawns it at full size, lifting realized throughput toward the plan. In a
   * constrained room (the common case) the gate never opens, which is correct:
   * we never disrupt deliveries to chase a bigger body we cannot afford.
   */
  private flagRuntForRecycling(creeps: Creep[], room: Room, spawn: StructureSpawn): void {
    if (!spawnIdleAndMaxed(room, spawn)) return;
    if (creeps.some((c) => c.memory.recycling)) return; // one at a time

    const idx = pickRuntToRecycle(
      creeps.map((c) => c.getActiveBodyparts(CARRY)),
      this.haulCarryNeeded(),
      this.maxCarryPerHauler(room)
    );
    if (idx !== null) creeps[idx].memory.recycling = true;
  }

  /**
   * Run behavior for a hauler creep.
   */
  private runHauler(creep: Creep, room: Room, spawn: StructureSpawn): void {
    // State transition
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      // Each hauler has ONE permanent home circuit (assigned in proportion to the
      // flow solver's per-sink allocations - see assignCircuit), so it is a dumb
      // automaton on a defined route, not re-rolling its destination every trip.
      // Re-assign only when it has no circuit or its route's flow has vanished
      // (e.g. construction finished).
      const home = creep.memory.homeSink as LocalSink | undefined;
      if (!home || !this.committedSinkHasFlow(home)) {
        this.assignCircuit(creep);
      }
      // This trip's destination is decided ONCE, here: top up a hungry spawn
      // (the critical bottleneck, under-weighted by its tiny flow share), else run
      // the home circuit. Fixed for the whole trip, so no mid-route thrash.
      const homeSink = creep.memory.homeSink as LocalSink;
      creep.memory.deliverSinkId =
        homeSink !== "spawn" && this.spawnNetworkHungry(room) ? "spawn" : homeSink;
      creep.say(creep.memory.deliverSinkId === "controller" ? "→ctrl" : "→spawn");
    }

    // A clean bus: it fills completely at its source stop, then runs the route and
    // empties completely at its sink stop - no grabbing energy off-route mid-trip
    // (that energy belongs to its own source's bus). The state flips above only on
    // full and on empty, so the hauler waits at each stop until the transaction is
    // done rather than leaving with a partial load.
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
    // Our source is reserved for the builder: don't draw from it. Stand by (idle
    // until the build finishes) so the construction tankers get its full output.
    if (this.yieldsToBuild()) return;

    const sources = room.find(FIND_SOURCES);
    const assignedSource = this.getAssignedSource(creep, sources);

    // The one fixed pickup stop on this hauler's bus route: its assigned source.
    let targetPos: RoomPosition | null = null;
    if (assignedSource) {
      targetPos = assignedSource.pos;
    } else if (creep.memory.assignedSourcePos) {
      const p = creep.memory.assignedSourcePos;
      targetPos = new RoomPosition(p.x, p.y, p.roomName);
    }
    if (!targetPos) return;

    if (targetPos.roomName !== creep.room.name) {
      creep.moveTo(targetPos, { visualizePathStyle: { stroke: "#ffaa00" } });
      return;
    }

    // Drive to the source and take whatever is there - its container if static
    // mining built one, otherwise the miner's drop pile. No room-wide "largest
    // pile" search: that pick changes as piles grow and shrink, so the hauler
    // wanders between them instead of running its route. A bus stops at its stop.
    const container = targetPos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
    })[0] as StructureContainer | undefined;
    if (container) {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // The miner's drop sits adjacent to the source (a fixed tile - the miner is
    // static), so this stays put; take the biggest of the (usually one) piles.
    const pile = targetPos
      .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })
      .sort((a, b) => b.amount - a.amount)[0];
    if (pile) {
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) {
        creep.moveTo(pile, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Nothing to grab yet: wait at the stop for the next drop.
    if (creep.pos.getRangeTo(targetPos) > 1) {
      creep.moveTo(targetPos, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
    }
  }

  /**
   * Deliver energy to the spawn network or the controller (a hauler's only two
   * sinks; construction is fed by tankers, not haulers).
   */
  private deliverEnergy(creep: Creep, room: Room, _spawn: StructureSpawn): void {
    // Deliver to this trip's destination (fixed at fill-up; see runHauler). No
    // re-decision here - that mid-route flip-flopping is exactly the thrash we are
    // removing.
    const target = (creep.memory.deliverSinkId as LocalSink | undefined) ?? "spawn";
    if (this.tryDeliverTo(creep, room, target)) return;

    // The destination momentarily can't take it (full): help the other sink rather
    // than idle, without disturbing the permanent home circuit. Spawn first -
    // surplus is most valuable kept in the spawn network.
    const fallback: LocalSink[] = ["spawn", "controller"];
    for (const sink of fallback) {
      if (sink === target) continue;
      if (this.tryDeliverTo(creep, room, sink)) return;
    }
  }

  /** Free energy capacity across the spawn network is worth a hauler's divert. */
  private spawnNetworkHungry(room: Room): boolean {
    const free = this.getSpawnZoneStructures(room).reduce(
      (sum, s) => sum + s.store.getFreeCapacity(RESOURCE_ENERGY),
      0
    );
    return free >= SPAWN_PRIORITY_FREE_CAPACITY;
  }

  /** Per-sink-type flow this corp's source feeds (spawn + controller; construction
   * is excluded - tankers serve it, not haulers). */
  private flowsBySink(): Record<LocalSink, number> {
    const flows: Record<LocalSink, number> = { spawn: 0, controller: 0 };
    for (const a of this.haulerAssignments) {
      if (a.toId.startsWith("controller-")) flows.controller += a.flowRate;
      else if (a.toId.startsWith("construction-")) continue;
      else flows.spawn += a.flowRate;
    }
    return flows;
  }

  /**
   * Is a hauler's committed circuit still real? Spawn is always a valid home (it
   * perpetually needs topping). The controller is valid only while the flow solver
   * still routes energy there - when its flow drops to zero its haulers re-assign.
   */
  private committedSinkHasFlow(sink: LocalSink): boolean {
    if (sink === "spawn") return true;
    return this.flowsBySink()[sink] > 0;
  }

  /**
   * Permanently assign this hauler to one delivery circuit, picking the sink type
   * that is most under-staffed relative to its share of the flow. Counting the
   * haulers already committed to each sink and handing the newcomer the one
   * furthest behind its flow share spreads the fleet across circuits in proportion
   * to the solver's allocations - the same proportional rule the old per-load
   * chooser used, applied once per hauler instead of every trip.
   */
  private assignCircuit(creep: Creep): void {
    const committed: { [sink: string]: number } = {};
    for (const h of this.getAssignedCreeps()) {
      if (h.name === creep.name) continue;
      const s = h.memory.homeSink;
      if (s) committed[s] = (committed[s] ?? 0) + 1;
    }
    creep.memory.homeSink = pickSinkByAllocation(this.haulerAssignments, committed);
  }

  /** Attempt delivery to a specific local sink; returns true if it took action. */
  private tryDeliverTo(creep: Creep, room: Room, sink: LocalSink): boolean {
    if (sink === "controller") return this.deliverToController(creep, room);
    return this.deliverToSpawn(creep, room);
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

    // The controller end of the bus route is one fixed drop-off: the upgrader
    // container if static upgrading built one, otherwise the controller itself
    // (drop beside it for the camping upgraders to draw from). No chasing whichever
    // upgrader currently has the most room - that pick changes every tick and the
    // hauler ends up shuttling between workers instead of running its route.
    const container = controller.pos.findInRange(FIND_STRUCTURES, 4, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    })[0] as StructureContainer | undefined;
    if (container) {
      if (creep.transfer(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { range: 1, visualizePathStyle: { stroke: "#ffffff" } });
      } else {
        this.recordProduction(Math.min(creep.store[RESOURCE_ENERGY], container.store.getFreeCapacity(RESOURCE_ENERGY)));
      }
      return true;
    }

    // No container: drive to the controller and drop the load there. The
    // stationary upgraders camp at the controller and pick it up.
    if (creep.pos.getRangeTo(controller) > 2) {
      creep.moveTo(controller, { range: 2, visualizePathStyle: { stroke: "#ffffff" } });
    } else {
      const dropped = creep.store[RESOURCE_ENERGY];
      creep.drop(RESOURCE_ENERGY);
      this.recordProduction(dropped);
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

    // If this source is reserved for the builder, field no haulers - its energy
    // belongs to the construction tankers.
    if (this.yieldsToBuild()) return [];

    const carryNeeded = this.haulCarryNeeded();
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

    // Don't let the scheduler spawn a 1-CARRY runt under energy pressure: it
    // moves only 50 energy per round trip - useless on a real route - yet it
    // occupies one of the fleet's few slots for its whole 1500-tick life, so
    // realized throughput falls far below the planned fleet. Floor every hauler
    // at a useful minimum body. We deliberately do NOT hold out for the full
    // desired body: the first hauler is what refills the spawn, so requiring a
    // full-size body before the spawn is full would deadlock the bootstrap. The
    // floor is cheap enough that a partly-drained spawn can still afford it, the
    // scheduler scales up toward desiredCost whenever more energy is on hand, and
    // any undersized survivors are recycled and replaced once we are maxed out
    // and the spawn would otherwise idle.
    const HAULER_MIN_CARRY = 3;
    const minCost = Math.min(desiredCarry, HAULER_MIN_CARRY) * PART_PAIR_COST;

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
   * CARRY parts the hauler fleet should staff: this source's SPAWN + CONTROLLER
   * routes only. Construction is excluded because the builder is fed by the
   * construction tankers - sizing (and therefore sending) haulers for the
   * builder's energy is what lets them show up and grab it. A source routed
   * entirely to construction yields zero here, so it fields no haulers and its
   * energy is left for the tankers.
   */
  private haulCarryNeeded(): number {
    return Math.ceil(
      this.haulerAssignments
        .filter((a) => !(a.toId ?? "").startsWith("construction-"))
        .reduce((sum, a) => sum + a.carryParts, 0)
    );
  }

  /** This corp's source game id (from its flow assignments). */
  private mySourceId(): string | undefined {
    const a = this.haulerAssignments[0];
    return a ? a.fromId.replace("source-", "") : undefined;
  }

  /**
   * True when this corp's source has been reserved for the builder: it must stand
   * down (field no haulers, and existing ones stop drawing from it) so the
   * construction tankers get the source's full output. The reservation is set by
   * ConstructionCorp in room memory while a build is active.
   */
  private yieldsToBuild(): boolean {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const dedicated = spawn?.room.memory.dedicatedBuildSourceId;
    return !!dedicated && this.mySourceId() === dedicated;
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
