/**
 * @fileoverview THE world adapter (ONTOLOGY §1): the whole PLAN<->world
 * translation layer in one module, since spec 35 phase G collapsed src/flow/'s
 * driver into it.
 *
 *  - FlowGraph: source/sink DISCOVERY from spatial nodes (the world-translation
 *    input this adapter flattens into the pure ColonyProblem);
 *  - buildColonyProblem/solveColony: run the GOAP CorpPlanner over that graph
 *    and emit both the FlowSolution shape the materialiser/telemetry consume
 *    and the Commission envelopes the corp kinds materialize from;
 *  - FlowEconomy: the solve cadence + persistence driver main.ts holds
 *    (Memory.goal / lastBankDraw / warchestTarget traffic lives HERE, behind
 *    typeof guards - the pure layers only ever receive them as arguments).
 *
 * DTO shapes stay in flow/FlowTypes.ts (Game-free, ratchet-scanned).
 *
 * @module economy/flowAdapter
 */

import "../types/Memory"; // RoomMemory.roadRoutes augmentation (paved receipts)
import { isSourceKeeperRoom, roomLinearDistance } from "../utils/RoomDiscovery";
import {
  FlowSink,
  FlowSolution,
  FlowSource,
  HaulerAssignment,
  MinerAssignment,
  SinkAllocation,
  SinkType,
  createFlowSink,
  createFlowSource,
  haulerAssignmentFromCommissioned
} from "../flow/FlowTypes";
import { Node, getResourcesByType } from "../nodes/Node";
import { countMiningSpots } from "../analysis/SourceAnalysis";
import { pathDistance, pathSwampFraction } from "../nodes/NodeNavigator";
import { Position } from "../types/Position";
import {
  controllerLink,
  coreLink,
  sourceLink,
  sourceBufferStock,
  controllerInputSpot,
  controllerParkingTiles
} from "../corps/nodeEnergy";
import { buildUpgraderBody } from "../spawn/BodyBuilder";
import {
  BUILD_ENERGY_PER_WORK,
  HARVEST_ENERGY_PER_WORK,
  INVADER_TAX_PER_ENERGY,
  UPGRADE_ENERGY_PER_WORK,
  infraSpawnEnergy,
  infraSpawnLoad,
  minerOverhead,
  projectAbsorbRate,
  workPartsForEnergyRate,
  WARTIME_BACKLOG_THRESHOLD,
  ANTI_DOWNGRADE_RESERVE
} from "./primitives";
import { detectRoomStocks, SCAVENGE_RATE_FLOOR, stockToTransientSource } from "./scavenge";
import { partialPaveRatio } from "./roadEconomics";
import {
  ColonyProblem,
  DEFAULT_SINK_VALUE,
  DepositPort,
  PlannerSink,
  PlannerSource,
  PlannerSpawn,
  SinkKind,
  planColony
} from "./CorpPlanner";
import { Commission } from "./Commission";
import { isBankSourceId, isMinedIncomeId, stripSourcePrefix, stripSpawnPrefix } from "./ids";
import { DEFAULT_VALUATION, Goal, SinkValuation, compileGoal } from "./goals";
import { searchStructure } from "./strategy";
import { commissionsFromPlan, consumerSpawnLoad } from "./commissionPlan";

// Re-exported from primitives (the coherent home for the controller sip); kept
// here so existing flowAdapter importers of the constant are unaffected.
export { ANTI_DOWNGRADE_RESERVE };

/**
 * The save-regime controller cap lives in economy/bank.ts with the rest of the
 * warchest primitives (the feeder and upgrader sizing derive from the same
 * module); re-exported here for the existing import sites.
 */
export { STORAGE_UPGRADE_TARGET } from "./bank";
import {
  STORAGE_UPGRADE_TARGET,
  bankToTransientSource,
  bankSourceId,
  controllerFloorRate,
  resolveReserveTarget,
  warchestTarget
} from "./bank";

// =============================================================================
// FLOW GRAPH - source/sink discovery from spatial nodes
// =============================================================================

/**
 * FlowGraph builds and maintains the flow network from spatial nodes.
 *
 * The flow network consists of:
 * - Sources: Energy producers (game Sources)
 * - Sinks: Energy consumers (spawns, controllers, construction sites, etc.)
 */
/** Normal controller upgrade demand (energy/tick) when nothing else competes. */
export const DEFAULT_CONTROLLER_UPGRADE_DEMAND = 50;

export class FlowGraph {
  /** All energy sources indexed by ID */
  private sources: Map<string, FlowSource>;

  /** All energy sinks indexed by ID */
  private sinks: Map<string, FlowSink>;

  /** All nodes in the network */
  private nodes: Map<string, Node>;

  /**
   * Creates a new FlowGraph from nodes.
   *
   * @param nodes - Array of territory nodes
   */
  public constructor(nodes: Node[]) {
    this.sources = new Map();
    this.sinks = new Map();
    this.nodes = new Map();

    // Index nodes
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }

    // Discover sources and sinks from nodes
    this.discoverSources();
    this.discoverSinks();
  }

  // ===========================================================================
  // DISCOVERY METHODS
  // ===========================================================================

  /**
   * Discover all energy sources from node resources.
   */
  private discoverSources(): void {
    this.sources.clear();

    for (const node of this.nodes.values()) {
      const sourceResources = getResourcesByType(node, "source");

      for (const resource of sourceResources) {
        // Skip sources in Source Keeper rooms (too dangerous to mine without combat)
        const roomName = resource.position.roomName;
        if (isSourceKeeperRoom(roomName)) {
          continue;
        }

        // resource.capacity is the total energy capacity (e.g., 3000)
        // Convert to rate: capacity / 300 ticks = energy per tick
        const energyCapacity = resource.capacity ?? 3000;
        const ratePerTick = energyCapacity / 300; // Standard: 3000/300 = 10 e/tick

        // Count mining spots from the actual game source
        let maxMiners = 1;
        if (typeof Game !== "undefined") {
          const gameSource = Game.getObjectById(resource.id as Id<Source>);
          if (gameSource) {
            maxMiners = countMiningSpots(gameSource);
          }
        }

        const source = createFlowSource(resource.id, node.id, resource.position, ratePerTick, maxMiners);
        this.sources.set(source.id, source);
      }
    }
  }

  /**
   * Discover all energy sinks from node resources.
   * Creates sinks for spawns, controllers, storage, etc.
   */
  private discoverSinks(): void {
    this.sinks.clear();

    for (const node of this.nodes.values()) {
      // Spawns - critical for creep production
      const spawns = getResourcesByType(node, "spawn");
      for (const resource of spawns) {
        const sink = createFlowSink(
          "spawn",
          resource.id,
          node.id,
          resource.position,
          10, // Base spawn overhead demand
          50 // Max capacity per tick
        );
        this.sinks.set(sink.id, sink);
      }

      // Controllers - upgrading (only owned controllers)
      const controllers = getResourcesByType(node, "controller");
      for (const resource of controllers) {
        // Only add controller as sink if we own it
        if (!resource.isOwned) continue;

        const sink = createFlowSink(
          "controller",
          resource.id,
          node.id,
          resource.position,
          DEFAULT_CONTROLLER_UPGRADE_DEMAND, // upgrade demand (reduced while building)
          100 // Max upgrade per tick (limited by WORK parts in practice)
        );
        this.sinks.set(sink.id, sink);
      }

      // Storage - buffer sink (lowest priority)
      const storages = getResourcesByType(node, "storage");
      for (const resource of storages) {
        const sink = createFlowSink(
          "storage",
          resource.id,
          node.id,
          resource.position,
          0, // No active demand (only takes excess)
          1000 // High capacity for buffering
        );
        this.sinks.set(sink.id, sink);
      }

      // Containers near sources become intermediate collection points
      // (handled differently - they're part of the edge, not a sink)
    }
  }

  // ===========================================================================
  // DYNAMIC SINK MANAGEMENT
  // ===========================================================================

  /**
   * Add a construction site as a temporary sink.
   *
   * @param id - Construction site ID
   * @param nodeId - Node containing the site
   * @param position - World position
   * @param progressRemaining - Build progress remaining
   * @param priority - Override priority (default: construction priority)
   */
  public addConstructionSite(
    id: string,
    nodeId: string,
    position: Position,
    progressRemaining: number,
    priority?: number
  ): void {
    const sink = createFlowSink(
      "construction",
      id,
      nodeId,
      position,
      // Demand a real build crew's worth, not one builder's. Construction outranks
      // the controller (priority 70 vs 60), so this makes building claim the node's
      // surplus while there is something to build - "build supersedes upgrade" - and
      // the builder squad sizes itself to the energy actually allocated (which the
      // available surplus and MAX_BUILDERS still cap, so it does not over-claim).
      // The controller resumes absorbing the surplus once building is done.
      20, // Demand: roughly a full build crew (MAX_BUILDERS) at low/mid RCL
      50, // Capacity: max build rate
      priority
    );
    sink.progressRemaining = progressRemaining;
    this.sinks.set(sink.id, sink);
  }

  // ===========================================================================
  // QUERY METHODS
  // ===========================================================================

  /**
   * Get all sources.
   */
  public getSources(): FlowSource[] {
    return Array.from(this.sources.values());
  }

  /**
   * Get a source by ID.
   */
  public getSource(id: string): FlowSource | undefined {
    return this.sources.get(id);
  }

  /**
   * Get all sinks, optionally filtered by type.
   */
  public getSinks(type?: SinkType): FlowSink[] {
    const sinks = Array.from(this.sinks.values());
    if (type) {
      return sinks.filter(s => s.type === type);
    }
    return sinks;
  }

  /**
   * Get a sink by ID.
   */
  public getSink(id: string): FlowSink | undefined {
    return this.sinks.get(id);
  }
}

