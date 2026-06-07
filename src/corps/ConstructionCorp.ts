/**
 * @fileoverview ConstructionCorp - Auxiliary corp for building infrastructure.
 *
 * The ConstructionCorp builds extensions to increase spawn capacity.
 * It only invests in construction when there's accumulated profit,
 * ensuring the economy is stable before expanding.
 *
 * @module corps/ConstructionCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";
import {
  MAX_BUILDERS,
  MIN_CONSTRUCTION_PROFIT,
} from "./CorpConstants";
import { BODY_PART_COST } from "../planning/EconomicConstants";
import { buildUpgraderBody } from "../spawn/BodyBuilder";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { SinkAllocation } from "../flow/FlowTypes";

/**
 * Serialized state specific to ConstructionCorp
 */
export interface SerializedConstructionCorp extends SerializedCorp {
  spawnId: string;
  lastPlacementAttempt: number;
  targetBuilders: number;
  /** Flow-based construction allocations (from FlowEconomy) */
  constructionAllocations?: SinkAllocation[];
}

/**
 * Extension limits by controller level (RCL 1-8)
 */
const EXTENSION_LIMITS: { [rcl: number]: number } = {
  1: 0,
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60,
};

/**
 * How often to attempt placing new construction sites (ticks)
 */
const PLACEMENT_COOLDOWN = 10;

/** Max containers per room (game limit is 5 at every RCL). */
const CONTAINER_LIMIT = 5;

/**
 * Don't invest in containers (5000 build cost each) until RCL 3+. At RCL 2 the
 * economy is too small to afford one without stalling the climb; extensions
 * (3000, compounding capacity) come first.
 */
const CONTAINER_MIN_RCL = 3;

/**
 * ConstructionCorp manages builder creeps that construct extensions.
 */
