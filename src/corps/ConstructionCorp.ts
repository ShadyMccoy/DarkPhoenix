/**
 * @fileoverview ConstructionCorp - the construction RUNTIME (auxiliary corp
 * for building infrastructure).
 *
 * The ConstructionCorp builds extensions to increase spawn capacity.
 * It only invests in construction when there's accumulated profit,
 * ensuring the economy is stable before expanding.
 *
 * Charter (spec 35 phase H split): the Game-coupled corp itself - work()
 * (crews, squads, the repair detail), spawn demand, project reconciliation,
 * placement/paving EXECUTION and serialization. Its two split-out companions
 * own the rest: the PLAN-consumed lens surface (project ledger + build pool)
 * lives in corps/constructionLedger.ts; the placement rung tables and
 * tile-election policy live in corps/constructionPlacement.ts. This corp is
 * the only WRITER of the ledger records the lens module reads.
 *
 * @module corps/ConstructionCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { stepOffRoad, travelTo } from "./movement";
import { plan as governorPlan } from "../execution/CpuGovernor";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { Squad, SquadPlan, splitIntoMembers } from "./Squad";
import { buildBuilderBody, buildTankerBody, buildUpgraderBody, TANKER_CARRY_PER_MOVE_PLAIN } from "../spawn/BodyBuilder";
import {
  wantsCriticalRecovery,
  wantsMaintenanceBuilder,
  nextRepairTarget,
  nextBuildTarget,
  pickRepairDetail,
  repairDetailRecruit
} from "./repair";
import { MAX_BUILDERS } from "./CorpConstants";
import { recordRepair } from "../telemetry/LossMeter";
import { creepRepairEnergy } from "../economy/primitives";
import { Position } from "../types/Position";
import { SinkAllocation } from "../flow/FlowTypes";
import {
  BUILD_ENERGY_PER_WORK,
  bufferCarryParts,
  carryPartsFor,
  DIRECT_DRAW_REACH,
  projectAbsorbRate,
  refuelIntervalTicks,
  SOURCE_RATE,
  supplyMethod,
  sustainableConsumptionRate,
  workPartsForEnergyRate
} from "../economy/primitives";
import { feederRelayRate, spendableBankSurplus, resolveReserveTarget } from "../economy/bank";
import {
  declinedVerdictStands,
  effectiveOneWayTiles,
  evaluateRoadRoute,
  tankerCarryNeededFor,
  RoadRouteSpec
} from "../economy/roadEconomics";
import { bestAdjacentTile, controllerInputSpot, controllerLink, coreLink, isRoomEdgeTile, isSourceApproachTile, sourceHarvestSpot, sourceLink } from "./nodeEnergy";
import { roomLinearDistance } from "../utils/RoomDiscovery";
import { buildPool, buildPoolAbsorbRate, buildPoolBacklog, ProjectRecord, PROJECT_LEDGER_DECAY } from "./constructionLedger";
import {
  bestControllerLinkTile,
  containersUnlocked,
  CONTAINER_LIMIT,
  EXTENSION_LIMITS,
  findGridPosition,
  LINK_LIMITS,
  LINK_MIN_SOURCE_RANGE,
  emergenceTileCount,
  PLACEMENT_COOLDOWN,
  placementGateOpen,
  SPAWN_EMERGENCE_MIN,
  SPAWN_PLACEMENT_ATTEMPTS,
  ROAD_PAYBACK_HORIZON,
  ROAD_RESURVEY_INTERVAL,
  ROAD_SPAWN_PART_VALUE,
  SITE_CAP,
  SOURCE_CONTAINER_PILE_THRESHOLD,
  STORAGE_MIN_RCL,
  TOWER_MIN_RCL,
  TrunkSurvey,
  trunkGateFromSurvey,
  wantsAnotherSpawn
} from "./constructionPlacement";

/**
 * Serialized state specific to ConstructionCorp
 */
export interface SerializedConstructionCorp extends SerializedCorp {
  spawnId: string;
  lastPlacementAttempt: number;
  /** Builder count the demand lens last wanted (release/adopt hand-off). */
  wantedBuilders?: number;
  /** Flow-based construction allocations (from FlowEconomy) */
  constructionAllocations?: SinkAllocation[];
  /** Spec 25 phase 3: source-funded remote-cluster rate for the pool crew */
  poolAllocatedRate?: number;
  /** The project ledger (pattern: constructionLedger.ProjectRecord). */
  projects?: ProjectRecord[];
}

/** The supply vector never runs fewer than two carriers (hot-swap staging);
 * also the delivery-cadence divisor the builder's buffer bridges (spec 34). */
const TANKER_FLOOR = 2;

/**
 * The tanker sizing formula MOVED to the economy formula home
 * (roadEconomics.tankerCarryNeededFor, 2026-08-02 - phase 1 of the
 * income-statement program): living here, outside economy/, was exactly how
 * the commission's all-in price kept the 1:1 vector model while this corp
 * fielded the gait-aware 3:1 fleet - F1 booked the difference as breach on
 * every build campaign. Re-exported so existing imports (the unit suite)
 * keep working; the arithmetic is byte-identical.
 */
export { tankerCarryNeededFor } from "../economy/roadEconomics";

/**
 * ConstructionCorp manages builder creeps that construct extensions.
 */
/**
 * A builder walking with energy repairs the road under it (owner 2026-07-22:
 * "2 birds with one stone. it moves faster, and roads get repaired") - repair
 * stacks with move in the same tick (different action groups), so travel ticks
 * become road maintenance at 1 energy/WORK/tick, and the roads the crew's own
 * traffic wears stay at full speed. Roads only (structural maintenance stays
 * the repair detail's job), most-damaged first. Guards keep it free: never
 * fires empty (the refuel walk costs nothing) and never on WORK-less bodies
 * (tankers), skipping even the range search.
 */
/**
 * The non-live corpId a released builder carries so OrphanRescue picks it up
 * (rescue SKIPS creeps with no corpId at all - "unmanaged by design" - so
 * deletion would strand them). BUILDER HAND-OFF (owner 2026-07-22
 * accountability ruling: "they could orphan and adopt creeps if necessary"):
 * measured across three captures, the remote container/road corps each bought
 * a fresh 4-part builder for their stint while the finished room's builder
 * idled to TTL death - no retirement path existed ("their builders age out").
 * Release -> constructionKind.claimsOrphan adopts into the nearest corp whose
 * demand wants a builder; no taker -> ordinary grace -> recycle refund.
 */
export const RELEASED_BUILDER_CORP_ID = "released-builder";

/**
 * How long the build pool must stay drained before it counts as OPERATION END
 * (spec 34 D6). Between ladder rungs the pool is legitimately empty for up to
 * PLACEMENT_COOLDOWN ticks (a site completes; the next placement attempt runs
 * on the cooldown clock), so an instantaneous pool-empty trigger would churn
 * the whole tanker detail every rung (the measured 25t churn-loop class). Two
 * cooldowns = the extension rung AND the surplus road pass each had a full
 * attempt at the drained pool and declined - the ladder is genuinely done,
 * not between placements. Builders need no such window: their release rides
 * the demand-lens want and re-adoption (claimsOrphan) recovers them within
 * the 25t orphan grace when the next rung lands.
 */
export const OPERATION_END_CONFIRM_TICKS = PLACEMENT_COOLDOWN * 2;

// Re-exported so the builder-assignment tests and callers reach the build-side
// latch through the corp that owns it (its twin nextRepairTarget lives here too).
export { nextBuildTarget };