/**
 * Routing capacity for a controller sink. Uncapped (mops up the remainder) until
 * the controller's room has a storage bank that is still FILLING, then bounded to
 * {@link STORAGE_UPGRADE_TARGET} so the surplus banks in storage. Once the bank
 * passes the warchest target (the room appears in `surplusRooms` because a bank
 * source was emitted for it - see detectBankSources), the cap lifts and the
 * controller reverts to mopping up: the warchest is full, so there is nothing
 * left to save for and the surplus draw needs somewhere to land. Pure over the
 * two room sets so it is unit-testable without Game.
 */
export function controllerRoutingCapacity(
  sink: { position: Position },
  totalSupply: number,
  roomsWithStorage: ReadonlySet<string>,
  surplusRooms: ReadonlySet<string> = new Set(),
  physicalUpgradeCap: number = Infinity,
  wartimeRooms: ReadonlySet<string> = new Set()
): number {
  // Two cases cap the controller at the save-regime floor so the surplus does
  // NOT mop up here:
  //  - FILLING warchest: the surplus banks toward the reserve (unchanged).
  //  - WARTIME (spec 33, owner 2026-07-27 "surplus ... normally for upgrading,
  //    but now for building"): a MEANINGFUL construction backlog stands in this
  //    room, so upgrading RELEGATES to the floor and the surplus flows to
  //    construction (value 70) instead of the controller's mop-up. Relegated
  //    != off - the anti-downgrade floor still holds; the mode exits (mop-up
  //    resumes) the moment the backlog drains, no isolated-sink nudge.
  const filling = roomsWithStorage.has(sink.position.roomName) && !surplusRooms.has(sink.position.roomName);
  if (filling || wartimeRooms.has(sink.position.roomName)) {
    return Math.max(STORAGE_UPGRADE_TARGET, ANTI_DOWNGRADE_RESERVE);
  }
  // #21 (owner 2026-07-19): in surplus the controller mops up the warchest, but
  // no faster than the upgrader fleet can PHYSICALLY burn it (parking tiles x
  // affordable WORK - see controllerUpgradeCap). Surplus beyond the cap has no
  // upgrader to consume it, so it overflows into the storage sink instead of
  // publishing an infeasible upgrade plan that out-competes remote mining
  // (live t72429680: uncapped 137 e/t against a ~4-upgrader fleet).
  return Math.min(Math.max(totalSupply, 1), physicalUpgradeCap);
}

/** UpgradingCorp's hard upgrader-count cap, mirrored (parking tiles are few). */
const CONTROLLER_UPGRADER_CAP = 8;

/**
 * The controller's PHYSICAL upgrade capacity (energy/tick) for the #21 sink
 * cap: how much the upgrader fleet can actually burn, bounded by the parking
 * tiles ringing the controller input spot and each body's affordable WORK at
 * the room's energy capacity (mirrors UpgradingCorp.upgraderTargetCount's
 * parking bound so the sink and the fleet agree). Infinity when Game or the
 * controller is unavailable, so unit/harness paths keep the uncapped default
 * unless a cap is passed explicitly.
 */
export function controllerUpgradeCap(roomName: string): number {
  if (typeof Game === "undefined" || !Game.rooms) return Infinity;
  const controller = Game.rooms[roomName]?.controller;
  if (!controller) return Infinity;
  try {
    // Best-effort physical estimate: any incomplete Game state (partial test
    // mock, room we cannot fully resolve) falls back to the uncapped default
    // rather than throwing - a missing cap is safe, it only reverts to old
    // behavior; the parking lens needs the live pos/room lookForAt API.
    const parking = controllerParkingTiles(controller, controllerInputSpot(controller).pos).length;
    const spots = Math.min(parking || CONTROLLER_UPGRADER_CAP, CONTROLLER_UPGRADER_CAP);
    const capacity = Game.rooms[roomName]?.energyCapacityAvailable ?? 300;
    const affordableWork = Math.max(1, buildUpgraderBody(capacity, 99, "containerFed").workParts);
    return spots * affordableWork * UPGRADE_ENERGY_PER_WORK;
  } catch {
    return Infinity;
  }
}

/** Ticks over which the agenda's funding need amortizes into a flow rate. */
export const FUND_HORIZON = 50;

/**
 * The spawn's outstanding must-fund bodies (Memory.spawnAgenda.fundingNeed,
 * spec 11) as an energy/tick rate: bank the queued bodies within roughly one
 * re-solve horizon. Stale agendas (spawn busy/skipped > 100 ticks) decay to
 * zero so a dead table entry cannot siphon flow forever.
 */
export function agendaFundingRate(sinkId: string): number {
  if (typeof Memory === "undefined" || typeof Game === "undefined") return 0;
  const spawnId = stripSpawnPrefix(sinkId);
  const entry = Memory.spawnAgenda?.[spawnId];
  if (!entry || Game.time - entry.tick > 100) return 0;
  return entry.fundingNeed / FUND_HORIZON;
}

/**
 * A NEW SPAWN's construction site (spec 06 expansion): above ordinary
 * construction so every room funnels its surplus to the founding, below the
 * live spawn network so keeping existing creeps alive still wins. Since
 * spec 18 the anchor lives in the goal's valuation (economy/goals - the
 * measured incident rationale is recorded there); this export is the default
 * profile's value, kept for its doc-reference role.
 */
export const NEW_SPAWN_SITE_VALUE = DEFAULT_VALUATION.newSpawnSite;

/** Controller-curve remaining-progress anchors (fresh L1 / L8-scale grind). */
const CONTROLLER_REMAINING_MIN = 200;
const CONTROLLER_REMAINING_MAX = 10_400_000;

/**
 * Value of a controller sink as a function of PROGRESS REMAINING to the next
 * level (owner directive 2026-07-09): remaining is what prices the marginal
 * energy, so a fresh L1 (200 to go) and a 99%-done level both price high,
 * while a mid-level grind sits near the old flat 50. Anchors: 200 -> 80,
 * 10.4M -> 40, log-interpolated and clamped. At RCL2 (45k) this yields ~60 -
 * still below construction's 70, so "build supersedes upgrade" is preserved
 * until a level is nearly done, exactly the crossover the owner asked for
 * ("if something is 99% to the next RCL level, those marginal points are
 * valuable").
 */
export function controllerValue(remaining: number, val: SinkValuation = DEFAULT_VALUATION): number {
  const k = (val.controllerMax - val.controllerMin) / Math.log(CONTROLLER_REMAINING_MAX / CONTROLLER_REMAINING_MIN);
  const v = val.controllerMax - k * Math.log(Math.max(1, remaining) / CONTROLLER_REMAINING_MIN);
  return Math.min(val.controllerMax, Math.max(val.controllerMin, v));
}

/**
 * Per-INSTANCE sink value (spec 06: "the ONE missing piece"). The planner's
 * DEFAULT_SINK_VALUE stays the kind-level baseline; this differentiates the
 * two cases the expansion economics need: a new-spawn site outprices ordinary
 * construction, and each controller prices by its remaining progress. Live
 * Game lookups are guarded so harness/unit paths fall back to the defaults.
 */
function perInstanceSinkValue(
  kind: SinkKind,
  sink: { gameId?: string; position: Position },
  val: SinkValuation = DEFAULT_VALUATION
): number {
  if (kind === "construction" && typeof Game !== "undefined" && Game.getObjectById && sink.gameId) {
    const site = Game.getObjectById(sink.gameId as Id<ConstructionSite>);
    if (site && site.structureType === "spawn") return val.newSpawnSite;
  }
  if (kind === "controller" && typeof Game !== "undefined" && Game.rooms) {
    const controller = Game.rooms[sink.position.roomName]?.controller;
    if (controller && controller.progressTotal) {
      return controllerValue(controller.progressTotal - controller.progress, val);
    }
  }
  // Kind-level fallback from the goal's valuation (controllerStatic is the
  // no-vision controller anchor - the pre-goal DEFAULT_SINK_VALUE numbers).
  return kind === "spawn"
    ? val.spawn
    : kind === "construction"
    ? val.construction
    : kind === "controller"
    ? val.controllerStatic
    : val.storage;
}

/** Map a FlowGraph sink type to the planner's coarser sink kind. */
function toSinkKind(type: SinkType): SinkKind | null {
  switch (type) {
    case "spawn":
    case "extension":
      return "spawn";
    case "construction":
      return "construction";
    case "controller":
      return "controller";
    case "storage":
      return "storage";
    case "tower":
      // Spawn-network demand (~10 e/t refill through the tender) - spec 07.
      // No tower sinks are DISCOVERED yet (FlowGraph doesn't emit them); this
      // mapping prices the draw the moment they are.
      return "spawn";
    default:
      return null; // terminal/link/lab/factory not modelled as energy sinks yet
  }
}

