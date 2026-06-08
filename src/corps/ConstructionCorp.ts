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
import { MAX_BUILDERS } from "./CorpConstants";
import { BODY_PART_COST } from "../planning/EconomicConstants";
import { buildUpgraderBody, buildTankerBody } from "../spawn/BodyBuilder";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { SinkAllocation } from "../flow/FlowTypes";
import { Squad, SquadPlan, splitIntoMembers } from "./Squad";

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
 * Dropped energy (within range 1 of a source) that signals a source container is
 * worth its 5000 build cost: a pile this big means a miner is producing there
 * faster than haulers clear it, so a static container will buffer the energy (and
 * stop it decaying on the ground) instead. Tunable - lower builds containers more
 * eagerly, higher waits for clearer evidence of sustained over-production.
 */
const SOURCE_CONTAINER_PILE_THRESHOLD = 200;

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

  /**
   * The builders, as a squad. Count scales with the energy budgeted to
   * construction (see getSpawnDemand): one big builder when energy is scarce,
   * several when there is enough delivery to keep them all building.
   */
  private readonly builders: Squad;

  /**
   * The hot-swapping feeder relay that keeps the builders fed. An INTRA-node
   * carrier squad (distinct from inter-node haulers), sized so one is always at a
   * builder while the rest refuel.
   */
  private readonly tankers: Squad;

  constructor(nodeId: string, spawnId: string, customId?: string) {
    super("building", nodeId, customId);
    this.spawnId = spawnId;

    this.builders = new Squad({
      corpId: this.id,
      workType: "build",
      role: "builder",
      value: 95, // just below the core mining economy, above upgrading
      producesIncome: false,
      blockingWhenEmpty: false,
      usefulPart: WORK,
    });
    this.tankers = new Squad({
      corpId: this.id,
      workType: "tank",
      role: "tanker",
      value: 94, // feeding the builders is nearly as important as the builders
      producesIncome: false,
      blockingWhenEmpty: true, // the first feeder is essential
      usefulPart: CARRY,
    });
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
      // Whether to build at all - and how fast - is the planner's call (it
      // budgets build-work and ranks construction above upgrading). Placing a
      // site is free in-game; the scarce energy to finish it is governed by the
      // build-work budget. So place whenever RCL still wants the structure,
      // without an independent internal-ledger veto.
      this.tryPlaceNextSite(room, tick, rcl);
    }

    // Once the room is maxed and the spawn would idle, retire an undersized
    // builder so it respawns at the size the room can now build (a no-op in a
    // constrained room - see Squad.flagRuntForRecycling).
    this.builders.flagRuntForRecycling(room, spawn, this.builderPlan(room.energyCapacityAvailable));

    // Run both squads. The squad hides the creep count: whether there is one
    // builder or several, the relay of feeders, and any creep mid-recycle.
    this.builders.run((creep) => this.runBuilder(creep, room), spawn);
    this.tankers.run((creep) => this.runTanker(creep, room), spawn);
  }

  /**
   * What the builder squad should look like. First the TOTAL work the squad
   * should field: enough WORK to consume the energy the flow solver budgets to
   * construction (a builder eats 5 energy per WORK per tick). Then pack that total
   * into the fewest creeps the room can build - ideally one big builder, splitting
   * into smaller ones only when the current extension capacity cannot afford a
   * single body that large. Either way the squad fields the same total WORK.
   * partsNeeded/maxPartsPerMember let a maxed room recycle a bootstrap runt up to
   * full size.
   */
  private builderPlan(energyCapacity: number): SquadPlan {
    const totalWork = Math.max(1, Math.ceil(this.getTotalAllocatedEnergy() / 5));
    // The biggest single builder this room's extension capacity can build.
    const maxPerBuilder = Math.max(1, buildUpgraderBody(energyCapacity, totalWork).workParts);
    const { count, partsPerMember } = splitIntoMembers(totalWork, maxPerBuilder, MAX_BUILDERS);

    const desired = buildUpgraderBody(energyCapacity, partsPerMember);
    const min = buildUpgraderBody(energyCapacity, 1);
    return {
      target: count,
      desiredCost: desired.cost,
      minCost: min.cost,
      bodyParam: partsPerMember,
      partsNeeded: totalWork,
      maxPartsPerMember: maxPerBuilder,
    };
  }

  /**
   * A tanker shuttles energy from the nearest source to the static builder and
   * hands it over, then circles back to refuel. With a relay of these, one is
   * always at the builder (hot swap) so it never stops building.
   */
  private runTanker(creep: Creep, room: Room): void {
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) creep.memory.working = true;

    // With a squad of builders, feed the nearest one that still has room; anchor
    // everything else on the construction site so the choice stays stable.
    const builders = this.builders.members();
    const hungry = creep.pos.findClosestByRange(
      builders.filter((b) => b.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
    );

    if (creep.memory.working) {
      // Deliver to the nearest hungry builder; if all are topped off, stage by the
      // site ready to swap in the moment one needs energy.
      if (hungry) {
        if (creep.transfer(hungry, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(hungry, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
      const site = creep.pos.findClosestByPath(room.find(FIND_MY_CONSTRUCTION_SITES));
      if (site && creep.pos.getRangeTo(site) > 2) {
        creep.moveTo(site, { range: 2, visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Refuel from THIS node's local source - the one by the worker we feed, not
    // whichever pile is momentarily closest to us. Anchoring the choice on the
    // builder keeps every tanker committed to the same source: with two
    // symmetric sources, picking "nearest to me" flip-flops left/right each tick
    // and the tanker oscillates in place, never refuelling. A tanker is an
    // intra-node carrier, so it draws from its node. Range (not path) keeps the
    // pick stable and cheap; moveTo still paths there.
    const anchor =
      builders[0]?.pos ?? room.find(FIND_MY_CONSTRUCTION_SITES)[0]?.pos ?? creep.pos;

    const container = anchor.findClosestByRange(room.find(FIND_STRUCTURES, {
      filter: (s) =>
        s.structureType === STRUCTURE_CONTAINER &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
    })) as StructureContainer | null;
    if (container) {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { visualizePathStyle: { stroke: "#00ff00" } });
      }
      return;
    }
    const pile = anchor.findClosestByRange(room.find(FIND_DROPPED_RESOURCES, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 20,
    }));
    if (pile) {
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) {
        creep.moveTo(pile, { visualizePathStyle: { stroke: "#00ff00" } });
      }
      return;
    }
    const source = anchor.findClosestByRange(room.find(FIND_SOURCES));
    if (source && creep.pos.getRangeTo(source) > 2) {
      creep.moveTo(source, { range: 2, visualizePathStyle: { stroke: "#00ff00" } });
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
    // A non-negative `since` guards against the cooldown; a negative one means
    // the clock went backwards (e.g. a snapshot reloaded with a stale
    // lastPlacementAttempt from a later tick) - don't let that block placement.
    const since = tick - this.lastPlacementAttempt;
    if (since >= 0 && since < PLACEMENT_COOLDOWN) {
      return;
    }
    this.lastPlacementAttempt = tick;

    // Infrastructure first at RCL 3+. A source container turns roaming
    // drop-mining into static mining; a controller container buffers the
    // upgraders so they withdraw locally and upgrade continuously instead of
    // starving while they wait for/chase a hauler. That efficiency lifts the
    // WHOLE economy, so it earns its 5000 build cost back faster than the next
    // extension would - hence it comes before finishing the extension set.
    if (rcl >= CONTAINER_MIN_RCL) {
      const container = this.findMissingContainer(room);
      if (container) {
        this.placeSite(room, container.x, container.y, STRUCTURE_CONTAINER, 0);
        return;
      }
    }

    // Extensions: cheap (3000) and they compound spawn capacity (bigger creeps).
    const ext = this.findGridPosition(room);
    if (ext) {
      this.placeSite(room, ext.x, ext.y, STRUCTURE_EXTENSION, 100);
      return;
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

    // Source containers: at most one per source (sources that already have a
    // container or pending site are skipped), and only once dropped energy has
    // piled up at the source. The pile is the demand signal - it means a miner is
    // mining there and out-producing the haulers, so a static container will pay
    // for itself by buffering the energy and ending the drop decay. No pile means
    // either no miner yet or haulers keeping up, so the 5000 build cost can wait.
    for (const source of room.find(FIND_SOURCES)) {
      if (hasContainerNear(source.pos.x, source.pos.y, 1)) continue;
      const pile = source.pos
        .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: (r) => r.resourceType === RESOURCE_ENERGY })
        .reduce((sum, r) => sum + r.amount, 0);
      if (pile < SOURCE_CONTAINER_PILE_THRESHOLD) continue;
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
      // While building, top up from energy at our feet in the SAME tick - build
      // (work-group) and withdraw/pickup (transfer-group) are different action
      // groups, so they don't conflict. This stops the builder draining to empty
      // and losing a whole tick to pure refuelling: parked next to its energy (a
      // source pile, a container, or a tanker), it stays full and builds every
      // tick - roughly doubling its effective rate versus the build/fetch toggle.
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        this.refuelInPlace(creep);
      }
    } else {
      this.doPickup(creep, room);
    }
  }

  /**
   * Top up from energy immediately adjacent (range 1) without moving: a tanker's
   * delivery, a drop at our feet, or an adjacent container. Lets the builder
   * refuel while staying put and building.
   */
  private refuelInPlace(creep: Creep): void {
    const drop = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0,
    })[0];
    if (drop) {
      creep.pickup(drop);
      return;
    }
    const store = creep.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s) =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
    })[0] as StructureContainer | undefined;
    if (store) {
      creep.withdraw(store, RESOURCE_ENERGY);
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
    return this.builders.members().length;
  }

  /**
   * Get the spawn ID this corp spawns from.
   */
  getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Declare this corp's spawn demand for the scheduler, as two squads: the
   * builders, then the feeder relay that keeps them fed.
   *
   * The builder count scales with the energy budgeted to construction (see
   * builderPlan), so the squad grows itself - the corp no longer reasons about
   * "one builder" vs "several". The first builder is fetched before any feeder
   * (an empty site has nothing to feed); after that both squads emit demand and
   * the scheduler arbitrates by value (builders 95 > feeders 94).
   */
  getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];
    const sites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) return [];

    const builderDemand = this.builders.spawnDemand(this.builderPlan(ctx.energyCapacity));

    // Get the first builder on the field before requesting feeders for it.
    if (this.builders.count() < 1) return builderDemand;

    const tankerDemand = this.tankers.spawnDemand(this.tankerPlan(ctx, spawn.room, sites[0]));
    return [...builderDemand, ...tankerDemand];
  }

  /**
   * What the feeder squad should look like: enough small tankers that one is
   * always at a builder while the others refuel, sized to the builders' total
   * consumption and the refuel round-trip (see targetTankerCount).
   */
  private tankerPlan(ctx: SpawnDemandContext, room: Room, site: ConstructionSite): SquadPlan {
    const perTanker = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / 100), 4));
    const target = this.targetTankerCount(room, site, this.builders.members(), perTanker);
    const desired = buildTankerBody(perTanker, ctx.energyCapacity, false);
    const min = buildTankerBody(1, ctx.energyCapacity, false);
    return {
      target,
      desiredCost: desired.cost,
      minCost: min.cost,
      bodyParam: perTanker,
    };
  }

  /**
   * How many tankers the relay needs: enough CARRY in flight to sustain the
   * builder's consumption over the refuel round-trip, never fewer than two so
   * there is always one staged for a seamless hot swap.
   */
  private targetTankerCount(
    room: Room,
    site: ConstructionSite,
    builders: Creep[],
    perTanker: number
  ): number {
    const work = builders.reduce((sum, b) => sum + b.getActiveBodyparts(WORK), 0);
    const consumption = Math.max(5, work * 5); // energy/tick the builder eats
    const source = site.pos.findClosestByRange(FIND_SOURCES);
    const dist = source ? site.pos.getRangeTo(source) : 8;
    const roundTrip = 2 * dist + 2;
    const carryNeeded = Math.ceil((consumption * roundTrip) / 50);
    return Math.max(2, Math.ceil(carryNeeded / perTanker));
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
