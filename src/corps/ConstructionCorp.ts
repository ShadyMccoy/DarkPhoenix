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
import { travelTo } from "./movement";
import { plan as governorPlan } from "../execution/CpuGovernor";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { Squad, SquadPlan, splitIntoMembers } from "./Squad";
import { buildTankerBody, buildUpgraderBody } from "../spawn/BodyBuilder";
import { pickCriticalRepairTarget, wantsCriticalRecovery, wantsMaintenanceBuilder, nextRepairTarget } from "./repair";
import { MAX_BUILDERS } from "./CorpConstants";
import { Position } from "../types/Position";
import { SinkAllocation } from "../flow/FlowTypes";
import { carryPartsFor, SOURCE_RATE, sustainableConsumptionRate } from "../economy/primitives";
import { spendableBankSurplus } from "../economy/bank";
import { evaluateRoadRoute, RoadRouteSpec, UNMAINTAINED_ROAD_LIFE } from "../economy/roadEconomics";
import { bestAdjacentTile, controllerInputSpot, coreDepot, sourceHarvestSpot } from "./nodeEnergy";

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
 * Don't invest in containers (5000 build cost each) before the extension set
 * exists. At RCL 3+ they come first (static mining lifts everything). At RCL 2
 * the owner build order applies: be greedy to RCL2, then EXTENSIONS (3000,
 * compounding capacity), THEN containers - so static-mining efficiency feeds
 * the RCL3 push - and containers only unlock once the extension set is BUILT.
 *
 * A/B'd 2026-07-10 and kept as-is: a broad RCL2 container flip collapsed the
 * maze world's consumption, and even a depot-only early gate just displaced
 * the extension rung (T0 policy cell). The refill SLA is instead served by
 * the universal tender (reloads from any stock) and the near-fuel gate.
 */
const CONTAINER_MIN_RCL = 3;

/** Container rungs open at RCL3+, or at RCL2 once the extension set is built. */
function containersUnlocked(rcl: number, extensionsAtCap: boolean): boolean {
  return rcl >= CONTAINER_MIN_RCL || (rcl === 2 && extensionsAtCap);
}

/** Storage unlocks at RCL 4 (game rule). It replaces the container core depot. */
const STORAGE_MIN_RCL = 4;

/** Towers unlock at RCL 3 (CONTROLLER_STRUCTURES) - spec 07's one-tower v1. */
const TOWER_MIN_RCL = 3;

/** Links allowed per RCL (game rule). The network anchors on the storage. */
const LINK_LIMITS: { [rcl: number]: number } = { 5: 2, 6: 3, 7: 4, 8: 6 };

/**
 * Don't spend a link on a source this close to the storage: the saved haul is
 * shorter than the link's build cost + 3% transfer fee are worth.
 */
const LINK_MIN_SOURCE_RANGE = 8;

/**
 * Dropped energy (within range 1 of a source) that signals a source container is
 * worth its 5000 build cost: a pile this big means a miner is producing there
 * faster than haulers clear it, so a static container will buffer the energy (and
 * stop it decaying on the ground) instead. Tunable - lower builds containers more
 * eagerly, higher waits for clearer evidence of sustained over-production.
 */
const SOURCE_CONTAINER_PILE_THRESHOLD = 200;

/**
 * Energy value assumed for a freed spawn build-part when judging a road route
 * (see primitives.energyPerSpawnPart: ~537 for a home source, ~153 for a d=75
 * remote, ~0 when the spawn is slack). A conservative mid-range constant until
 * the corp can read the planner's actual marginal un-staffed source.
 */
const ROAD_SPAWN_PART_VALUE = 100;

/**
 * Horizon a road route must repay its build cost within: the wall-clock life
 * of an unmaintained road (50k ticks). A home room lives far longer, but a
 * route that cannot repay before its own pavement would have fully decayed is
 * not worth the maintenance commitment.
 */
