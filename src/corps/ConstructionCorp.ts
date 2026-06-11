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
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { Squad, SquadPlan, splitIntoMembers } from "./Squad";
import { buildTankerBody, buildUpgraderBody } from "../spawn/BodyBuilder";
import { MAX_BUILDERS } from "./CorpConstants";
import { Position } from "../types/Position";
import { SinkAllocation } from "../flow/FlowTypes";
import { sourceHarvestSpot } from "./nodeEnergy";

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
  8: 60
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
  private lastPlacementAttempt = 0;

  /** Target number of builders (computed during planning) */
  private targetBuilders = 0;

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

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("building", nodeId, customId);
    this.spawnId = spawnId;

    this.builders = new Squad({
      corpId: this.id,
      workType: "build",
      role: "builder",
      value: 95, // just below the core mining economy, above upgrading
      producesIncome: false,
      blockingWhenEmpty: false,
      usefulPart: WORK
    });
    this.tankers = new Squad({
      corpId: this.id,
      workType: "tank",
      role: "tanker",
      value: 94, // feeding the builders is nearly as important as the builders
      producesIncome: false,
      blockingWhenEmpty: true, // the first feeder is essential
      usefulPart: CARRY
    });
  }

  /**
   * Plan construction operations.
   */
  public plan(tick: number): void {
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
  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Main work loop - run builder creeps.
   */
  public work(tick: number): void {
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
      filter: s => s.structureType === STRUCTURE_EXTENSION
    }).length;
    const activeSites = room.find(FIND_MY_CONSTRUCTION_SITES).length;

    const wantsContainer =
      rcl >= CONTAINER_MIN_RCL &&
      (this.findMissingSourceContainer(room) !== null || this.findMissingControllerContainer(room) !== null);
    const canBuildMore = activeSites === 0 && (currentExtensions < maxExtensions || wantsContainer);

    if (canBuildMore) {
      // Whether to build at all - and how fast - is the planner's call (it
      // budgets build-work and ranks construction above upgrading). Placing a
      // site is free in-game; the scarce energy to finish it is governed by the
      // build-work budget. So place whenever RCL still wants the structure,
      // without an independent internal-ledger veto.
      this.tryPlaceNextSite(room, tick, rcl);
    }

    // Reserve a whole source for the builder while building, so its miner feeds
    // the tankers directly and nothing else drains it (see updateDedicatedSource).
    this.updateDedicatedSource(room, activeSites > 0);

    // A reserved source feeds far more than a runt builder (spawned small under
    // early energy pressure) can use. Retire the runt so it respawns at the size
    // the dedicated source can keep busy - but only when the room can afford the
    // full body, else we would just respawn another runt and loop.
    this.recycleUndersizedBuilder(room);

    // Once the room is maxed and the spawn would idle, retire an undersized
    // builder so it respawns at the size the room can now build (a no-op in a
    // constrained room - see Squad.flagRuntForRecycling).
    this.builders.flagRuntForRecycling(room, spawn, this.builderPlan(room.energyCapacityAvailable, room));

    // Run both squads. The squad hides the creep count: whether there is one
    // builder or several, the relay of feeders, and any creep mid-recycle.
    this.builders.run(creep => this.runBuilder(creep, room), spawn);
    this.tankers.run(creep => this.runTanker(creep, room), spawn);
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
  /**
   * Recycle a builder that is smaller than the dedicated source can feed, so its
   * replacement spawns at full size. Gated on (a) a source actually being reserved
   * and (b) the room being able to afford the full body right now - otherwise the
   * replacement would spawn small again and we would churn builders forever. One
   * at a time.
   */
  private recycleUndersizedBuilder(room: Room): void {
    if (!room.memory.dedicatedBuildSourceId) return;
    const builders = this.builders.members();
    if (builders.length === 0 || builders.some(b => b.memory.recycling)) return;

    const plan = this.builderPlan(room.energyCapacityAvailable, room);
    if (room.energyAvailable < plan.desiredCost) return;

    const runt = builders.find(b => b.getActiveBodyparts(WORK) < (plan.maxPartsPerMember ?? 1));
    if (runt) runt.memory.recycling = true;
  }

  private builderPlan(energyCapacity: number, room: Room): SquadPlan {
    // Energy the crew should consume: the flow's construction allocation, OR -
    // when a whole source is reserved for the builder - that source's full output
    // (which all flows to construction). Sizing to the dedicated source lets the
    // crew actually use it (a 10/tick source -> a 2-WORK builder) instead of being
    // capped at the flow's smaller nominal share and leaving the source half-idle.
    let buildEnergy = this.getTotalAllocatedEnergy();
    const dedicated = room.memory.dedicatedBuildSourceId;
    if (dedicated) {
      const src = Game.getObjectById(dedicated as Id<Source>);
      if (src) buildEnergy = Math.max(buildEnergy, src.energyCapacity / ENERGY_REGEN_TIME);
    }
    const totalWork = Math.max(1, Math.ceil(buildEnergy / 5));
    // The biggest single builder this room's extension capacity can build.
    const maxPerBuilder = Math.max(1, buildUpgraderBody(energyCapacity, totalWork).workParts);
    const { count, partsPerMember } = splitIntoMembers(totalWork, maxPerBuilder, MAX_BUILDERS);

    const desired = buildUpgraderBody(energyCapacity, partsPerMember);
    // Floor the builder at its planned size rather than a 1-WORK runt: a reserved
    // source feeds a full builder, and a 1-WORK builder (5/tick) would leave half
    // that source idle. Better to wait a few ticks for the energy and spawn the
    // right body (the scheduler still ranks the builder high, so it spawns soon).
    const min = desired;
    return {
      target: count,
      desiredCost: desired.cost,
      minCost: min.cost,
      bodyParam: partsPerMember,
      partsNeeded: totalWork,
      maxPartsPerMember: maxPerBuilder
    };
  }

  /**
   * A tanker is a dumb automaton running one fixed shuttle: pull energy from its
   * ONE committed source, carry it to the builder, repeat. It never re-decides
   * which source to use - that decision is made once, for life (see tankerSource).
   * The old code re-picked "nearest pile" every tick, so with two mined sources it
   * chased whichever pile was momentarily closest and thrashed between them. A
   * fixed route is less locally optimal but predictable and ~free on CPU.
   */
  private runTanker(creep: Creep, room: Room): void {
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity() === 0) creep.memory.working = true;

    if (creep.memory.working) {
      // Deliver to the nearest builder with room. Builders are static, so "nearest"
      // is a fixed pick, not a moving target - no thrash.
      const builders = this.builders.members();
      const target = creep.pos.findClosestByRange(builders.filter(b => b.store.getFreeCapacity(RESOURCE_ENERGY) > 0));
      if (target) {
        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
      // Everyone topped off: stage next to a builder so the hand-off is instant.
      const stage = builders[0];
      if (stage && creep.pos.getRangeTo(stage) > 1) {
        creep.moveTo(stage, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
      }
      return;
    }

    // Refuel from the ONE source this tanker is committed to - the same one every
    // trip. Everything below is scoped to that source's tile (range 1), so there
    // is no room-wide "closest pile" search to flip-flop on.
    const source = this.tankerSource(creep, room);
    if (!source) return;

    const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0
    })[0] as StructureContainer | undefined;
    if (container) {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(container, { visualizePathStyle: { stroke: "#00ff00" } });
      }
      return;
    }
    const pile = source.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 20
    })[0];
    if (pile) {
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) {
        creep.moveTo(pile, { visualizePathStyle: { stroke: "#00ff00" } });
      }
      return;
    }
    // Nothing to grab yet: wait at the source so we are ready when it drops.
    if (creep.pos.getRangeTo(source) > 1) {
      creep.moveTo(source, { range: 1, visualizePathStyle: { stroke: "#00ff00" } });
    }
  }

  /**
   * The single source this tanker draws from, decided once and remembered for
   * life. New tankers commit to the source that currently has the fewest tankers
   * (so a relay spreads itself across a room's sources), with a stable id
   * tie-break. After that it never changes - the route is fixed.
   */
  /**
   * Reserve one whole source for the builder while a build is active: the source
   * nearest the site (shortest tanker shuttle). Its miner then feeds the tankers
   * directly and its haulers stand down (CarryCorp reads dedicatedBuildSourceId),
   * so the builder gets the source's full output instead of fighting the haulers
   * for it. Only when there is a spare source - the others still feed
   * spawn/controller; a one-source room can't give its only source away.
   */
  private updateDedicatedSource(room: Room, building: boolean): void {
    const sources = room.find(FIND_SOURCES);
    if (!building || sources.length < 2) {
      delete room.memory.dedicatedBuildSourceId;
      return;
    }
    const site = room.find(FIND_MY_CONSTRUCTION_SITES)[0];
    const nearest = site ? site.pos.findClosestByRange(sources) : null;
    room.memory.dedicatedBuildSourceId = nearest?.id;
  }

  private tankerSource(creep: Creep, room: Room): Source | null {
    // While building, every tanker draws from the one reserved source.
    const dedicated = room.memory.dedicatedBuildSourceId;
    if (dedicated) {
      const s = Game.getObjectById(dedicated as Id<Source>);
      if (s) {
        creep.memory.assignedSourceId = s.id;
        return s;
      }
    }
    if (creep.memory.assignedSourceId) {
      const s = Game.getObjectById(creep.memory.assignedSourceId as Id<Source>);
      if (s) return s;
    }
    const sources = room.find(FIND_SOURCES).sort((a, b) => a.id.localeCompare(b.id));
    if (sources.length === 0) return null;

    const load = new Map<string, number>();
    for (const t of this.tankers.members()) {
      const id = t.memory.assignedSourceId;
      if (id) load.set(id, (load.get(id) ?? 0) + 1);
    }
    let pick = sources[0];
    for (const s of sources) {
      if ((load.get(s.id) ?? 0) < (load.get(pick.id) ?? 0)) pick = s;
    }
    creep.memory.assignedSourceId = pick.id;
    return pick;
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

    // 1. Source containers first (RCL 3+): they sit on the source, are cheap to
    //    build, and turn roaming drop-mining into static mining - efficiency that
    //    lifts the whole economy.
    if (rcl >= CONTAINER_MIN_RCL) {
      const srcContainer = this.findMissingSourceContainer(room);
      if (srcContainer) {
        this.placeSite(room, srcContainer.x, srcContainer.y, STRUCTURE_CONTAINER, 0);
        return;
      }
    }

    // 2. Extensions: cheap (3000), near the sources, and they compound spawn
    //    capacity (bigger creeps) - so they come BEFORE the far controller
    //    container. Building the controller container first (it sits ~20 tiles
    //    from the sources) stalls the whole build set on one slow, hard-to-feed
    //    structure while the cheap capacity-growing extensions wait.
    const ext = this.findGridPosition(room);
    if (ext) {
      this.placeSite(room, ext.x, ext.y, STRUCTURE_EXTENSION, 100);
      return;
    }

    // 3. Controller container last: a luxury that only buffers upgrading and is
    //    expensive to feed, so it waits until the extension set is done.
    if (rcl >= CONTAINER_MIN_RCL) {
      const ctrlContainer = this.findMissingControllerContainer(room);
      if (ctrlContainer) {
        this.placeSite(room, ctrlContainer.x, ctrlContainer.y, STRUCTURE_CONTAINER, 0);
        return;
      }
    }
  }

  /** Create a construction site and record its cost. */
  private placeSite(room: Room, x: number, y: number, type: BuildableStructureConstant, cost: number): void {
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
  /**
   * A still-missing SOURCE container: a tile adjacent to a source that lacks one,
   * but only once dropped energy has piled up there (the demand signal that a
   * miner is out-producing the haulers, so a static container will pay for itself).
   * At most one per source. These sit right on the source, so they are cheap to
   * build and turn roaming drop-mining into static mining - infrastructure worth
   * placing before extensions.
   */
  private findMissingSourceContainer(room: Room): { x: number; y: number } | null {
    if (this.containerBudgetFull(room)) return null;
    for (const source of room.find(FIND_SOURCES)) {
      if (this.hasContainerNear(room, source.pos, 1)) continue;
      const pile = source.pos
        .findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY })
        .reduce((sum, r) => sum + r.amount, 0);
      if (pile < SOURCE_CONTAINER_PILE_THRESHOLD) continue;
      // Place the container on the SAME tile the miner stands on (sourceHarvestSpot),
      // so the static miner ends up standing on its own container - the drop pile,
      // the container, and the haulers' pickup all converge on one tile instead of
      // the miner dropping energy on a tile the haulers never visit.
      const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
      const spot = sourceHarvestSpot(source, spawn?.pos);
      return { x: spot.x, y: spot.y };
    }
    return null;
  }

  /**
   * A still-missing CONTROLLER container: a tile within range 2 of the controller.
   * It buffers the upgraders, but it sits far from the sources (expensive to feed
   * a builder there) and only helps upgrading - a luxury. So it is placed LAST,
   * after extensions, which are cheap, near the sources, and compound spawn
   * capacity for the whole economy.
   */
  private findMissingControllerContainer(room: Room): { x: number; y: number } | null {
    if (this.containerBudgetFull(room)) return null;
    const ctrl = room.controller;
    if (ctrl && ctrl.my && !this.hasContainerNear(room, ctrl.pos, 2)) {
      return this.bestAdjacentTile(room, ctrl.pos, 2);
    }
    return null;
  }

  /** True once the room is at its container cap (built + pending). */
  private containerBudgetFull(room: Room): boolean {
    const built = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length;
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    }).length;
    return built + sites >= CONTAINER_LIMIT;
  }

  /** Is there already a container (built or pending) within `range` of `pos`? */
  private hasContainerNear(room: Room, pos: RoomPosition, range: number): boolean {
    const containers = [
      ...room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER }),
      ...room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_CONTAINER })
    ];
    return containers.some(s => Math.max(Math.abs(s.pos.x - pos.x), Math.abs(s.pos.y - pos.y)) <= range);
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
          for (const nearSource of sources) {
            const weightedDist = this.estimatePathCost(x, y, nearSource.pos.x, nearSource.pos.y, terrain);
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
  private estimatePathCost(x1: number, y1: number, x2: number, y2: number, terrain: RoomTerrain): number {
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
        cost += 5; // Swamp costs 5x
      } else {
        cost += 1; // Plains cost 1x
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
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
    })[0];
    if (drop) {
      creep.pickup(drop);
      return;
    }
    const store = creep.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0
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
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 20
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
      filter: t => t.store[RESOURCE_ENERGY] > 0
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
      filter: r => r.store[RESOURCE_ENERGY] > 0
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
      filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 50
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
  public getCreepCount(): number {
    return this.builders.members().length;
  }

  /**
   * Get the spawn ID this corp spawns from.
   */
  public getSpawnId(): string {
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
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];
    const sites = spawn.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) return [];

    const builderDemand = this.builders.spawnDemand(this.builderPlan(ctx.energyCapacity, spawn.room));

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
      bodyParam: perTanker
    };
  }

  /**
   * How many tankers the relay needs: enough CARRY in flight to sustain the
   * builder's consumption over the refuel round-trip, never fewer than two so
   * there is always one staged for a seamless hot swap.
   */
  private targetTankerCount(room: Room, site: ConstructionSite, builders: Creep[], perTanker: number): number {
    const work = builders.reduce((sum, b) => sum + b.getActiveBodyparts(WORK), 0);
    const consumption = Math.max(5, work * 5); // energy/tick the builder eats
    const source = site.pos.findClosestByRange(FIND_SOURCES);
    const dist = source ? site.pos.getRangeTo(source) : 8;
    const roundTrip = 2 * dist + 2;
    // CARRY needed in flight to sustain consumption over the round trip, with a
    // 1.5x margin: a tanker also spends ticks transferring at the builder and
    // withdrawing at the source, so the bare round-trip figure under-delivers and
    // a far site starves its builder. The margin scales the relay with distance.
    const carryNeeded = Math.ceil((consumption * roundTrip * 1.5) / 50);
    return Math.max(2, Math.ceil(carryNeeded / perTanker));
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

  /**
   * Set construction allocations from FlowEconomy.
   * Each allocation specifies energy rate for a construction site.
   */
  public setConstructionAllocations(allocations: SinkAllocation[]): void {
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
  public getConstructionAllocations(): SinkAllocation[] {
    return this.constructionAllocations;
  }

  /**
   * Check if this corp has flow-based allocations.
   */
  public hasFlowAllocations(): boolean {
    return this.constructionAllocations.length > 0;
  }

  /**
   * Get total allocated energy rate for construction.
   */
  public getTotalAllocatedEnergy(): number {
    return this.constructionAllocations.reduce((sum, a) => sum + a.allocated, 0);
  }

  /**
   * Budgeted energy/tick: the construction allocation the plan routed here.
   * Matches recordProduction's unit (WORK*5 energy invested). 0 when unallocated
   * (or building off a dedicated source), excluding the corp from variance.
   */
  public budgetedRate(): number {
    return this.getTotalAllocatedEnergy();
  }

  /**
   * Get the highest priority construction site (from flow allocations).
   */
  public getHighestPriorityAllocation(): SinkAllocation | undefined {
    if (this.constructionAllocations.length === 0) return undefined;
    return this.constructionAllocations.reduce((best, curr) => (curr.priority > best.priority ? curr : best));
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedConstructionCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      lastPlacementAttempt: this.lastPlacementAttempt,
      targetBuilders: this.targetBuilders,
      constructionAllocations: this.constructionAllocations.length > 0 ? this.constructionAllocations : undefined
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedConstructionCorp): void {
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
export function createConstructionCorp(room: Room, spawn: StructureSpawn): ConstructionCorp {
  const nodeId = `${room.name}-construction`;
  const corp = new ConstructionCorp(nodeId, spawn.id);
  corp.balance = CONSTRUCTION_CORP_STARTING_BALANCE;
  return corp;
}