/**
 * Build the planner's clean world description from the live flow graph.
 *
 * The spawn sink gets its *demand* as capacity (≈10), not 0: unlike the old shadow
 * planner - which only re-sized haulers while FlowSolver still fed the spawn - the
 * CorpPlanner IS the routing authority, so it must deliver the spawn its overhead
 * energy itself. Capacity = demand keeps the spawn fed without letting it (value
 * 100) starve the controller of the surplus.
 */
/**
 * Detect scavengeable ground stocks across visible rooms and turn them into
 * transient sources. Live default for buildColonyProblem; injectable for tests.
 */
export function detectTransientSources(): PlannerSource[] {
  if (typeof Game === "undefined" || !Game.rooms) return [];
  const out: PlannerSource[] = [];
  for (const roomName in Game.rooms) {
    // REMOTE SCAVENGE IS SPILL-ONLY (refining the 2026-07-19 ruling): the
    // original incident was detectRoomStocks summing a remote CONTAINER into
    // the pile, so scavengers siphoned the route's own supply and the colony
    // burned its warchest while the remote "delivered" a trickle. The
    // container stays structurally un-scavengeable here (includeContainers
    // false) - but DROPPED piles in remote rooms are energy nobody's route
    // will ever haul (a demoted source has no route at all; a funded route's
    // spill exceeds its flow-sized haulers) and they DECAY at
    // ceil(amount/1000)/t: measured t72446738, 25k standing at four remote
    // mouths bleeding ~19 e/t - the colony's largest live leak. Threshold
    // 1000 keeps the fleet off harvest jitter; only real spills qualify.
    const owned = !!Game.rooms[roomName].controller?.my;
    const stocks = owned
      ? detectRoomStocks(Game.rooms[roomName])
      : detectRoomStocks(Game.rooms[roomName], REMOTE_SPILL_THRESHOLD, false);
    for (const stock of stocks) {
      const src = stockToTransientSource(stock, `${roomName}-scavenge`, stockSpawnDistance(stock.pos));
      // Micro-route floor (owner 2026-07-20): a sub-floor rate plans a
      // sub-1-CARRY route whose corp lifecycle costs more than it recovers
      // (the E2/E5 churn loop) - leave those piles to opportunistic pickup.
      if (src.rate >= SCAVENGE_RATE_FLOOR) out.push(src);
    }
  }
  return out;
}

/** Remote dropped piles must exceed this to field a scavenger (real spills
 * decay ~1+/t at this size; harvest jitter stays below it). */
export const REMOTE_SPILL_THRESHOLD = 1000;

/** Walking distance estimate from a stock to its nearest spawn (linear-room
 * approximation cross-room) - the effective-ttl input to scavengeRate. */
function stockSpawnDistance(pos: Position): number {
  if (typeof Game === "undefined" || !Game.spawns) return 0;
  let best = Infinity;
  for (const name in Game.spawns) {
    const sp = Game.spawns[name].pos;
    const d =
      sp.roomName === pos.roomName
        ? Math.abs(sp.x - pos.x) + Math.abs(sp.y - pos.y)
        : roomLinearDistance(sp.roomName, pos.roomName) * 50;
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

/**
 * Detect link-served sources across visible rooms: a source with its own link
 * within feeding range, in a room whose core link (beside the storage) exists.
 * Such a source's output emerges at the CORE, so the planner prices and routes
 * its hauling from there (haulPos) while the miner keeps the real distance.
 * Live default for buildColonyProblem; injectable for tests.
 */
export function detectLinkHaulPositions(graph: FlowGraph): Map<string, Position> {
  const out = new Map<string, Position>();
  if (typeof Game === "undefined" || !Game.rooms) return out;
  for (const s of graph.getSources()) {
    const room = Game.rooms[s.position.roomName];
    if (!room) continue;
    const core = coreLink(room);
    if (!core) continue;
    const pos = new RoomPosition(s.position.x, s.position.y, s.position.roomName);
    if (sourceLink(pos, core.id)) {
      out.set(s.id, { x: core.pos.x, y: core.pos.y, roomName: core.pos.roomName });
    }
  }
  return out;
}

/**
 * Detect DEPOSIT PORTS (spec 26, deposit-side mirror of detectLinkHaulPositions):
 * links a mined deposit may turn around at instead of walking to its storage hub.
 * v1 emits CONTROLLER links only - energy dropped there is consumed IN PLACE by
 * the upgraders, which by the LinkRunner backpressure displaces an equal bank->
 * controller relay (bank-neutral), so no drain hauler and no transit toll are
 * needed. (Source links FORWARD to the core, whose core->storage drain is staffed
 * only for the home source's own rate - an unstaffed leg the plan cannot honestly
 * price yet, so they are a follow-up.) The port's headroom is the controller's
 * bank-fed consumption rate (feederRelayRate) - what a mined drop can displace and
 * what the link can drain - a FINITE, plan-computable bound the pricing shares.
 * Requires a storage hub (the port is a shortcut TO that hub). Live default for
 * buildColonyProblem; injectable for tests.
 */
/** v1 conservative per-port deposit cap (e/t). Bounds the drain + blast radius
 * while the source-link port stabilises; the measured opportunity is ~30 e/t. */
export const DEPOSIT_PORT_HEADROOM = 30;

export function detectLinkDepositPorts(): DepositPort[] {
  // SOURCE-LINK PORTS (spec-26 stage 4 redesign, owner 2026-07-23): a remote
  // hauler deposits at a home-room SOURCE link it passes (measured: 3 routes,
  // ~13 tiles saved each) instead of walking to storage. The link fires to the
  // core; the drain is STAFFED (the missing v1 leg) by attributing the deposited
  // flow to the port's owning link-served source, whose hauler already picks up
  // at the core (sourcePickupSpot). Controller-link ports (bank-neutral, no
  // drain) stay OUT of v1 - they need the relay to reserve drop room (the stage-2
  // lesson). Requires a storage hub (the port is a shortcut TO it).
  if (typeof Game === "undefined" || !Game.rooms) return [];
  const out: DepositPort[] = [];
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my || !room.storage?.my) continue;
    const core = coreLink(room);
    if (!core) continue;
    const ctrl = controllerLink(room);
    const links = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_LINK
    }) as StructureLink[];
    const sources = room.find(FIND_SOURCES);
    for (const link of links) {
      if (link.id === core.id) continue; // the hub itself, not a shortcut
      if (ctrl && link.id === ctrl.id) continue; // controller port = v2 (bank-neutral, no drain)
      // The link's owning source: its hauler already drains the core, so it
      // staffs the deposit drain. No adjacent source => not a source-link.
      const owner = sources.find(s => s.pos.inRangeTo(link.pos, 2));
      if (!owner) continue;
      out.push({
        pos: { x: link.pos.x, y: link.pos.y, roomName },
        headroom: DEPOSIT_PORT_HEADROOM,
        drainFrom: { x: core.pos.x, y: core.pos.y, roomName },
        drainSourceId: `source-${owner.id}`
      });
    }
  }
  return out;
}

/**
 * Detect SURPLUS storage banks across visible owned rooms and turn each into a
 * transient bank source at its storage position (spec 03 withdrawal, surplus
 * half - see economy/bank.ts). A bank still filling its warchest emits nothing:
 * the deposit half (STORAGE_UPGRADE_TARGET cap) keeps accumulating it. Live
 * default for buildColonyProblem; injectable for tests.
 */
export function detectBankSources(): PlannerSource[] {
  if (typeof Game === "undefined" || !Game.rooms) return [];
  // The reserve target the last solve published (colony income x coverage);
  // falls back to the hard floor before the first solve. One number, shared
  // with every execution consumer, so surplus emission and consumer sizing
  // agree on where the reserve sits.
  const reserveTarget = resolveReserveTarget(typeof Memory !== "undefined" ? Memory.warchestTarget : undefined);
  const out: PlannerSource[] = [];
  for (const roomName in Game.rooms) {
    const storage = Game.rooms[roomName].storage;
    if (!storage || !storage.my) continue;
    const banked = storage.store.energy ?? 0;
    const source = bankToTransientSource(roomName, { x: storage.pos.x, y: storage.pos.y, roomName }, banked, reserveTarget);
    if (source) out.push(source);
  }
  return out;
}

/**
 * Physical energy room remaining in a room's storage bank. Infinity when there
 * is no live storage to read (harness/unit paths keep the old "soak totalSupply"
 * behavior unchanged). This is the storage sink's true ceiling: while the bank
 * has room it can soak any remote surplus (storage is the hub - owner 2026-07-19
 * "consumption takes from the storage, so it IS a viable sink for remotes");
 * once it reaches ~0 the warchest is topped out and mining beyond the other
 * sinks' capacity has no home, which is exactly the owner's storage-full defund
 * trigger (selectProducers drops whole corps when mining > total sink capacity).
 */