const ROAD_PAYBACK_HORIZON = UNMAINTAINED_ROAD_LIFE;

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
   * The room this corp BUILDS in - its commission's room, which during an
   * expansion founding differs from the STAFFING spawn's room (spec 06: the
   * new room's corps attribute to the parent spawn until its own stands).
   * Falls back to the spawn's room without vision.
   */
  private workRoom(spawn: StructureSpawn): Room | null {
    const roomName = this.nodeId.replace(/-construction$/, "");
    const room = Game.rooms[roomName];
    if (room) return room;
    // Same-room corps always resolve; a CROSS-ROOM corp (founding, remote
    // containers) without vision must NOT fall back to the spawn's room -
    // operating on home would double the home corp's sites and demands.
    return roomName === spawn.room.name ? spawn.room : null;
  }

  /**
   * A workRoom we build in but do not own: a reserved remote-mining room
   * (spec: remote source containers). Its only construction rung is the
   * pile-gated source container - no extensions/depot/storage/links/roads,
   * no dedicated-source reservation (that would stand down the remote's own
   * haul route), no tankers (the builder eats the pile at the site, which is
   * the whole point: the build is funded by energy that was decaying anyway).
   */
  private isRemoteWorkRoom(room: Room): boolean {
    return !room.controller?.my;
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

    const workRoom = this.workRoom(spawn);
    if (!workRoom) {
      this.targetBuilders = 0;
      return;
    }
    const constructionSites = workRoom.find(FIND_MY_CONSTRUCTION_SITES);
    if (constructionSites.length === 0) {
      // Nothing to build, but containers decay - keep one builder while any needs
      // repair, so a finished (RCL-maxed) room still maintains its containers.
      this.targetBuilders = this.wantsMaintenance(workRoom) ? 1 : 0;
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

    const room = this.workRoom(spawn);
    if (!room) return; // cross-room corp without vision this tick
    const controller = room.controller;
    if (!controller) return;

    if (this.isRemoteWorkRoom(room)) {
      // Remote rung: one source container at a time, triggered by the pile
      // threshold (findMissingSourceContainer), built from that same pile.
      if (room.find(FIND_MY_CONSTRUCTION_SITES).length === 0) {
        const spot = this.findMissingSourceContainer(room);
        if (spot) this.placeSite(room, spot.x, spot.y, STRUCTURE_CONTAINER);
      }
      this.builders.run(creep => this.runBuilder(creep, room), spawn);
      return;
    }

    // Build one structure at a time (a queue, not a spread): only place the next
    // construction site when there are NO active sites in the room. Concentrating
    // all builder/hauler effort on a single site finishes it sooner (capacity
    // grows incrementally) instead of inching dozens of sites forward at once.
    const rcl = controller.level;
    const maxExtensions = EXTENSION_LIMITS[rcl] || 0;
    const currentExtensions = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_EXTENSION
    }).length;
    // ROAD sites don't hold the queue: a paving project is linear, cheap per
    // segment, and built by scavenging en route - letting it block the next
    // STRUCTURE kept the pipeline world depot-less for 1500+ ticks while the
    // remote route paved (refill SLA breach: the tender's reload stayed a
    // full haul away).
    // TOWER sites don't hold it either (spec 07): the tower is a security
    // fixture placed early in the ladder, and a pending 600-energy site must
    // not stall the storage/extension pipeline behind it while the room's
    // builder fleet ramps (measured: storage-depot regression - the tower
    // site parked the queue for 900+ ticks in a builder-less world).
    const activeSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: s => s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_TOWER
    }).length;

    const wantsContainer =
      containersUnlocked(rcl, currentExtensions >= maxExtensions) &&
      (this.findMissingSourceContainer(room) !== null ||
        this.findMissingCoreDepot(room) !== null ||
        this.findMissingControllerContainer(room) !== null);
    const wantsStorage = this.findMissingStorage(room, rcl) !== null;
    const wantsLink = this.findMissingLink(room, rcl) !== null;
    const wantsTower = this.findMissingTower(room, rcl) !== null;
    const canBuildMore =
      activeSites === 0 &&
      (currentExtensions < maxExtensions ||
        wantsContainer ||
        wantsStorage ||
        wantsLink ||
        wantsTower ||
        this.wantsRoadWork(room));

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
    // Only once a builder is actually fielded (or spawning): reserving earlier
    // strands the source's output - its haulers stand down, income drops, and the
    // poorer spawn then can't fund the very builder the reservation is waiting
    // for. Supply before demand, same as the upgrader gate.
    // ROAD sites don't count: a paving project is cheap, linear, and lies along
    // an existing haul route, so the builder scavenges locally (doPickup /
    // refuelInPlace) instead of commandeering a source - reserving one stands
    // down that route's haulers and starves the room's delivery (measured: the
    // tender-bus T4 world, where the reservation broke the extension bus).
    const structureSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: s => s.structureType !== STRUCTURE_ROAD
    }).length;
    this.updateDedicatedSource(room, structureSites > 0 && this.builders.count() > 0);

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
    // Never strand the site: only heal a runt once a sibling exists (see
    // Squad.flagRuntForRecycling - the lone-builder recycle loop measured live).
    if (builders.length < 2 || builders.some(b => b.memory.recycling)) return;

    const plan = this.builderPlan(room.energyCapacityAvailable, room);
    if (room.energyAvailable < plan.desiredCost) return;

    const runt = builders.find(b => b.getActiveBodyparts(WORK) < (plan.maxPartsPerMember ?? 1));
    if (runt) runt.memory.recycling = true;
  }

  /**
   * Energy ACTUALLY on the build side: the dedicated source's container and
   * pile, plus containers/piles around the active site. What the crew can
   * really burn - primitive piles and proper structures alike.
   */
  private buildSideStock(room: Room): number {
    let stock = 0;
    const around = (pos: RoomPosition, range: number): void => {
      for (const s of pos.findInRange(FIND_STRUCTURES, range)) {
        if (s.structureType === STRUCTURE_CONTAINER) {
          stock += (s as StructureContainer).store[RESOURCE_ENERGY];
        }
      }
      for (const r of pos.findInRange(FIND_DROPPED_RESOURCES, range)) {
        if (r.resourceType === RESOURCE_ENERGY) stock += r.amount;
      }
    };
    const dedicated = room.memory.dedicatedBuildSourceId;
    if (dedicated) {
      const src = Game.getObjectById(dedicated as Id<Source>);
      if (src) around(src.pos, 2);
    }
    const site = room.find(FIND_MY_CONSTRUCTION_SITES)[0];
    if (site) around(site.pos, 3);
    return stock;
  }

  private builderPlan(energyCapacity: number, room: Room): SquadPlan {
    // Energy the crew should consume: the flow's construction allocation, OR -
    // when a whole source is reserved for the builder - that source's full output
    // (which all flows to construction). Sizing to the dedicated source lets the
    // crew actually use it (a 10/tick source -> a 2-WORK builder) instead of being
    // capped at the flow's smaller nominal share and leaving the source half-idle.
    let buildEnergy = this.getTotalAllocatedEnergy();
    // A remote workRoom gets NO flow allocation (the solver only admits owned
    // rooms' sites) and needs none: the crew is funded entirely by the source
    // pile at the site, so let the stock cap below be the sizing authority.
    if (this.isRemoteWorkRoom(room)) buildEnergy = Number.POSITIVE_INFINITY;
    const dedicated = room.memory.dedicatedBuildSourceId;
    if (dedicated) {
      const src = Game.getObjectById(dedicated as Id<Source>);
      if (src) buildEnergy = Math.max(buildEnergy, src.energyCapacity / ENERGY_REGEN_TIME);
    }
    // STOCK-GROUNDED (owner doctrine 2026-07-10): the crew is sized to the
    // FUEL that actually reaches the build side - depot + dedicated-source
    // stocks drained over a creep lifetime plus the reserve trickle - capped
    // by the plan's allocation above. An allocation-sized crew with no real
    // fuel is dead apparatus: measured on W2N6 as 20 e/t of builder capacity
    // (plus a 6-tanker relay) fed ~4 e/t. Under-fueled sites keep the crew
    // small and the spawn on the supply side; accumulated stock scales it up.
    const fuel = this.buildSideStock(room);
    buildEnergy = Math.max(5, Math.min(buildEnergy, sustainableConsumptionRate(fuel, 5)));
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

    // Owner build order: at RCL2 the container rungs open only once the
    // extension SET IS BUILT (sites don't count) - extensions, then
    // containers, then the RCL3 push.
    const builtExtensions = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_EXTENSION
    }).length;
    const containersOpen = containersUnlocked(rcl, builtExtensions >= (EXTENSION_LIMITS[rcl] || 0));

    // 1. Source containers first (when the rung is open): they sit on the
    //    source, are cheap to build, and turn roaming drop-mining into static
    //    mining - efficiency that lifts the whole economy.
    if (containersOpen) {
      const srcContainer = this.findMissingSourceContainer(room);
      if (srcContainer) {
        this.placeSite(room, srcContainer.x, srcContainer.y, STRUCTURE_CONTAINER);
        return;
      }
    }

    // 1.5 Core depot: a container beside the spawn. Haulers dump into it and the
    //     extension tender drains it to fill the extensions - the split that keeps
    //     the long-range haulers off the extensions (no schooling). Comes right
    //     after source containers so the tender has somewhere to draw from early.
    if (containersOpen) {
      const depot = this.findMissingCoreDepot(room);
      if (depot) {
        this.placeSite(room, depot.x, depot.y, STRUCTURE_CONTAINER);
        return;
      }
    }

    // 1.7 Controller container JUMPS the queue in the surplus-spend regime
    //     (spec 03 withdrawal): with the warchest full, the feeder relays the
    //     bank draw plus the upgrade target through the drop-off - 30+ e/t
    //     across a bare tile whose pile decays ~2 e/t forever. The 5k
    //     container pays for itself in ~2500 ticks and every rung below waits
    //     one 5k build. While the warchest is still FILLING the ladder is
    //     unchanged (rung 3 below) - cons-ext-before-ctrl-container and
    //     cons-link-core-first pin that ordering.
    if (containersOpen && room.storage?.my && spendableBankSurplus(room.storage.store.energy ?? 0) > 0) {
      const ctrlContainer = this.findMissingControllerContainer(room);
      if (ctrlContainer) {
        this.placeSite(room, ctrlContainer.x, ctrlContainer.y, STRUCTURE_CONTAINER);
        return;
      }
    }

    // 1.8 Tower (RCL 3, spec 07 - owner directive 2026-07-17 "at home, we
    //     will build towers"): the room's entire NPC defense. Between the core
    //     depot and extensions: the engine's raid table only sends 50-part
    //     "big" invaders to OWNED rooms at RCL4+, so one tower placed at RCL3
    //     precedes every threat class it must answer. Near the spawn so the
    //     extension tender can reach it.
    const tower = this.findMissingTower(room, rcl);
    if (tower) {
      this.placeSite(room, tower.x, tower.y, STRUCTURE_TOWER);
      return;
    }

    // 2. Extensions: cheap (3000), near the sources, and they compound spawn
    //    capacity (bigger creeps) - so they come BEFORE the far controller
    //    container. Building the controller container first (it sits ~20 tiles
    //    from the sources) stalls the whole build set on one slow, hard-to-feed
    //    structure while the cheap capacity-growing extensions wait.
    //    Cap-guarded here (not just in work()'s gate): when the gate opens for a
    //    wanted container/storage with extensions already maxed, attempting an
    //    over-cap extension would fail every cooldown and starve the later steps.
    if (builtExtensions < (EXTENSION_LIMITS[rcl] || 0)) {
      const ext = this.findGridPosition(room);
      if (ext) {
        this.placeSite(room, ext.x, ext.y, STRUCTURE_EXTENSION);
        return;
      }
    }

    // 2.5 Storage (RCL 4): the colony's bank and the durable core depot. It
    //     replaces the fragile 2000-cap container depot with a structure that can
    //     hold a real reserve (spawn-surge and downgrade insurance). After the
    //     extension set (capacity compounds first), before the controller
    //     container (a luxury).
    const storage = this.findMissingStorage(room, rcl);
    if (storage) {
      this.placeSite(room, storage.x, storage.y, STRUCTURE_STORAGE);
      return;
    }

    // 2.7 Links (RCL 5): a core link beside the storage, then a source link at
    //     the farthest source - the pair replaces that source's long haul with an
    //     instant transfer (see execution/LinkRunner).
    const link = this.findMissingLink(room, rcl);
    if (link) {
      this.placeSite(room, link.x, link.y, STRUCTURE_LINK);
      return;
    }

    // 3. Controller container last: it buffers the upgrade push (containerFed
    //    upgraders draw from it), so under the owner build order it lands at
    //    RCL2 right before the RCL3 push - after extensions and the mining
    //    containers.
    if (containersOpen) {
      const ctrlContainer = this.findMissingControllerContainer(room);
      if (ctrlContainer) {
        this.placeSite(room, ctrlContainer.x, ctrlContainer.y, STRUCTURE_CONTAINER);
        return;
      }
    }

    // 4. Roads dead last: they are efficiency, not capacity, and they pay only
    //    over long horizons - so every capacity structure the RCL allows comes
    //    first. Each source->depot haul route is judged by roadEconomics and
    //    paved as a batch (roads are 300/tile; dribbling them one per cooldown
    //    through the one-site-at-a-time gate would take forever).
    if (containersOpen) {
      this.tryPlaceRoadRoute(room);
    }
  }

  /**
   * Cheap gate for work(): is there road work outstanding - a source with a
   * container (a stable route endpoint) whose route has no paving verdict yet,
   * or a planned route whose tiles are not all built?
   */
  private wantsRoadWork(room: Room): boolean {
    for (const source of room.find(FIND_SOURCES)) {
      const entry = room.memory.roadRoutes?.[source.id];
      if (entry?.paved || entry?.declined) continue;
      if (this.hasContainerNear(room, source.pos, 1)) return true;
    }
    return false;
  }

  /**
   * Pave the best un-verdicted source->depot route, one route at a time. A
   * route only becomes a candidate once its source has a container (static
   * mining established - the endpoints won't move), and only paves when
   * roadEconomics says the build cost repays within ROAD_PAYBACK_HORIZON,
   * with freed spawn parts monetized at ROAD_SPAWN_PART_VALUE. Verdicts are
   * cached in room memory: `paved` once every tile has a built road (the
   * receipt the 2:1 hauler-ratio wiring reads), `declined` when not worth it.
   */
  private tryPlaceRoadRoute(room: Room): void {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;
    const depotPos = room.storage?.pos ?? spawn.pos;
    const routes = (room.memory.roadRoutes = room.memory.roadRoutes ?? {});

    for (const source of room.find(FIND_SOURCES)) {
      if (!this.hasContainerNear(room, source.pos, 1)) continue;
      const entry = routes[source.id];
      if (entry?.paved || entry?.declined) continue;

      if (entry) {
        // Route already planned: finish it (re-place any missing sites) or
        // stamp the paved receipt once every tile has a built road. This is
        // the current project's bookkeeping, so it is NOT repair-gated.
        if (this.roadTilesBuilt(room, entry.tiles)) {
          entry.paved = true;
          console.log(`[Construction] Route to source ${source.id} fully paved`);
          continue;
        }
        this.placeMissingRoadSites(room, entry.tiles);
        return;
      }

      // Starting a NEW paving project yields to repair: placing sites pulls
      // the builder off maintenance (repair only runs with zero sites), so
      // wait until nothing wants a repairer - wantsMaintenance carries the
      // hysteresis (a fielded builder keeps repairing to the 99% ceiling; a
      // mid-repair room must not have its builder yanked onto roadworks the
      // moment the worst structure crosses the 60% start gate).
      if (this.wantsMaintenance(room)) return;

      // Paving is a SURPLUS investment: in a demand-saturated room (organic
      // spawning consuming the whole income) a paving project tips the spawn
      // network into the critical failsafe and disrupts delivery (measured:
      // the tender-bus T4 world). A full spawn bank is the cheap observable
      // that income currently exceeds spawn demand; the placement cooldown
      // retries every 10 ticks, so a healthy room catches a full-bank tick
      // between spawns soon enough.
      if (room.energyAvailable < room.energyCapacityAvailable) return;

      const tiles = this.planRoadPath(room, source, depotPos, spawn.pos);
      if (!tiles) continue;
      const verdict = evaluateRoadRoute(this.roadRouteSpec(room, tiles), ROAD_PAYBACK_HORIZON, ROAD_SPAWN_PART_VALUE);
      if (!verdict.worthPaving) {
        routes[source.id] = { tiles: [], declined: true };
        continue;
      }
      const flat: number[] = [];
      for (const t of tiles) flat.push(t.x, t.y);
      routes[source.id] = { tiles: flat };
      const placed = this.placeMissingRoadSites(room, flat);
      console.log(
        `[Construction] Paving route to source ${source.id}: ${tiles.length} tiles ` +
          `(${placed} sites), payback ~${Math.round(verdict.paybackTicks)}t`
      );
      return; // one route at a time - the builders finish this before the next
    }
  }

  /**
   * The hauler path from the source's harvest spot (exclusive - the container
   * tile needs no road, the miner is static) to range 1 of the depot. Costs
   * mirror an unpaved hauler's terrain weights, with existing roads at 1 so new
   * pavement reuses old, and blocking structures/sites impassable.
   */
  private planRoadPath(
    room: Room,
    source: Source,
    depotPos: RoomPosition,
    spawnPos: RoomPosition
  ): { x: number; y: number }[] | null {
    const spot = sourceHarvestSpot(source, spawnPos);
    const origin = new RoomPosition(spot.x, spot.y, room.name);
    const result = PathFinder.search(
      origin,
      { pos: depotPos, range: 1 },
      { plainCost: 2, swampCost: 10, maxRooms: 1, roomCallback: () => this.roadPlanningCosts(room) }
    );
    if (result.incomplete || result.path.length === 0) return null;
    return result.path.map(p => ({ x: p.x, y: p.y }));
  }

  /** Cost matrix for road planning: existing roads 1, blocking structures 255. */
  private roadPlanningCosts(room: Room): CostMatrix {
    const costs = new PathFinder.CostMatrix();
    const walkable = (type: StructureConstant): boolean =>
      type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER || type === STRUCTURE_RAMPART;
    for (const s of room.find(FIND_STRUCTURES)) {
      if (s.structureType === STRUCTURE_ROAD) costs.set(s.pos.x, s.pos.y, 1);
      else if (!walkable(s.structureType)) costs.set(s.pos.x, s.pos.y, 0xff);
    }
    for (const s of room.find(FIND_MY_CONSTRUCTION_SITES)) {
      if (!walkable(s.structureType)) costs.set(s.pos.x, s.pos.y, 0xff);
    }
    return costs;
  }

  /** RoadRouteSpec for a planned path: swamp counted from terrain, flow = source rate. */
  private roadRouteSpec(room: Room, tiles: { x: number; y: number }[]): RoadRouteSpec {
    const terrain = room.getTerrain();
    let swampTiles = 0;
    for (const t of tiles) {
      if (terrain.get(t.x, t.y) & TERRAIN_MASK_SWAMP) swampTiles++;
    }
    return { plainTiles: tiles.length - swampTiles, swampTiles, flow: SOURCE_RATE };
  }

  /** Place road sites on planned tiles lacking both a road and a site. Returns count placed. */
  private placeMissingRoadSites(room: Room, flat: number[]): number {
    if (governorPlan().pauseConstruction) return 0; // CPU governor: paving is investment
    let placed = 0;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const x = flat[i];
      const y = flat[i + 1];
      const covered =
        room.lookForAt(LOOK_STRUCTURES, x, y).some(s => s.structureType === STRUCTURE_ROAD) ||
        room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).some(s => s.structureType === STRUCTURE_ROAD);
      if (covered) continue;
      if (room.createConstructionSite(x, y, STRUCTURE_ROAD) === OK) placed++;
    }
    return placed;
  }

  /** True when every planned tile has a BUILT road. */
  private roadTilesBuilt(room: Room, flat: number[]): boolean {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (!room.lookForAt(LOOK_STRUCTURES, flat[i], flat[i + 1]).some(s => s.structureType === STRUCTURE_ROAD)) {
        return false;
      }
    }
    return true;
  }

  /** Create a construction site. */
  private placeSite(room: Room, x: number, y: number, type: BuildableStructureConstant): void {
    // CPU governor (spec 09 ph5): under austere degradation, NEW investment
    // pauses - existing sites keep building, the income core keeps running.
    if (governorPlan().pauseConstruction) return;
    const result = room.createConstructionSite(x, y, type);
    if (result === OK) {
      console.log(`[Construction] Placed ${type} site at ${room.name} (${x}, ${y})`);
    } else {
      console.log(`[Construction] Failed to place ${type} at ${room.name} (${x}, ${y}): ${result}`);
    }
  }

  /**
   * The core depot: a container tile beside the spawn (the haulers' drop-off and
   * the extension tender's draw point). Null when one already exists adjacent to a
   * spawn (a source container next to the spawn doubles as the depot) or the room
   * is at its container cap.
   */
  private findMissingCoreDepot(room: Room): { x: number; y: number } | null {
    if (room.storage) return null; // storage IS the depot - no container needed
    if (this.containerBudgetFull(room)) return null;
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return null;
    if (this.hasContainerNear(room, spawn.pos, 1)) return null;
    const tile = bestAdjacentTile(room, spawn.pos, 1, spawn.pos, STRUCTURE_CONTAINER);
    return tile ? { x: tile.x, y: tile.y } : null;
  }

  /**
   * A still-missing STORAGE: the room is RCL 4+ and has neither a storage nor a
   * storage site. Placed within 2 of the spawn so it slots straight into the
   * depot role (haulers' dump point, tender's draw point) without changing any
   * routes - coreDepot() prefers it over the container from the moment it's built.
   */
  /**
   * A still-missing TOWER (spec 07 v1: one per room from RCL3). Beside the
   * spawn - pattern of findMissingStorage - so the tender's fill circuit
   * covers it without a dedicated runner.
   */
  private findMissingTower(room: Room, rcl: number): { x: number; y: number } | null {
    if (rcl < TOWER_MIN_RCL) return null;
    const hasTower =
      room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).length > 0 ||
      room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER }).length > 0;
    if (hasTower) return null;
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return null;
    const tile = bestAdjacentTile(room, spawn.pos, 3, spawn.pos, STRUCTURE_TOWER);
    return tile ? { x: tile.x, y: tile.y } : null;
  }

  private findMissingStorage(room: Room, rcl: number): { x: number; y: number } | null {
    if (rcl < STORAGE_MIN_RCL || room.storage) return null;
    const hasSite =
      room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_STORAGE }).length > 0;
    if (hasSite) return null;
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return null;
    const tile = bestAdjacentTile(room, spawn.pos, 2, spawn.pos, STRUCTURE_STORAGE);
    return tile ? { x: tile.x, y: tile.y } : null;
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
   * A still-missing LINK (RCL 5+). The network anchors on the storage: first a
   * CORE link beside it (the receiving end - the others are useless without it),
   * then one link per far source, farthest first (longest haul saved), adjacent
   * to the harvest spot so the standing miner can feed it without moving.
   */
  private findMissingLink(room: Room, rcl: number): { x: number; y: number } | null {
    const limit = LINK_LIMITS[rcl] ?? 0;
    if (limit === 0) return null;
    const storage = room.storage;
    if (!storage) return null;

    const links = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_LINK
    }) as StructureLink[];
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_LINK });
    const all: { pos: RoomPosition }[] = [...links, ...sites];
    if (all.length >= limit) return null;

    const linkNear = (pos: RoomPosition, range: number): boolean => all.some(l => l.pos.inRangeTo(pos, range));

    // 1) Core link beside the storage.
    if (!linkNear(storage.pos, 2)) {
      const tile = bestAdjacentTile(room, storage.pos, 1, storage.pos, STRUCTURE_LINK);
      return tile ? { x: tile.x, y: tile.y } : null;
    }

    // 2) Source links, farthest first; nearby sources aren't worth one.
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    const candidates = room
      .find(FIND_SOURCES)
      .filter(s => !linkNear(s.pos, 2) && s.pos.getRangeTo(storage.pos) > LINK_MIN_SOURCE_RANGE)
      .sort((a, b) => b.pos.getRangeTo(storage.pos) - a.pos.getRangeTo(storage.pos));
    for (const source of candidates) {
      const spot = sourceHarvestSpot(source, spawn?.pos);
      const tile = bestAdjacentTile(room, spot, 1, spawn?.pos, STRUCTURE_LINK);
      if (tile) return { x: tile.x, y: tile.y };
    }
    return null;
  }

  /**
   * A still-missing CONTROLLER container: the RCL drop-off's own buffer. It lands
   * ON the drop-off tile itself (controllerInputSpot), so the hauler's pile, the
   * container, and the upgraders' draw point converge on ONE tile - the same
   * convergence sourceHarvestSpot gives the source container - rather than a
   * spawn-nearest tile the pile never reaches.
   *
   * Unlike the source container this is NOT pile-gated. It sits LAST in the ladder
   * (after extensions, storage, and links), and once the ladder completes we do
   * not want to plan around energy piling on the ground at the drop-off - so it
   * builds regardless of the drop-off pile. It buffers the upgraders but sits far
   * from the sources (expensive to feed a builder there) and only helps upgrading,
   * hence the last-place slot behind the capacity structures.
   */
  private findMissingControllerContainer(room: Room): { x: number; y: number } | null {
    if (this.containerBudgetFull(room)) return null;
    const ctrl = room.controller;
    if (!ctrl || !ctrl.my) return null;
    // controllerInputSpot resolves an existing container/link within range 3; if
    // one already buffers the drop-off (or a storage serves), no new container is
    // wanted.
    const input = controllerInputSpot(ctrl);
    if (input.structure) return null;
    return { x: input.pos.x, y: input.pos.y };
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

    // ENERGY HUBS stay clear (owner 2026-07-10: extensions built around a
    // drop spot boxed the haulers in on each other): the core depot and the
    // controller input are high-traffic exchange tiles - keep a 1-tile ring
    // of walking room around each.
    const hubRing = (pos: { x: number; y: number } | undefined): void => {
      if (!pos) return;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          avoidPositions.add(`${pos.x + dx},${pos.y + dy}`);
        }
      }
    };
    const depot = coreDepot(room);
    hubRing(depot ? { x: depot.pos.x, y: depot.pos.y } : undefined);
    if (room.controller) {
      const input = controllerInputSpot(room.controller);
      hubRing(input ? { x: input.pos.x, y: input.pos.y } : undefined);
    }

    // CLUSTER placement (owner directive 2026-07-09: "proximity to OTHER
    // extensions and spawns should be a big factor - all in one area so we
    // can refill them efficiently"). The refill chain is haulers -> core
    // depot (beside the spawn) -> tender -> extensions, so the refill cost
    // is the tender's depot<->extension round trip: spawn proximity and
    // cluster tightness are the whole price, and SOURCE distance is
    // irrelevant (haulers deliver to the depot wherever extensions sit).
    // The old source-centered scorer scattered extensions into per-source
    // patches the tender had to tour.
    const spawnPos = spawns[0]?.pos;
    if (!spawnPos) return null;
    const clusterPoints: Array<{ x: number; y: number }> = [];
    for (const s of structures) {
      if (s.structureType === STRUCTURE_EXTENSION) clusterPoints.push({ x: s.pos.x, y: s.pos.y });
    }
    for (const s of sites) {
      if (s.structureType === STRUCTURE_EXTENSION) clusterPoints.push({ x: s.pos.x, y: s.pos.y });
    }

    // Checkerboard tiles within tender range of the spawn.
    for (let dx = -8; dx <= 8; dx++) {
      for (let dy = -8; dy <= 8; dy++) {
        const distToSpawn = Math.max(Math.abs(dx), Math.abs(dy));
        if (distToSpawn < 2) continue; // keep the spawn ring clear

        const x = spawnPos.x + dx;
        const y = spawnPos.y + dy;
        if (x < 2 || x > 47 || y < 2 || y > 47) continue;
        if ((x + y) % 2 !== 0) continue; // checkerboard for walkability
        const terrainType = terrain.get(x, y);
        if (terrainType === TERRAIN_MASK_WALL) continue;
        if (avoidPositions.has(`${x},${y}`)) continue;

        // At least 3 walkable neighbors (path connectivity)
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

        // Tight cluster: near the spawn AND near the extensions we already
        // have. Cohesion weighs as much as spawn proximity so the mass grows
        // outward ring by ring instead of sprinkling the whole radius; a
        // small swamp penalty breaks ties toward plains.
        let cohesion = 0;
        if (clusterPoints.length > 0) {
          for (const p of clusterPoints) {
            cohesion += Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
          }
          cohesion /= clusterPoints.length;
        }
        const swampPenalty = terrainType === TERRAIN_MASK_SWAMP ? 2 : 0;
        const score = 100 - distToSpawn * 3 - cohesion * 3 - swampPenalty;
        candidates.push({ x, y, score });
      }
    }

    if (candidates.length === 0) return null;

    // Deterministic best: score, then y, then x.
    candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
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
  /** Everything the corp maintains: containers plus roads (both decay). */
  private roomRepairables(room: Room): (StructureContainer | StructureRoad)[] {
    return room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD
    }) as (StructureContainer | StructureRoad)[];
  }

  /** Whether to field/keep a maintenance builder for decaying structures (hysteresis). */
  private wantsMaintenance(room: Room): boolean {
    return wantsMaintenanceBuilder(this.roomRepairables(room), this.builders.count() > 0);
  }

  /**
   * A structure decayed into the critical band (about to expire) that a builder
   * must rescue even while construction sites are outstanding, or null when the
   * room's decaying structures are all healthier than the critical gate.
   */
  private findCriticalRepairTarget(room: Room): StructureContainer | StructureRoad | null {
    return pickCriticalRepairTarget(this.roomRepairables(room));
  }

  /** Whether a mid-diversion builder should keep repairing (see wantsCriticalRecovery). */
  private wantsCriticalRecovery(room: Room): boolean {
    return wantsCriticalRecovery(this.roomRepairables(room));
  }

  /**
   * Maintain decaying structures when there is nothing to build. Containers fuel
   * the builder themselves (they hold energy), so maintenance needs no tanker;
   * roads hold nothing, so a road target sends the builder to the nearest energy
   * instead. It fully repairs one structure (latched, most-decayed first) to the
   * ceiling before starting the next, until all reach the ceiling - at which point
   * nextRepairTarget returns null and the builder idles to be recycled.
   */
  private doMaintenance(creep: Creep, room: Room): void {
    // Latch onto one structure and repair it to the ceiling before switching, so
    // the builder finishes a structure instead of ping-ponging to whichever is
    // momentarily most decayed (see nextRepairTarget).
    const target = nextRepairTarget(this.roomRepairables(room), creep.memory.repairTargetId);
    if (!target) {
      delete creep.memory.repairTargetId; // all healthy: idle until plan() retires this builder
      return;
    }
    creep.memory.repairTargetId = target.id;

    if (creep.store[RESOURCE_ENERGY] === 0) {
      this.refuelForMaintenance(creep, target);
      return;
    }

    const result = creep.repair(target);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#00ff88" } });
    }
  }

  /**
   * Fuel for a repair job: the target itself when it holds energy (containers),
   * otherwise - roads, or a drained container - the nearest drop, container, or
   * storage. Roads pave haul routes, so there is energy at both ends by design.
   */
  private refuelForMaintenance(creep: Creep, target: StructureContainer | StructureRoad): void {
    const targetStore = (target as StructureContainer).store;
    if (targetStore && targetStore[RESOURCE_ENERGY] > 0) {
      if (creep.withdraw(target as StructureContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#00ff88" } });
      }
      return;
    }

    const drop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 20
    });
    if (drop) {
      if (creep.pickup(drop) === ERR_NOT_IN_RANGE) {
        creep.moveTo(drop, { visualizePathStyle: { stroke: "#00ff88" } });
      }
      return;
    }

    const store = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: s =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        (s as StructureContainer).store[RESOURCE_ENERGY] > 0
    }) as StructureContainer | StructureStorage | null;
    if (store) {
      if (creep.withdraw(store, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(store, { range: 1, visualizePathStyle: { stroke: "#00ff88" } });
      }
    }
  }

  private runBuilder(creep: Creep, room: Room): void {
    // No construction sites: switch to container maintenance (fuel from + repair the
    // most decayed container) instead of standing idle.
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) {
      delete creep.memory.repairingCritical;
      this.doMaintenance(creep, room);
      return;
    }

    // EMERGENCY REPAIR outranks building: ordinary maintenance is gated off
    // entirely while any site exists (the builder builds one site at a time and
    // only maintains a fully-built room), so a structure that decays past the
    // critical gate mid-build would head to expiry with nothing repairing it.
    // Divert the crew to rescue it, latched with hysteresis (repair up out of the
    // idle-maintenance band before resuming) so it doesn't thrash between a far
    // site and the container each tick it dips past the start gate.
    if (creep.memory.repairingCritical) {
      if (this.wantsCriticalRecovery(room)) {
        this.doMaintenance(creep, room);
        return;
      }
      delete creep.memory.repairingCritical;
    } else if (this.findCriticalRepairTarget(room)) {
      creep.memory.repairingCritical = true;
      this.doMaintenance(creep, room);
      return;
    }

    // A founding crew works OUT OF ITS SITE ROOM: the hauler founding lane
    // delivers energy at the site, not at the parent spawn, so walk over
    // first instead of idling at home waiting to fill (measured: ~600 ticks
    // of parent-room dawdling before the first cross-border trip).
    if (creep.room.name !== room.name) {
      travelTo(creep, new RoomPosition(sites[0].pos.x, sites[0].pos.y, room.name), {
        range: 3,
        visualizePathStyle: { stroke: "#ffaa00" }
      });
      return;
    }

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

    // A founding crew's site is in ANOTHER room (spec 06: the corp's workRoom
    // differs from its staffing spawn's room). findClosestByPath is same-room
    // only - it returns null from home - so walk the border first.
    if (creep.room.name !== room.name) {
      travelTo(creep, new RoomPosition(sites[0].pos.x, sites[0].pos.y, room.name), {
        range: 3,
        visualizePathStyle: { stroke: "#ffaa00" }
      });
      return;
    }

    const target = creep.pos.findClosestByPath(sites) ?? sites[0];
    if (!target) return;

    const result = creep.build(target);
    if (result === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
    } else if (result === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
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

    // No energy in reach: park beside the site instead of freezing where we
    // stand - deliveries (home tankers, the founding hauler lane) land AT the
    // site, and a builder stranded outside doPickup's range-4 scan starves
    // next to nothing (measured: the founding builder deadlocked empty on the
    // border tile all window).
    const site = _room.find(FIND_MY_CONSTRUCTION_SITES)[0];
    if (site && creep.pos.getRangeTo(site.pos) > PICKUP_RANGE) {
      creep.moveTo(site.pos, { range: 2, visualizePathStyle: { stroke: "#ffaa00" } });
    }
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
   * Rebind to the commission's CURRENT spawn. The spawn id is commission-owned
   * state: a persisted corp outlives spawns (measured live: an immortal
   * upgrade/construction corp carried a dead spawn's id for good, so
   * collectDemands dropped its demands forever - 0 upgraders/builders while
   * the plan begged for them). Every kind's materialize() refreshes this.
   */
  public setSpawnId(spawnId: string): void {
    this.spawnId = spawnId;
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
    const workRoom = this.workRoom(spawn);
    if (!workRoom) return [];
    const sites = workRoom.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) {
      // No sites, but containers decay: field one small builder to maintain them.
      // It self-fuels at the container, so no tankers are needed (hence we return
      // only the builder demand here, never the feeder demand below).
      if (!this.wantsMaintenance(workRoom)) return [];
      return this.builders.spawnDemand(this.builderPlan(ctx.energyCapacity, workRoom));
    }

    const builderDemand = this.builders.spawnDemand(this.builderPlan(ctx.energyCapacity, workRoom));

    // Get the first builder on the field before requesting feeders for it.
    if (this.builders.count() < 1) return builderDemand;

    // A remote workRoom never fields feeders: the builder eats the source
    // pile at the site, and a tanker's home-side refuel loop would just walk
    // energy across the border that the pile already provides for free.
    if (this.isRemoteWorkRoom(workRoom)) return builderDemand;

    const tankerDemand = this.tankers.spawnDemand(this.tankerPlan(ctx, workRoom, sites[0]));
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
    // CARRY needed in flight to sustain consumption over the round trip, with a
    // 1.5x margin: a tanker also spends ticks transferring at the builder and
    // withdrawing at the source, so the bare round-trip figure under-delivers and
    // a far site starves its builder. The margin scales the relay with distance.
    const carryNeeded = Math.ceil(carryPartsFor(consumption, dist) * 1.5);
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

/**
 * Create a ConstructionCorp for a room.
 */
export function createConstructionCorp(room: Room, spawn: StructureSpawn): ConstructionCorp {
  const nodeId = `${room.name}-construction`;
  const corp = new ConstructionCorp(nodeId, spawn.id);
  return corp;
}