export function repairRoadEnRoute(creep: Creep): void {
  if (creep.store[RESOURCE_ENERGY] === 0 || creep.getActiveBodyparts(WORK) === 0) return;
  const roads = creep.pos.findInRange(FIND_STRUCTURES, 3, {
    filter: (s: Structure) => s.structureType === STRUCTURE_ROAD && s.hits < s.hitsMax
  });
  if (roads.length === 0) return;
  roads.sort((a, b) => a.hits - b.hits);
  if (creep.repair(roads[0]) === OK) recordRepair(creepRepairEnergy(creep.getActiveBodyparts(WORK)));
}

export class ConstructionCorp extends Corp {
  /** ID of the spawn to use */
  private spawnId: string;

  /** Last tick we attempted to place extensions */
  private lastPlacementAttempt = 0;
  /** Cooldown clock for the surplus road-scan path (not persisted - a reset
   * just re-arms the scan a cooldown early, which is harmless). */
  private lastRoadAttempt = 0;
  private remoteTrunks: { sourceId: string; pos: Position; flow: number }[] = [];

  /**
   * Builder count the demand lens wanted at its last walk - stashed by
   * getSpawnDemand at every return path so release (work) and adoption
   * (claimsOrphan) read the SAME decision the spawn side priced, never a
   * recomputation (staffsPost symmetry). Serialized: survives resets.
   * NULL = never stashed (fresh corp, or pre-hand-off memory at the deploy
   * boundary): release must NO-OP then - treating unknown as 0 would have
   * released every builder colony-wide on the first post-deploy tick.
   */
  private lastWantedBuilders: number | null = null;