export function storageRoomRemaining(roomName: string): number {
  if (typeof Game === "undefined" || !Game.rooms) return Infinity;
  const storage = Game.rooms[roomName]?.storage;
  if (!storage) return Infinity;
  return storage.store.getFreeCapacity(RESOURCE_ENERGY) ?? Infinity;
}

/** Energy standing in a room's storage (0 without one; harness-safe 0). */
export function storageRoomStock(roomName: string): number {
  if (typeof Game === "undefined" || !Game.rooms) return 0;
  return Game.rooms[roomName]?.storage?.store?.[RESOURCE_ENERGY] ?? 0;
}

/**
 * Paved FRACTION of each source's haul route, by GAME id (the receipts in
 * room memory - see RoomMemory.roadRoutes): the binary `paved` receipt reads
 * as 1, an in-progress trunk's survey receipt as built/total (owner
 * 2026-07-20: a 32/38 trunk already fields the 2:1 body - the repricing
 * verdict is roadEconomics.partialPaveRatio, applied in buildColonyProblem).
 * Graph source ids carry a "source-" prefix, so callers match with
 * stripFlowId. Live default for buildColonyProblem; injectable for tests.
 */
export function detectPavedSources(): Map<string, number> {
  const paved = new Map<string, number>();
  if (typeof Game === "undefined" || !Game.rooms) return paved;
  for (const roomName in Game.rooms) {
    const routes = Game.rooms[roomName].memory?.roadRoutes;
    for (const sourceId in routes ?? {}) {
      const e = routes![sourceId];
      if (e.paved) paved.set(sourceId, 1);
      else if (!e.declined && e.total && e.built !== undefined) {
        paved.set(sourceId, Math.min(1, e.built / e.total));
      }
    }
  }
  return paved;
}

/** Last pass-2 per-spawn fleet maintenance (energy/tick) - exported for the
 *  flow segment so a capture can decompose the spawn sink's demand. */
export let spawnMaintenanceStamp = 0;

/** Inputs the last charge was computed from (spec 14 decision stamp) - exported
 *  for the flow segment so `charge * spawnCount == fleetEnergy` is a direct read. */
export let fleetChargeStamp: NonNullable<FlowSolution["fleetCharge"]> | undefined;

/** Fixed-point iteration bounds for the spawn's fleet charge. Four passes is
 *  ample for a damped contraction (the measured spread was 49.45 vs 27.65, so
 *  two damped steps land inside a fraction of an e/t); the tolerance stops
 *  early on any world where the charge barely moves. */
const FLEET_CHARGE_MAX_PASSES = 4;
const FLEET_CHARGE_TOLERANCE = 0.25;

/**
 * Iterate the spawn's fleet charge to its FIXED POINT, damped.
 *
 * The charge and the fleet are mutually dependent - charging the spawn takes
 * energy away from the fill, which funds fewer hauler routes, which lowers the
 * fleet the charge is priced from. Pricing the charge off a plan solved under a
 * DIFFERENT charge (the two-pass solve as first shipped) is not a fixed point:
 * measured live t72717545, the sequence 0 -> 49.45 -> 27.65 oscillated and the
 * plan shipped a 1.79x over-charge.
 *
 * Damping (average the charge with the fleet it produces) turns that
 * oscillation into a contraction - it converges for any response slope < 3,
 * where the undamped recurrence diverges above 1. Bounded by MAX_PASSES so a
 * discontinuous response can never run the per-tick solve away, and
 * tolerance-stopped so a world whose charge barely moves pays for no re-solve
 * at all.
 *
 * SEEDED from the PREVIOUS solve's charge, which is what makes this cheap and
 * what makes it converge. The fixed point persists across solves - between two
 * replans 50 ticks apart the colony's fleet barely moves - so starting from
 * last time's answer means the tolerance check usually fires immediately and
 * the whole iteration costs ZERO extra searches. Starting from 0 every time
 * instead (as first shipped) both threw away the answer and spent its entire
 * pass budget re-deriving it: measured live t72718367, `passes: 4` hit the cap
 * with the charge still 6.4% short of `fleetEnergy`. Only a genuine regime
 * change now pays for the full iteration.
 *
 * @param initialCharge previous solve's converged charge (0 on a cold start)
 * @param seedFleet per-spawn fleet cost of the plan solved AT initialCharge
 * @param fleetChargeOf per-spawn fleet cost of a solved plan
 * @param solveWith re-solve the plan under a given per-spawn charge
 * @returns the converged charge, and the plan solved AT it when a pass ran
 *          (`solved` undefined means the seed already converged - the caller's
 *          own pass-1 plan was solved at that charge and IS the answer)
 */
export function convergeFleetCharge<T>(
  initialCharge: number,
  seedFleet: number,
  fleetChargeOf: (solved: T) => number,
  solveWith: (charge: number) => T
): { charge: number; solved: T | undefined; passes: number } {
  let charge = Math.max(0, initialCharge);
  let target = seedFleet;
  let solved: T | undefined;
  let passes = 0;
  for (let pass = 0; pass < FLEET_CHARGE_MAX_PASSES; pass += 1) {
    if (Math.abs(target - charge) <= FLEET_CHARGE_TOLERANCE) break; // converged
    charge = Math.max(0, (charge + target) / 2); // damped step
    solved = solveWith(charge);
    target = fleetChargeOf(solved);
    passes += 1;
  }
  return { charge, solved, passes };
}