export class ConstructionCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Last tick we attempted to place extensions */
  private lastPlacementAttempt: number = 0;

  /** Target number of builders (computed during planning) */
  private targetBuilders: number = 0;

  /**
   * Flow-based construction allocations from FlowEconomy.
   * Each allocation specifies energy for a construction site.
   */
  private constructionAllocations: SinkAllocation[] = [];

  constructor(nodeId: string, spawnId: string, customId?: string) {
    super("building", nodeId, customId);
    this.spawnId = spawnId;
  }

  /**
   * Get active creeps assigned to this corp.
   */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "build" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * Plan construction operations.
   */
  plan(tick: number): void {
    super.plan(tick);

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      this.targetBuilders = 0;
      return;
    }

    const constructionSites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (constructionSites.length === 0) {
      this.targetBuilders = 0;
      return;
    }

    const totalWorkRemaining = constructionSites.reduce((sum, site) => {
      return sum + (site.progressTotal - site.progress);
    }, 0);

    const buildersNeeded = Math.min(MAX_BUILDERS, Math.ceil(totalWorkRemaining / 50000));
    this.targetBuilders = Math.max(1, buildersNeeded);
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
   * Main work loop - run builder creeps.
   */
  work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const room = spawn.room;
    const controller = room.controller;
    if (!controller) return;

    // Build one structure at a time (a queue, not a spread): only place the next
    // construction site when there are NO active sites in the room. Concentrating
    // all builder/hauler effort on a single site finishes it sooner (capacity
    // grows incrementally) instead of inching dozens of sites forward at once.
    const rcl = controller.level;
    const maxExtensions = EXTENSION_LIMITS[rcl] || 0;
    const currentExtensions = room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION,
    }).length;
    const activeSites = room.find(FIND_MY_CONSTRUCTION_SITES).length;

    const wantsContainer = rcl >= CONTAINER_MIN_RCL && this.findMissingContainer(room) !== null;
    const canBuildMore = activeSites === 0 && (currentExtensions < maxExtensions || wantsContainer);

    if (canBuildMore) {
      // Debug: log why we might not be placing
      if (this.balance < MIN_CONSTRUCTION_PROFIT) {
        if (tick % 100 === 0) {
          console.log(`[Construction] Balance too low: ${this.balance.toFixed(0)} < ${MIN_CONSTRUCTION_PROFIT}`);
        }
      } else {
        this.tryPlaceNextSite(room, tick, rcl);
      }
    }

    const creeps = this.getActiveCreeps();
    for (const creep of creeps) {
      this.runBuilder(creep, room);
    }
  }

  /**
   * Place the next-most-valuable structure (one at a time). Infrastructure that
   * raises the whole economy's efficiency comes first: a container at each
   * source turns roaming drop-mining into static mining (the miner sits on the
   * container and never moves), and a container by the controller buffers the
   * upgrader. Extensions - which grow spawn capacity - come after.
   */
  private tryPlaceNextSite(room: Room, tick: number, rcl: number): void {
    if (tick - this.lastPlacementAttempt < PLACEMENT_COOLDOWN) {
      return;
    }
    this.lastPlacementAttempt = tick;

    // Extensions first: cheap (3000) and they compound spawn capacity, which
    // speeds up everything afterwards - including the pricier containers.
    const ext = this.findGridPosition(room);
    if (ext) {
      this.placeSite(room, ext.x, ext.y, STRUCTURE_EXTENSION, 100);
      return;
    }

    // Containers (5000 each) only once the room can afford the investment
    // without crippling RCL progress. They pay back via static mining + buffered
    // upgrading over the source's long life.
    if (rcl >= CONTAINER_MIN_RCL) {
      const container = this.findMissingContainer(room);
      if (container) {
        this.placeSite(room, container.x, container.y, STRUCTURE_CONTAINER, 0);
        return;
      }
    }
  }

  /** Create a construction site and record its cost. */
  private placeSite(
    room: Room,
    x: number,
    y: number,
    type: BuildableStructureConstant,
    cost: number
  ): void {
    const result = room.createConstructionSite(x, y, type);
    if (result === OK) {
      this.recordCost(cost);
      console.log(`[Construction] Placed ${type} site at (${x}, ${y})`);
    } else {
      console.log(`[Construction] Failed to place ${type} at (${x}, ${y}): ${result}`);
    }
  }

  /**
   * Find the best tile for a still-missing container: one adjacent to a source
   * that lacks one (for static mining), or one beside the controller (to buffer
   * the upgrader). Returns null when every source and the controller already
   * have a container (built or under construction). Caps at the room's limit.
   */
  private findMissingContainer(room: Room): { x: number; y: number } | null {
    const built = room.find(FIND_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_CONTAINER });
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES, { filter: (s) => s.structureType === STRUCTURE_CONTAINER });
    if (built.length + sites.length >= CONTAINER_LIMIT) return null;
    const taken = [...built, ...sites].map((s) => s.pos);
    const hasContainerNear = (x: number, y: number, range: number): boolean =>
      taken.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) <= range);

    // Source containers: a walkable tile adjacent to the source.
    for (const source of room.find(FIND_SOURCES)) {
      if (hasContainerNear(source.pos.x, source.pos.y, 1)) continue;
      const tile = this.bestAdjacentTile(room, source.pos, 1);
      if (tile) return tile;
    }

    // Controller container: a walkable tile within range 2 of the controller.
    if (room.controller && room.controller.my && !hasContainerNear(room.controller.pos.x, room.controller.pos.y, 2)) {
      const tile = this.bestAdjacentTile(room, room.controller.pos, 2);
      if (tile) return tile;
    }

    return null;
  }

  /**
   * Pick a walkable, unoccupied tile within `range` of `target`, preferring the
   * one nearest the spawn (shorter hauls).
   */
  private bestAdjacentTile(room: Room, target: RoomPosition, range: number): { x: number; y: number } | null {
    const terrain = room.getTerrain();
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const occupied = new Set<string>();
    for (const s of room.find(FIND_STRUCTURES)) occupied.add(`${s.pos.x},${s.pos.y}`);
    for (const s of room.find(FIND_CONSTRUCTION_SITES)) occupied.add(`${s.pos.x},${s.pos.y}`);

    let best: { x: number; y: number; d: number } | null = null;
    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = target.x + dx;
        const y = target.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        if (occupied.has(`${x},${y}`)) continue;
        const d = spawn ? Math.max(Math.abs(spawn.pos.x - x), Math.abs(spawn.pos.y - y)) : 0;
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * Find a position for extension using a grid pattern near sources.
   * Uses checkerboard pattern (every other tile) for walkability.
   */
  private findGridPosition(room: Room): { x: number; y: number } | null {
    const terrain = room.getTerrain();
    const candidates: { x: number; y: number; score: number }[] = [];

    // Build set of positions to avoid (occupied or reserved)
    const avoidPositions = new Set<string>();

    // Avoid spawn and adjacent tiles
    const spawns = room.find(FIND_MY_SPAWNS);
    for (const s of spawns) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          avoidPositions.add(`${s.pos.x + dx},${s.pos.y + dy}`);
        }
      }
    }

    // Avoid source mining positions (1 tile radius for miners)
    const sources = room.find(FIND_SOURCES);
    for (const source of sources) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          avoidPositions.add(`${source.pos.x + dx},${source.pos.y + dy}`);
        }
      }
    }

    // Avoid controller upgrade positions (2 tile radius)
    if (room.controller) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          avoidPositions.add(`${room.controller.pos.x + dx},${room.controller.pos.y + dy}`);
        }
      }
    }

    // Avoid existing structures and construction sites
    const structures = room.find(FIND_STRUCTURES);
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (const s of structures) {
      avoidPositions.add(`${s.pos.x},${s.pos.y}`);
    }
    for (const s of sites) {
      avoidPositions.add(`${s.pos.x},${s.pos.y}`);
    }

    // Search in a grid pattern near sources
    // Extensions near sources = short haul distance for haulers
    // Checkerboard: only consider tiles where (x + y) % 2 === 0
    for (const source of sources) {
      const center = { x: source.pos.x, y: source.pos.y };
      // Search in area from 2 to 6 tiles away from center
      for (let dx = -6; dx <= 6; dx++) {
        for (let dy = -6; dy <= 6; dy++) {
          // Skip positions too close (< 2 tiles)
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (dist < 2) continue;

          const x = center.x + dx;
          const y = center.y + dy;

          // Bounds check
          if (x < 2 || x > 47 || y < 2 || y > 47) continue;

          // Checkerboard pattern for walkability
          if ((x + y) % 2 !== 0) continue;

          // Skip walls and swamps (prefer plains)
          const terrainType = terrain.get(x, y);
          if (terrainType === TERRAIN_MASK_WALL) continue;

          // Skip avoided positions
          if (avoidPositions.has(`${x},${y}`)) continue;

          // Ensure at least 3 walkable neighbors (path connectivity)
          let walkableNeighbors = 0;
          for (let nx = -1; nx <= 1; nx++) {
            for (let ny = -1; ny <= 1; ny++) {
              if (nx === 0 && ny === 0) continue;
              const tx = x + nx;
              const ty = y + ny;
              if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;
              if (terrain.get(tx, ty) !== TERRAIN_MASK_WALL) {
                walkableNeighbors++;
              }
            }
          }
          if (walkableNeighbors < 3) continue;

          // Estimate weighted path cost from this position to nearest source
          // Haulers walk from sources to extensions - shorter = better
          // Extensions near sources are great: short haul distance + energy available for spawning
          let minWeightedDist = Infinity;
          for (const source of sources) {
            const weightedDist = this.estimatePathCost(x, y, source.pos.x, source.pos.y, terrain);
            minWeightedDist = Math.min(minWeightedDist, weightedDist);
          }

          // Score based purely on path cost to sources
          // Lower path cost = higher score (easier for haulers to fill)
          const score = 100 - Math.min(minWeightedDist, 50);

          candidates.push({ x, y, score });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  /**
   * Estimate path cost between two points, accounting for swamps.
   * Uses a simple line-walk approximation (not full pathfinding).
   * Swamps cost 5x, plains cost 1x.
   */
  private estimatePathCost(
    x1: number, y1: number,
    x2: number, y2: number,
    terrain: RoomTerrain
  ): number {
    let cost = 0;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));

    if (steps === 0) return 0;

    // Walk along the line and sum terrain costs
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x1 + (dx * i) / steps);
      const y = Math.round(y1 + (dy * i) / steps);

      const t = terrain.get(x, y);
      if (t === TERRAIN_MASK_WALL) {
        // Wall in path - add heavy penalty (path would go around)
        cost += 10;
      } else if (t === TERRAIN_MASK_SWAMP) {
        cost += 5;  // Swamp costs 5x
      } else {
        cost += 1;  // Plains cost 1x
      }
    }

    return cost;
  }

  /**
   * Run behavior for a builder creep.
   */
  private runBuilder(creep: Creep, room: Room): void {
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.working = false;
      creep.say("pickup");
    }
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
      creep.memory.working = true;
      creep.say("build");
    }

    if (creep.memory.working) {
      this.doBuild(creep, room);
    } else {
      this.doPickup(creep, room);
    }
  }

  /**
   * Build the nearest construction site.
   */
  private doBuild(creep: Creep, room: Room): void {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) {
      // No construction sites - stay put
      return;
    }

    const target = creep.pos.findClosestByPath(sites);
    if (!target) return;

    const result = creep.build(target);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (result === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordConsumption(workParts * 5);
      this.recordProduction(workParts * 5);
    }
  }

  /**
   * Pick up energy from nearby sources only (stationary - don't travel for energy).
   * Haulers are responsible for delivering energy to builders.
   */
  private doPickup(creep: Creep, _room: Room): void {
    const PICKUP_RANGE = 4; // Only grab energy within this range

    // Check for dropped energy within range
    const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, PICKUP_RANGE, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 20,
    });
    if (dropped.length > 0) {
      const target = dropped[0];
      if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check for tombstones with energy within range
    const tombstones = creep.pos.findInRange(FIND_TOMBSTONES, PICKUP_RANGE, {
      filter: (t) => t.store[RESOURCE_ENERGY] > 0,
    });
    if (tombstones.length > 0) {
      const target = tombstones[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check for ruins with energy within range
    const ruins = creep.pos.findInRange(FIND_RUINS, PICKUP_RANGE, {
      filter: (r) => r.store[RESOURCE_ENERGY] > 0,
    });
    if (ruins.length > 0) {
      const target = ruins[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // Check containers within range
    const containers = creep.pos.findInRange(FIND_STRUCTURES, PICKUP_RANGE, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 50,
    }) as StructureContainer[];
    if (containers.length > 0) {
      const target = containers[0];
      if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
      }
      return;
    }

    // No energy nearby - stay put and wait for delivery
    // (creep will move to construction site when it has energy)
  }

  /**
   * Get number of active builder creeps.
   */
  getCreepCount(): number {
    return this.getActiveCreeps().length;
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
   * Builders are low-priority, non-blocking, non-income work: only requested
   * when there are construction sites and no builder yet. They build the
   * extensions that grow spawn capacity.
   */
  getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    if (this.getCreepCount() >= 1) return [];
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];
    const sites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) return [];

    const desired = buildUpgraderBody(ctx.energyCapacity, 2);
    const min = buildUpgraderBody(ctx.energyCapacity, 1);
    if (min.cost === 0) return [];

    return [{
      buyerCorpId: this.id,
      // After an RCL-up, building new structures takes precedence over upgrading
      // (capacity compounds into faster RCL later). Rank a builder just below the
      // core mining economy but above upgrading so it reliably gets spawned.
      role: "builder",
      value: 95,
      blocking: false,
      producesIncome: false,
      desiredCost: desired.cost,
      minCost: min.cost,
      since: 0,
      bodyParam: 2,
    }];
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set construction allocations from FlowEconomy.
   * Each allocation specifies energy rate for a construction site.
   */
  setConstructionAllocations(allocations: SinkAllocation[]): void {
    this.constructionAllocations = allocations;
    // Adjust target builders based on total allocated energy
    const totalAllocated = allocations.reduce((sum, a) => sum + a.allocated, 0);
    // Each builder with ~2 WORK parts builds at ~10 energy/tick
    const workPerBuilder = 10;
    this.targetBuilders = Math.min(MAX_BUILDERS, Math.max(1, Math.ceil(totalAllocated / workPerBuilder)));
  }

  /**
   * Get all construction allocations.
   */
  getConstructionAllocations(): SinkAllocation[] {
    return this.constructionAllocations;
  }

  /**
   * Check if this corp has flow-based allocations.
   */
  hasFlowAllocations(): boolean {
    return this.constructionAllocations.length > 0;
  }

  /**
   * Get total allocated energy rate for construction.
   */
  getTotalAllocatedEnergy(): number {
    return this.constructionAllocations.reduce((sum, a) => sum + a.allocated, 0);
  }

  /**
   * Get the highest priority construction site (from flow allocations).
   */
  getHighestPriorityAllocation(): SinkAllocation | undefined {
    if (this.constructionAllocations.length === 0) return undefined;
    return this.constructionAllocations.reduce((best, curr) =>
      curr.priority > best.priority ? curr : best
    );
  }

  /**
   * Serialize for persistence.
   */
  serialize(): SerializedConstructionCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      lastPlacementAttempt: this.lastPlacementAttempt,
      targetBuilders: this.targetBuilders,
      constructionAllocations: this.constructionAllocations.length > 0 ? this.constructionAllocations : undefined,
    };
  }

  /**
   * Deserialize from persistence.
   */
  deserialize(data: SerializedConstructionCorp): void {
    super.deserialize(data);
    this.lastPlacementAttempt = data.lastPlacementAttempt || 0;
    this.targetBuilders = data.targetBuilders || 0;
    this.constructionAllocations = data.constructionAllocations ?? [];
  }
}

/** Starting balance for construction corps (enough to place several extensions) */
const CONSTRUCTION_CORP_STARTING_BALANCE = 1000;

/**
 * Create a ConstructionCorp for a room.
 */
export function createConstructionCorp(
  room: Room,
  spawn: StructureSpawn
): ConstructionCorp {
  const nodeId = `${room.name}-construction`;
  const corp = new ConstructionCorp(nodeId, spawn.id);
  corp.balance = CONSTRUCTION_CORP_STARTING_BALANCE;
  return corp;
}