  /**
   * First tick the build pool was observed drained (spec 34 D6), or null while
   * work stands. Transient by design: a reset mid-drain just restarts the
   * confirm window - a few ticks of extra patience, never a wrong release.
   */
  private poolDrainedSince: number | null = null;

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
      usefulPart: CARRY,
      why: "infra" // agenda label: DECLARED, never derived from the role name (spec 35 phase D)
    });
  }

  /**
   * The room this corp BUILDS in - its commission's room, which during an
   * expansion founding differs from the STAFFING spawn's room (spec 06: the
   * new room's corps attribute to the parent spawn until its own stands).
   * Falls back to the spawn's room without vision.
   */
  /** The room this corp builds in, vision or not (the nodeId is the truth). */
  public workRoomName(): string {
    return this.nodeId.replace(/-construction$/, "");
  }

  /**
   * Does this corp's demand lens want one more builder than it fields? Read
   * by constructionKind.claimsOrphan to route a released builder here instead
   * of letting the spawn buy a fresh body. Counts live members the same way
   * the squad does; compares against the stashed demand decision.
   */
  public wantsAnotherBuilder(): boolean {
    if (this.lastWantedBuilders === null || this.lastWantedBuilders <= 0) return false;
    let members = 0;
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c.memory.corpId === this.id && c.memory.workType === "build" && !c.spawning) members++;
    }
    return members < this.lastWantedBuilders;
  }

  /**
   * BUILDER HAND-OFF, release half (owner accountability ruling): builders
   * beyond the demand lens's stashed want are RELEASED - corpId set to the
   * non-live marker so OrphanRescue re-homes them (claimsOrphan -> the
   * nearest corp that wants one; nobody -> grace -> recycle refund). Keeps
   * the repair detail first (a standing function), then the freshest bodies
   * (most remaining life = most value). Replaces the measured idle-to-death:
   * "their builders age out" while sibling corps bought fresh 4p bodies.
   */
  private releaseExcessBuilders(): void {
    if (this.lastWantedBuilders === null) return; // unknown want: never release on a guess
    const wanted = Math.max(0, this.lastWantedBuilders);
    const members = this.builders.members().filter(c => !c.memory.recycling);
    if (members.length <= wanted) return;
    const keepRank = (c: Creep): number => (c.memory.repairDetail ? 1_000_000 : 0) + (c.ticksToLive ?? 0);
    const ordered = [...members].sort((a, b) => keepRank(b) - keepRank(a));
    for (const creep of ordered.slice(wanted)) {
      creep.memory.corpId = RELEASED_BUILDER_CORP_ID;
      delete creep.memory.repairDetail;
    }
  }

  /**
   * COHORT RELEASE (spec 34 D6): release is an OPERATION-END event. When the
   * build pool drains - work COMPLETE, confirmed against the placement
   * cadence - every squad releases the same tick: builders to the adoption
   * marker (claimsOrphan routes them to the next corp that wants one, else
   * grace -> recycle), the vector's carriers straight to CORP-DRIVEN recycle
   * (memory.recycling; Squad.run walks them to the spawn, banks any cargo,
   * refunds the body). Tankers deliberately SKIP the orphan path: no rescue
   * exists for them by design (the tender kind declines foreign tanks), so
   * the 25t orphan grace bought nothing and cost plenty - a released tanker
   * FROZE in place through the grace, and it was last standing inside the
   * extension cluster: measured as fid-t4-synthetic's refill-SLA breach at
   * t1091 (deterministic, two draws - the frozen tanker parked on the
   * tender's refill-approach tile while an extension sat 44 short).
   *
   * The trigger is the SAME buildPool lens the demand side gates orders on
   * (staffsPost symmetry) - physical standing work, never the plan's
   * allocation. A mid-operation WANT DIP is the defund shape: the spawn
   * side already orders no new bodies, and the standing fleet keeps eating
   * the pool to natural death. Releasing on the dip is the trap-list
   * revocation class - measured in the builder-buffer-feed cell as a
   * stranded 2W builder: the re-solve repriced the shrinking pool (want
   * 2 -> 1), the "excess" builder froze as an unwanted orphan holding 80
   * energy while 6k+ of funded work stood and its vector kept delivering.
   * Only finished work releases anyone.
   */
  private releaseCohortAtOperationEnd(spawn: StructureSpawn, tick: number): void {
    if (buildPoolBacklog(spawn.pos.roomName) > 0) {
      this.poolDrainedSince = null; // work stands (funded or not): not operation end
      return;
    }
    if (this.poolDrainedSince === null) this.poolDrainedSince = tick;
    if (tick - this.poolDrainedSince < OPERATION_END_CONFIRM_TICKS) return;
    // The stashed want at a drained pool is the standing repair detail
    // (repairerPlan) - releaseExcessBuilders keeps exactly that.
    this.releaseExcessBuilders();
    for (const tanker of this.tankers.members()) {
      tanker.memory.recycling = true; // corp-driven: walk out, bank cargo, refund
    }
  }

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
        repairRoadEnRoute(creep);
      }, spawn);
      return;
    }
    const controller = room.controller;
    if (!controller) return;

    if (this.isRemoteWorkRoom(room)) {
      // Hand-off, release half (REMOTE stint): the want here is a stable
      // LOCAL signal (container project / trunk road sites standing), so a
      // drop means this room's work is genuinely done - release immediately
      // and claimsOrphan walks the builder to the next project (the original
      // hand-off incident: finished remotes idling builders to TTL death
      // while siblings bought fresh bodies). The HOME pool corp releases
      // through the operation-end cohort below instead - its want is a
      // re-solve PRICE that dips mid-operation (revocation trap class).
      this.releaseExcessBuilders();
      // Remote rung: one source container at a time, triggered by the pile
      // threshold (findMissingSourceContainer), built from that same pile.
      const spot = this.remoteContainerSiteWanted(room);
      if (spot) this.placeSite(room, spot.x, spot.y, STRUCTURE_CONTAINER);
      // The repair detail is dispatched here exactly as at home (owner
      // 2026-07-21 "or partially built": the old branch ran EVERYONE through
      // runBuilder, so the detail the demand fielded for a decaying remote
      // container idled at the sites gate while the container rotted).
      // A remote crew's build work is this room's own sites (the pool lens is
      // the HOME corp's; a remote corp never leaves its room).
      this.assignRepairDetail(room, this.localSiteWork(room));
      this.builders.run(
        creep => (creep.memory.repairDetail ? this.doMaintenance(creep, room) : this.runBuilder(creep, room)),
        spawn
      );
      return;
    }

    // COHORT RELEASE (spec 34 D6): the home pool corp releases squads only at
    // confirmed operation end - see releaseCohortAtOperationEnd for why a
    // mid-operation want dip must NOT release (revocation trap class).
    this.releaseCohortAtOperationEnd(spawn, tick);

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
    // The spawn rung joins the gate's "is anything wanted" test, or
    // canBuildMore closes and tryPlaceNextSite never runs far enough to reach it.
    const wantsSpawn = wantsAnotherSpawn(
      rcl,
      room.find(FIND_MY_SPAWNS).length,
      room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_SPAWN }).length
    );
    // BATCH THE WHOLE WANTED SET (owner 2026-07-29): the gate no longer waits
    // for activeSites === 0. Sizing reads work that EXISTS as sites
    // (siteWorkRemaining -> projectAbsorbRate), so one-at-a-time placement
    // capped the crew against a single open site while the rest of the
    // build-out stayed invisible - the extension-batch reasoning (owner
    // 2026-07-20) generalized to every rung. Focus is preserved on the BUILD
    // side (the latch + buildRank ladder order), not by starving the board.
    const canBuildMore = placementGateOpen({
      activeSites,
      wantsMore:
        currentExtensions < maxExtensions ||
        wantsContainer ||
        wantsStorage ||
        wantsLink ||
        wantsTower ||
        wantsSpawn ||
        this.wantsRoadWork(room),
      atSiteCap: Object.keys(Game.constructionSites ?? {}).length >= SITE_CAP,
      // Widening is funded by the warchest surplus - the same lens paving
      // uses. Without it a cold room keeps the one-at-a-time ladder so the
      // construction sink cannot out-compete its own income (see
      // placementGateOpen).
      hasSurplus:
        !!room.storage?.my &&
        spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget)) > 0
    });

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
      spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget)) > 0 &&
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
    // ONE BUILD POOL (owner 2026-07-20): the crew works the pool's head room
    // - home first, else the nearest room with sites (its trunk tiles, a
    // founding site two rooms over, wherever). runBuilder already drives and
    // refuels in whatever room it is handed (the remote rung proved it).
    // Walked ONCE per tick and reused - the scan finds sites in every visible
    // room, so re-deriving it per reader is a real CPU line, not a nicety.
    const pool = buildPool(spawn.pos.roomName);
    // The DURABLE build-work signal for the last-builder rule: pool WORK,
    // which charges blind receipt rooms their unbuilt share, so a room going
    // dark cannot read as "nothing to build" and conscript the whole crew
    // (CLAUDE.md: room state from intel, never vision).
    const buildWork = pool.reduce((s, e) => s + e.work, 0) > 0;
    this.assignRepairDetail(room, buildWork);
    const poolHead = pool[0];
    if (poolHead && !poolHead.room) {
      // BLIND receipt head (stranded-trunk deadlock): no vision anywhere in
      // the pool - the crew's own travel is the only thing that can restore
      // it. March the builders at the receipt room; the repair detail keeps
      // its beat, tankers hold their home loop until a real site resolves.
      // STAMPED before the early return (2026-07-30): this branch wrote NO
      // sizing record, so a crew marching at a blind head was indistinguishable
      // from a crew that never ran - the P8 "CREW IDLE" read had no way to see
      // it. A silent early return in a decision path is a hole in spec 14 by
      // construction.
      this.stampSizing({ ...this.poolStamp(pool), ...this.crewStamp(room), gate: "blind-head" });
      this.builders.run(
        creep =>
          creep.memory.repairDetail
            ? this.doMaintenance(creep, room)
            : void (travelTo(creep, new RoomPosition(25, 25, poolHead.roomName)), repairRoadEnRoute(creep)),
        spawn
      );
      this.tankers.run(creep => this.runTanker(creep, room), spawn);
      return;
    }
    const buildRoom = poolHead?.room ?? room;
    // The vector-is-live signal for the parked-burn path (spec 34 D1/D2):
    // this corp's own fielded carriers, the census lens for the very
    // decision tankerPlan priced. Fetch worlds field none and keep the
    // full-refill toggle.
    const vectorFed = this.tankers.members().length > 0;
    // CREW-SPLIT STAMP (owner 2026-07-29: "there's a big builder, but he's
    // going around repairing roads instead"). Live t72667111: the spawn site
    // was placed OK at 42,22 (siteTotal 15000) but siteProgress sat at 0 for
    // ~500 ticks with 2 builders fielded - and because a structure site
    // reserves a source for the crew, P9 routed fell 110 -> 81.4 e/t and the
    // piles began returning. So the cost is income loss AND no progress.
    // One hypothesis was already falsified by code read (non-detail builders
    // cannot divert to repair - pickCriticalRepairTarget is an unused import),
    // so per spec-14 doctrine the next step is a STAMP, not a second guess:
    // export who is on which detail and what each is actually latched to.
    this.stampSizing({
      ...this.poolStamp(pool),
      ...this.crewStamp(room),
      buildRoom: buildRoom.name,
      tankers: this.tankers.members().length,
      vectorFed,
      wantsMaintenance: this.wantsMaintenance(room),
      // The last-builder rule's input: with buildWork true and crew 1, the
      // detail is NOT recruited (repairDetailRecruit) - so a future
      // "crew 1 / onRepairDetail 1" stamp is readable as a bug, not a policy.
      buildWork,
      dedicatedSource: room.memory.dedicatedBuildSourceId ? 1 : 0
    });
    this.builders.run(
      creep =>
        creep.memory.repairDetail ? this.doMaintenance(creep, room) : this.runBuilder(creep, buildRoom, vectorFed),
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
   *
   * `buildWork` is the crew's OUTSTANDING build work (backlog for the home
   * pool, local sites for a remote room). It never clears an active detail -
   * it only blocks conscripting the LAST builder (see repairDetailRecruit).
   */
  private assignRepairDetail(room: Room, buildWork: boolean): void {
    const members = this.builders.members();
    const detail = members.find(c => c.memory.repairDetail);
    const critical = this.wantsCriticalRecovery(room, detail !== undefined);
    if (!this.wantsMaintenance(room) && !critical) {
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
    if (!repairDetailRecruit({ crew: members.length, hasDetail: detail !== undefined, buildWork, critical })) return;
    // The SMALLEST body takes the beat - a big builder's WORK belongs on the
    // sites, not parked on a road (see pickRepairDetail).
    const recruit = pickRepairDetail(members, c => this.builderSize(c));
    if (recruit) recruit.memory.repairDetail = true;
  }

  /** Body size of a crew member for the detail pick; 0 when unmeasurable (partial mocks). */
  private builderSize(creep: Creep): number {
    try {
      return creep.getActiveBodyparts(WORK);
    } catch {
      return 0;
    }
  }

  /**
   * WHERE the crew was sent and what it competed against (P8 diagnosis,
   * 2026-07-30). The P8 "CREW IDLE" read could see 15 remote sites and 0
   * progress but not WHICH room the pool elected - and the pool ranks HOME
   * first, then by linear distance, so a distance-1 room carrying a blind
   * receipt share outranks the distance-2 room where the real sites stand.
   * Whether that actually happens is the open question; this stamp answers it
   * from data instead of a second theory.
   */
  private poolStamp(pool: { roomName: string; room?: Room; work: number }[]): { [k: string]: number | string } {
    const head = pool[0];
    return {
      poolHead: head?.roomName ?? "",
      poolHeadBlind: head && !head.room ? 1 : 0,
      poolRooms: pool.length,
      // Room:work for the whole pool, so the ELECTION is reproducible from the
      // stamp - the ranking is what is in question, not just its winner.
      poolWork: pool.map(e => `${e.roomName}${e.room ? "" : "*"}:${Math.round(e.work)}`).join(",")
    };
  }

  /** Who is in the crew, where they stand, and what each is doing (P8 diagnosis). */
  private crewStamp(room: Room): { [k: string]: number | string } {
    const crew = this.builders.members();
    // The VECTOR path never sets memory.working (it builds whenever the store
    // holds energy - spec 34 parked consumer), so the working-derived F/W
    // letters lied there: a correctly PARKED builder awaiting its tanker
    // stamped "F" ("stuck fetching") - recorded stamp defect, t72676091. On
    // the vector path the truthful split is fed vs dry.
    const vectorFed = this.tankers.members().length > 0;
    return {
      crew: crew.length,
      onRepairDetail: crew.filter(c => c.memory.repairDetail).length,
      latchedToSite: crew.filter(c => c.memory.buildTargetId).length,
      // R=repair detail, B=latched to a site; vector path: V=parked-fed
      // (energy aboard, burning), D=parked-dry (awaiting the tanker); fetch
      // path: W=working (building), F=fetching. "-" never appears - every
      // state has a letter, so no two states share a reading (the original
      // "-" was ambiguous across four states and t72675034 could not close).
      buildTargets: crew
        .map(c => {
          if (c.memory.repairDetail) return "R";
          if (c.memory.buildTargetId) return "B";
          if (vectorFed) return (c.store?.[RESOURCE_ENERGY] ?? 0) > 0 ? "V" : "D";
          return c.memory.working ? "W" : "F";
        })
        .join(""),
      // Where the crew actually STANDS - a builder marching between rooms and
      // a builder parked at home look identical in every other field.
      crewAt: crew.map(c => c.room?.name ?? "?").join(","),
      crewHome: crew.filter(c => c.room?.name === room.name).length
    };
  }

  /** Whether this room has construction work standing (partial mocks -> false). */
  private localSiteWork(room: Room): boolean {
    try {
      return room.find(FIND_MY_CONSTRUCTION_SITES).length > 0;
    } catch {
      return false;
    }
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
    if (room.storage?.my)
      stock += spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget));
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
    buildEnergy = Math.max(BUILD_ENERGY_PER_WORK, buildEnergy);
    const totalWork = Math.max(1, workPartsForEnergyRate(buildEnergy, BUILD_ENERGY_PER_WORK));
    // SPEC 34 D2/D3: the fuel GEOMETRY sizes the onboard buffer of the PARKED
    // builder (owner: "they stay in one place building" - haulers bring the
    // energy). One lens with the tanker fetch (buildFuelDistance); the supply
    // verdict is computed (fuel withdraw-adjacent -> direct draw in place, no
    // vector); the buffer bridges the delivery interval (vector drops every
    // RT/n; adjacent draw needs barely a tick's worth). A slower burner needs
    // less buffer, so the buffer scales with each member's WORK -
    // buildBuilderBody preserves the ratio under a tight budget.
    const bufSite =
      (room.find(FIND_MY_CONSTRUCTION_SITES)[0] as ConstructionSite | undefined) ??
      (spawnForTravel ? this.poolTankerSite(spawnForTravel.pos.roomName) : null);
    const fuelDist = bufSite ? this.buildFuelDistance(room, bufSite) : 8;
    const supply = supplyMethod(buildEnergy, fuelDist);
    // The buffer bridges the vector's REAL cadence (owner 2026-07-28): the
    // interval reads the gait+road effective distance - the same lens the
    // fleet is sized with - while supplyMethod keeps the RAW tiles (its
    // direct-draw verdict is geometric adjacency, not travel time).
    const bufPavedF = bufSite ? this.buildFuelPavedFraction(room, bufSite) : 0;
    const effFuelDist = effectiveOneWayTiles(fuelDist, bufPavedF, TANKER_CARRY_PER_MOVE_PLAIN);
    const interval = refuelIntervalTicks(effFuelDist, supply.method === "vector" ? TANKER_FLOOR : 0);
    const bufferFor = (work: number): number =>
      Math.max(1, Math.ceil(bufferCarryParts(work * BUILD_ENERGY_PER_WORK, interval)));
    // The biggest single builder this room's extension capacity can build, in
    // the buffered shape (buildBuilderBody shrinks-to-fit, so its workParts IS
    // the affordable max for the WORK:buffer ratio).
    const maxPerBuilder = Math.max(1, buildBuilderBody(totalWork, bufferFor(totalWork), energyCapacity).workParts);
    const { count, partsPerMember } = splitIntoMembers(totalWork, maxPerBuilder, MAX_BUILDERS);

    const bufferCarry = bufferFor(partsPerMember);
    const desired = buildBuilderBody(partsPerMember, bufferCarry, energyCapacity);
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
      bufferCarry,
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
      // Deliver to the POOL CREW only - the repair detail self-fuels at
      // containers/storage by design (repairerPlan) and must never soak the
      // pool's fuel (incident t72504146: three full ~800-energy tankers
      // orbited the wandering detail at home while the cross-room pool
      // builder burned its own 50 carry at the cd8d trunk and stood dry to
      // TTL death - trunk frozen at 51/53 for 3,300+ ticks, ledger P8 FAIL).
      const crew = this.builders.members().filter(b => !b.memory.repairDetail);
      const eligible = crew.filter(b => b.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
      // NEED-FIRST dispatch (haul-t3-dedicated-runt-heals, 2026-07-28):
      // builders below half buffer are served before anyone is topped off.
      // Closest-only let a container-adjacent builder - self-refueling, so
      // ~5 free capacity every tick - shadow a parked sibling standing at
      // ZERO for its whole life (parked builders don't walk to fuel; the
      // vector is their lifeline, and a starving member is the vector's
      // first duty).
      const hungry = eligible.filter(b => b.store[RESOURCE_ENERGY] < (b.store.getCapacity(RESOURCE_ENERGY) ?? 0) / 2);
      const pickFrom = hungry.length > 0 ? hungry : eligible;
      // findClosestByRange is SAME-ROOM-ONLY - the t72504146 blindness: a
      // pool builder in another room was invisible to the pick. Nearest
      // local crew wins as before; with NO local crew the tanker marches at
      // the cross-room builder (transfer returns ERR_NOT_IN_RANGE until it
      // arrives - moveTo paths between rooms).
      const target = creep.pos.findClosestByRange(pickFrom) ?? pickFrom[0];
      if (target) {
        if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
        }
        return;
      }
      // Everyone topped off: stage next to the POOL crew (never the detail)
      // so the hand-off is instant when a buffer opens.
      const stage = crew[0];
      if (stage && creep.pos.getRangeTo(stage) > 1) {
        creep.moveTo(stage, { range: 1, visualizePathStyle: { stroke: "#ffaa00" } });
      } else if (stage) {
        // Staged and idle: clear the delivery lane (owner 2026-07-22 -
        // standing workers stand off the roads), keeping hand-off range 1.
        stepOffRoad(creep, stage.pos, 1);
      }
      return;
    }

    // SURPLUS-SPEND REGIME: with the warchest full, the bank IS the build
    // fuel - the tanker draws from storage directly (same spendable-surplus
    // lens as buildSideStock, so sizing and fetching cannot disagree). This
    // is what lets road projects burn banked energy instead of waiting on a
    // committed source's trickle.
    const bank = room.storage;
    if (bank?.my && spendableBankSurplus(bank.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget)) > 0) {
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
    // STORAGE FALLBACK for a DRY committed source (owner 2026-07-27, the link-fed
    // build-stall): a LINK-SERVED source feeds its link, never a container/pile,
    // so once the warchest drops OUT of surplus (the surplus fast-path above no
    // longer fires) the tanker finds no ground fuel and would wait here forever -
    // the builder starves and the crew idles (measured t72597918: 3 extension
    // sites, a 2-WORK builder, 0 built, storage ~55k sitting at the reserve). Draw
    // the plan-allocated build fuel from the BANK instead: the mined income lands
    // there (via the links/feeder), so the tanker moves the construction share
    // through storage to the builder. Bounded by the crew's allocation (sized to
    // the mined-income share below surplus) and by the finite remaining site work,
    // so it finishes the rebuild and stands down - it does not bleed the reserve.
    if (bank?.my && (bank.store[RESOURCE_ENERGY] ?? 0) > 0) {
      if (creep.withdraw(bank, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(bank, { visualizePathStyle: { stroke: "#00ff00" } });
      }
      return;
    }
    // Nothing to grab yet: wait at the source so we are ready when it drops.
    if (creep.pos.getRangeTo(source) > 1) {
      creep.moveTo(source, { range: 1, visualizePathStyle: { stroke: "#00ff00" } });
    } else {
      // Waiting and idle: stand off the road (the structure-free rule inside
      // also keeps it off the miner's container tile).
      stepOffRoad(creep, source.pos, 1);
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
   *
   * CONDITIONAL DEDICATION ATTEMPTED AND REVERTED (2026-07-28, same day): an
   * "earned reservation" gauge - dedicationJustified(min(standing burn, pool
   * absorb), sourceRate) - was landed on the owner's "make sure the builder
   * does its job and is sized correctly" and reverted after the grid showed
   * the always-dedicate regime is FOUR-legged coupling, not one rule: the
   * stand-down, the drain valve (yieldsToBuild's consumption-lag lens), the
   * tanker source pinning, and UpgradingCorp.effectiveAllocated's (n-1)/n
   * damping all switch on this reservation together. Gating it broke each
   * leg's dependents in turn (runt-economy cold-ramp freeze under an
   * absorb-only gauge; the refill-SLA class + fid-t5-real-maze 50->16% under
   * min(burn, absorb) - un-scaled upgraders and spread tankers drained the
   * tender's margin). The redesign is spec 34 open item 5's fork - owner
   * ruling required; measurements in the spec.
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

    // UN-RESERVED builds fetch from the SITE-NEAREST source (2026-07-28, with
    // the earned reservation): the least-loaded spread below siphoned EVERY
    // income stream at once - measured in fid-t4-preramped as a colony-wide
    // refill-SLA breach (@239 deterministic: three spread tankers drained
    // both circuits while the tender crawled at spawn self-regen; the old
    // always-dedicate had confined construction's draw to one source).
    // Nearest-to-site IS the plan's construction fill order (spec 25
    // nearest-first), so execution and plan agree on which stream funds the
    // build; the other circuits feed the core untouched.
    const site = room.find(FIND_MY_CONSTRUCTION_SITES)[0];
    if (site) {
      const nearest = site.pos.findClosestByRange(sources);
      if (nearest) {
        creep.memory.assignedSourceId = nearest.id;
        return nearest;
      }
    }

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
        return; // ONE rung per pass - see the same-tick note on tryPlaceNextSite
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
    if (
      containersOpen &&
      room.storage?.my &&
      spendableBankSurplus(room.storage.store.energy ?? 0, resolveReserveTarget(Memory.warchestTarget)) > 0
    ) {
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
        const ext = findGridPosition(room, placedHere);
        if (!ext) break;
        this.placeSite(room, ext.x, ext.y, STRUCTURE_EXTENSION);
        placedHere.add(`${ext.x},${ext.y}`);
        remaining -= 1;
        placedAny = true;
      }
      if (placedAny) return;
    }

    // 2.6 ADDITIONAL SPAWNS as the RCL allows (owner 2026-07-29). AFTER the
    //     extension set - a bigger body per spawn compounds first - but before
    //     storage/links, because spawn throughput
    //     (spawnCount * SPAWN_PARTS_PER_TICK) is the colony's hardest physical
    //     ceiling: measured t72663189-t72665987, Spawn1 ran 0.87-0.97
    //     utilization with a 4-6 deep queue against a 0.333 p/t ceiling that a
    //     second spawn DOUBLES. The rate-matched tender model then sizes itself
    //     up to feed it (spawnConsumptionCeiling scales with spawn count).
    const nextSpawn = this.findMissingSpawn(room, rcl);
    if (nextSpawn) {
      this.placeSite(room, nextSpawn.x, nextSpawn.y, STRUCTURE_SPAWN);
      return;
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
   * A route entry that needs no further work: paved AND not due for its
   * pothole re-survey, or declined at a flow that still stands
   * (declinedVerdictStands). The work() gate and the placement path MUST read
   * this same lens - if the gate thinks a stale declined verdict is settled
   * while the placement path would re-judge it, work() never routes here and
   * the re-judge never runs. The same symmetry is why `paved` is conditional
   * here: the re-survey lives inside tryPlaceRoadRoute, so a paved route that
   * counted as settled would never let work() reach the sweep that unsettles
   * it - the receipt would stay true over a hole forever.
   */
  private routeSettled(
    entry: NonNullable<Room["memory"]["roadRoutes"]>[string] | undefined,
    currentFlow: number
  ): boolean {
    if (!entry) return false;
    if (entry.paved) return !this.resurveyDue(entry);
    return !!entry.declined && declinedVerdictStands(entry.judgedFlow, currentFlow);
  }

  /**
   * Is a paved route's receipt old enough to re-verify? An entry that has
   * NEVER been re-surveyed is due at once - never `tick - 0 >= INTERVAL`,
   * which reads as "not due" for the first 1500 ticks of a server's life and
   * silently voids the whole sweep on a young colony (and in every staged
   * cell, whose clock starts at 0).
   */
  private resurveyDue(entry: NonNullable<Room["memory"]["roadRoutes"]>[string], tick = Game.time): boolean {
    return entry.resurveyed === undefined || tick - entry.resurveyed >= ROAD_RESURVEY_INTERVAL;
  }

  /**
   * POTHOLE SWEEP: re-verify routes stamped `paved` and reopen any that have
   * lost pavement (owner 2026-07-29: "sometimes the roads in remote rooms
   * decayed or got destroyed, and they never get rebuilt").
   *
   * Roads are the one thing this corp builds that can DISAPPEAR on its own. A
   * road decays to nothing in ~31k ticks under a 2:1 trunk fleet, and an
   * invader flattens one in an afternoon. Repair answers the decay half only
   * where a repair detail stands - and a trunk's PASS-THROUGH rooms (neither
   * owned nor mined) host no construction corp at all, so their tiles get no
   * maintenance and are exactly the ones that die. The receipt then lied
   * permanently: `paved` fed the 2:1 hauler repricing and every placement path
   * skipped the route, so the hole was never re-placed.
   *
   * Reopening is deliberately NOT a re-judge: the route already cleared
   * roadEconomics and stands almost entirely built, so re-running the verdict
   * could DECLINE a 97%-built road and abandon it (the revocation trap class).
   * We only drop the receipt and hand the entry back to the ordinary
   * in-progress machinery, which re-places the missing sites and re-stamps
   * `paved` through its own completion sweep once the crew rebuilds them.
   */
  private resurveyPavedRoutes(room: Room, routes: NonNullable<Room["memory"]["roadRoutes"]>): void {
    const trunkByKey = new Map(this.remoteTrunks.map(t => [t.sourceId.replace(/^source-/, ""), t]));
    for (const key in routes) {
      const entry = routes[key];
      if (!entry?.paved || !this.resurveyDue(entry)) continue;

      if (entry.tiles3 && entry.rooms) {
        const trunk = trunkByKey.get(key);
        // Not in the plan any more: no rebuild (a road to a source we no
        // longer fund is dead capital) and no revocation either - the
        // standing road keeps serving whoever walks it.
        if (!trunk) continue;
        // The survey IS the re-placement: it stamps a site on every visible
        // tile missing its road, and reports which tiles those were.
        const survey = this.placeTrunkSites(entry.rooms, entry.tiles3, trunk.pos);
        entry.resurveyed = Game.time;
        entry.total = survey.total;
        // Ground truth may count DOWN here - the ratchet elsewhere exists to
        // stop a BLIND pass from deflating the pave fraction (and flapping
        // the hauler body), not to deny a fully-visible pass that watched a
        // road die. With any room blind the ratchet still holds.
        entry.built = survey.blind.length === 0 ? survey.built : Math.max(entry.built ?? 0, survey.built);
        // `missing` is exactly "a visible, placeable tile with no built road"
        // - blind-safe by construction, so a trunk we cannot see is never
        // reopened on a guess.
        if (survey.missing.length === 0) continue;
        delete entry.paved;
        this.stampSizing({
          roadGate: `trunk-reopened-${survey.missing.length}`,
          trunkMissing: survey.missing.join(" ")
        });
        console.log(
          `[Construction] TRUNK to ${key} lost pavement (${survey.built}/${survey.total} standing, ` +
            `${survey.placed} sites re-placed) - receipt dropped, rebuilding`
        );
        return; // one project at a time, same as the placement paths
      }

      // In-room route (source lane or the feeder): this room's own tiles,
      // full vision, so the check is exact.
      entry.resurveyed = Game.time;
      if (entry.tiles.length === 0 || this.roadTilesBuilt(room, entry.tiles)) continue;
      delete entry.paved;
      const placed = this.placeMissingRoadSites(room, entry.tiles);
      this.stampSizing({ roadGate: `road-reopened-${key.slice(-4)}` });
      console.log(
        `[Construction] Route ${key} lost pavement (${placed} sites re-placed) - receipt dropped, rebuilding`
      );
      return;
    }
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
    const feederFlow = room.storage?.my
      ? feederRelayRate(room.storage.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget))
      : 0;
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

    // Maintenance of what stands comes before investment in what doesn't: a
    // reopened route is a road we already paid for and are losing, while every
    // path below is a new commitment. It runs FIRST so the one-route-at-a-time
    // returns downstream can never starve it.
    this.resurveyPavedRoutes(room, routes);

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
      const surplusBanked =
        room.storage?.my &&
        spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget)) > 0;
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
      !declinedVerdictStands(
        entry.judgedFlow,
        feederRelayRate(bank.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget))
      )
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

    if (
      spendableBankSurplus(bank.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget)) <= 0 &&
      room.energyAvailable < room.energyCapacityAvailable
    ) {
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
    const spec = this.roadRouteSpec(
      room,
      tiles,
      feederRelayRate(bank.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget))
    );
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
      // A container makes any road ON its tile redundant (owner 2026-07-23):
      // the miner stands there statically and haulers STOP to load, so fatigue
      // clears while standing and the road saves nothing (the isSourceApproachTile
      // rationale) - it would just decay-tax us forever under the container.
      // Container + road is engine-legal (they coexist), so this is cleanup, not
      // a placement requirement: bestAdjacentTile now lands the container on the
      // paved harvest tile and we remove the redundant road it sat on.
      if (type === STRUCTURE_CONTAINER) {
        for (const s of room.lookForAt(LOOK_STRUCTURES, x, y)) {
          if (s.structureType === STRUCTURE_ROAD) s.destroy();
        }
      }
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

  /**
   * Tile for the next SPAWN this RCL allows, or null (owner 2026-07-29: "lets
   * take a look at placing the additional spawns as rcl allows").
   *
   * Reuses findGridPosition's scoring deliberately: it already ranks buildable
   * tiles by cohesion with the extension cluster and proximity to the existing
   * spawn, and already excludes hub rings, source/controller lanes and occupied
   * tiles. That IS the right objective - the marginal value of spawn #2 is
   * THROUGHPUT, which is position-independent (the engine's _charge-energy draws
   * from ALL room extensions nearest-first, no range limit), so position only
   * moves the tender's refill walk (dominant: refillCircuit visits spawns) and a
   * ~1% creep-travel term. spawnSiteValue is deliberately NOT used - it answers
   * "where would a NEW economy run best", the wrong question for a developed
   * room whose economy is already planned and routed.
   *
   * The one thing findGridPosition cannot know: NEWBORNS NEED SOMEWHERE TO STEP
   * OUT. It packs extensions densely (extensions do not care), so its best tile
   * can be walled in - which would strand every creep the spawn builds. We walk
   * its ranking, rejecting tiles below SPAWN_EMERGENCE_MIN via its own
   * `exclude` set, and stamp each rejection so a capture names the reason.
   */
  private findMissingSpawn(room: Room, rcl: number): { x: number; y: number } | null {
    const built = room.find(FIND_MY_SPAWNS).length;
    const pending = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: s => s.structureType === STRUCTURE_SPAWN
    }).length;
    if (!wantsAnotherSpawn(rcl, built, pending)) return null;

    // Harness-safe: a partial room mock may supply neither getTerrain nor a
    // full find(). Without a terrain read we cannot prove a tile can release
    // newborns, so we decline to place rather than guess - the rung simply
    // waits for a cooldown with real vision (live rooms always answer).
    if (typeof room.getTerrain !== "function") return null;
    const terrain = room.getTerrain();
    const blockers = new Set<string>();
    for (const st of room.find(FIND_STRUCTURES)) {
      // Roads and containers are walkable; own ramparts too. Everything else
      // blocks a newborn from stepping off the spawn tile.
      if (st.structureType === STRUCTURE_ROAD || st.structureType === STRUCTURE_CONTAINER) continue;
      if (st.structureType === STRUCTURE_RAMPART) continue;
      blockers.add(`${st.pos.x},${st.pos.y}`);
    }
    const isBlocked = (x: number, y: number): boolean =>
      (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0 || blockers.has(`${x},${y}`);

    const rejected = new Set<string>();
    for (let attempt = 0; attempt < SPAWN_PLACEMENT_ATTEMPTS; attempt++) {
      const pos = findGridPosition(room, rejected);
      if (!pos) return null;
      if (emergenceTileCount(isBlocked, pos.x, pos.y) >= SPAWN_EMERGENCE_MIN) return pos;
      this.stampSizing({ spawnTileRejected: `${pos.x},${pos.y}:walled-in` });
      rejected.add(`${pos.x},${pos.y}`);
    }
    return null;
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
      // No buildable adjacent tile: every neighbour is a natural wall (a road
      // no longer disqualifies one - bestAdjacentTile places containers on
      // roads now, so a paved harvest tile is used, not skipped). With nothing
      // adjacent, bestAdjacentTile returned null and sourceHarvestSpot fell back
      // to the source's OWN tile - a container can never sit on a source (-7
      // forever), and that fallback bypasses the deadTiles loop entirely
      // (bestAdjacentTile already excludes the source tile, so blacklisting it
      // is a no-op). There is nowhere to put this source's container - skip it.
      if (spot.x === source.pos.x && spot.y === source.pos.y) continue;
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
      const tile = bestControllerLinkTile(room, ctrl);
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
    // momentarily most decayed. With nothing endangered the latch hands over the
    // NEAREST below-ceiling structure next (the range lens), so the detail sweeps
    // sequentially along a road instead of crisscrossing the room (see
    // nextRepairTarget); endangered structures still preempt by fraction.
    const target = nextRepairTarget(this.roomRepairables(room), creep.memory.repairTargetId, s =>
      creep.pos.getRangeTo(s.pos)
    );
    if (!target) {
      delete creep.memory.repairTargetId; // all healthy: idle until plan() retires this builder
      return;
    }
    creep.memory.repairTargetId = target.id;

    if (creep.store[RESOURCE_ENERGY] === 0) {
      this.refuelForMaintenance(creep, target);
      return;
    }

    // EXIT-TILE ESCAPE: same rule as doBuild - the repair detail latches
    // border roads (a paved route's tiles run right up to the exit), and
    // repairing from the exit tile teleports the detail across at tick end.
    // Repair + move stack in one tick, so the escape is free.
    const onExit = isRoomEdgeTile(creep.pos.x, creep.pos.y);
    if (onExit) {
      creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#00ff88" } });
    }

    const result = creep.repair(target);
    // MEASURED repair spend (spec 15): only an OK repair actually burned energy.
    if (result === OK) recordRepair(creepRepairEnergy(creep.getActiveBodyparts(WORK)));
    if (result === ERR_NOT_IN_RANGE) {
      if (!onExit) {
        creep.moveTo(target, { range: 1, visualizePathStyle: { stroke: "#00ff88" } });
      }
      // ERR_NOT_IN_RANGE means the target repair did NOT fire, so the work
      // action group is free: repair the road underfoot on the walk (most
      // damaged first), turning the commute into maintenance too.
      repairRoadEnRoute(creep);
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

  private runBuilder(creep: Creep, room: Room, vectorFed = false): void {
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
      // UNLADEN RELOCATION (owner, spec 34: "builders don't MOVE the energy...
      // when they move to the next site they empty their carry if necessary
      // for longer routes"): a cross-room leg IS the longer route - shed the
      // load first (adjacent store if one is there, else drop; drop and move
      // are different action groups, so shedding costs zero ticks). Empty
      // CARRY generates no fatigue: the walk runs at WORK-only speed instead
      // of dragging the buffer laden.
      this.shedLoad(creep);
      travelTo(creep, new RoomPosition(sites[0].pos.x, sites[0].pos.y, room.name), {
        range: 3,
        visualizePathStyle: { stroke: "#ffaa00" }
      });
      repairRoadEnRoute(creep);
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

    // PARKED CONSUMER (spec 34 D1/D2): while the corp fields its supply
    // vector (live tankers - the same decision tankerPlan priced), the
    // builder holds its post and burns whatever the buffer holds. Build
    // resumes on the FIRST delivered energy - the full-refill toggle below
    // is fetch-cycle logic (it stops a FETCHING builder thrashing between
    // one-tick trips), and on the vector-fed path it idled fielded WORK
    // while the tanker dribbled the buffer full: the builder-buffer-feed
    // cell measured 73% of all idle as this held-energy class. When dry the
    // builder stays parked (walking to fetch is D1's priced-out
    // counterfactual) and tops up from adjacent energy only.
    if (vectorFed) {
      if (creep.store[RESOURCE_ENERGY] > 0) {
        this.doBuild(creep, room);
      } else {
        // Dry off-post (a newborn at the spawn): walk out to the latched
        // site so the vector's deliveries land on a parked consumer.
        const target = nextBuildTarget(sites, creep.memory.buildTargetId, s => creep.pos.getRangeTo(s.pos)) ?? sites[0];
        // `|| exit tile`: a dry parked builder must never wait on a border
        // tile - tick-end teleports it and the bounce loop begins (same
        // escape as doBuild).
        if (target && (creep.pos.getRangeTo(target.pos) > 3 || isRoomEdgeTile(creep.pos.x, creep.pos.y))) {
          creep.memory.buildTargetId = target.id;
          travelTo(creep, new RoomPosition(target.pos.x, target.pos.y, room.name), {
            range: 3,
            visualizePathStyle: { stroke: "#ffaa00" }
          });
        }
      }
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        this.refuelInPlace(creep);
      }
      return;
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
   * Empty the carry before a long leg (spec 34 unladen-relocation rule): into
   * an adjacent store with room if one stands there, else onto the ground.
   * Same-tick compatible with movement, so it never delays the departure.
   */
  private shedLoad(creep: Creep): void {
    if ((creep.store[RESOURCE_ENERGY] ?? 0) <= 0) return;
    const store = creep.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (s: AnyStructure) =>
        (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE) &&
        ((s as StructureContainer).store?.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0
    })[0];
    if (store) {
      creep.transfer(store, RESOURCE_ENERGY);
      return;
    }
    creep.drop(RESOURCE_ENERGY);
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
      // No construction sites - stay put, and drop the latch so a stale id
      // never survives into the next build-out.
      delete creep.memory.buildTargetId;
      return;
    }

    // A founding crew's site is in ANOTHER room (spec 06: the corp's workRoom
    // differs from its staffing spawn's room). findClosestByPath is same-room
    // only - it returns null from home - so walk the border first. Unladen
    // (spec 34): shed the load before the long leg, same rule as runBuilder's.
    if (creep.room.name !== room.name) {
      this.shedLoad(creep);
      travelTo(creep, new RoomPosition(sites[0].pos.x, sites[0].pos.y, room.name), {
        range: 3,
        visualizePathStyle: { stroke: "#ffaa00" }
      });
      repairRoadEnRoute(creep);
      return;
    }

    // LATCH to one site and finish it before moving to the nearest next (owner
    // 2026-07-22: "they just go to a site, stay there ... and build"). The old
    // findClosestByPath re-picked every tick, so a builder drifting along a
    // paving route kept re-choosing whichever tile was momentarily closest and
    // ping-ponged; nextBuildTarget holds the site until it is built, then hands
    // over the nearest remaining one - a sequential sweep.
    const target = nextBuildTarget(sites, creep.memory.buildTargetId, s => creep.pos.getRangeTo(s.pos)) ?? sites[0];
    if (!target) return;
    creep.memory.buildTargetId = target.id;

    // EXIT-TILE ESCAPE (owner-reported 2026-07-31, measured live: builder
    // 72685930 teleport-bounced W43N23(36,49) <-> W43N22(36,0) over the road
    // site at (36,2) - the engine moves any creep standing on a border tile
    // into the next room at tick end, the cross-room branch walked it back
    // (shedding its cargo each re-entry), and the arrival tile was the exit
    // again; poolWork moved 0.28 e/t against a 30-site campaign). A latched
    // target within working range of the border makes the range-3 stop the
    // exit itself. Build and move are DIFFERENT action groups, so stepping
    // inward costs zero build throughput: same tick still builds.
    const onExit = isRoomEdgeTile(creep.pos.x, creep.pos.y);
    if (onExit) {
      creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
    }

    const result = creep.build(target);
    if (result === ERR_NOT_IN_RANGE) {
      if (!onExit) {
        creep.moveTo(target, { visualizePathStyle: { stroke: "#ffaa00" } });
      }
      // Only on the walk: a same-tick build already claimed the work action
      // group, and repair would cancel it. Spending carried energy on the road
      // underfoot also lightens the load, so the walk itself is faster.
      repairRoadEnRoute(creep);
    } else if (result === OK) {
      const workParts = creep.getActiveBodyparts(WORK);
      this.recordProduction(workParts * BUILD_ENERGY_PER_WORK);
    }
  }

  /**
   * Pick up energy from nearby sources only (stationary - don't travel for energy).
   * Haulers are responsible for delivering energy to builders.
   */
  private doPickup(creep: Creep, _room: Room): void {
    // ONE reach constant, shared with the supply verdict (primitives.
    // DIRECT_DRAW_REACH): supplyMethod may only elect a self-fetch inside the
    // range this scan actually covers. Two literals drifted apart once already
    // - the plan priced a 100-tile "direct" draw against a 4-tile scan and the
    // crew starved beside its own sites (P8, t72675271).
    const PICKUP_RANGE = DIRECT_DRAW_REACH;

    // Any walk here can carry a partial load (the builder tops up over several
    // ticks), so every moveTo repairs the road underfoot in the same tick -
    // repairRoadEnRoute no-ops when the store is empty, so a fully-drained
    // builder just walks (faster, unladen) and only a laden one maintains.
    // Check for dropped energy within range
    const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, PICKUP_RANGE, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 20
    });
    if (dropped.length > 0) {
      const target = dropped[0];
      if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
        creep.moveTo(target);
        repairRoadEnRoute(creep);
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
        repairRoadEnRoute(creep);
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
        repairRoadEnRoute(creep);
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
        repairRoadEnRoute(creep);
      }
      return;
    }

    // No energy in reach: park beside the builder's OWN latched site instead of
    // freezing where we stand - deliveries (home tankers, the founding hauler
    // lane) land AT the site, and a builder stranded outside doPickup's range-4
    // scan starves next to nothing (measured: the founding builder deadlocked
    // empty on the border tile all window). The latch keeps it walking back to
    // the site it is building, not to whichever site find() happens to list
    // first (a second site across the room would drag it off its own work).
    const latched = creep.memory.buildTargetId
      ? (Game.getObjectById(creep.memory.buildTargetId as Id<ConstructionSite>) as ConstructionSite | null)
      : null;
    const site = latched ?? (_room.find(FIND_MY_CONSTRUCTION_SITES)[0] as ConstructionSite | undefined);
    if (site && creep.pos.getRangeTo(site.pos) > PICKUP_RANGE) {
      creep.moveTo(site.pos, { range: 2, visualizePathStyle: { stroke: "#ffaa00" } });
      repairRoadEnRoute(creep);
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
      this.lastWantedBuilders = plan.target;
      return this.builders.spawnDemand(plan);
    }

    const poolWork = buildPool(spawn.pos.roomName).reduce((s, e) => s + e.work, 0);
    if (poolWork === 0) {
      // No sites anywhere: only the standing repair detail may want staffing.
      // It self-fuels at containers/storage, so it never needs tankers.
      const detailPlan = this.repairerPlan(ctx, workRoom);
      this.lastWantedBuilders = detailPlan.target;
      return this.builders.spawnDemand(detailPlan);
    }

    const crewPlan = this.builderPlanWithDetail(ctx, workRoom);
    this.lastWantedBuilders = crewPlan.target;
    const builderDemand = this.builders.spawnDemand(crewPlan);

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
   * consumption and the refuel round-trip (see tankerCarryNeeded).
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
    const perTankerMax = Math.max(1, Math.min(Math.floor(ctx.energyCapacity / 100), 16));
    const consumption = Math.max(5, this.builderPlan(ctx.energyCapacity, room).partsNeeded! * 5);
    const dist = this.buildFuelDistance(room, site);
    // SUPPLY-METHOD verdict (spec 34 D1): withdraw-adjacent fuel needs NO
    // vector - the builders draw directly (the owner's "route of length 0").
    // Beyond adjacency the computed crossover favors the dedicated vector
    // (idle WORK at 100e/part is the game's costliest waste), so the tanker
    // detail is exactly the vector's carriers - a verdict, not a category.
    if (supplyMethod(consumption, dist).method === "direct") {
      return { target: 0, desiredCost: 0, minCost: 0, bodyParam: 1 };
    }
    // GAIT + ROAD AWARE (owner 2026-07-28): the fleet is sized to the 3C:1M
    // body's REAL round trip over the route's actual paving - the old
    // 1:1-speed sizing under-delivered its own vector ~2x on unpaved routes
    // (spec 34 item 3's starvation valleys; most of the measured symptom was
    // the since-fixed closest-only dispatch, but the formula stays honest
    // regardless of the ratio built).
    const pavedF = this.buildFuelPavedFraction(room, site);
    const carryNeeded = tankerCarryNeededFor(consumption, dist, pavedF, TANKER_CARRY_PER_MOVE_PLAIN);
    // At least TWO bodies so one is always staged for a seamless hot swap, but
    // size EACH to its SHARE of the real carryNeeded - never the max body.
    // The old code fielded max(2, ...) bodies each at perTankerMax (16 CARRY at
    // RCL6), so a 2-WORK site (10 e/t, ~6 CARRY needed over a short home leg)
    // got 2x16 = 32 CARRY - the measured 34-CARRY over-provisioning
    // (t72596906): 26 CARRY of spawn parts + CPU on haul the site can't use.
    // Distribute the need across the bodies instead.
    const target = Math.max(2, Math.ceil(carryNeeded / perTankerMax));
    const carryPer = Math.max(1, Math.min(perTankerMax, Math.ceil(carryNeeded / target)));
    // The SHAPE stays 3:1 (useRoads=false): switching to 1:1 collapsed the
    // poor-economy ramp through a demand-shape interaction that is NOT yet
    // diagnosed (fid-t5-real-maze 51% -> 25%, twice, cost-cap falsified -
    // spec 34 item 3). The ratio-choice optimization is likewise out of
    // scope; only the SIZING is corrected to the shape actually built.
    const desired = buildTankerBody(carryPer, ctx.energyCapacity, false);
    const min = buildTankerBody(1, ctx.energyCapacity, false);
    return {
      target,
      desiredCost: desired.cost,
      minCost: min.cost,
      bodyParam: carryPer
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

  /**
   * Where the build site's FUEL stands: the storage in the surplus regime,
   * the nearest source otherwise - ONE lens for the vector sizing, the tanker
   * fetch, the builder's buffer, and the supply verdict (spec 34), so none of
   * them can disagree.
   */
  private buildFuelPos(room: Room, site: ConstructionSite): RoomPosition | null {
    const bank = room.storage;
    const surplusBanked =
      bank?.my && spendableBankSurplus(bank.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget)) > 0;
    return (surplusBanked ? bank!.pos : site.pos.findClosestByRange(FIND_SOURCES)?.pos) ?? null;
  }

  /** Distance from the build site to its fuel (see buildFuelPos). */
  private buildFuelDistance(room: Room, site: ConstructionSite): number {
    const fuelPos = this.buildFuelPos(room, site);
    // A pool site can sit in ANOTHER room (same-room getRangeTo is Infinity
    // across rooms): price the cross-room shuttle at the linear room distance.
    return !fuelPos
      ? 8
      : site.pos.roomName === fuelPos.roomName
      ? site.pos.getRangeTo(fuelPos)
      : roomLinearDistance(site.pos.roomName, fuelPos.roomName) * 50;
  }

  /**
   * Fraction of the straight line between the site and its fuel covered by
   * BUILT roads - the road-awareness input to the gait lens (owner
   * 2026-07-28). Reads standing road structures, deliberately NOT roadRoutes
   * receipts (the trap list: receipts-gated paths never execute in sims), so
   * staged roads in a grid cell exercise it and live roads count the moment
   * they finish. Same straight-line geometry buildFuelDistance prices, so
   * distance and paving cannot disagree about the route. Cross-room legs
   * read 0 - unknown terrain sizes as plain, the bigger-fleet direction.
   */
  private buildFuelPavedFraction(room: Room, site: ConstructionSite): number {
    const fuelPos = this.buildFuelPos(room, site);
    if (!fuelPos || fuelPos.roomName !== site.pos.roomName || site.pos.roomName !== room.name) return 0;
    if (typeof room.lookForAt !== "function") return 0; // partial mocks: plain (the bigger-fleet direction)
    const a = site.pos;
    const b = fuelPos;
    const steps = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    if (steps <= 1) return 0;
    let roads = 0;
    for (let i = 1; i < steps; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / steps);
      const y = Math.round(a.y + ((b.y - a.y) * i) / steps);
      if (room.lookForAt(LOOK_STRUCTURES, x, y).some(s => s.structureType === STRUCTURE_ROAD)) roads++;
    }
    return roads / (steps - 1);
  }

  // ===========================================================================
  // FLOW INTEGRATION
  // ===========================================================================

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
   * Serialize for persistence.
   */
  public serialize(): SerializedConstructionCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      lastPlacementAttempt: this.lastPlacementAttempt,
      wantedBuilders: this.lastWantedBuilders ?? undefined,
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
    this.lastWantedBuilders = data.wantedBuilders ?? null;
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