export function buildColonyProblem(
  graph: FlowGraph,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  linkHaulPos: Map<string, Position> = detectLinkHaulPositions(graph),
  pavedSources: Map<string, number> = detectPavedSources(),
  bankSources: PlannerSource[] = detectBankSources(),
  remoteInvaderTax: number = INVADER_TAX_PER_ENERGY,
  valuation: SinkValuation = DEFAULT_VALUATION,
  prevBankDraw?: number,
  depositPorts: DepositPort[] = detectLinkDepositPorts(),
  /**
   * PASS-2 INPUT (two-pass solve): energy/tick the plan's standing fleet costs
   * to maintain, PER SPAWN. Zero on pass 1 (unknown until the plan exists), so
   * pass 1 behaves exactly as before and the pass-2 problem is the only one
   * that differs. See solveColony.
   */
  spawnMaintenance = 0
): ColonyProblem {
  const spawns: PlannerSpawn[] = graph.getSinks("spawn").map(s => ({ id: s.id, pos: s.position }));

  // The invader tax (spec 13 phase 5) applies to sources OUTSIDE spawn
  // rooms: raid frequency is proportional to energy harvested, and at home
  // the tower absorbs the raid for the cost of its shots (~0).
  const spawnRooms = new Set(spawns.map(s => s.pos.roomName));

  const sources: PlannerSource[] = graph.getSources().map(s => {
    // The mid-build repricing verdict (roadEconomics): a route >= 1/2 built
    // already fields the 2:1 body; the fraction rides along so the planner
    // sizes CARRY at the effective (crawl-corrected) distance.
    const paveFrac = pavedSources.get(stripSourcePrefix(s.id));
    const pave = paveFrac === undefined ? undefined : partialPaveRatio(paveFrac, 1);
    return {
      id: s.id,
      nodeId: s.nodeId,
      pos: s.position,
      rate: s.capacity,
      maxMiners: s.maxMiners,
      haulPos: linkHaulPos.get(s.id),
      // Swamp share of the haul path, off the same cached PathFinder search
      // that produced the distance - no extra pathfinding, and the planner
      // finally prices a route in TICKS rather than tiles.
      ...(() => {
        // Nearest spawn is the same endpoint the source's distance is measured
        // to, so the cached search is already warm and the fraction is free.
        let frac = 0;
        let best = Infinity;
        for (const sp of spawns) {
          const d = dist(s.position, sp.pos);
          if (d < best) {
            best = d;
            frac = pathSwampFraction(s.position, sp.pos);
          }
        }
        return frac > 0 ? { swampFraction: frac } : {};
      })(),
      ...(pave && pave.ratio === "2:1" ? { paved: true, pavedFraction: pave.fraction } : {}),
      ...(spawnRooms.has(s.position.roomName) || remoteInvaderTax <= 0 ? {} : { invaderTax: remoteInvaderTax }),
      // STAGED MOUTH STOCK (phase 1 of the income-statement program): the
      // SAME sourceBufferStock lens the corp's drain term and E6's gate read,
      // so the plan prices the drain fleet the corp will actually field.
      // Walk-served mouths only - a link-served source's stock is the link
      // network's business, and pricing haulers for it would re-open the
      // haul-of-zero contract. No vision => absent, never a fabricated zero.
      ...(() => {
        if (linkHaulPos.get(s.id) !== undefined) return {};
        if (typeof Game === "undefined" || !Game.getObjectById) return {};
        const live = Game.getObjectById(stripSourcePrefix(s.id) as Id<Source>);
        if (!live) return {};
        const staged = sourceBufferStock(live);
        return staged !== null && staged > 0 ? { staged } : {};
      })()
    };
  });
  // Sustained income only: what mined sources yield per tick. Transient
  // stocks are real energy but ONE-OFF - sizing standing fleets or the
  // construction absorb rate to them publishes fantasy plans (measured on
  // the shard1 stress fixture: unhauled piles grew, inflating supply until
  // the plan wanted build 140 e/t / 316 CARRY against 20 e/t of mining).
  // PHANTOM GUARD (t72444684 review finding): intel-only PROSPECTS - rooms
  // scouted before their source ids were ever recorded - are not income
  // (live: 31 of 38 candidates were "source-intel-*", 285 e/t of phantom
  // inflating this valve term to 455). Prospects scouted WITH real ids
  // still count (indistinguishable from mined by id alone - an accepted
  // residual, bounded by the fill's bank-pool cap which is funded-credit
  // sized post-solve either way).
  const minedSupply = sources.filter(s => isMinedIncomeId(s.id)).reduce((sum, s) => sum + s.rate, 0);
  // Ground stocks join as miner-less transient sources (scavenging), and so
  // do SURPLUS storage banks (spec 03 withdrawal: a bank above its warchest
  // is a ground-stock-shaped supply at the storage position).
  sources.push(...transientSources, ...bankSources);
  // Assembly counts (flow v5): which layer dropped the remotes - the graph
  // (nodes), the problem (this assembly), or the solver (candidates) - has
  // been un-nameable in every warmup remote-drop; these three numbers plus
  // candidates[] name it in one capture.
  const assembly = {
    graphSources: graph.getSources().length,
    mined: sources.length - transientSources.length - bankSources.length,
    transient: transientSources.length,
    bank: bankSources.length
  };
  const totalSupply = sources.reduce((sum, s) => sum + s.rate, 0);
  // The warchest surplus draw (spec 03). Unlike scavenge piles this is a
  // DURABLE, tapered supply (bank.ts prices and bounds it), so standing
  // fleets may size to it - it funds the controller today and, below,
  // construction (owner 2026-07-18: "building takes priority over the
  // upgrading... use all the energy in the storage as needed, same as for
  // the upgrader" - the sink ladder already ranks construction 70 above
  // controller 50, so opening the capacity valve is the whole change).
  const bankRate = bankSources.reduce((sum, b) => sum + b.rate, 0);

  // Rooms whose bank is built: their controller stops mopping up the surplus so
  // the storage can soak it (see controllerRoutingCapacity / STORAGE_UPGRADE_TARGET).
  const roomsWithStorage = new Set<string>();
  for (const sink of graph.getSinks()) {
    if (sink.type === "storage") roomsWithStorage.add(sink.position.roomName);
  }
  // Rooms whose bank is in SURPLUS (a bank source was emitted): the warchest is
  // over its target, so the controller cap lifts. The storage sink STAYS (owner
  // 2026-07-19: consumers draw from storage, so it is a valid home for remote
  // surplus - keeping it lets excess production bank instead of rotting at remote
  // containers, #19). The anti-pump is now structural in routeToSinks: bank
  // sources never fill the storage sink, so a solve can never both withdraw the
  // warchest AND deposit to it. The storage sink's capacity is its physical room
  // remaining, so a topped-out bank presents zero room and the surplus mining is
  // defunded rather than rotted.
  const surplusRooms = new Set(bankSources.map(b => b.pos.roomName));

  // HUB-AND-SPOKE (owner 2026-07-19): the storage is the hub - mined income banks
  // to it and consumers draw it back. The bank/hub SOURCE that routeToSinks spends
  // to consumers must carry the mined THROUGHPUT plus the surplus, else at/below
  // target (surplus ~0) consumers have no source and starve. But the mined part
  // is the FUNDED income (~7 sources here), which the adapter CANNOT know - it
  // runs before selectProducers. Sizing it here from all graph sources sent
  // phantom supply (38 candidates = 380 e/t) that construction over-drew,
  // exhausting the parts ledger so real mined never banked (P9->0 live stall
  // t72437535). So the adapter ONLY guarantees a bank source EXISTS for every
  // storage room (rate = its surplus draw, or 0 while filling); planColony adds
  // the funded mined income once the funded set is known. `bankRate`/`totalSupply`
  // stay the real supply (surplus only). selectProducers ignores the bank
  // (transient, maxMiners 0).
  const storageSinkList = graph.getSinks().filter(s => s.type === "storage");
  for (const st of storageSinkList) {
    const room = st.position.roomName;
    if (sources.some(src => src.id === bankSourceId(room))) continue; // surplus bank already emitted
    sources.push({
      id: bankSourceId(room),
      nodeId: `${room}-bank`,
      pos: st.position,
      rate: 0, // filling: no surplus draw yet; planColony credits the funded mined income
      maxMiners: 0,
      transient: true
    });
  }

  // SPEC 25 / filed 2026-07-21: per-site construction capacities share ONE
  // pool absorb budget instead of each carrying the max(5,...) floor - 10
  // road sites summed to 50 e/t of priority-70 demand against a pool that
  // absorbs ~7 (measured t72480337: the freed ledger parts inflated the
  // consumer plan). Pool absorb = the SAME sum-of-projects formula the crew
  // sizes with (primitives.projectAbsorbRate over total remaining work at
  // the farthest site's travel); each site's capacity is its pro-rata share
  // by remaining work. A single site degenerates to exactly the old number.
  const constructionSites = graph
    .getSinks()
    .filter(s => toSinkKind(s.type) === "construction" && s.progressRemaining !== undefined);

  // WARTIME rooms (spec 33, owner 2026-07-27): rooms holding a MEANINGFUL
  // construction backlog - summed site work >= one structure (~3000). While
  // one stands (and the warchest is in surplus), the controller relegates to
  // its floor so the surplus goes to BUILDING, not upgrading (see
  // controllerRoutingCapacity). The threshold excludes a lone road so trivial
  // paving never relegates upgrading; a real build-out (extensions, storage)
  // does. Exits cleanly when the backlog drains below the threshold.
  const constructionWorkByRoom = new Map<string, number>();
  for (const cs of constructionSites) {
    const r = cs.position.roomName;
    constructionWorkByRoom.set(r, (constructionWorkByRoom.get(r) ?? 0) + (cs.progressRemaining ?? 0));
  }
  const wartimeRooms = new Set(
    [...constructionWorkByRoom].filter(([, w]) => w >= WARTIME_BACKLOG_THRESHOLD).map(([r]) => r)
  );

  // SOURCE-LOCAL CLUSTERS (spec 25 phase 3, owner: "there shouldn't be any
  // residual - we can just make a bigger builder... consume all the energy
  // from the source mine during that time"): a site nearer to a mined source
  // than that source's hub is the source's whole economy during its build
  // window - local building is ~5x spawn-cheaper per e/t than hauling the
  // unpaved route home. Such clusters price at the SOURCE'S RATE (pro-rata
  // by remaining work), not the completion horizon; the fill's local-build
  // pre-pass then drains the source into its sites and NO residual route
  // exists until the segment's remaining work tapers below the rate (the
  // completion transition). Same nearer-than-hub rule as the fill.
  const storagePositions = graph
    .getSinks()
    .filter(s => s.type === "storage")
    .map(s => s.position);
  // Same phantom guard as minedSupply above - intel-only prospects are not
  // income and must not anchor a cluster (this was isMinedIncomeId's documented
  // "one home" rule re-implemented inline; audit finding economy-adapters/5).
  const clusterSources = graph.getSources().filter(s => isMinedIncomeId(s.id));
  const clusters = new Map<string, { rate: number; remaining: number }>();
  const sinkClusterSource = new Map<string, string>();
  if (storagePositions.length > 0) {
    for (const cs of constructionSites) {
      // HUB-room sites are BANK-funded (G6: a home build-out may absorb the
      // full surplus valve) - source-clustering is for the road-building
      // REMOTES only (owner 2026-07-21), never a home site that merely sits
      // near a source.
      if (roomsWithStorage.has(cs.position.roomName)) continue;
      let bestId: string | null = null;
      let bestRate = 0;
      let bestD = Infinity;
      for (const src of clusterSources) {
        const dSrc = dist(src.position, cs.position);
        const hubD = Math.min(...storagePositions.map(p => dist(src.position, p)));
        if (dSrc < hubD && dSrc < bestD) {
          bestD = dSrc;
          bestId = src.id;
          bestRate = src.capacity;
        }
      }
      if (bestId) {
        sinkClusterSource.set(cs.id, bestId);
        const c = clusters.get(bestId) ?? { rate: bestRate, remaining: 0 };
        c.remaining += cs.progressRemaining ?? 0;
        clusters.set(bestId, c);
      }
    }
  }
  /** A source-local site's capacity: its share of the local source's rate. */
  const clusterCapacity = (sinkId: string, remaining: number): number | undefined => {
    const srcId = sinkClusterSource.get(sinkId);
    if (!srcId) return undefined;
    const c = clusters.get(srcId)!;
    return c.remaining > 0 ? c.rate * (remaining / c.remaining) : 0;
  };

  // The bank-funded pool budget covers only the UNclustered sites (spec 25 /
  // filed 2026-07-21: per-site floors summed to 50 e/t against a pool
  // absorbing ~7 - one horizon budget, pro-rata by remaining work).
  const pooledSites = constructionSites.filter(s => !sinkClusterSource.has(s.id));
  const poolRemaining = pooledSites.reduce((a, s) => a + (s.progressRemaining ?? 0), 0);
  const poolTravel =
    spawns.length === 0 || pooledSites.length === 0
      ? 0
      : Math.max(...pooledSites.map(s => Math.min(...spawns.map(sp => dist(sp.pos, s.position)))));
  // WARTIME acceleration (spec 33 down-payment): while a spendable warchest
  // surplus stands (bankRate > 0, the SAME lens the crew's buildPoolAbsorbRate
  // reads), the construction sink absorbs FASTER so the surplus is spent into
  // structures, not banked - bounded by min(minedSupply + bankRate, ...) below,
  // so it only draws energy already available. Upgrading floors meanwhile and
  // resumes when the surplus/backlog drains.
  const buildAccelerate = bankRate > 0;
  const poolAbsorb = poolRemaining > 0 ? projectAbsorbRate(poolRemaining, poolTravel, buildAccelerate) : 0;

  const sinks: PlannerSink[] = [];
  for (const sink of graph.getSinks()) {
    const kind = toSinkKind(sink.type);
    if (!kind) continue;
    sinks.push({
      id: sink.id,
      kind,
      pos: sink.position,
      value: perInstanceSinkValue(kind, sink, valuation),
      capacity:
        kind === "spawn"
          ? // Overhead need PLUS the agenda's funding need (spec 11 phase 2,
            // owner doctrine "production over consumption"): while the spawn's
            // published queue holds must-fund bodies (blocking, replacement,
            // holdToFund), the solver routes their financing here instead of
            // spilling it to build/controller - the energy arrives exactly
            // while production has something to buy, and reverts to surplus
            // consumption when the queue drains. Measured absence: the
            // reserver waited 1800+ ticks behind chained holds because its
            // 650 never banked (task #30).
            // FLEET MAINTENANCE (two-pass solve, 2026-08-01): `sink.demand` is
            // a hardcoded 10 "base spawn overhead" from discoverSinks - it was
            // the plan's ENTIRE model of what running the spawn costs, against
            // a fleet costing ~42 e/t. The spawn is the TOP of the value ladder,
            // so the shortfall was freed down it and the controller absorbed it
            // (measured t72714129: controller allocated 108.87 of ~100 net
            // mining). Pass 2 supplies the fleet's real standing cost here.
            Math.max(sink.demand, 1, spawnMaintenance) + agendaFundingRate(sink.id)
          : kind === "construction"
          ? // Build-out is an INVESTMENT: extensions raise energyCapacity, which
            // raises every body size and the whole colony's energy-per-spawn-part
            // shadow price - worth more than the upgrade it displaces. While
            // sites exist, construction (value 70 > controller 50) may absorb the
            // full surplus and upgrading pauses at its anti-downgrade reserve
            // (the reserve pre-pass guarantees the floor); with no sites there is
            // no construction sink and the controller resumes mopping up. The old
            // flat 5 e/t cap was the measured RCL2->3 bottleneck: a 1-WORK
            // builder against 15k of extensions kept rooms at 300 capacity for
            // thousands of ticks (spec 10 G6, owner directive 2026-07-09).
            // Bounded by MINED supply plus the BANK draw ("within reason"):
            // scavenge piles stay excluded (one-off stocks must not size
            // standing fleets), but the warchest surplus is durable and
            // tapered, so construction may burn it - at 5 e/WORK-tick it
            // turns the bank into finished roads/structures 5x more
            // spawn-cheaply than upgrading burns the same energy.
            // AND by the project's own absorb rate (prod t72444684, E4): the
            // sink's remaining work through the SAME sum-of-projects lens
            // that sizes the crew (primitives.projectAbsorbRate) - without
            // it, one 455-energy site out-priced the controller for the
            // ENTIRE 455 e/t supply, allocated 124 e/t, burned 0.45, and
            // the warchest climbed to 8.3x target while upgrading starved.
            Math.min(
              Math.max(minedSupply + bankRate, 1),
              // Pro-rata share of the POOL absorb (spec 25 / the floor-sum
              // fix): the crew is ONE fleet sized against the whole pool, so
              // per-site demands must sum to what that fleet can eat - not
              // to N independent floors. Horizon travel = the farthest
              // site's spawn distance (the crew must finish the whole pool
              // within its buffered effective life). SOURCE-LOCAL sites
              // (owner: no residual) price at the local source's rate
              // instead - the bigger builder eats the whole mine.
              sink.progressRemaining !== undefined
                ? clusterCapacity(sink.id, sink.progressRemaining) ??
                  (poolRemaining > 0 ? poolAbsorb * (sink.progressRemaining / poolRemaining) : Number.POSITIVE_INFINITY)
                : Number.POSITIVE_INFINITY
            )
          : kind === "storage"
          ? // Soak the surplus, but only up to the bank's PHYSICAL room remaining:
            // a topped-out storage presents zero capacity, which is the owner's
            // defund trigger (mining beyond total sink capacity has no home).
            // While it has room this is min(totalSupply, huge) = totalSupply, so
            // the old "soak excess" behavior is unchanged until the bank fills.
            Math.max(0, Math.min(totalSupply, storageRoomRemaining(sink.position.roomName)))
          : controllerRoutingCapacity(
              sink,
              totalSupply,
              roomsWithStorage,
              surplusRooms,
              controllerUpgradeCap(sink.position.roomName),
              wartimeRooms
            ), // controller: mops up the remainder up to the fleet's physical upgrade rate (#21); the excess banks to storage
      // SPEC 38 PHASE A (2026-08-02): the controller's floor moves INSIDE the
      // plan. controllerFloorRate = the save-regime target as fast as the
      // standing bank can sustain it (the ONE drain law), floored at the
      // anti-downgrade trickle - so the reserve pre-pass guarantees what
      // feederRelayRate's +STORAGE_UPGRADE_TARGET side-channel guaranteed
      // outside the plan (P12's measured 3.30x non-bank divergence), and a
      // cold storage room's spawn is never out-reserved by its controller.
      reserve:
        kind === "controller" ? controllerFloorRate(storageRoomStock(sink.position.roomName)) : undefined
    });
  }

  // Standing-infra spawn load (spec 15 P4): the feeder shuttle sized to the
  // bank relay, the tender detail, one reserver per mined remote room - real
  // bodies the plan implies but never commissions through routeToSinks.
  // Deducted from the planner's spawn-parts ledger so the sink fill spends
  // only what the spawn can truly still build.
  const remoteRooms = new Set(
    sources.filter(s => !s.transient && !spawnRooms.has(s.pos.roomName)).map(s => s.pos.roomName)
  );
  // FEEDER PRICED AT THE REALIZED DRAW (prod t72447444, the starvation
  // loop): pricing the relay at the FULL surplus (15 + bankRate = 115 live)
  // charged 64p of infra for a relay whose actual consumers - starved by
  // that very charge - drew ~2 e/t. Self-fulfilling: feeder priced for big
  // consumers is WHY consumers stay small. The relay now prices at the
  // PREVIOUS solve's realized bank draw, floored at STORAGE_UPGRADE_TARGET
  // (so it can ratchet UP from the floor: cheap feeder -> parts free ->
  // bigger consumer allocation -> next solve prices the feeder for it;
  // converges in <=2 solves both directions). No history (first solve,
  // harness, golden master) keeps the old full-surplus pricing.
  const pricedRelay =
    prevBankDraw !== undefined
      ? Math.min(STORAGE_UPGRADE_TARGET + bankRate, Math.max(STORAGE_UPGRADE_TARGET, prevBankDraw))
      : STORAGE_UPGRADE_TARGET + bankRate;
  // Link-fed depots price the feeder at the storage->core-link leg (spec 24
  // rung 3) - the SAME controllerLink lens the corp's sizing reads.
  let linkFedRooms = 0;
  if (typeof Game !== "undefined" && Game.rooms) {
    for (const roomName of roomsWithStorage) {
      const room = Game.rooms[roomName];
      if (room && controllerLink(room)) linkFedRooms++;
    }
  }
  const infraPartsPerTick = infraSpawnLoad(pricedRelay, roomsWithStorage.size, remoteRooms.size, linkFedRooms);
  // Same three details, priced in ENERGY - the second currency the spawn sink
  // needs (see the two-pass solve in solveColony).
  const infraEnergyPerTick = infraSpawnEnergy(pricedRelay, roomsWithStorage.size, remoteRooms.size, linkFedRooms);

  return {
    assembly,
    spawns,
    sources, sinks, dist, infraPartsPerTick, infraEnergyPerTick, depositPorts };
}

