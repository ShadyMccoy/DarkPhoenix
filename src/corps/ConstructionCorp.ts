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
import { carryPartsFor, projectAbsorbRate, SOURCE_RATE, sustainableConsumptionRate } from "../economy/primitives";
import { feederRelayRate, spendableBankSurplus } from "../economy/bank";
import {
  declinedVerdictStands,
  evaluateRoadRoute,
  ROAD_BUILD_COST,
  RoadRouteSpec,
  UNMAINTAINED_ROAD_LIFE
} from "../economy/roadEconomics";
import { bestAdjacentTile, controllerInputSpot, controllerLink, coreDepot, coreLink, isRoomEdgeTile, isSourceApproachTile, sourceHarvestSpot, sourceLink } from "./nodeEnergy";
import { roomLinearDistance } from "../utils/RoomDiscovery";

/**
 * One entry of the corp's PROJECT LEDGER (the observe-and-remember pattern,
 * owner 2026-07-22: "construction sites should be part of the corps memory
 * so it can rehydrate and bypass Vision. That's a general pattern we should
 * work towards - similar to staffsPost"): a durable record of a standing
 * construction site, written/refreshed whenever its room is SIGHTED, read
 * by decisions (the plan's sink admission) regardless of vision. Ground
 * truth wins on sight; a record unseen for PROJECT_LEDGER_DECAY retires
 * (hostiles can stomp sites in unowned rooms while we are blind).
 */
export interface ProjectRecord {
  id: string;
  x: number;
  y: number;
  roomName: string;
  structureType: string;
  /** Energy remaining (progressTotal - progress) at last sight. */
  remaining: number;
  /** Tick of last reconciliation against vision. */
  seen: number;
}

/** Ticks a ledger record survives without sight before it retires. */
export const PROJECT_LEDGER_DECAY = 10_000;

/**
 * Serialized state specific to ConstructionCorp
 */
export interface SerializedConstructionCorp extends SerializedCorp {
  spawnId: string;
  lastPlacementAttempt: number;
  targetBuilders: number;
  /** Flow-based construction allocations (from FlowEconomy) */
  constructionAllocations?: SinkAllocation[];
  /** Spec 25 phase 3: source-funded remote-cluster rate for the pool crew */
  poolAllocatedRate?: number;
  /** The project ledger (pattern above). */
  projects?: ProjectRecord[];
}

/**
 * THE ONE LENS for "what construction projects stand, colony-wide" - read
 * from the serialized corp store in Memory (durable across resets, never
 * vision-gated), deduped by site id across corps. The plan's sink
 * admission, crew reasoning and telemetry must all read THIS, never scan
 * Game.rooms (the staffsPost symmetry rule applied to world state; the
 * measured alternative was the cluster flap - 15 sinks -> 0 across two
 * captures with the solve keyed to which room happened to be sighted).
 */
