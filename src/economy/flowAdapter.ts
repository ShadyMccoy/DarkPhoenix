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
import { hostileRooms, isSourceKeeperRoom, roomLinearDistance } from "../utils/RoomDiscovery";
import { portPosts } from "../corps/nodeEnergy";
import { guardTargetsFor } from "../utils/raidMeter";
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
  controllerParkingTiles,
  observedMouthStock
} from "../corps/nodeEnergy";
import { buildUpgraderBody } from "../spawn/BodyBuilder";
import {
  BUILD_ENERGY_PER_WORK,
  HARVEST_ENERGY_PER_WORK,
  raidGuardTaxPerEnergy,
  UPGRADE_ENERGY_PER_WORK,
  infraSpawnEnergy,
  infraSpawnLoad,
  minerOverhead,
  projectAbsorbRate,
  spawnEnergyCeiling,
  workPartsForEnergyRate,
  WARTIME_BACKLOG_THRESHOLD,
  ANTI_DOWNGRADE_RESERVE,
  depositPortHeadroom,
  SOURCE_RATE
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
import { Commission, FieldedFleet } from "./Commission";
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
import {
  bankFedControllerRate,
  bankToTransientSource,
  bankSourceId,
  controllerFloorRate,
  fundedMiningIncome,
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
 * Routing capacity for a controller sink.
 *
 * THE BANK-FED INVERSION (owner 2026-08-04: "The bank should be the income
 * mop up not the upgrade"): when the room has a live bank, the caller passes
 * `bankFedAllocation` (= bank.bankFedControllerRate: floor + surplus/
 * SURPLUS_DRAIN_TICKS) and that IS the allocation - upgrade proportional to
 * surplus plus its floor, the BANK the residual claimant on income by
 * construction. One formula, continuous in the (slow-moving) bank level, so
 * the 2026-08-03 asymptotic ruling holds with no regime branch anywhere.
 * Phase C's refill-claim machinery is retired with this. Rooms WITHOUT a
 * bank keep the mop-up: there is no storage to absorb the residual.
 */
export function controllerRoutingCapacity(
  sink: { position: Position },
  totalSupply: number,
  physicalUpgradeCap: number = Infinity,
  wartimeRooms: ReadonlySet<string> = new Set(),
  bankFedAllocation?: number,
  /** The danger-gated floor (0 unless the downgrade timer is low) - what
   * wartime relegates TO. */
  controllerFloor: number = 0
): number {
  // WARTIME (spec 33, owner 2026-07-27 "surplus ... normally for upgrading,
  // but now for building"): a MEANINGFUL construction backlog stands in this
  // room, so upgrading RELEGATES to the floor and the surplus flows to
  // construction (value 70) instead. Relegated != off - the anti-downgrade
  // floor still holds; the mode exits the moment the backlog drains.
  // Doctrine keyed to a real backlog, NOT a bank level; it outranks the
  // bank-fed rate.
  if (wartimeRooms.has(sink.position.roomName)) {
    return controllerFloor;
  }
  // #21 (owner 2026-07-19): never faster than the upgrader fleet can
  // PHYSICALLY burn (parking tiles x affordable WORK - see
  // controllerUpgradeCap). Surplus beyond the cap has no upgrader to consume
  // it, so it overflows into the storage sink instead of publishing an
  // infeasible upgrade plan that out-competes remote mining (live t72429680:
  // uncapped 137 e/t against a ~4-upgrader fleet).
  if (bankFedAllocation !== undefined) {
    return Math.min(bankFedAllocation, physicalUpgradeCap);
  }
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
 * The spawn sink's demand: ONE upkeep estimate, never a sum (t72749493).
 * The fleet charge (steady-state upkeep of the plan's fleet) and the agenda
 * funding rate (queued must-fund bodies amortized over FUND_HORIZON) both
 * estimate "energy/tick the spawn must receive" - the queued bodies ARE the
 * replacements the charge prices, seen as cash-flow timing. Summing them
 * double-claimed the flow; dribble-sized while minCost-300 entries kept
 * fundingNeed small, 58 e/t once hold-to-fund queued full-share bodies:
 * measured t72749493, spawn sinks routed 108.25 (charge 50.29 + funding
 * 57.96) against 41.5 actually spent, and the controller allocation sat at
 * 16.56 for 1500+ ticks while the standing 75-WORK fleet decayed toward it.
 * MAX is the honest combinator: a banking wave claims the funding rate
 * exactly when it exceeds the steady charge; steady state claims the
 * charge; the flow is never claimed twice.
 */
export function spawnSinkDemand(
  baseDemand: number,
  maintenance: number,
  fundingRate: number,
  /**
   * PHYSICAL CONVERSION CEILING (P12 plan-side unification, t72773737):
   * primitives.spawnEnergyCeiling(fleet e/p) - the most energy/tick this
   * spawn can turn into bodies. The funding rate knows no such bound:
   * hold-to-fund queued 5,100e of full-share bodies, FUND_HORIZON turned
   * that into a 102 e/t claim on a spawn that converts ~25, and the solver
   * (spawn = top of the value ladder) parked the difference - a 156.61 e/t
   * gross bank draw with 101.45 round-tripping straight back to storage,
   * while the published controller allocation sat at 39.64 against its own
   * bankFedControllerRate cap of 59.04. The cap is HARD, even over the
   * charge: a converged charge above physical describes a fleet this spawn
   * cannot maintain - that is P4's infeasibility to flag, not a bigger
   * claim. Undefined = no cap (cold start, before the first solve publishes
   * the fleet mix through Memory.lastFleetEnergyPerPart) - legacy behavior
   * for exactly one solve.
   */
  ceiling?: number
): number {
  const claim = Math.max(baseDemand, 1, maintenance, fundingRate);
  return ceiling !== undefined ? Math.min(claim, ceiling) : claim;
}

/**
 * The fleet-mix energy-per-part the ceiling prices: fleet ENERGY (converged
 * charge x spawn count) over the parts ledger's planned parts (miners +
 * infra + routed haulers). Threads solve-to-solve through
 * Memory.lastFleetEnergyPerPart exactly like the charge itself
 * (Memory.lastFleetCharge). Undefined without a ledger or on degenerate
 * totals - no cap rather than a wrong one.
 */
export function fleetEnergyPerPart(
  fleetEnergy: number,
  partsLedger?: { minerLoad: number; infra: number; spent?: number }
): number | undefined {
  if (!partsLedger) return undefined;
  const parts = partsLedger.minerLoad + partsLedger.infra + (partsLedger.spent ?? 0);
  return parts > 1e-9 && fleetEnergy > 0 ? fleetEnergy / parts : undefined;
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
      // AN ADJACENT SOURCE IS NO LONGER REQUIRED (owner 2026-08-06: *"I
      // disagree that it's only links with sources. Building links inside our
      // rooms near the edge for remote mining is probably a great way to go in
      // a lot of cases. And in that case there's no miner, but we still want a
      // tender."*). The old gate was a spec-26 v1 leftover: the owning
      // source's hauler was how the drain got STAFFED. Since spec 02 the
      // feeder is the sole core-link operator and staffs it regardless, so the
      // requirement outlived its reason and was excluding exactly the geometry
      // that serves remote hauls best - a link that meets haulers where they
      // ENTER the room rather than where a source happens to sit.
      const owner = sources.find(s => s.pos.inRangeTo(link.pos, 2));
      // A port cannot absorb more than it can FIRE, and its own source (if
      // any) lands in the same link and comes off that first. Flat 30 was safe
      // for range 13-14; at the far edge of a room it over-routes into a
      // saturated link - see depositPortHeadroom.
      const rangeToCore = typeof link.pos.getRangeTo === "function" ? link.pos.getRangeTo(core.pos) : undefined;
      const headroom = depositPortHeadroom(rangeToCore, owner ? SOURCE_RATE : 0);
      if (headroom <= 0) continue; // too far to be worth routing anything to
      out.push({
        pos: { x: link.pos.x, y: link.pos.y, roomName },
        headroom,
        drainFrom: { x: core.pos.x, y: core.pos.y, roomName },
        ...(owner ? { drainSourceId: `source-${owner.id}` } : {})
      });
    }
  }
  return out;
}

/**
 * Detect SURPLUS storage banks across visible owned rooms and turn each into a
 * transient bank source at its storage position (spec 03 withdrawal, surplus
 * half - see economy/bank.ts). A bank still filling its warchest emits nothing:
 * the deposit half (storageRefillReserve's asymptotic claim) keeps
 * accumulating it. Live default for buildColonyProblem; injectable for tests.
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
 * The bank-fed controller allocation for a room (energy/tick), or undefined
 * when there is no live OWNED storage to read - the discriminator
 * controllerRoutingCapacity branches on (owner 2026-08-04: "The bank should
 * be the income mop up not the upgrade"). Same guards and the same
 * resolveReserveTarget as detectBankSources, so the allocation and the
 * surplus emission read the same stock and target and cannot drift.
 * Harness/unit paths without a staged storage get undefined, keeping the
 * pre-storage mop-up unchanged there.
 */
export function storageBankFedAllocation(roomName: string): number | undefined {
  if (typeof Game === "undefined" || !Game.rooms) return undefined;
  const storage = Game.rooms[roomName]?.storage;
  if (!storage || !storage.my) return undefined;
  const banked = storage.store?.[RESOURCE_ENERGY] ?? 0;
  const reserveTarget = resolveReserveTarget(typeof Memory !== "undefined" ? Memory.warchestTarget : undefined);
  return bankFedControllerRate(banked, reserveTarget, controllerDowngradeTicks(roomName));
}

/** Live ticksToDowngrade for a room's controller (undefined without vision -
 * the danger-gated floor's input; owned rooms always have vision live). */
export function controllerDowngradeTicks(roomName: string): number | undefined {
  if (typeof Game === "undefined" || !Game.rooms) return undefined;
  return Game.rooms[roomName]?.controller?.ticksToDowngrade;
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

/**
 * How many corrective re-solves the reserver set gets (see solveColony). Two,
 * because the first is the ordinary case - the set moved by a room and the
 * re-price settles it - and the second only exists to catch a room that its own
 * freed charge funds back. A third would be chasing an oscillation, which is a
 * residual to REPORT (infraInputs.remoteRoomsFunded), not to spend the tick's
 * heaviest work on.
 */
const REMOTE_SET_MAX_PASSES = 2;

/**
 * The remote rooms a solved plan actually funds a miner in - the reserver set
 * the reservation corps will be proposed for, and the set the NEXT solve prices
 * its infra from (persisted as Memory.fundedRemoteRooms). Sorted, so two solves'
 * sets compare and serialise identically.
 */
function fundedRemoteRoomsOf(problem: ColonyProblem, plan: { miners: { sourceId: string }[] }): string[] {
  const spawnRoomSet = new Set(problem.spawns.map(s => s.pos.roomName));
  const srcById = new Map(problem.sources.map(s => [s.id, s]));
  const rooms = new Set<string>();
  for (const m of plan.miners) {
    const rn = srcById.get(m.sourceId)?.pos.roomName;
    if (rn && !spawnRoomSet.has(rn)) rooms.add(rn);
  }
  return [...rooms].sort();
}

export function buildColonyProblem(
  graph: FlowGraph,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  linkHaulPos: Map<string, Position> = detectLinkHaulPositions(graph),
  pavedSources: Map<string, number> = detectPavedSources(),
  bankSources: PlannerSource[] = detectBankSources(),
  /**
   * The remote admission tax, as a FUNCTION of the room's total mined rate
   * (2026-08-07). It was a flat coefficient while the guard was priced as a
   * per-raid purchase; since spec 51 phase 2 the guard is a STANDING fleet, so
   * what a room owes is the TIME it holds one - inversely proportional to how
   * fast it mines. Per ROOM, not per source, because the raid meter accrues per
   * room. Pass `() => 0` to disable.
   */
  remoteInvaderTax: (roomMinedRate: number) => number = raidGuardTaxPerEnergy,
  valuation: SinkValuation = DEFAULT_VALUATION,
  prevBankDraw?: number,
  depositPorts: DepositPort[] = detectLinkDepositPorts(),
  /**
   * PASS-2 INPUT (two-pass solve): energy/tick the plan's standing fleet costs
   * to maintain, PER SPAWN. Zero on pass 1 (unknown until the plan exists), so
   * pass 1 behaves exactly as before and the pass-2 problem is the only one
   * that differs. See solveColony.
   */
  spawnMaintenance = 0,
  /**
   * The previous solve's FUNDED remote rooms (Memory.fundedRemoteRooms,
   * threaded by the execution layer like prevBankDraw). Prices the standing
   * reserver upkeep from the rooms actually worked instead of every scouted
   * candidate - see the remoteRooms derivation.
   */
  prevFundedRemoteRooms?: readonly string[],
  /**
   * FIELDED-fleet actuals per commission (spec 39 phase 2), assembled by the
   * host (CommissionHost.assembleFieldedFleets) and threaded by main - the
   * per-post actuals the plan incorporates. Carried as data; phase 3's
   * replacement scheduling is the reader.
   */
  fielded?: Record<string, FieldedFleet>,
  /**
   * The previous solve's fleet-mix energy-per-part
   * (Memory.lastFleetEnergyPerPart, threaded like prevBankDraw) - prices the
   * spawn sink's PHYSICAL conversion ceiling (spawnEnergyCeiling). Undefined
   * on a cold start: the sink claim stays uncapped for exactly one solve.
   */
  prevFleetEnergyPerPart?: number
): ColonyProblem {
  const spawns: PlannerSpawn[] = graph.getSinks("spawn").map(s => ({ id: s.id, pos: s.position }));

  // The invader tax (spec 13 phase 5) applies to sources OUTSIDE spawn
  // rooms: raid frequency is proportional to energy harvested, and at home
  // the tower absorbs the raid for the cost of its shots (~0).
  const spawnRooms = new Set(spawns.map(s => s.pos.roomName));

  // ROOM mined rate - the tax's denominator. The engine's raid counter is
  // per ROOM (raidMeter mirrors it that way), so a two-source remote reaches
  // the trigger in half the ticks and holds its guard for half as long per
  // unit mined. Summed over the room's own sources, not read per source.
  const roomMinedRate = new Map<string, number>();
  for (const s of graph.getSources()) {
    if (spawnRooms.has(s.position.roomName)) continue;
    roomMinedRate.set(s.position.roomName, (roomMinedRate.get(s.position.roomName) ?? 0) + s.capacity);
  }

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
      // SAME-LENS DEFUND (cycle t72793209): HarvestCorp's defense-economics
      // gate buys no bodies while hostileRooms() marks this room (creep
      // marks + invader reservations), so the plan must not price its
      // capacity either - the divergence WAS the -41 forgone line and the
      // phantom budget margin. Never stamped for spawn rooms: home defense
      // is towers + guards, and un-funding the home economy mid-raid would
      // be the death spiral, not honesty.
      ...(!spawnRooms.has(s.position.roomName) && hostileRooms().has(s.position.roomName) ? { defunded: true } : {}),
      ...(() => {
        if (spawnRooms.has(s.position.roomName)) return {};
        const tax = remoteInvaderTax(roomMinedRate.get(s.position.roomName) ?? s.capacity);
        return tax > 0 ? { invaderTax: tax } : {};
      })(),
      // STAGED MOUTH STOCK (phase 1 of the income-statement program): the
      // SAME sourceBufferStock lens the corp's drain term and E6's gate read,
      // so the plan prices the drain fleet the corp will actually field.
      // Walk-served mouths only - a link-served source's stock is the link
      // network's business, and pricing haulers for it would re-open the
      // haul-of-zero contract.
      //
      // VISION IS NOT THE LENS (2026-08-07, the pile-decay cycle). "No vision
      // => absent" read as prudence and was the bug: `Game.getObjectById`
      // returns null for a source in a remote room with no creep standing in
      // it, and the SOLVE runs whether or not one happens to be there. So the
      // plan priced ZERO drain for exactly the mouths that were piling up.
      // Measured t72850264: six of eleven mouths held 2,737-3,553 for 78-100%
      // of the window (E6, from the miners' OWN stamps) while every hauler
      // route in the published plan was sized at flow = 10 - the raw source
      // rate, no drain anywhere. 13.36 e/t of decay, and self-reinforcing: the
      // pile gates the miner off, the miner leaving takes the room's vision,
      // and the plan goes blinder still.
      //
      // Live vision first (freshest), then the miner's durable stamp - the
      // stranded-reserver rule applied to a source mouth: read the observation,
      // never "is one of our creeps standing there".
      ...(() => {
        if (linkHaulPos.get(s.id) !== undefined) return {};
        if (typeof Game === "undefined" || !Game.getObjectById) return {};
        const live = Game.getObjectById(stripSourcePrefix(s.id) as Id<Source>);
        const staged = live ? sourceBufferStock(live) : observedMouthStock(s.id, Game.time);
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

  // Rooms whose bank is built (storage-hub rooms): used for infra pricing and
  // remote-site exclusion below. The storage sink STAYS open in every regime
  // (owner 2026-07-19: consumers draw from storage, so it is a valid home for
  // remote surplus - keeping it lets excess production bank instead of rotting
  // at remote containers, #19). The anti-pump is structural in routeToSinks:
  // bank sources never fill the storage sink, so a solve can never both
  // withdraw the warchest AND deposit to it - and the refill claim
  // (storageRefillReserve) is nonzero only BELOW the target, where no bank
  // source exists, so claim-and-drain can never coexist either. The storage
  // sink's capacity is its physical room remaining, so a topped-out bank
  // presents zero room and the surplus mining is defunded rather than rotted.
  const roomsWithStorage = new Set<string>();
  for (const sink of graph.getSinks()) {
    if (sink.type === "storage") roomsWithStorage.add(sink.position.roomName);
  }

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
  // CONSTRUCTION IS SCOPED TO THE ROOMS THE COLONY WORKS (2026-08-07).
  //
  // Not a distress gate and not a defund - the working set is simply what the
  // plan is solving. A site in a room the plan does not work has no supply line
  // to it: no miner, no hauler route, no reason for a builder to be there. The
  // plan was funding those anyway because `graph.getSinks()` hands back EVERY
  // site the engine knows about, with no test of whether the economy reaches it.
  //
  // Measured t72850264, and it was the colony's ENTIRE construction budget: one
  // container in W41N25 at 4,582/5,000 - a two-source remote we last harvested
  // ~12,000 ticks earlier and the plan has since stopped funding. It held
  // 10 e/t of sink demand at priority 70 (ABOVE the controller, whose effective
  // priority was 44.8 with 35.69 unmet) plus 0.135 p/t of spawn budget - four
  // times the whole tender detail - and delivered 0.00 e/t for the window with
  // its corp at creeps 0. Incoherent by construction: fund the room or don't,
  // but never build infrastructure FOR a room you have decided not to work.
  //
  // The site itself is left standing, deliberately: it is a real 92%-paid asset
  // and removing it would burn 4,582e of sunk work. If W41N25 comes back into
  // the plan, its container comes back with it, and this scope test admits it
  // again on the same solve.
  //
  // Scope = spawn rooms + the PREVIOUS solve's funded remotes, the same ratchet
  // `pricedRelay` and the reserver set already use (no history admits
  // everything for exactly one solve, then converges).
  const workedRooms = new Set<string>(spawnRooms);
  for (const r of prevFundedRemoteRooms ?? []) workedRooms.add(r);
  const constructionSites = graph
    .getSinks()
    .filter(s => toSinkKind(s.type) === "construction" && s.progressRemaining !== undefined)
    .filter(s => prevFundedRemoteRooms === undefined || workedRooms.has(s.position.roomName));

  // WARTIME (spec 33, owner 2026-07-27; COLONY-WIDE since owner 2026-08-05:
  // "I WANT construction to be the primary consumer over controller if we
  // have a construction project. Banking excess it can't consume is fine").
  // The backlog is summed across the WHOLE colony - the per-room lens was
  // the measured gap at t72799968: 24 remote road sites stood (the roads
  // that fix the haul economics) while the home room held zero sites, so
  // the home controller never relegated and took the bank-fed allocation
  // over the build-out. While a meaningful backlog stands ANYWHERE (>= one
  // structure, ~3000 - the threshold still excludes a lone road so trivial
  // paving never flaps upgrading), EVERY owned controller relegates to its
  // danger-gated floor (see controllerRoutingCapacity), construction
  // absorbs at its own caps, and the residual banks - never the controller.
  // Exits cleanly when the colony backlog drains below the threshold.
  const colonyBacklog = constructionSites.reduce((sum, cs) => sum + (cs.progressRemaining ?? 0), 0);
  const wartimeRooms: ReadonlySet<string> =
    colonyBacklog >= WARTIME_BACKLOG_THRESHOLD
      ? new Set(
          graph
            .getSinks()
            .filter(s => s.type === "controller")
            .map(s => s.position.roomName)
        )
      : new Set();

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
  const fundedSiteIds = new Set(constructionSites.map(s => s.id));
  for (const sink of graph.getSinks()) {
    const kind = toSinkKind(sink.type);
    if (!kind) continue;
    // Out-of-scope construction never becomes a sink at all - the backlog math
    // above already dropped it, and a sink the plan would fund while the
    // backlog ignores it is two books again. See the workedRooms derivation.
    if (kind === "construction" && !fundedSiteIds.has(sink.id)) continue;
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
            // mining). Pass 2 supplies the fleet's real standing cost here -
            // combined with the agenda's funding rate by MAX, never sum (the
            // t72749493 double-claim lock; see spawnSinkDemand).
            spawnSinkDemand(
              sink.demand,
              spawnMaintenance,
              agendaFundingRate(sink.id),
              prevFleetEnergyPerPart !== undefined ? spawnEnergyCeiling(prevFleetEnergyPerPart) : undefined
            )
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
              controllerUpgradeCap(sink.position.roomName),
              wartimeRooms,
              // THE BANK-FED INVERSION (owner 2026-08-04): with a live bank,
              // the controller's cap IS floor + surplus draw and the bank
              // absorbs the income residual by construction. Undefined
              // (no storage / harness) keeps the mop-up.
              storageBankFedAllocation(sink.position.roomName),
              controllerFloorRate(controllerDowngradeTicks(sink.position.roomName))
            ),
      // SPEC 38 PHASE A (2026-08-02): the controller's floor moves INSIDE the
      // plan. controllerFloorRate = the save-regime target as fast as the
      // standing bank can sustain it (the ONE drain law), floored at the
      // anti-downgrade trickle - so the reserve pre-pass guarantees what
      // feederRelayRate's +STORAGE_UPGRADE_TARGET side-channel guaranteed
      // outside the plan (P12's measured 3.30x non-bank divergence), and a
      // cold storage room's spawn is never out-reserved by its controller.
      // (Phase D 2026-08-04: the storage sink carries NO reserve - the bank
      // is the residual claimant by construction, nothing to claim.)
      reserve:
        kind === "controller"
          ? controllerFloorRate(controllerDowngradeTicks(sink.position.roomName))
          : undefined
    });
  }

  // Standing-infra spawn load (spec 15 P4): the feeder shuttle sized to the
  // bank relay, the tender detail, one reserver per mined remote room - real
  // bodies the plan implies but never commissions through routeToSinks.
  // Deducted from the planner's spawn-parts ledger so the sink fill spends
  // only what the spawn can truly still build.
  // The remote set for infra pricing is the FUNDED rooms of the previous
  // solve when history exists (Memory.fundedRemoteRooms, threaded by the
  // execution layer like prevBankDraw) - the candidate derivation below
  // counts every scouted room holding a source, and the reserver upkeep
  // priced from it charged for rooms the colony never works (measured
  // t72750467, the first infraInputs stamp: remoteRooms 26 against 8
  // funded - ~10+ e/t of phantom standing charge inside the fleet charge,
  // routed to the spawn sinks at the controller's expense). No history
  // (first solve, harness) keeps the candidate set: over-priced for ONE
  // solve, then the published funded set converges it - the pricedRelay
  // ratchet pattern exactly.
  const remoteRooms = new Set(
    prevFundedRemoteRooms ??
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
  // KNOWN DRIFT (2026-08-03, deferred deliberately): with the save-regime
  // controller cap retired, a FILLING room's published allocation can exceed
  // this price's 15-floor while bankRate is 0, so the feeder's infra charge
  // under-states the relay it will field. Measured scale: the whole feeder
  // term is ~0.005 p/t (P4) - a ~25 e/t relay mispricing is ~0.003 p/t
  // against F1's 0.244 p/t breach. Fix belongs with P12's unification (price
  // the PREVIOUS solve's published allocation), not here.
  const pricedRelay =
    prevBankDraw !== undefined
      ? Math.min(controllerFloorRate() + bankRate, Math.max(controllerFloorRate(), prevBankDraw))
      : controllerFloorRate() + bankRate;
  // Link-fed depots price the feeder at the storage->core-link leg (spec 24
  // rung 3) - the SAME controllerLink lens the corp's sizing reads.
  let linkFedRooms = 0;
  if (typeof Game !== "undefined" && Game.rooms) {
    for (const roomName of roomsWithStorage) {
      const room = Game.rooms[roomName];
      if (room && controllerLink(room)) linkFedRooms++;
    }
  }
  // ARMED ROOMS (spec 51 phase 2): one standing guard each, from the SAME lens
  // RaidGuardCorp holds its posts with and the commission budgets from. Usually
  // zero - this is the one infra term that is conditional on the world being
  // dangerous, which is exactly why it reads a lens and not a constant.
  const guardedRooms = new Set<string>();
  for (const home of spawnRooms) for (const target of guardTargetsFor(home)) guardedRooms.add(target);
  // PORTED ROOMS (2026-08-08): home rooms carrying a deposit port that has a
  // BUFFER container - the ports the port tender has a post at. Read through
  // `portPosts`, the SAME lens the corp holds its post with and the delivery
  // side resolves its buffer with, so the price and the behaviour cannot
  // disagree about which ports exist (spec 17 P3, and the reason `guardedRooms`
  // above is a lens rather than a count).
  const portRooms = new Set<string>();
  for (const roomName of spawnRooms) {
    const room = Game.rooms[roomName];
    if (room && portPosts(room).length > 0) portRooms.add(roomName);
  }
  const infraPartsPerTick = infraSpawnLoad(
    pricedRelay,
    roomsWithStorage.size,
    remoteRooms.size,
    linkFedRooms,
    1,
    guardedRooms.size,
    portRooms.size
  );
  // Same details, priced in ENERGY - the second currency the spawn sink
  // needs (see the two-pass solve in solveColony).
  const infraEnergyPerTick = infraSpawnEnergy(
    pricedRelay,
    roomsWithStorage.size,
    remoteRooms.size,
    linkFedRooms,
    1,
    guardedRooms.size,
    portRooms.size
  );
  const infraInputs = {
    pricedRelay,
    depotRooms: roomsWithStorage.size,
    remoteRooms: remoteRooms.size,
    linkFedRooms,
    guardedRooms: guardedRooms.size,
    portRooms: portRooms.size
  };

  return {
    assembly,
    spawns,
    sources, sinks, dist, infraPartsPerTick, infraEnergyPerTick, infraInputs, depositPorts,
    ...(fielded ? { fielded } : {}) };
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
  prevFleetCharge?: number,
  /**
   * The previous solve's funded remote rooms (Memory.fundedRemoteRooms) -
   * threaded exactly like prevBankDraw; prices infra's reserver term from
   * the worked set, not the scouted candidates (t72750467: 26 vs 8).
   */
  prevFundedRemoteRooms?: readonly string[],
  /** Fielded-fleet actuals (spec 39 phase 2), host-assembled - see buildColonyProblem. */
  fielded?: Record<string, FieldedFleet>,
  /**
   * The previous solve's fleet-mix e/p (Memory.lastFleetEnergyPerPart),
   * threaded like prevFleetCharge - prices the spawn sink's physical
   * conversion ceiling. See buildColonyProblem / spawnSinkDemand.
   */
  prevFleetEnergyPerPart?: number
): { solution: FlowSolution; commissions: Commission[]; adopted: { sourceId: string; spawnId: string; gain: number }[] } {
  const seedCharge = Math.max(0, prevFleetCharge ?? 0);
  const baseProblem = buildColonyProblem(
    graph,
    dist,
    transientSources,
    detectLinkHaulPositions(graph),
    detectPavedSources(),
    bankSources,
    raidGuardTaxPerEnergy,
    compileGoal(goal),
    prevBankDraw,
    detectLinkDepositPorts(),
    seedCharge,
    prevFundedRemoteRooms,
    fielded,
    prevFleetEnergyPerPart
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
  // Reads the SOLVED problem's infra, not baseProblem's. Identical while the
  // priced remote set is fixed (every iteration built it from the same input);
  // it stops being identical once the reserver pass below re-prices that set, and
  // a charge priced off a different problem's infra than the plan it ships is
  // the same class of error the damping above exists to kill.
  const fleetOf = (p: { plan: { totalOverhead: number }; problem: ColonyProblem }): number =>
    p.plan.totalOverhead + (p.problem.infraEnergyPerTick ?? 0);
  const spawnCount = Math.max(1, baseProblem.spawns.length);
  const solveWith = (
    perSpawn: number,
    remotes: readonly string[] | undefined = prevFundedRemoteRooms
  ): ReturnType<typeof searchStructure> =>
    searchStructure(
      buildColonyProblem(
        graph, dist, transientSources, detectLinkHaulPositions(graph), detectPavedSources(),
        bankSources, raidGuardTaxPerEnergy, compileGoal(goal), prevBankDraw,
        detectLinkDepositPorts(), perSpawn, remotes, fielded, prevFleetEnergyPerPart
      )
    );

  // ---- THE RESERVER TERM'S OWN LAG (spec 51, measured t72828763) ----
  //
  // `infraSpawnLoad` prices one reserver per remote room from
  // `prevFundedRemoteRooms` - the PREVIOUS solve's answer - because the charge
  // has to be deducted before the solve that decides this one's. The reservation
  // CORPS, meanwhile, are proposed off THIS solve's draft. So the two books
  // agree only while the funded set holds still, and diverge by one reserver per
  // room that joined or left.
  //
  // That lag was survivable at a 50-tick solve cadence. It is not at the fiscal
  // month term (spec 46 phase A): the plan built here IS the month's budget, so
  // a remote that drops out at a boundary is charged to the colony for the whole
  // month after it stopped being worked. And it drops out at exactly the moment
  // the sweep is measuring - raising the handicap shrinks the spawn budget, and
  // the first thing that budget does is stop admitting marginal remotes.
  // Measured live: priced 9, funded 8, Sigma(auxiliary corps) short by exactly
  // one roomReserverSpawnLoad (0.003704 p/t).
  //
  // So close it here, where THIS solve's answer is already in hand: when the plan
  // funds a different number of remotes than it was priced for, re-solve with the
  // set it actually funded. It also converges a COLD start in one solve rather
  // than one replan - with no history the priced set is every scouted candidate
  // (t72750467: 26 rooms against 8 funded).
  //
  // The re-price is OUTSIDE the damped charge iteration and each re-price runs a
  // full one of its own. That is not belt-and-braces: dropping a reserver lowers
  // `infraEnergyPerTick`, which is a TERM OF THE CHARGE (see fleetOf), so a
  // corrective solve bolted on after convergence would ship a plan whose fleet
  // costs less than the charge the spawn sink is still demanding - moving the
  // same over-charge from the parts ledger into the energy ledger instead of
  // removing it. The inner iteration is seeded from the converged charge, so when
  // the set does not move it costs zero extra searches, and when it does it
  // usually costs one.
  //
  // Not guaranteed to reach a fixed point: dropping a room frees its charge,
  // which can fund it right back. Bounded at REMOTE_SET_MAX_PASSES; when that
  // binds, the last plan ships and `infraInputs.remoteRoomsFunded` records the
  // residual next to the priced count, so the reconciliation NAMES the
  // disagreement instead of hiding it.
  let remotes: readonly string[] | undefined = prevFundedRemoteRooms;
  let searched = pass1;
  let charge = seedCharge;
  let dampedPasses = 0;
  let fundedRemotes: string[] = [];
  for (let pass = 0; ; pass += 1) {
    const converged = convergeFleetCharge(
      charge,
      fleetOf(searched) / spawnCount,
      (s: ReturnType<typeof searchStructure>) => fleetOf(s) / spawnCount,
      (perSpawn: number) => solveWith(perSpawn, remotes)
    );
    charge = converged.charge;
    dampedPasses += converged.passes;
    if (converged.solved) searched = converged.solved;

    fundedRemotes = fundedRemoteRoomsOf(searched.problem, searched.plan);
    const priced = searched.problem.infraInputs?.remoteRooms;
    if (pass >= REMOTE_SET_MAX_PASSES || priced === undefined || priced === fundedRemotes.length) break;
    // Re-price, then re-converge from the charge we already have. The explicit
    // solve is required: convergeFleetCharge stops on the charge's tolerance and
    // would return `solved: undefined` - keeping the OLD set's plan - when only
    // the SET moved.
    remotes = fundedRemotes;
    searched = solveWith(charge, remotes);
  }
  spawnMaintenanceStamp = charge;

  // DECISION STAMP (spec 14): every input of the charge, not just the result.
  // `spawnMaintenance` alone could not distinguish an unconverged iteration
  // from a wrong divisor from a mis-estimated infra term - two diagnoses off
  // the sum alone were both wrong. `charge * spawnCount == fleetEnergy` is now
  // checkable straight from a capture.
  fleetChargeStamp = {
    fleetEnergy: fleetOf(searched),
    production: searched.plan.totalOverhead,
    infra: searched.problem.infraEnergyPerTick ?? 0,
    spawnCount,
    // Summed across every charge iteration, including any the reserver re-price
    // triggered - the field means "damped iterations actually run", and that is
    // still what this counts.
    passes: dampedPasses,
    ...(searched.problem.infraInputs
      ? { infraInputs: { ...searched.problem.infraInputs, remoteRoomsFunded: fundedRemotes.length } }
      : {})
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
    // The mouth buffer the drain reprice actually read (v17) - see MinerAssignment.
    ...(() => {
      const src = problem.sources.find(s => s.id === m.sourceId);
      return src?.staged !== undefined ? { staged: src.staged } : {};
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
      // What the ROUTING pass actually debited for this sink's consumer bodies
      // (audit t72846447), published for EVERY sink kind - unlike `spawnLoad`
      // below, which is construction-only by design. The pair is what makes
      // `partsLedger.spent` decomposable from a capture.
      ...(k.chargedWork !== undefined ? { chargedWork: k.chargedWork } : {}),
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
    // The funded remote set this solve actually worked - persisted by the
    // execution layer (Memory.fundedRemoteRooms) to price the NEXT solve's
    // reserver upkeep from reality (see buildColonyProblem.remoteRooms). Already
    // computed above, where the corrective reserver pass converged it against
    // the priced set; recomputing here would risk the two drifting apart.
    fundedRemoteRooms: fundedRemotes,
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
  public update(tick: number, fielded?: Record<string, FieldedFleet>): void {
    // The goal is EXECUTION-owned state (Memory.goal, set by the operator via
    // global.setGoal); the pure layers only ever receive it as an argument.
    // `fielded` (spec 39 phase 2) arrives as an ARGUMENT, not via Memory: it
    // is a live snapshot owned by the execution layer's commission store
    // (CommissionHost.assembleFieldedFleets), not persisted history.
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
    // Same lifetime and rationale as the two above: the funded remote set
    // prices the next solve's reserver upkeep from the rooms actually worked.
    const prevFundedRemoteRooms = typeof Memory !== "undefined" ? Memory.fundedRemoteRooms : undefined;
    // Same lifetime again: the fleet-mix e/p prices the spawn sink's physical
    // conversion ceiling (spawnEnergyCeiling) - undefined for exactly one
    // solve after a wipe, then known forever.
    const prevFleetEnergyPerPart = typeof Memory !== "undefined" ? Memory.lastFleetEnergyPerPart : undefined;
    const result = solveColony(
      this.graph, tick, undefined, undefined, undefined, goal, prevBankDraw, prevFleetCharge, prevFundedRemoteRooms,
      fielded, prevFleetEnergyPerPart
    );
    if (typeof Memory !== "undefined") {
      Memory.lastFleetCharge = result.solution.spawnMaintenance;
      // The ceiling's mix input: fleet ENERGY (per-spawn charge x spawns the
      // solve actually planned) over the parts ledger's planned parts.
      const spawnSinkIds = new Set(
        result.solution.sinkAllocations.filter(a => a.sinkType === "spawn").map(a => a.sinkId)
      );
      Memory.lastFleetEnergyPerPart = fleetEnergyPerPart(
        (result.solution.spawnMaintenance ?? 0) * Math.max(1, spawnSinkIds.size),
        result.solution.partsLedger
      );
      Memory.fundedRemoteRooms = result.solution.fundedRemoteRooms;
      Memory.lastBankDraw = result.solution.sinkAllocations
        .filter(a => a.sinkType === "controller" || a.sinkType === "construction")
        .reduce((sum, a) => sum + a.allocated, 0);
      // Publish the plan's routed controller allocation PER ROOM (spec 38
      // phase B) - the ONE number every runtime reader that asks "how fast
      // does energy reach this controller" resolves through
      // bank.plannedControllerFlow: the feeder trunk's road-payback flow
      // (ConstructionCorp), and any future reader. The feeder corp itself
      // receives the same solve's number through its commission
      // (linkKind), so the two channels cannot disagree by more
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
      // Income is the colony's sustained FUNDED mined rate - this solve's own
      // producer verdicts, NOT the graph's candidate pool. The pool counts
      // every scouted source whose real id intel recorded (isMinedIncomeId's
      // accepted residual), so giving vision to unworked neighbor rooms
      // inflated the reserve +42k and throttled the controller valve 49 -> 31
      // e/t (measured t72788704, the 11->12 remote regression - full story on
      // bank.fundedMiningIncome). The reserve covers the payroll of fleets
      // this plan actually fields; candidates fund nothing.
      Memory.warchestTarget = warchestTarget(fundedMiningIncome(result.solution.sourceVerdicts));
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