/**
 * Solve the colony economy with the CorpPlanner and return a FlowSolution.
 * Drop-in replacement for FlowSolver.solve / solveIteratively.
 */
/**
 * Publish the commissioned roster to Memory.economyPlan so tooling (the
 * plan-vs-spawn harness, telemetry) can compare what the single planner asked
 * for against what was actually fielded. Same shape the shadow planner used to
 * write, now sourced from the live CorpPlanner. Work sizes convert through the
 * primitives *_ENERGY_PER_WORK constants (one formula home), floored at 1 so
 * every published corp fields at least one body.
 */
function publishRoster(plan: ReturnType<typeof planColony>, linkServedIds: ReadonlySet<string> = new Set()): void {
  if (typeof Memory === "undefined") return;
  const corps: Record<string, unknown>[] = [];
  for (const m of plan.miners) {
    corps.push({
      kind: "mine",
      work: Math.max(1, workPartsForEnergyRate(m.rate, HARVEST_ENERGY_PER_WORK)),
      sourceId: m.sourceId,
      spawnId: m.spawnId
    });
  }
  for (const h of plan.haulers) {
    // Bank flows are executed by the depot movers (tender/feeder), never by a
    // spawnable CarryCorp - publishing them would be permanent phantom variance
    // for the plan-vs-fielded gauges.
    if (isBankSourceId(h.sourceId)) continue;
    // Link-served sources (spec 02 feeder-router): transported by the link
    // network + feeder, not a walking CarryCorp (commissionsFromPlan omits the
    // carry corp). Publishing their uncommissioned haulers - including the
    // spec-26 deposit-drain leg that rides the owning link-served source id -
    // would be permanent phantom variance, same reasoning as bank- above.
    if (linkServedIds.has(h.sourceId)) continue;
    corps.push({
      kind: "haul",
      carry: Math.max(1, Math.ceil(h.carryParts)),
      fromId: h.sourceId,
      toId: h.sinkId,
      spawnId: h.spawnId,
      // Deposit port (spec 26): the link this route turns around at (shrinks
      // its carry). Present only on ported routes - the plan-vs-fielded gauge
      // and the grid read it to confirm the shortcut was priced.
      ...(h.depositPos ? { port: h.depositPos } : {})
    });
  }
  for (const k of plan.sinks) {
    if (k.allocated <= 1e-9) continue;
    if (k.kind === "controller") {
      corps.push({
        kind: "upgrade",
        work: Math.max(1, workPartsForEnergyRate(k.allocated, UPGRADE_ENERGY_PER_WORK)),
        sinkId: k.sinkId
      });
    } else if (k.kind === "construction") {
      corps.push({
        kind: "build",
        work: Math.max(1, workPartsForEnergyRate(k.allocated, BUILD_ENERGY_PER_WORK)),
        sinkId: k.sinkId
      });
    }
  }
  (Memory as { economyPlan?: unknown }).economyPlan = {
    corps,
    overhead: Number(plan.totalOverhead.toFixed(2)),
    unrouted: Number((plan.totalProduced - plan.totalDelivered).toFixed(2))
  };
}