export function constructionProjectLedger(): ProjectRecord[] {
  const out = new Map<string, ProjectRecord>();
  if (typeof Memory === "undefined" || !Memory.commissionedCorps) return [];
  for (const key of Object.keys(Memory.commissionedCorps)) {
    const entry = Memory.commissionedCorps[key] as { kind?: string; corp?: { projects?: ProjectRecord[] } };
    if (entry?.kind !== "construction") continue;
    for (const rec of entry.corp?.projects ?? []) {
      if (rec.remaining > 0) out.set(rec.id, rec);
    }
  }
  return [...out.values()];
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
// The sum-of-projects crew cap (owner 2026-07-19) lives in
// primitives.projectAbsorbRate - shared verbatim with the PLAN's
// construction-sink capacity so plan and crew can never disagree.

/**
 * Horizon a road route must repay its build cost within: the wall-clock life
 * of an unmaintained road (50k ticks). A home room lives far longer, but a
 * route that cannot repay before its own pavement would have fully decayed is
 * not worth the maintenance commitment.
 */
const ROAD_PAYBACK_HORIZON = UNMAINTAINED_ROAD_LIFE;

/**
 * The colony's BUILD POOL (owner 2026-07-20: "It basically just doesn't
 * matter which room the construction is in"): every room with our
 * construction sites, home room first then nearest, each with its remaining
 * work. ONE spawn-scoped crew is sized against the whole pool and marches
 * wherever the work is - the room enters the math only as travel distance.
 * This retires the distributed trunk model (each room's corp owned its
 * segment), whose empty-room corps fielded self-ferrying 1-WORK runts:
 * trunk stalled at 32/38 for ~4300 ticks, measured.
 */
export interface BuildPoolEntry {
  roomName: string;
  /** Absent for a BLIND receipt entry - the crew's travel restores it. */
  room?: Room;
  work: number;
}

export function buildPool(homeRoomName: string): BuildPoolEntry[] {
  const entries: BuildPoolEntry[] = [];
  if (typeof Game === "undefined" || !Game.rooms) return entries;
  for (const roomName in Game.rooms) {
    const r = Game.rooms[roomName];
    let work = 0;
    try {
      for (const s of r.find(FIND_MY_CONSTRUCTION_SITES)) work += s.progressTotal - s.progress;
    } catch {
      continue; // partial mocks
    }
    if (work > 0) entries.push({ roomName, room: r, work });
  }
  // RECEIPT REMAINDERS (the stranded-trunk deadlock, prod t72488324): the
  // vision scan above is a creep-position lens - when a trunk room went
  // dark, poolWork hit 0, the crew stood down, and nobody was left to ever
  // restore vision (trunk-blind-W43N22 for 1100+ ticks, cee0 frozen 35/50).
  // The HOME room's roadRoutes receipts are the durable signal (CLAUDE.md:
  // room state from intel, never vision): charge each BLIND route room its
  // tile-share of the unbuilt remainder so the crew fields and marches -
  // arrival restores vision and the ground-truth scan takes over. Visible
  // rooms NEVER take a receipt charge (their standing sites are the truth).
  const routes = Game.rooms[homeRoomName]?.memory?.roadRoutes;
  if (routes) {
    const blindWork = new Map<string, number>();
    for (const key of Object.keys(routes)) {
      const e = routes[key];
      if (!e || e.paved || e.declined || !e.tiles3 || !e.rooms) continue;
      const total = e.total ?? 0;
      const remaining = total - (e.built ?? 0);
      if (total <= 0 || remaining <= 0) continue;
      const tileCount = e.tiles3.length / 3;
      const perRoom = new Map<string, number>();
      for (let i = 2; i < e.tiles3.length; i += 3) {
        const rn = e.rooms[e.tiles3[i]];
        if (rn) perRoom.set(rn, (perRoom.get(rn) ?? 0) + 1);
      }
      for (const [rn, count] of perRoom) {
        if (Game.rooms[rn]) continue;
        const share = (remaining * count) / tileCount;
        blindWork.set(rn, (blindWork.get(rn) ?? 0) + share * ROAD_BUILD_COST);
      }
    }
    for (const [roomName, work] of blindWork) {
      if (work > 0) entries.push({ roomName, work });
    }
  }
  const rank = (name: string): number => (name === homeRoomName ? -1 : roomLinearDistance(homeRoomName, name));
  entries.sort((a, b) => rank(a.roomName) - rank(b.roomName));
  return entries;
}

/**
 * The energy/tick the ONE build-pool crew can usefully absorb - the shared
 * CONSTRUCTION-FIRST bound (prod t72478939). Three readers, one formula:
 * the crew sizing (builderPlan), the plan's construction-sink capacity
 * (flowAdapter, via the same primitives.projectAbsorbRate), and the
 * consumers' surplus clamp (feederRelayTarget / upgraderSizing). The clamp's
 * boolean predecessor ("any site stands") treated 12 road sites - pool
 * absorb ~5 e/t - exactly like a 100k build-out: it freed the whole 115 e/t
 * surplus from the upgraders, construction ate 0.47 e/t measured, and the
 * difference BANKED (+20.18/t at 474k, 17x the warchest target). Bounding
 * the clamp by what the build set can actually EAT is what makes
 * "construction first" funnel energy to construction instead of the bank.
 *
 * Inputs mirror builderPlan's home branch verbatim: total pool work over
 * the buffered horizon of the FARTHEST pool room (in-room = spawn range to
 * the first site; remote = roomLinearDistance * 50).
 */
export function buildPoolAbsorbRate(homeRoomName: string, spawnPos: RoomPosition | undefined): number {
  const pool = buildPool(homeRoomName);
  if (pool.length === 0) return 0;
  const siteWork = pool.reduce((s, e) => s + e.work, 0);
  let travel = 0;
  for (const e of pool) {
    let t: number;
    if (e.roomName === homeRoomName && e.room && spawnPos) {
      let sitePos: RoomPosition | undefined;
      try {
        sitePos = e.room.find(FIND_MY_CONSTRUCTION_SITES)[0]?.pos;
      } catch {
        sitePos = undefined; // partial mocks
      }
      t = spawnPos.getRangeTo(sitePos ?? spawnPos);
    } else {
      // Blind receipt entries take this leg too - only the NAME is needed.
      t = roomLinearDistance(homeRoomName, e.roomName) * 50;
    }
    if (t > travel) travel = t;
  }
  return projectAbsorbRate(siteWork, travel);
}

/** One placement pass over a trunk's tiles: what stands, what was added,
 * which rooms could not be read. */
export interface TrunkSurvey {
  placed: number;
  built: number;
  total: number;
  blind: string[];
  /** The unbuilt VISIBLE tiles, each with its pass state - `room:x,y:site`
   * (construction site standing), `:placed` (site created this pass),
   * `:paused` (governor), or `:err<rc>` (createConstructionSite failed -
   * the silent-forever state; prod t72482860: the gate read
   * trunk-building-36/38 for ~4400t across 5 captures and WHICH 2 tiles
   * never built - or why - was invisible). Capped at 4 entries. */
  missing: string[];
}

/**
 * The trunk gate stamp from a pass survey - each zero-placement state gets
 * its own name (owner 2026-07-20: a single "waiting-vision" stamp conflated
 * "tiles in a blind room" with "fully placed, crews building" and misread a
 * healthy build as stalled for a whole day).
 */
export function trunkGateFromSurvey(s: TrunkSurvey): string {
  if (s.placed > 0) return `trunk-placing-${s.placed}`;
  if (s.blind.length > 0) return `trunk-blind-${s.blind.join("+")}`;
  return `trunk-building-${s.built}/${s.total}`;
}

/**
 * ConstructionCorp manages builder creeps that construct extensions.
 */
export class ConstructionCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Last tick we attempted to place extensions */
  private lastPlacementAttempt = 0;
  /** Cooldown clock for the surplus road-scan path (not persisted - a reset
   * just re-arms the scan a cooldown early, which is harmless). */
  private lastRoadAttempt = 0;
  private remoteTrunks: { sourceId: string; pos: Position; flow: number }[] = [];

  /** Target number of builders (computed during planning) */
  private targetBuilders = 0;

  /**
   * Flow-based construction allocations from FlowEconomy.
   * Each allocation specifies energy for a construction site.
   */
  private constructionAllocations: SinkAllocation[] = [];

  /**
   * Spec 25 phase 3 (owner: "no residual - we can just make a bigger
   * builder"): the summed construction allocations of the SPAWNLESS rooms
   * this spawn staffs - remote source-local clusters the plan prices at the
   * SOURCE'S rate. Only the spawn's own-room corp (the pool crew's home)
   * ever receives a non-zero value; it sizes the crew on top of the
   * own-room allocations above.
   */
  private poolAllocatedRate = 0;

  /** The project ledger (see ProjectRecord): durable site records, written
   * only by reconcileProjects (sight), read by everyone via
   * constructionProjectLedger. */
  private projects: ProjectRecord[] = [];

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
   * Reconcile the project ledger against every SIGHTED room: replace each
   * visible room's records with ground truth (sites gone -> records gone;
   * progress -> remaining updated), keep blind rooms' records verbatim,
   * retire records unseen for PROJECT_LEDGER_DECAY. Vision is a
   * reconciliation event here, never a data source for decisions - the
   * ledger IS the data source (owner 2026-07-22 pattern ruling).
   */
  public reconcileProjects(tick: number): void {
    const keep: ProjectRecord[] = [];
    const visibleRecorded = new Set<string>();
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      let sites: ConstructionSite[];
      try {
        sites = room.find(FIND_MY_CONSTRUCTION_SITES);
      } catch {
        continue; // partial mocks
      }
      visibleRecorded.add(roomName);
      for (const s of sites) {
        keep.push({
          id: s.id,
          x: s.pos.x,
          y: s.pos.y,
          roomName,
          structureType: s.structureType,
          remaining: s.progressTotal - s.progress,
          seen: tick
        });
      }
    }
    for (const rec of this.projects) {
      if (visibleRecorded.has(rec.roomName)) continue; // ground truth replaced it
      if (tick - rec.seen > PROJECT_LEDGER_DECAY) continue; // blind too long
      keep.push(rec);
    }
    this.projects = keep;
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
    // ONE BUILD POOL (owner 2026-07-20): the home corp counts the colony's
    // whole outstanding site work; remote corps count nothing (their sites
    // belong to the pool, their builders age out).
    const isHome = spawn.pos.roomName === workRoom.name;
    const totalWorkRemaining = isHome
      ? buildPool(spawn.pos.roomName).reduce((s, e) => s + e.work, 0)
      : 0;
    if (totalWorkRemaining === 0) {
      // Nothing to build. Maintenance belongs to the repair detail (separate
      // squad, runs regardless of sites) - the build crew stands down.
      this.targetBuilders = 0;
      return;
    }

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

    // PROJECT LEDGER reconciliation (single writer: the spawn's own-room
    // corp). Every sighted room's records go to ground truth; blind rooms'
    // records persist - the plan's sink admission reads the ledger, so the
    // sink set stops flapping with whichever room was visible at solve time.
    if (spawn.pos.roomName === this.nodeId.replace(/-construction$/, "")) {
      this.reconcileProjects(tick);
    }

    const room = this.workRoom(spawn);
    if (!room) {
      // Cross-room corp without vision: demand saw the room (intel/vision at
      // order time) but an idle member at the home spawn provides no vision -
      // a deadlock only the member's own travel can break (measured
      // 2026-07-19: four remote builders idled ~600t at Spawn1). March them;
      // arrival restores vision and the full work loop.
      const targetRoom = this.nodeId.replace(/-construction$/, "");
      this.builders.run(creep => {
        travelTo(creep, new RoomPosition(25, 25, targetRoom));
      }, spawn);
      return;
    }
    const controller = room.controller;
    if (!controller) return;

    if (this.isRemoteWorkRoom(room)) {
      // Remote rung: one source container at a time, triggered by the pile
      // threshold (findMissingSourceContainer), built from that same pile.
      const spot = this.remoteContainerSiteWanted(room);
      if (spot) this.placeSite(room, spot.x, spot.y, STRUCTURE_CONTAINER);
      // The repair detail is dispatched here exactly as at home (owner
      // 2026-07-21 "or partially built": the old branch ran EVERYONE through
      // runBuilder, so the detail the demand fielded for a decaying remote
      // container idled at the sites gate while the container rotted).
      this.assignRepairDetail(room);
      this.builders.run(
        creep => (creep.memory.repairDetail ? this.doMaintenance(creep, room) : this.runBuilder(creep, room)),
        spawn
      );
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
    } else if (
      // ROADS ROLLOUT (owner 2026-07-20: "finish out the roads rollout ...
      // to the remote sources"): paving is a surplus INVESTMENT, not a
      // capacity structure - it no longer waits for activeSites===0 or the
      // capacity rungs above it in the ladder. With the warchest in surplus
      // the road scan runs on its own cooldown even while other projects
      // build; judged routes drop their whole tile set at once and the
      // sum-of-projects crew sizing absorbs them like any other work.
      room.storage?.my &&
      spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0) > 0 &&
      tick - this.lastRoadAttempt >= PLACEMENT_COOLDOWN &&
      this.wantsRoadWork(room)
    ) {
      this.lastRoadAttempt = tick;
      this.tryPlaceRoadRoute(room);
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
    this.assignRepairDetail(room);
    // ONE BUILD POOL (owner 2026-07-20): the crew works the pool's head room
    // - home first, else the nearest room with sites (its trunk tiles, a
    // founding site two rooms over, wherever). runBuilder already drives and
    // refuels in whatever room it is handed (the remote rung proved it).
    const poolHead = buildPool(spawn.pos.roomName)[0];
    if (poolHead && !poolHead.room) {
      // BLIND receipt head (stranded-trunk deadlock): no vision anywhere in
      // the pool - the crew's own travel is the only thing that can restore
      // it. March the builders at the receipt room; the repair detail keeps
      // its beat, tankers hold their home loop until a real site resolves.
      this.builders.run(
        creep =>
          creep.memory.repairDetail
            ? this.doMaintenance(creep, room)
            : void travelTo(creep, new RoomPosition(25, 25, poolHead.roomName)),
        spawn
      );
      this.tankers.run(creep => this.runTanker(creep, room), spawn);
      return;
    }
    const buildRoom = poolHead?.room ?? room;
    this.builders.run(
      creep => (creep.memory.repairDetail ? this.doMaintenance(creep, room) : this.runBuilder(creep, buildRoom)),
      spawn
    );
    this.tankers.run(creep => this.runTanker(creep, room), spawn);
  }

  /**
   * Keep exactly one crew member flagged as the REPAIR DETAIL while anything
   * wants maintenance (owner 2026-07-18: repair and building are separate
   * functions - sites never impact repair). Sticky: the flag lives on the
   * creep for life; a new one is assigned only when none exists. With nothing
   * to maintain the flag clears so the member rejoins the build crew.
   */
  private assignRepairDetail(room: Room): void {
    const members = this.builders.members();
    const detail = members.find(c => c.memory.repairDetail);
    if (!this.wantsMaintenance(room) && !this.wantsCriticalRecovery(room, detail !== undefined)) {
      if (detail) delete detail.memory.repairDetail;
      return;
    }
    // Repair is DECOUPLED from building (owner 2026-07-18: "the existence of
    // construction sites doesn't have to impact the repair in any way"). The
    // maintenance detail is assigned whenever something wants maintenance,
    // regardless of sites; the +1 detail target (builderPlanWithDetail) orders
    // the second builder so construction is not starved. A former "never take
    // the LAST builder while sites exist" guard VIOLATED this directive - it
    // cleared an active repair detail the moment the corp placed a site, so a
    // 1-builder room abandoned a below-gate container to chase construction
    // forever (cons-repair-stops-at-99, root-caused via diag-repair-latch: 8
    // sites placed at t20 -> detail cleared -> the 55% container never rose).
    // The cold-ramp case that motivated it is covered by the 2-builder
    // cons-t3 staging and by the fact that a real cold ramp's containers are
    // full (no maintenance competition).
    if (detail) return;
    const recruit = members[0];
    if (recruit) recruit.memory.repairDetail = true;
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
    // The warchest SURPLUS is build fuel (owner 2026-07-18: "use all the
    // energy in the storage as needed, same as for the upgrader") - the same
    // spendable-surplus lens the whole spec-03 spend path uses, so the
    // expansion warchest floor stays untouchable. Without this a road site
    // near the spine saw no container and sized a 5 e/t token crew against a
    // 600k bank.
    if (room.storage?.my) stock += spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0);
    return stock;
  }

  /**
   * Energy still needed to finish every construction site in the room - the
   * SUM of this corp's projects (owner 2026-07-19). Each site's remaining cost
   * is progressTotal - progress (build progress is 1:1 with energy). Under the
   * distributed trunk model a corp's remote-trunk tiles are ordinary road
   * sites in the rooms they cross, each owned and built by that room's corp,
   * so summing THIS room's sites is the whole of this corp's outstanding work.
   */
  private siteWorkRemaining(room: Room): number {
    let energy = 0;
    for (const s of room.find(FIND_MY_CONSTRUCTION_SITES)) energy += s.progressTotal - s.progress;
    return energy;
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
    buildEnergy = Math.min(buildEnergy, sustainableConsumptionRate(fuel, 5));
    // SPEC 25 PHASE 3 (owner: "there shouldn't be any residual - we can just
    // make a bigger builder"): the plan's source-funded cluster rate joins
    // AFTER the stock clamp - its fuel is the remote source's continuous
    // output at the site, not this room's depot, so an empty home depot
    // cannot strangle a crew the plan funds from a mine.
    buildEnergy += this.poolAllocatedRate;
    // SUM OF PROJECTS (owner 2026-07-19): a construction project is a finite
    // tile list with a computable total cost, so never size the crew to burn
    // more per tick than finishes the room's outstanding site work over the
    // build horizon. ONLY when there IS build work to cap: a repair-only crew
    // (no sites) sizes by its own path, and capping it to 0/H = 5 starved the
    // repairer (cons-repair-stops-at-99). Under the distributed trunk model
    // each room's corp owns its segment, so "sum of THIS corp's projects" is
    // exactly its room's remaining site work.
    // ONE BUILD POOL (owner 2026-07-20: "it basically just doesn't matter
    // which room the construction is in"): the home corp sizes against the
    // colony's WHOLE outstanding site work - room only enters as travel.
    // Remote corps keep their per-room read for their aging-out legacy crews.
    const spawnForTravel = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    const isHome = spawnForTravel ? spawnForTravel.pos.roomName === room.name : true;
    let absorb = 0;
    if (isHome && spawnForTravel) {
      // Horizon travel = the FARTHEST pool room (the crew must finish the
      // whole pool within its buffered effective life - owner: "based on
      // effective ttl ... not a hard constant"). buildPoolAbsorbRate IS this
      // branch, extracted so the consumers' construction-first clamp reads
      // the identical formula (prod t72478939 - three readers, one lens).
      absorb = buildPoolAbsorbRate(spawnForTravel.pos.roomName, spawnForTravel.pos);
    } else {
      const siteWork = this.siteWorkRemaining(room);
      const firstSite = room.find(FIND_MY_CONSTRUCTION_SITES)[0];
      const travel =
        spawnForTravel && firstSite
          ? spawnForTravel.pos.roomName === room.name
            ? spawnForTravel.pos.getRangeTo(firstSite.pos)
            : roomLinearDistance(spawnForTravel.pos.roomName, room.name) * 50
          : 0;
      if (siteWork > 0) absorb = projectAbsorbRate(siteWork, travel);
    }
    // The horizon cap still bounds BANK-funded pool work, but the crew may
    // size up to the plan's source-funded cluster rate (spec 25 phase 3).
    // The pool crew works ONE project at a time (pool-head order), so its
    // size is the MAX of the two funding tracks, never their sum - a summed
    // crew would field parts that idle at whichever project they are not at
    // (owner: "body parts standing around, unable to do their job is one
    // form of waste").
    if (absorb > 0 || this.poolAllocatedRate > 0) {
      buildEnergy = Math.min(buildEnergy, Math.max(absorb, this.poolAllocatedRate));
    }
    buildEnergy = Math.max(5, buildEnergy);
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

    // SURPLUS-SPEND REGIME: with the warchest full, the bank IS the build
    // fuel - the tanker draws from storage directly (same spendable-surplus
    // lens as buildSideStock, so sizing and fetching cannot disagree). This
    // is what lets road projects burn banked energy instead of waiting on a
    // committed source's trickle.
    const bank = room.storage;
    if (bank?.my && spendableBankSurplus(bank.store[RESOURCE_ENERGY] ?? 0) > 0) {
      if (creep.withdraw(bank, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(bank, { visualizePathStyle: { stroke: "#00ff00" } });
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
      // BATCH the remaining set (owner 2026-07-20: "having the set of all
      // the extensions at once would factor into the plan just by
      // increasing the size of the energy commitment ... which ups the
      // limit on the builder fleet size"): the sum-of-projects lens can
      // only amortize a crew against work standing as SITES, and
      // one-at-a-time placement hid most of the build-out (3k visible of
      // 9k). Same-tick placements are invisible to lookFor until next
      // tick, so an exclusion set threads our own placements through the
      // position scan.
      const standingExtSites = room
        .find(FIND_MY_CONSTRUCTION_SITES)
        .filter(s => s.structureType === STRUCTURE_EXTENSION).length;
      let remaining = (EXTENSION_LIMITS[rcl] || 0) - builtExtensions - standingExtSites;
      const placedHere = new Set<string>();
      let placedAny = false;
      while (remaining > 0) {
        const ext = this.findGridPosition(room, placedHere);
        if (!ext) break;
        this.placeSite(room, ext.x, ext.y, STRUCTURE_EXTENSION);
        placedHere.add(`${ext.x},${ext.y}`);
        remaining -= 1;
        placedAny = true;
      }
      if (placedAny) return;
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
   * A route entry that needs no further work: paved, or declined at a flow
   * that still stands (declinedVerdictStands). The work() gate and the
   * placement path MUST read this same lens - if the gate thinks a stale
   * declined verdict is settled while the placement path would re-judge it,
   * work() never routes here and the re-judge never runs.
   */
  private routeSettled(
    entry: NonNullable<Room["memory"]["roadRoutes"]>[string] | undefined,
    currentFlow: number
  ): boolean {
    if (!entry) return false;
    if (entry.paved) return true;
    return !!entry.declined && declinedVerdictStands(entry.judgedFlow, currentFlow);
  }

  /**
   * Cheap gate for work(): is there road work outstanding - a source with a
   * container (a stable route endpoint) whose route has no paving verdict yet
   * (or a declined verdict its risen flow has voided), or a planned route
   * whose tiles are not all built?
   */
  private wantsRoadWork(room: Room): boolean {
    for (const source of room.find(FIND_SOURCES)) {
      if (this.routeSettled(room.memory.roadRoutes?.[source.id], SOURCE_RATE)) continue;
      if (this.hasContainerNear(room, source.pos, 1)) return true;
    }
    // The feeder trunk counts as outstanding road work too (same gate the
    // placement path uses: depot era, input container standing, no verdict).
    // Unverdicted or unfinished TRUNKS are outstanding road work too.
    for (const trunk of this.remoteTrunks) {
      const e = room.memory.roadRoutes?.[trunk.sourceId.replace(/^source-/, "")];
      if (!this.routeSettled(e, trunk.flow)) return true;
    }
    const feeder = room.memory.roadRoutes?.["feeder"];
    const feederFlow = room.storage?.my ? feederRelayRate(room.storage.store[RESOURCE_ENERGY] ?? 0) : 0;
    if (!this.routeSettled(feeder, feederFlow) && room.storage?.my) {
      const ctrl = room.controller;
      if (ctrl && ctrl.pos.findInRange(FIND_STRUCTURES, 3, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length > 0)
        return true;
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
      let entry: NonNullable<Room["memory"]["roadRoutes"]>[string] | undefined = routes[source.id];
      if (entry?.declined && !declinedVerdictStands(entry.judgedFlow, SOURCE_RATE)) {
        delete routes[source.id]; // flow outgrew the cached verdict - re-judge from scratch
        entry = undefined;
      }
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

      // No repair gate at all: repair is a separate standing detail (owner
      // 2026-07-18) that runs regardless of sites, and room decay costs a
      // few e/t against a bank-funded allocation - paving and upkeep never
      // compete for energy or crew.

      // Paving is a SURPLUS investment: in a demand-saturated room (organic
      // spawning consuming the whole income) a paving project tips the spawn
      // network into the critical failsafe and disrupts delivery (measured:
      // the tender-bus T4 world). Two surplus observables, either suffices:
      // a full spawn bank (lean rooms between spawns), or a warchest in
      // SURPLUS (owner 2026-07-18: a 600k bank is the surplus signal - the
      // full-bank tick almost never occurred while the spawn ran pinned, so
      // zero routes were ever judged despite the fattest bank all session).
      const surplusBanked = room.storage?.my && spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0) > 0;
      if (room.energyAvailable < room.energyCapacityAvailable && !surplusBanked) {
        // The last silent exit in the road scan (spec 14): an unjudged source
        // behind this wall blocks the feeder trunk below it every pass.
        this.stampSizing({ roadGate: `road-wall-energy-${source.id.slice(-4)}` });
        return;
      }

      const tiles = this.planRoadPath(room, source, depotPos, spawn.pos);
      if (!tiles) continue;
      const spec = this.roadRouteSpec(room, tiles);
      const verdict = evaluateRoadRoute(spec, ROAD_PAYBACK_HORIZON, ROAD_SPAWN_PART_VALUE);
      if (!verdict.worthPaving) {
        routes[source.id] = { tiles: [], declined: true, judgedFlow: spec.flow };
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

    // FEEDER TRUNK (owner 2026-07-18): the storage->controller-input lane
    // carries the relay (upgrade target + the whole bank draw) - the highest
    // flow in the colony - yet candidacy was home-source-only and it was
    // never judged. Same verdict machinery, keyed "feeder".
    this.tryPlaceFeederRoadRoute(room, routes);
    this.tryPlaceTrunkRoutes(room, routes);
  }

  /**
   * Judge and pave CROSS-ROOM trunks to the plan's funded remote sources
   * (owner 2026-07-19: the corp has a spawn, not a room - a route is a
   * string of construction sites wherever they lead). Sites are placed
   * progressively in rooms with vision; the remote rooms' own construction
   * corps field the builders (their plan() counts any site in their room,
   * and cross-room builders march since the vision-march fix). The paved
   * receipt reprices the source's haulers at 2:1 via detectPavedSources.
   */
  private tryPlaceTrunkRoutes(room: Room, routes: NonNullable<Room["memory"]["roadRoutes"]>): void {
    const gate = (reason: string): void => {
      this.stampSizing({ roadGate: reason });
    };
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;
    const depotPos = room.storage?.pos ?? spawn.pos;

    // COMPLETION SWEEP over ALL entries first (prod t72484878): the
    // one-project-at-a-time return below lives in the SURVEY path, so an
    // in-progress trunk earlier in remoteTrunks order took every pass and a
    // fully-built trunk behind it was never re-checked - no paved receipt,
    // no pave fraction, haulers priced 1:1 (carry 14.8 vs ~11) for two full
    // windows after the road stood complete. Completion is cheap (lookForAt
    // over the tile list) and idempotent; only PLACEMENT stays serialized.
    for (const trunk of this.remoteTrunks) {
      const key = trunk.sourceId.replace(/^source-/, "");
      const entry = routes[key];
      if (!entry || entry.paved || entry.declined || !entry.tiles3 || !entry.rooms) continue;
      if (this.trunkBuilt(entry.rooms, entry.tiles3, trunk.pos)) {
        entry.paved = true;
        gate("trunk-paved");
        console.log(`[Construction] TRUNK to ${key} fully paved (${entry.tiles3.length / 3} tiles)`);
      }
    }

    for (const trunk of this.remoteTrunks) {
      const key = trunk.sourceId.replace(/^source-/, "");
      let entry: NonNullable<Room["memory"]["roadRoutes"]>[string] | undefined = routes[key];
      if (entry?.declined && !declinedVerdictStands(entry.judgedFlow, trunk.flow)) {
        // The plan's flow outgrew the cached verdict (reservation doubling a
        // remote source is the canonical rise) - void it and re-judge below.
        console.log(
          `[Construction] TRUNK to ${key}: flow rose ${entry.judgedFlow ?? "?"}->${trunk.flow}, re-judging`
        );
        delete routes[key];
        entry = undefined;
      }
      if (entry?.paved || entry?.declined) continue;

      if (entry?.tiles3 && entry.rooms) {
        // In-progress trunk (the completion sweep above already receipted
        // finished ones): place what vision allows.
        // The stamp names WHICH state a zero-placement pass is (owner
        // 2026-07-20: "waiting-vision" stamped all day while the true state
        // was fully-placed-and-building - the remotes are mined, vision was
        // never the blocker; the ambiguity was).
        const survey = this.placeTrunkSites(entry.rooms, entry.tiles3, trunk.pos);
        // Survey receipt for the partial-pave repricing lens
        // (detectPavedSources): verified built RATCHETS - a blind pass sees
        // fewer tiles, not fewer roads, and counting down would flap the
        // hauler body around the repricing threshold.
        entry.built = Math.max(entry.built ?? 0, survey.built);
        entry.total = survey.total;
        // The residual tiles ride the stamp by NAME (prod t72482860: 36/38
        // for ~4400t and the 2 unbuilt tiles were unnameable from captures).
        this.stampSizing({
          roadGate: trunkGateFromSurvey(survey),
          ...(survey.missing.length > 0 ? { trunkMissing: survey.missing.join(" ") } : {})
        });
        return; // one project at a time
      }

      // Unjudged trunk: cross-room path + roadEconomics verdict.
      const path = this.planTrunkPath(trunk.pos, depotPos);
      if (!path) {
        gate("trunk-path-incomplete");
        continue;
      }
      const spec = this.trunkSpec(path, trunk.flow);
      const verdict = evaluateRoadRoute(spec, ROAD_PAYBACK_HORIZON, ROAD_SPAWN_PART_VALUE);
      if (!verdict.worthPaving) {
        routes[key] = { tiles: [], declined: true, judgedFlow: trunk.flow };
        gate(`trunk-declined-payback-${Math.round(verdict.paybackTicks)}t`);
        continue;
      }
      const roomsTable: string[] = [];
      const tiles3: number[] = [];
      for (const p of path) {
        // Border tiles are walkable but never placeable (isRoomEdgeTile) -
        // a cross-room path always includes them; recording them made the
        // trunk's completion condition unsatisfiable (prod t72483047).
        if (isRoomEdgeTile(p.x, p.y)) continue;
        // Never record source-approach tiles on NEW paths (stored old
        // routes rely on the survey/completion skips instead).
        if (isSourceApproachTile(p.x, p.y, p.roomName, trunk.pos)) continue;
        let ri = roomsTable.indexOf(p.roomName);
        if (ri === -1) {
          ri = roomsTable.length;
          roomsTable.push(p.roomName);
        }
        tiles3.push(p.x, p.y, ri);
      }
      routes[key] = { tiles: [], tiles3, rooms: roomsTable };
      const placed = this.placeTrunkSites(roomsTable, tiles3, trunk.pos);
      gate(`trunk-judged-paving-${Math.round(verdict.paybackTicks)}t`);
      console.log(
        `[Construction] TRUNK to ${key}: ${tiles3.length / 3} tiles across ${roomsTable.length} rooms ` +
          `(${placed} sites placed), payback ~${Math.round(verdict.paybackTicks)}t`
      );
      return; // one project at a time
    }
  }

  /** Cross-room road path: visible rooms use live costs, blind rooms terrain-only. */
  private planTrunkPath(origin: Position, depotPos: RoomPosition): RoomPosition[] | null {
    const result = PathFinder.search(
      new RoomPosition(origin.x, origin.y, origin.roomName),
      { pos: depotPos, range: 1 },
      {
        plainCost: 2,
        swampCost: 10,
        maxRooms: 4,
        roomCallback: (name: string): CostMatrix | boolean => {
          const r = Game.rooms[name];
          // No vision: allow the room at terrain-only costs (an empty matrix).
          return r ? this.roadPlanningCosts(r) : new PathFinder.CostMatrix();
        }
      }
    );
    if (result.incomplete || result.path.length === 0) return null;
    return result.path;
  }

  /** Route spec across rooms - Game.map terrain needs no vision. */
  private trunkSpec(path: RoomPosition[], flow: number): RoadRouteSpec {
    let swampTiles = 0;
    for (const p of path) {
      if (Game.map.getRoomTerrain(p.roomName).get(p.x, p.y) & TERRAIN_MASK_SWAMP) swampTiles++;
    }
    return { plainTiles: path.length - swampTiles, swampTiles, flow };
  }

  /** Place trunk sites in every VISIBLE room; blind stretches wait for walkers. */
  private placeTrunkSites(roomsTable: string[], tiles3: number[], sourcePos?: Position): TrunkSurvey {
    const survey: TrunkSurvey = { placed: 0, built: 0, total: 0, blind: [], missing: [] };
    const blind = new Set<string>();
    const paused = governorPlan().pauseConstruction;
    const noteMissing = (roomName: string, x: number, y: number, state: string): void => {
      if (survey.missing.length < 4) survey.missing.push(`${roomName}:${x},${y}:${state}`);
    };
    for (let i = 0; i + 2 < tiles3.length; i += 3) {
      const x0 = tiles3[i];
      const y0 = tiles3[i + 1];
      // Border tiles are walkable but NEVER placeable (isRoomEdgeTile - the
      // err-7-forever state, prod t72483047): not part of the placeable
      // total, defensively skipped so routes STORED with edge tiles
      // (pre-fix paths) complete without migration.
      if (isRoomEdgeTile(x0, y0)) continue;
      const roomName = roomsTable[tiles3[i + 2]];
      // Source-approach tiles are not worth paving (owner 2026-07-22) -
      // same defensive-skip class, so stored routes complete unmigrated.
      if (isSourceApproachTile(x0, y0, roomName, sourcePos)) continue;
      survey.total++;
      const r = Game.rooms[roomName];
      if (!r) {
        blind.add(roomName); // no vision this pass
        continue;
      }
      const x = x0;
      const y = y0;
      if (r.lookForAt(LOOK_STRUCTURES, x, y).some(s => s.structureType === STRUCTURE_ROAD)) {
        survey.built++;
        continue;
      }
      if (r.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).some(s => s.structureType === STRUCTURE_ROAD)) {
        noteMissing(roomName, x, y, "site");
        continue;
      }
      if (paused) {
        noteMissing(roomName, x, y, "paused");
        continue;
      }
      const rc = r.createConstructionSite(x, y, STRUCTURE_ROAD);
      if (rc === OK) {
        survey.placed++;
        noteMissing(roomName, x, y, "placed");
      } else {
        // The silent-forever state: a tile placement rejects every pass
        // (blocked structure, invalid terrain drift) and no counter moved.
        noteMissing(roomName, x, y, `err${rc}`);
      }
    }
    survey.blind = [...blind];
    return survey;
  }

  /** All PLACEABLE trunk tiles verifiably built - a blind room cannot verify,
   * so false; border tiles carry creeps without roads and are exempt (the
   * completion condition was otherwise unsatisfiable - prod t72483047), as
   * are source-approach tiles (owner 2026-07-22: not worth paving). */
  private trunkBuilt(roomsTable: string[], tiles3: number[], sourcePos?: Position): boolean {
    for (let i = 0; i + 2 < tiles3.length; i += 3) {
      if (isRoomEdgeTile(tiles3[i], tiles3[i + 1])) continue;
      const roomName = roomsTable[tiles3[i + 2]];
      if (isSourceApproachTile(tiles3[i], tiles3[i + 1], roomName, sourcePos)) continue;
      const r = Game.rooms[roomName];
      if (!r) return false;
      if (!r.lookForAt(LOOK_STRUCTURES, tiles3[i], tiles3[i + 1]).some(s => s.structureType === STRUCTURE_ROAD)) {
        return false;
      }
    }
    return true;
  }

  /** Judge and pave the storage -> controller-input lane, receipt-keyed "feeder". */
  private tryPlaceFeederRoadRoute(room: Room, routes: NonNullable<Room["memory"]["roadRoutes"]>): void {
    // Every exit stamps WHY (spec 14: no invisible decisions - roadRoutes sat
    // EMPTY a full session because these returns were silent).
    const gate = (reason: string): void => {
      this.stampSizing({ roadGate: reason });
    };
    let entry: NonNullable<Room["memory"]["roadRoutes"]>[string] | undefined = routes["feeder"];
    const bank = room.storage;
    if (
      entry?.declined &&
      bank?.my &&
      !declinedVerdictStands(entry.judgedFlow, feederRelayRate(bank.store[RESOURCE_ENERGY] ?? 0))
    ) {
      delete routes["feeder"]; // the relay rate outgrew the cached verdict - re-judge
      entry = undefined;
    }
    if (entry?.paved || entry?.declined) {
      gate(entry.paved ? "feeder-paved" : "feeder-declined");
      return;
    }
    const ctrl = room.controller;
    if (!bank?.my || !ctrl) {
      gate("feeder-no-depot");
      return; // the lane exists only in the depot era
    }
    const input = ctrl.pos.findInRange(FIND_STRUCTURES, 3, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    })[0] as StructureContainer | undefined;
    if (!input) {
      gate("feeder-no-input-container");
      return; // rung 1.7 builds the input container first
    }

    if (entry) {
      if (this.roadTilesBuilt(room, entry.tiles)) {
        entry.paved = true;
        console.log(`[Construction] Feeder trunk fully paved`);
        gate("feeder-paved");
        return;
      }
      this.placeMissingRoadSites(room, entry.tiles);
      gate("feeder-building");
      return;
    }

    if (spendableBankSurplus(bank.store[RESOURCE_ENERGY] ?? 0) <= 0 && room.energyAvailable < room.energyCapacityAvailable) {
      gate("feeder-no-surplus");
      return;
    }

    const result = PathFinder.search(
      bank.pos,
      { pos: input.pos, range: 1 },
      { plainCost: 2, swampCost: 10, maxRooms: 1, roomCallback: () => this.roadPlanningCosts(room) }
    );
    if (result.incomplete || result.path.length === 0) {
      gate("feeder-path-incomplete");
      return;
    }
    const tiles = result.path.map(p => ({ x: p.x, y: p.y }));
    // Flow = the live relay rate: this lane moves the bank draw, not a source's 10.
    const spec = this.roadRouteSpec(room, tiles, feederRelayRate(bank.store[RESOURCE_ENERGY] ?? 0));
    const verdict = evaluateRoadRoute(spec, ROAD_PAYBACK_HORIZON, ROAD_SPAWN_PART_VALUE);
    if (!verdict.worthPaving) {
      routes["feeder"] = { tiles: [], declined: true, judgedFlow: spec.flow };
      gate(`feeder-judged-declined-payback-${Math.round(verdict.paybackTicks)}t`);
      return;
    }
    gate(`feeder-judged-paving-payback-${Math.round(verdict.paybackTicks)}t`);
    const flat: number[] = [];
    for (const t of tiles) flat.push(t.x, t.y);
    routes["feeder"] = { tiles: flat };
    const placed = this.placeMissingRoadSites(room, flat);
    console.log(
      `[Construction] Paving feeder trunk: ${tiles.length} tiles (${placed} sites), ` +
        `payback ~${Math.round(verdict.paybackTicks)}t`
    );
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
  private roadRouteSpec(room: Room, tiles: { x: number; y: number }[], flow: number = SOURCE_RATE): RoadRouteSpec {
    const terrain = room.getTerrain();
    let swampTiles = 0;
    for (const t of tiles) {
      if (terrain.get(t.x, t.y) & TERRAIN_MASK_SWAMP) swampTiles++;
    }
    return { plainTiles: tiles.length - swampTiles, swampTiles, flow };
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
  /** Merge a sizing-stamp patch for THIS tick (spec 14): same-tick stamps
   * from different decision sites (the ladder's placeAttempt, the road
   * gates) must COEXIST - whole-object writes clobbered the ladder's
   * evidence (t72464499: roadGate alone survived while the placeResult that
   * would have named the stuck link rung was overwritten same-tick). */
  private stampSizing(patch: { [k: string]: number | string | boolean }): void {
    const prev = this.lastSizing && this.lastSizing.tick === Game.time ? this.lastSizing : { tick: Game.time };
    this.lastSizing = { ...prev, tick: Game.time, ...patch };
  }

  private placeSite(room: Room, x: number, y: number, type: BuildableStructureConstant): void {
    // CPU governor (spec 09 ph5): under austere degradation, NEW investment
    // pauses - existing sites keep building, the income core keeps running.
    // Every outcome stamps (spec 14): a placeSite that fails every cooldown is
    // an invisible infinite loop that eats the whole placement ladder below
    // its rung (W43N23 2026-07-19: zero sites, zero road verdicts, no trace).
    if (governorPlan().pauseConstruction) {
      this.stampSizing({ placeGate: "governor-paused" });
      return;
    }
    const result = room.createConstructionSite(x, y, type);
    this.stampSizing({ placeAttempt: `${type}@${room.name}:${x},${y}`, placeResult: result });
    if (result === OK) {
      console.log(`[Construction] Placed ${type} site at ${room.name} (${x}, ${y})`);
    } else {
      if (result === ERR_INVALID_TARGET) {
        // Permanently invalid for this tile (wall/occupant/near-exit rule the
        // candidate generators can't see): blacklist it so they move on
        // instead of retrying every cooldown forever (the eaten-ladder loop).
        const dead = (room.memory.deadTiles = room.memory.deadTiles ?? {});
        dead[`${x},${y}`] = Game.time;
      }
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
    const tile = bestAdjacentTile(room, spawn.pos, 1, spawn.pos, undefined, STRUCTURE_CONTAINER);
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
    const tile = bestAdjacentTile(room, spawn.pos, 3, spawn.pos, [spawn.pos], STRUCTURE_TOWER);
    return tile ? { x: tile.x, y: tile.y } : null;
  }

  private findMissingStorage(room: Room, rcl: number): { x: number; y: number } | null {
    if (rcl < STORAGE_MIN_RCL || room.storage) return null;
    const hasSite =
      room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_STORAGE }).length > 0;
    if (hasSite) return null;
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return null;
    const tile = bestAdjacentTile(room, spawn.pos, 2, spawn.pos, [spawn.pos], STRUCTURE_STORAGE);
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
  /**
   * The REMOTE rung's placement decision: one container project at a time,
   * gated on CONTAINER sites only - the trunk program strings ROAD sites
   * through remote rooms for whole reservation cycles, and counting them
   * blocked the container forever (owner 2026-07-21: "some of the remote
   * source don't have containers built").
   */
  private remoteContainerSiteWanted(room: Room): { x: number; y: number } | null {
    const containerSites = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    });
    if (containerSites.length > 0) return null;
    return this.findMissingSourceContainer(room);
  }

  /**
   * Is the remote room's pile-funded container project live - a container
   * site standing, or the pile signal calling for one? The demand side
   * (getSpawnDemand's local crew) and the placement side (work()'s remote
   * rung) read THIS same lens - staffsPost symmetry.
   */
  private remoteContainerProject(room: Room): boolean {
    if (
      room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length > 0
    ) {
      return true;
    }
    return this.remoteContainerSiteWanted(room) !== null;
  }

  private findMissingSourceContainer(room: Room): { x: number; y: number } | null {
    if (this.containerBudgetFull(room)) return null;
    const core = coreLink(room);
    for (const source of room.find(FIND_SOURCES)) {
      // A link-fed source needs no container: its output leaves through the
      // link. Without this skip, the legacy container decaying to dust would
      // be REBUILT here forever (owner 2026-07-20).
      if (core && sourceLink(source.pos, core.id)) continue;
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
    // NOTE: no blanket early-return on a full table - the controller step
    // below must still run to SWAP a weak source link out (t72465499: the
    // early return silently starved the controller link forever once both
    // source links existed). Each placement rung guards the limit itself.
    const linkNear = (pos: RoomPosition, range: number): boolean => all.some(l => l.pos.inRangeTo(pos, range));

    // 1) Core link beside the storage.
    if (all.length < limit && !linkNear(storage.pos, 2)) {
      const tile = bestAdjacentTile(room, storage.pos, 1, storage.pos, room.find(FIND_MY_SPAWNS).map(s => s.pos), STRUCTURE_LINK);
      return tile ? { x: tile.x, y: tile.y } : null;
    }

    // 1.5) Controller link (spec 24 rung 3, owner 2026-07-20): retires the
    // long feeder leg - worth more than any source link (64p of feeder plan
    // pricing vs ~10-30p of haul). Placed at the best structure-free
    // range-2 tile by the SAME park-ring metric the input election uses;
    // once built, controllerInputSpot prefers it and the container decays
    // via the displaced rule.
    // SAME-LENS discipline (live deadlock t72462700-t72463749, three
    // captures, zero sites): linkNear(ctrl, 3) counted ANY link - the CORE
    // included when the storage parks near the controller - while the
    // controllerLink lens excludes the core. Ladder said "served", lens said
    // "not link-fed", nobody placed. The ladder asks the lens; only a
    // pending link SITE in the controller ring also counts as served.
    const ctrl = room.controller;
    if (ctrl?.my && !controllerLink(room) && !sites.some(s => s.pos.inRangeTo(ctrl.pos, 3))) {
      const tile = this.bestControllerLinkTile(room, ctrl);
      if (tile && all.length < limit) return tile;
      if (tile) {
        // LINK SWAP (t72465499: RCL6's three slots were FULL - core + both
        // source links - so this step nulled on the limit check forever,
        // with no stamp). The controller link outvalues the weakest source
        // link ~15:1 (64p of feeder plan pricing vs a couple of carry parts
        // of saved haul), so retire the source link whose source sits
        // NEAREST the storage; its container + hauler resume seamlessly
        // (sourceLink/supersededByLink lenses re-read next pass). The freed
        // slot places the controller link on the following cooldown.
        const core = coreLink(room);
        const sourceLinks = links.filter(l => l.id !== core?.id);
        let weakest: { link: StructureLink; range: number } | null = null;
        for (const l of sourceLinks) {
          for (const source of room.find(FIND_SOURCES)) {
            if (!source.pos.inRangeTo(l.pos, 2)) continue;
            const range = storage.pos.getRangeTo(source.pos);
            if (!weakest || range < weakest.range) weakest = { link: l, range };
          }
        }
        if (weakest) {
          this.stampSizing({ linkSwap: `retired-${weakest.link.id.slice(-4)}@range${weakest.range}` });
          console.log(`[Construction] LINK SWAP: retiring source link ${weakest.link.id} (range ${weakest.range}) for the controller link`);
          weakest.link.destroy();
        }
        return null; // the freed slot places next cooldown
      }
    }

    // 2) Source links, farthest first; nearby sources aren't worth one.
    if (all.length >= limit) return null; // table full; only the swap above may free a slot
    const spawn = room.find(FIND_MY_SPAWNS)[0];
    const candidates = room
      .find(FIND_SOURCES)
      .filter(s => !linkNear(s.pos, 2) && s.pos.getRangeTo(storage.pos) > LINK_MIN_SOURCE_RANGE)
      .sort((a, b) => b.pos.getRangeTo(storage.pos) - a.pos.getRangeTo(storage.pos));
    for (const source of candidates) {
      const spot = sourceHarvestSpot(source, spawn?.pos);
      const tile = bestAdjacentTile(room, spot, 1, spawn?.pos, room.find(FIND_MY_SPAWNS).map(s => s.pos), STRUCTURE_LINK);
      if (tile) return { x: tile.x, y: tile.y };
    }
    return null;
  }

  /**
   * Best tile for the CONTROLLER LINK: a walkable, structure-and-site-free
   * range-2 tile maximizing the same park ring the input election scores
   * (walkable neighbours within upgrade range, controller tile excluded).
   * The link is unwalkable, so it must not steal the container's tile - any
   * other full-ring tile serves (open terrain has several).
   */
  private bestControllerLinkTile(room: Room, ctrl: StructureController): { x: number; y: number } | null {
    const terrain = room.getTerrain();
    const cx = ctrl.pos.x;
    const cy = ctrl.pos.y;
    const walkable = (x: number, y: number): boolean =>
      x >= 1 && x <= 48 && y >= 1 && y <= 48 && terrain.get(x, y) !== TERRAIN_MASK_WALL;
    const inRange = (x: number, y: number): boolean => Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= 3;
    const occupied = (x: number, y: number): boolean =>
      room.lookForAt(LOOK_STRUCTURES, x, y).length > 0 || room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0;
    let best: { x: number; y: number; score: number } | null = null;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const x = cx + dx;
        const y = cy + dy;
        if ((dx === 0 && dy === 0) || !walkable(x, y) || occupied(x, y)) continue;
        let score = 0;
        for (let ex = -1; ex <= 1; ex++) {
          for (let ey = -1; ey <= 1; ey++) {
            if (ex === 0 && ey === 0) continue;
            const nx = x + ex;
            const ny = y + ey;
            if (nx === cx && ny === cy) continue;
            if (walkable(nx, ny) && inRange(nx, ny)) score++;
          }
        }
        if (!best || score > best.score || (score === best.score && (x < best.x || (x === best.x && y < best.y)))) {
          best = { x, y, score };
        }
      }
    }
    return best ? { x: best.x, y: best.y } : null;
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
  private findGridPosition(room: Room, exclude?: Set<string>): { x: number; y: number } | null {
    const terrain = room.getTerrain();
    const candidates: { x: number; y: number; score: number }[] = [];

    // Build set of positions to avoid (occupied or reserved)
    const avoidPositions = new Set<string>(exclude ?? []);

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
  /** Everything the corp maintains: containers plus roads (both decay) -
   * MINUS containers a link has superseded (owner 2026-07-20: "we keep
   * repairing the container even though we don't use it anymore") and MINUS
   * a displaced controller input container (spec 24 rung 1: the input spot
   * migrated to a better park ring; the legacy container decays to dust). */
  private roomRepairables(room: Room): (StructureContainer | StructureRoad)[] {
    return (
      room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD
      }) as (StructureContainer | StructureRoad)[]
    )
      .filter(s => !this.supersededByLink(room, s))
      .filter(s => !this.displacedInputContainer(room, s));
  }

  /** A controller-range container that is NOT the current input spot: the
   * picker migrated off it, nothing reads it, it must not be maintained. */
  private displacedInputContainer(room: Room, s: { structureType: string; pos: RoomPosition }): boolean {
    if (s.structureType !== STRUCTURE_CONTAINER) return false;
    const ctrl = room.controller;
    if (!ctrl?.my) return false;
    if (Math.max(Math.abs(ctrl.pos.x - s.pos.x), Math.abs(ctrl.pos.y - s.pos.y)) > 3) return false;
    // Source containers can sit within range 3 of a controller on tight maps -
    // only a container that LOST the input election is displaced.
    for (const source of room.find(FIND_SOURCES)) {
      if (Math.max(Math.abs(source.pos.x - s.pos.x), Math.abs(source.pos.y - s.pos.y)) <= 1) return false;
    }
    const input = controllerInputSpot(ctrl);
    return !(input.pos.x === s.pos.x && input.pos.y === s.pos.y);
  }

  /**
   * A source container SUPERSEDED by the link network: once its source feeds
   * a link, the container is legacy plumbing - the output leaves through the
   * link, so the container is never repaired again (it decays to dust for
   * free; the miner standing on it is harmless) and never re-placed
   * (findMissingSourceContainer skips link-fed sources). Repairing it was
   * a small forever-tax: container decay in an owned room is ~10 hits/t =
   * ~0.15 e/t of repair plus the repairer's trips, for a structure nothing
   * reads.
   */
  private supersededByLink(room: Room, s: { structureType: string; pos: RoomPosition }): boolean {
    if (s.structureType !== STRUCTURE_CONTAINER) return false;
    const core = coreLink(room);
    if (!core) return false;
    for (const source of room.find(FIND_SOURCES)) {
      const near = Math.max(Math.abs(source.pos.x - s.pos.x), Math.abs(source.pos.y - s.pos.y)) <= 1;
      if (near && sourceLink(source.pos, core.id)) return true;
    }
    return false;
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

  /** Whether emergency repair outranks construction (see wantsCriticalRecovery). */
  private wantsCriticalRecovery(room: Room, inDiversion: boolean): boolean {
    return wantsCriticalRecovery(this.roomRepairables(room), inDiversion);
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
    // Builders ONLY build (owner 2026-07-18: repair is a fully separate
    // function - the repair detail owns ALL maintenance, critical included,
    // sites or no sites). No mode switches, no diversions.
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) return; // the squad plan retires the crew when nothing remains to build

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
   * Number of creeps this corp OWNS: builders AND the tanker detail. The
   * tankers were invisible to the census (X3 sat at "untracked 3" for a full
   * day; countMismatch t72446096 named it: claimed 4, counted 2 - the two
   * missing were this corp's own tankers). Census-only lens: demand sizing
   * reads the squads directly, so widening this cannot change spawning.
   */
  public getCreepCount(): number {
    return this.builders.members().length + this.tankers.members().length;
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

    // ONE BUILD POOL PER SPAWN (owner 2026-07-20): remote corps field NO
    // pool builders - their room's HOME-FUNDED sites belong to the home
    // corp's pool crew. They keep the standing repair detail (their
    // containers still decay) - PLUS the pile-funded container crew (owner
    // 2026-07-21: "a similar paradigm to building a road from the remote
    // end, with no hauling ... energy is laying there anyways"): the source
    // container is funded entirely by the pile decaying at the site, a
    // different funding class from the pool, so ONE local builder fields
    // while that project stands and eats the pile as it builds. No tankers.
    if (this.isRemoteWorkRoom(workRoom)) {
      const plan = this.repairerPlan(ctx, workRoom);
      // The local project lens: the pile-funded container, OR the trunk's
      // ROAD sites through this room (owner 2026-07-21: "feed the Z-to-A
      // remote builder from the source" - with hauling stood down while the
      // trunk builds, the source's whole 10 e/t feeds this crew; one 2-WORK
      // body burns exactly that). work()'s remote rung already builds any
      // site handed to it - the gate was the only gap.
      const roadSites = workRoom.find(FIND_MY_CONSTRUCTION_SITES, {
        filter: s => s.structureType === STRUCTURE_ROAD
      }).length;
      if (this.remoteContainerProject(workRoom) || roadSites > 0) plan.target += 1;
      return this.builders.spawnDemand(plan);
    }

    const poolWork = buildPool(spawn.pos.roomName).reduce((s, e) => s + e.work, 0);
    if (poolWork === 0) {
      // No sites anywhere: only the standing repair detail may want staffing.
      // It self-fuels at containers/storage, so it never needs tankers.
      return this.builders.spawnDemand(this.repairerPlan(ctx, workRoom));
    }

    const builderDemand = this.builders.spawnDemand(this.builderPlanWithDetail(ctx, workRoom));

    // Get the first builder on the field before requesting feeders for it.
    if (this.builders.count() < 1) return builderDemand;

    // Tankers serve the POOL crew wherever the pool head is (owner #24: "the
    // builder plus carrier squad mix in aggregate ... it might represent more
    // hauling"). The old home-sites-only gate corked the trunk at 34/38 for
    // 3500+ ticks (t72473701): the last tiles sat mid-route, outside the
    // builders' 4-tile self-fuel reach, while the bank held 370k the tankers
    // were forbidden to carry there. runTanker already shuttles cross-room
    // (surplus bank draw + stage-toward-builder); only the gate was home-only.
    const poolSite = this.poolTankerSite(spawn.pos.roomName);
    if (!poolSite) return builderDemand;

    const tankerDemand = this.tankers.spawnDemand(this.tankerPlan(ctx, workRoom, poolSite));
    return [...builderDemand, ...tankerDemand];
  }

  /**
   * What the feeder squad should look like: enough small tankers that one is
   * always at a builder while the others refuel, sized to the builders' total
   * consumption and the refuel round-trip (see targetTankerCount).
   */
  /** Crew plan plus the standing repair detail (owner 2026-07-18: repair is a
   * separate FUNCTION - one crew member is permanently assigned to repair,
   * sites or no sites; see assignRepairDetail). */
  private builderPlanWithDetail(ctx: SpawnDemandContext, room: Room): SquadPlan {
    const plan = this.builderPlan(ctx.energyCapacity, room);
    if (this.wantsMaintenance(room)) plan.target += 1; // the detail rides along
    return plan;
  }

  /** The standing repair detail: one small self-fueling W-heavy body while
   * anything sits below the maintenance start gate. Independent of sites. */
  private repairerPlan(ctx: SpawnDemandContext, room: Room): SquadPlan {
    const body = buildUpgraderBody(Math.min(ctx.energyCapacity, 550), 2);
    return {
      target: this.wantsMaintenance(room) ? 1 : 0,
      desiredCost: body.cost,
      minCost: body.cost,
      bodyParam: 2
    };
  }

  private tankerPlan(ctx: SpawnDemandContext, room: Room, site: ConstructionSite): SquadPlan {
    // Big shuttles, few bodies (owner 2026-07-18: construction consumes 5x
    // more energy per WORK, so the DELIVERY side is the binding constraint -
    // "we actually need the haulers to be bigger"). The old 4-CARRY cap
    // forced 200-capacity shuttles out of an 1800-capacity room.
    const perTanker = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / 100), 16));
    const target = this.targetTankerCount(room, site, perTanker, ctx);
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
   * CREW PLAN's consumption over the refuel round-trip, never fewer than two
   * so there is always one staged for a seamless hot swap. Sized to the PLAN
   * (builderPlan's buildEnergy), not the fielded builders - the relay must
   * arrive WITH the crew, not lag it (consumers size to their allocated flow;
   * the ledger shrinks the ALLOCATION when parts are scarce, never the crew
   * against a funded flow). The round-trip endpoint is the SAME lens the
   * tanker fetch uses: the storage in the surplus regime, the nearest source
   * otherwise - sizing and fetching cannot disagree.
   */
  /**
   * The construction site the tanker detail serves: the POOL head's first
   * site - home when home builds, else the nearest room with sites (the same
   * ordering the crew itself works, so carriers and builders never disagree
   * on where the project is).
   */
  private poolTankerSite(spawnRoomName: string): ConstructionSite | null {
    // First entry WITH vision: tankers need a real site to serve; blind
    // receipt entries wait for the builders' vision bootstrap.
    for (const entry of buildPool(spawnRoomName)) {
      if (!entry.room) continue;
      const site = entry.room.find(FIND_MY_CONSTRUCTION_SITES)[0] as ConstructionSite | undefined;
      if (site) return site;
    }
    return null;
  }

  private targetTankerCount(room: Room, site: ConstructionSite, perTanker: number, ctx: SpawnDemandContext): number {
    const consumption = Math.max(5, this.builderPlan(ctx.energyCapacity, room).partsNeeded! * 5);
    const bank = room.storage;
    const surplusBanked = bank?.my && spendableBankSurplus(bank.store[RESOURCE_ENERGY] ?? 0) > 0;
    const fuelPos = surplusBanked ? bank!.pos : site.pos.findClosestByRange(FIND_SOURCES)?.pos;
    // A pool site can sit in ANOTHER room (same-room getRangeTo is Infinity
    // across rooms - an unfixed count would be Infinity, not a fleet): price
    // the cross-room shuttle at the linear room distance.
    const dist = !fuelPos
      ? 8
      : site.pos.roomName === fuelPos.roomName
      ? site.pos.getRangeTo(fuelPos)
      : roomLinearDistance(site.pos.roomName, fuelPos.roomName) * 50;
    // CARRY needed in flight to sustain consumption over the round trip, with a
    // 1.5x margin: a tanker also spends ticks transferring at the builder and
    // withdrawing at the fuel point, so the bare round-trip figure under-delivers
    // and a far site starves its builder. The margin scales the relay with distance.
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
  /**
   * Remote trunk candidates (owner 2026-07-19: routes are site strings, not
   * rooms) - the plan's funded remote harvests staffed from this corp's
   * spawn. Commission-owned, refreshed by materialize every round.
   */
  public setRemoteTrunks(trunks: { sourceId: string; pos: Position; flow: number }[]): void {
    this.remoteTrunks = trunks;
  }

  /** Spec 25 phase 3: the plan's source-funded remote-cluster rate this
   * spawn's pool crew must eat (owner: "make a bigger builder").
   * Commission-owned, refreshed by materialize every round. */
  public setPoolAllocatedRate(rate: number): void {
    this.poolAllocatedRate = rate;
  }

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
      constructionAllocations: this.constructionAllocations.length > 0 ? this.constructionAllocations : undefined,
      poolAllocatedRate: this.poolAllocatedRate > 0 ? this.poolAllocatedRate : undefined,
      projects: this.projects.length > 0 ? this.projects : undefined
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
    this.poolAllocatedRate = data.poolAllocatedRate ?? 0;
    this.projects = data.projects ?? [];
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