export function solveWithCorpPlanner(
  graph: FlowGraph,
  tick = 0,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  bankSources: PlannerSource[] = detectBankSources()
): FlowSolution {
  return solveColony(graph, tick, dist, transientSources, bankSources).solution;
}

/**
 * Solve the colony ONCE and return both representations of the result:
 *  - solution: the FlowSolution the live materializer/telemetry consume today;
 *  - commissions: the same plan wrapped as Commission envelopes (the framework
 *    seam - what the corp kinds materialize from).
 * Both come from a single planColony() call, so surfacing commissions for the
 * rung-5 cutover costs no extra solve. commissionsFromPlan is used (not
 * planCommissions) so the adapter stays free of kind-registry side effects -
 * auxiliary kinds propose() in the host, not here.
 */
export function solveColony(
  graph: FlowGraph,
  tick = 0,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  bankSources: PlannerSource[] = detectBankSources(),
  goal?: Goal,
  prevBankDraw?: number,
  /**
   * The PREVIOUS solve's converged fleet charge (per spawn). Threaded from
   * Memory by the execution layer exactly as `prevBankDraw` is - the pure
   * layer never reads it itself. Seeds the fixed-point iteration below, which
   * is what lets a steady-state replan converge without an extra search.
   */
  prevFleetCharge?: number
): { solution: FlowSolution; commissions: Commission[]; adopted: { sourceId: string; spawnId: string; gain: number }[] } {
  const seedCharge = Math.max(0, prevFleetCharge ?? 0);
  const baseProblem = buildColonyProblem(
    graph,
    dist,
    transientSources,
    detectLinkHaulPositions(graph),
    detectPavedSources(),
    bankSources,
    INVADER_TAX_PER_ENERGY,
    compileGoal(goal),
    prevBankDraw,
    detectLinkDepositPorts(),
    seedCharge
  );
  // THE STRATEGIC SEARCH (spec 18 P1, live from day one): planColony is the
  // evaluator; the searcher may pin budget-dropped sources to spawns with
  // slack. Under the default goal on a status-quo-optimal world it adopts
  // nothing and the plan is bit-identical to the plain solve (the pin).
  const pass1 = searchStructure(baseProblem);

  // ---- THE FLEET CHARGE: the spawn sink pays for the plan's own fleet ----
  //
  // The spawn sink must demand what maintaining the plan's fleet costs. Before
  // this, `discoverSinks` priced the
  // spawn at a hardcoded 10 e/t while the fleet cost ~42 - and because the
  // spawn tops the value ladder, the shortfall was handed DOWN the ladder and
  // the controller absorbed it (t72714129: controller allocated 108.87 against
  // ~100 e/t of net mining, and the runtime delivered 47.6).
  //
  // Scope is deliberately PRODUCTION + INFRA, not consumers. Charging CONSUMER
  // bodies here would be doubly circular - spawn demand shrinks the controller
  // allocation, which shrinks the upgrader fleet, which shrinks the spawn
  // demand - and consumers are already funded from what remains, which is
  // exactly what the ladder is for.
  //
  // That scoping does NOT make a single pass 2 a fixed point, which is what
  // the first implementation assumed and got wrong. It priced the charge off
  // PASS 1's fleet - a fleet solved with NO spawn charge, so far more energy
  // reached the fill and far more hauler routes were funded. Measured live
  // t72717545: the plan charged 49.45 e/t for a fleet that, once charged, cost
  // 27.65. A 1.79x over-charge, and the sequence 0 -> 49.45 -> 27.65 is
  // OSCILLATING, not converging. Production is not independent of the charge
  // after all, because routing haulers is what the fill spends its energy on.
  //
  // So iterate to the actual fixed point, DAMPED (average the charge with the
  // fleet it produces). Damping is what turns an oscillation into a
  // contraction; undamped, C_{n+1} = F(C_n) ping-pongs between the two ends.
  // Capped and tolerance-stopped so the solve can never run away.
  const fleetOf = (p: { plan: { totalOverhead: number } }): number =>
    p.plan.totalOverhead + (baseProblem.infraEnergyPerTick ?? 0);
  const spawnCount = Math.max(1, baseProblem.spawns.length);
  const solveWith = (perSpawn: number): ReturnType<typeof searchStructure> =>
    searchStructure(
      buildColonyProblem(
        graph, dist, transientSources, detectLinkHaulPositions(graph), detectPavedSources(),
        bankSources, INVADER_TAX_PER_ENERGY, compileGoal(goal), prevBankDraw,
        detectLinkDepositPorts(), perSpawn
      )
    );

  const converged = convergeFleetCharge(
    seedCharge,
    fleetOf(pass1) / spawnCount,
    (s: ReturnType<typeof searchStructure>) => fleetOf(s) / spawnCount,
    solveWith
  );
  spawnMaintenanceStamp = converged.charge;
  const searched = converged.solved ?? pass1;
  // DECISION STAMP (spec 14): every input of the charge, not just the result.
  // `spawnMaintenance` alone could not distinguish an unconverged iteration
  // from a wrong divisor from a mis-estimated infra term - two diagnoses off
  // the sum alone were both wrong. `charge * spawnCount == fleetEnergy` is now
  // checkable straight from a capture.
  fleetChargeStamp = {
    fleetEnergy: fleetOf(searched),
    production: searched.plan.totalOverhead,
    infra: baseProblem.infraEnergyPerTick ?? 0,
    spawnCount,
    passes: converged.passes
  };
  const problem = searched.problem;
  const plan = searched.plan;
  // Link-served sources (haulPos set): their transport is the link network +
  // feeder, not a commissioned CarryCorp (spec 02) - keep them out of the
  // plan-vs-fielded roster so the gauge sees no phantom walking haulers.
  const linkServedIds = new Set(problem.sources.filter(s => s.haulPos).map(s => s.id));
  publishRoster(plan, linkServedIds);
  const commissions = commissionsFromPlan(problem, plan);

  const miners: MinerAssignment[] = plan.miners.map(m => ({
    sourceId: m.sourceId,
    nodeId: m.nodeId,
    spawnId: m.spawnId,
    spawnDistance: m.distance,
    harvestRate: m.rate,
    spawnCostPerTick: minerOverhead(m.distance),
    maxMiners: m.maxMiners,
    // Published so the account can BUDGET the link transfer tax against the
    // sources that actually pay it, instead of inferring link service from a
    // short haul distance (inference is how link haulage read as free).
    ...(linkServedIds.has(m.sourceId) ? { linkServed: true } : {}),
    // The swamp share the plan actually priced this route at - so a capture can
    // tell "no swamp on this map" from "the wiring is dead".
    ...(() => {
      const src = problem.sources.find(s => s.id === m.sourceId);
      return src?.swampFraction !== undefined ? { swampFraction: src.swampFraction } : {};
    })(),
    efficiency: m.efficiency
  }));

  // The ONE CommissionedHauler -> HaulerAssignment mapper, shared with
  // carryKind.materialize (solver-bridge pin): paved verdict, spawnParts, and
  // the spec-26 depositPos all ride through identically on both paths.
  const haulers: HaulerAssignment[] = plan.haulers.map(haulerAssignmentFromCommissioned);

  const sinkTypeById = new Map(graph.getSinks().map(s => [s.id, s.type]));
  const sinkPosById = new Map(problem.sinks.map(s => [s.id, s.pos]));
  const sinkAllocations: SinkAllocation[] = plan.sinks.map(k => {
    // The plan's all-in consumer charge (spec 34 P4), stamped so telemetry
    // and the waste ledger ECHO the commission price instead of re-deriving
    // (the v8 hauler-spawnParts pattern). Construction only: the controller
    // line's ledger model deliberately stays plan-side workParts.
    const charge = k.kind === "construction" ? consumerSpawnLoad(problem, k, sinkPosById.get(k.sinkId)) : null;
    const roomName = sinkPosById.get(k.sinkId)?.roomName;
    return {
      sinkId: k.sinkId,
      sinkType: sinkTypeById.get(k.sinkId) ?? "controller",
      ...(roomName ? { roomName } : {}),
      allocated: k.allocated,
      demand: k.demand,
      unmet: Math.max(0, k.demand - k.allocated),
      priority: k.value,
      ...(k.partsLeft !== undefined ? { partsLeft: k.partsLeft } : {}),
      ...(charge ? { spawnLoad: charge.load, spawnDist: charge.dist } : {}),
      sourceFlows: k.sources.map(sf => ({ sourceId: sf.sourceId, amount: sf.amount, distance: sf.distance }))
    };
  });

  const totalHarvest = plan.totalProduced;
  const miningOverhead = miners.reduce((s, m) => s + m.spawnCostPerTick, 0);
  const haulingOverhead = haulers.reduce((s, h) => s + h.spawnCostPerTick, 0);
  const totalOverhead = miningOverhead + haulingOverhead;
  const netEnergyTotal = totalHarvest - totalOverhead;

  const unmetDemand = new Map<string, number>();
  for (const a of sinkAllocations) if (a.unmet > 0) unmetDemand.set(a.sinkId, a.unmet);

  const solution: FlowSolution = {
    miners,
    haulers,
    sinkAllocations,
    partsLedger: plan.partsLedger,
    ...(problem.assembly ? { assembly: problem.assembly } : {}),
    totalHarvest,
    miningOverhead,
    haulingOverhead,
    totalOverhead,
    spawnMaintenance: spawnMaintenanceStamp,
    ...(fleetChargeStamp ? { fleetCharge: fleetChargeStamp } : {}),
    netEnergy: netEnergyTotal,
    efficiency: totalHarvest > 0 ? (netEnergyTotal / totalHarvest) * 100 : 0,
    unmetDemand,
    isSustainable: netEnergyTotal >= 0,
    warnings: [],
    computedAt: tick,
    sourceVerdicts: plan.sourceVerdicts
  };
  return { solution, commissions, adopted: searched.adopted };
}

// =============================================================================
// FLOW ECONOMY - the solve cadence + persistence driver
// =============================================================================

/**
 * FlowEconomy - the solve driver main.ts holds.
 *
 * Builds the FlowGraph from spatial nodes and drives the ONE economy solve
 * (solveColony -> planColony). One solve yields both the FlowSolution (legacy
 * telemetry DTO) and the Commission envelopes the corp kinds materialize from
 * (execution/CommissionHost).
 *
 * Spec 17 P5 trimmed this class to its live seam: the pre-cleanup façade
 * carried a dead query/metrics/preset API (~two-thirds of the class, zero
 * callers) and the retired PriorityManager second sink ladder - sinks are
 * valued by the planner's ladder (perInstanceSinkValue over
 * DEFAULT_SINK_VALUE), nowhere else. Spec 35 phase G folded it into this
 * adapter: its Memory traffic (goal / lastBankDraw / warchestTarget) is
 * world-adapter business, not a layer of its own.
 */
export class FlowEconomy {
  /** Flow graph built from nodes */
  private graph: FlowGraph;

  /** Current solution (null if not yet solved) */
  private solution: FlowSolution | null = null;

  /**
   * The current solve's commissions (the framework seam). Same plan as
   * `solution`, wrapped as Commission envelopes for the corp kinds to
   * materialize. Empty until the first solve.
   */
  private commissions: Commission[] = [];

  public constructor(nodes: Node[]) {
    this.graph = new FlowGraph(nodes);
  }

  /**
   * Re-solve the economy. The caller (main.ts) owns the cadence - the CPU
   * governor's solve interval and the bootstrap eager-solve gate - so this
   * always solves when called.
   */
  public update(tick: number): void {
    // The goal is EXECUTION-owned state (Memory.goal, set by the operator via
    // global.setGoal); the pure layers only ever receive it as an argument.
    const goal: Goal | undefined = typeof Memory !== "undefined" ? Memory.goal : undefined;
    // The previous solve's realized bank draw (consumer allocations drawn
    // from the hub) - the feeder-pricing signal that breaks the starvation
    // loop (see buildColonyProblem). PERSISTED in Memory, not on `this`:
    // main.ts replaces the FlowEconomy instance on every graph rebuild, so
    // instance-held history died before it was ever read (prod t72447816:
    // infra pinned at 0.1874 across every post-deploy solve - the fix was
    // deployed and dormant). Memory survives rebuilds and global resets.
    const prevBankDraw = typeof Memory !== "undefined" ? Memory.lastBankDraw : undefined;
    // Same rationale, same lifetime: the converged fleet charge seeds the next
    // solve's fixed-point iteration so a steady-state replan spends no extra
    // searches re-deriving it.
    const prevFleetCharge = typeof Memory !== "undefined" ? Memory.lastFleetCharge : undefined;
    const result = solveColony(this.graph, tick, undefined, undefined, undefined, goal, prevBankDraw, prevFleetCharge);
    if (typeof Memory !== "undefined") {
      Memory.lastFleetCharge = result.solution.spawnMaintenance;
      Memory.lastBankDraw = result.solution.sinkAllocations
        .filter(a => a.sinkType === "controller" || a.sinkType === "construction")
        .reduce((sum, a) => sum + a.allocated, 0);
      // Publish the plan's routed controller allocation PER ROOM (spec 38
      // phase B) - the ONE number every runtime reader that asks "how fast
      // does energy reach this controller" resolves through
      // bank.plannedControllerFlow: the feeder trunk's road-payback flow
      // (ConstructionCorp), and any future reader. The feeder corp itself
      // receives the same solve's number through its commission
      // (controllerFeederKind), so the two channels cannot disagree by more
      // than one solve's staleness. Same publish-don't-rederive pattern as
      // warchestTarget above.
      const ctrlByRoom: Record<string, number> = {};
      for (const a of result.solution.sinkAllocations) {
        if (a.sinkType !== "controller" || !a.roomName) continue;
        ctrlByRoom[a.roomName] = (ctrlByRoom[a.roomName] ?? 0) + a.allocated;
      }
      Memory.controllerAllocations = ctrlByRoom;
      // Publish the liquidity reserve target for next solve's bank-surplus
      // emission and every consumer that sizes off it (bank.resolveReserveTarget).
      // Income is the colony's sustained mined rate - the SAME set and rule as
      // buildColonyProblem's minedSupply (isMinedIncomeId), so the reserve and
      // the plan never classify income differently.
      const income = this.graph
        .getSources()
        .filter(s => isMinedIncomeId(s.id))
        .reduce((sum, s) => sum + s.capacity, 0);
      Memory.warchestTarget = warchestTarget(income);
    }
    this.solution = result.solution;
    this.commissions = result.commissions;
    if (result.adopted.length > 0) {
      console.log(
        `[Strategy] adopted ${result.adopted.length} restructuring(s): ` +
          result.adopted.map(a => `${a.sourceId}->${a.spawnId} (+${(a.gain * 100).toFixed(1)}%)`).join(", ")
      );
    }
  }

  /** Get current solution (or null if not solved). */
  public getSolution(): FlowSolution | null {
    return this.solution;
  }

  /**
   * The current solve's commissions (the framework seam). Same plan as
   * getSolution(), wrapped as Commission envelopes. Empty until the first solve.
   */
  public getCommissions(): Commission[] {
    return this.commissions;
  }

  /** Get the flow graph for direct access. */
  public getFlowGraph(): FlowGraph {
    return this.graph;
  }

  /**
   * Add a construction site dynamically (main.ts feeds newly-placed sites in
   * between full graph rebuilds).
   */
  public addConstructionSite(id: string, nodeId: string, position: Position, progressRemaining: number): void {
    this.graph.addConstructionSite(id, nodeId, position, progressRemaining);
  }
}

/** Re-export for the integration site. */
export type { Position };
