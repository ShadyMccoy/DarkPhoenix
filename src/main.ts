/**
 * @fileoverview Main game loop entry point.
 *
 * This is the entry point for the Screeps AI. It orchestrates the colony
 * using a flow-based economic system.
 *
 * ## Phased Architecture
 *
 * ### EVERY TICK (execution)
 * 1. INIT: Lazy hydration from Memory (once per code push)
 * 2. EXECUTE: Run all corps (spawning, mining, hauling, upgrading, etc.)
 * 3. PERSIST: Save state to Memory
 *
 * ### EVERY 5000 TICKS (planning)
 * 1. SURVEY: Analyze territory, create corps from node resources
 * 2. FLOW: Solve optimal energy allocation (sources -> sinks)
 * 3. MATERIALIZE: Update corps with flow assignments
 *
 * ## Key Components
 * - Colony: Economic coordinator (treasury, surveying)
 * - Nodes: Territory-based regions (from spatial peak detection)
 * - Corps: Business units that execute flow assignments
 * - FlowEconomy: Solver for optimal energy routing
 *
 * ## Console Commands
 * - global.plan() - Force run flow economy planning
 * - global.status() - Show orchestration status
 * - global.flowStatus() - Show flow economy details
 *
 * @module main
 */

import "./types/Memory";
import { Colony, createColony } from "./colony";
import { updateExpansionCampaign } from "./execution/ExpansionCampaign";
import {
  CorpRegistry,
  allCommissionedCorps,
  cleanupDeadCreeps,
  completeCensus,
  commissionedCorpsOfKind,
  createCorpRegistry,
  getAnalysisCache,
  isAnalysisInProgress,
  isSpawnPlacementInProgress,
  logCorpStats,
  persistState,
  refreshNodeResourcesFromCache,
  renderNodeVisuals,
  renderSpatialVisuals,
  renderRoadScores,
  rescueOrphans,
  resetAnalysis,
  restoreVisualizationCache,
  runBootstrapCorps,
  runCommissionHost,
  runIncrementalAnalysis,
  runLinks,
  runSpawnPlacementStep,
  runSpawnScheduling,
  runSpawningCorps,
  runTowers,
  snapshotCorpVariance,
  startSpawnPlacement,
  trackRoadUsage
} from "./execution";
import { constructionProjectLedger } from "./corps/ConstructionCorp";
import { aggregateTrunkRoadSinks } from "./economy/roadSegments";
import { collectTrunkRoutes, homeBankSupply } from "./economy/roadSegmentsGame";
import { EdgeType, Node, NodeNavigator, SerializedNode, createNodeNavigator, deserializeNode } from "./nodes";
import { FlowEconomy } from "./flow";
import {
  PLANNING_INTERVAL,
  initCorps,
  setLastPlanningTick,
  shouldRunPlanning
} from "./orchestration";
import { ErrorMapper } from "./utils";
import { getTelemetry } from "./telemetry";
import { errRowCount, flush as blackBoxFlush, lastSpawnTick, record as blackBoxRecord } from "./telemetry/BlackBox";
import { GovernorPlan, runGovernor } from "./execution/CpuGovernor";
import { runWatchdogs } from "./telemetry/watchdogs";

// =============================================================================
// GLOBALS
// =============================================================================

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting NodeJS.Global has no ES-module equivalent
  namespace NodeJS {
    interface Global {
      log: any;
      colony: Colony | undefined;
      corps: CorpRegistry;
      // Flow economy (new integration)
      flowEconomy: FlowEconomy | undefined;
      nodeNavigator: NodeNavigator | undefined;
      // Orchestration commands
      plan: () => void;
      status: () => void;
      flowStatus: () => void;
      // Legacy commands
      recalculateTerrain: () => void;
      setGoal: (profile?: string, weight?: number) => void;
      resetAnalysis: () => void;
      showNodes: () => void;
      exportNodes: () => string;
      clearSpawnQueue: () => void;
      forceBootstrap: () => void;
      sourceEfficiency: () => void;
      roadHeatmap: (roomName?: string) => void;
    }
  }
}

/** The colony instance (persisted across ticks) */
let colony: Colony | undefined;

/** Node navigator for pathfinding (created from persisted edges) */
let nodeNavigator: NodeNavigator | undefined;

/** Flow economy coordinator (replaces market-based allocation) */
let flowEconomy: FlowEconomy | undefined;

/** All active corps */
const corps: CorpRegistry = createCorpRegistry();

// =============================================================================
// MAIN GAME LOOP
// =============================================================================

/**
 * Main game loop - executed every tick.
 *
 * ## Phased Execution
 *
 * ### Every Tick
 * 1. INIT: Lazy hydration from Memory (once per code push)
 * 2. EXECUTE: Run all corps
 * 3. PERSIST: Save state
 *
 * ### Every 5000 Ticks (Planning Phase)
 * 1. SURVEY: Analyze territory, create corps from node resources
 * 2. MARKET: Register offers, run market clearing
 * 3. PLAN: Find optimal chains, store contracts
 *
 * Wrapped with ErrorMapper to catch and log errors without crashing.
 */
/**
 * Phase bulkhead (spec 09 ph5): one phase's throw must not abort the tick's
 * remaining phases. ErrorMapper saves the PROCESS; this saves the TICK - the
 * error is logged, recorded to the black box with its phase name, and the
 * loop moves on.
 */
function bulkhead(name: string, fn: () => void): void {
  // spec 20 P2: every bulkheaded phase is a named INFRASTRUCTURE bucket in
  // the CPU ledger - the residual the corp accounting can't attribute is
  // named, never hidden (the reconciliation invariant).
  const before = typeof Game !== "undefined" && Game.cpu?.getUsed ? Game.cpu.getUsed() : null;
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Bulkhead:${name}] ${msg}\n${e instanceof Error ? e.stack ?? "" : ""}`);
    blackBoxRecord("err", { phase: name, msg });
  } finally {
    if (before !== null) infraCpu[name] = (infraCpu[name] ?? 0) + (Game.cpu.getUsed() - before);
  }
}

/** This tick's named infrastructure CPU buckets (reset each loop). */
let infraCpu: { [bucket: string]: number } = {};

/**
 * Publish the infrastructure half of the CPU ledger beside the host's
 * per-corp half (spec 20 P2): Memory.corpCpu.infra + wholeTick complete the
 * reconciliation - wholeTick - corpsTotal - Σinfra = the still-unnamed
 * remainder (governor, cleanup, planning-phase work outside bulkheads).
 */
function publishInfraCpu(): void {
  if (typeof Memory === "undefined" || typeof Game === "undefined" || !Game.cpu?.getUsed) return;
  const ledger = Memory.corpCpu;
  if (ledger && ledger.tick === Game.time) {
    const rounded: { [bucket: string]: number } = {};
    for (const bucket in infraCpu) rounded[bucket] = Number(infraCpu[bucket].toFixed(3));
    ledger.infra = rounded;
    ledger.wholeTick = Number(Game.cpu.getUsed().toFixed(3));
  }
  infraCpu = {};
}

export const loop = ErrorMapper.wrapLoop(() => {
  // Reclaim memory for creeps that died last tick. Done first so it always runs,
  // even if a later phase throws (the loop is ErrorMapper-wrapped) - otherwise
  // dead-creep memory would leak whenever planning/execution hit an error.
  cleanupDeadCreeps();

  // CPU governor (spec 09 ph5): compute this tick's degradation plan from the
  // bucket. Consumers (solve cadence, telemetry, construction, scouting) read
  // it via plan(); level transitions land in the black box.
  const gov: GovernorPlan = runGovernor(typeof Game.cpu?.bucket === "number" ? Game.cpu.bucket : 10000);

  // ===========================================================================
  // PHASE 0: INIT - Lazy initialization (once per code push)
  // ===========================================================================

  // Initialize corps from Memory if cache is empty (after code push)
  // This is a no-op if corps are already in the global cache
  initCorps(corps);

  // Initialize or restore colony (needed for planning and persistence)
  colony = getOrCreateColony();

  // Initialize or restore flow economy (node navigator + flow solver)
  if (!nodeNavigator || !flowEconomy) {
    const result = getOrCreateFlowEconomy(colony);
    nodeNavigator = result.navigator;
    flowEconomy = result.economy;
  }

  // Make state available globally for debugging
  global.colony = colony;
  global.corps = corps;
  global.flowEconomy = flowEconomy;
  global.nodeNavigator = nodeNavigator;

  // ===========================================================================
  // PHASE 1: EXECUTE - Run all corps (every tick)
  // ===========================================================================

  // Track where our creeps walked on unpaved ground and paid move-fatigue a road
  // would have saved (execution/roadTracker -> RoomMemory.roadScores). A durable
  // statistical heatmap the road planner mines for where to pave; reads this
  // tick's engine-resolved creep positions, so run it before anything issues new
  // move intents.
  bulkhead("road-tracker", () => trackRoadUsage(Game.time));

  // Run spawning corps first (they process pending spawn orders)
  bulkhead("spawning-corps", () => runSpawningCorps(corps));

  // Run bootstrap corps. Everything else (mining, hauling, upgrading,
  // construction, scout, reservation, tender) runs through the commission host.
  bulkhead("bootstrap", () => runBootstrapCorps(corps));

  // Run all FRAMEWORK-commissioned corps: the solver-backed economy
  // (harvest/carry/upgrade, from the planner's commissions) plus the
  // auxiliaries (scout, reservation, tender).
  bulkhead("commissions", () => runCommissionHost(corps, flowEconomy?.getCommissions() ?? [], Game.time));

  // Safety net: re-adopt or recycle any creep no live corp claimed this tick.
  // A creep only acts if a corp scans it in by corpId; corps are demobilized
  // routinely (a re-solve dropping a source's commission deletes the corp while
  // its creeps live on), so without this an orphaned creep just freezes on its
  // tile until it dies. Runs AFTER every corp so it sees this tick's live set.
  bulkhead("orphans", () => rescueOrphans(corps));

  // Fire each room's source links at the core link (RCL 5+; no-op before links).
  bulkhead("links", () => runLinks());

  // Fire each room's towers at the closest hostile (RCL 3+; no-op before towers).
  bulkhead("towers", () => runTowers());

  // Snapshot budget-vs-actual variance so outlier corps (those straying furthest
  // below their commissioned throughput) surface in Memory.corpVariance.
  if (Game.time % 25 === 0) {
    snapshotCorpVariance(corps, Game.time);
  }

  // ===========================================================================
  // INCREMENTAL ANALYSIS - Continue if in progress (runs across multiple ticks)
  // ===========================================================================

  // Continue incremental analysis if one is in progress
  // This must happen OUTSIDE the planning phase check to spread across ticks
  if (isAnalysisInProgress()) {
    runIncrementalAnalysis(colony);
  }

  // Fine-grained spawn placement: sweep the top nodes' territories for the best
  // spawn tile, spread across ticks under a CPU budget (like the analysis above).
  // Kick a fresh sweep on the planning cadence once node ROI is available; the
  // results land in Memory.spawnPlacements for expansion/build planning to use.
  if (isSpawnPlacementInProgress()) {
    runSpawnPlacementStep();
  } else if (shouldRunPlanning(Game.time) && !isAnalysisInProgress()) {
    const cache = getAnalysisCache();
    if (cache && colony.getNodes().length > 0) {
      startSpawnPlacement(colony.getNodes(), cache.result.territories);
    }
  }

  // Fresh respawn detection: if no nodes exist and no analysis in progress,
  // start terrain analysis immediately (don't wait for planning interval)
  const hasNoNodes = colony.getNodes().length === 0 && (!Memory.nodes || Object.keys(Memory.nodes).length === 0);
  if (hasNoNodes && !isAnalysisInProgress()) {
    console.log(`[Respawn] No nodes in memory - starting terrain analysis immediately`);
    runIncrementalAnalysis(colony);
  }

  // After a GLOBAL RESET (frequent on a live server, never in a sim) the module
  // caches are wiped and only a territory-LESS visualization cache is restored,
  // which leaves refreshNodeResourcesFromCache below with no territories to claim
  // newly scouted sources from - so remote mining silently stops. If we have nodes
  // but the analysis cache has no real territories, force a fresh terrain pass to
  // rebuild them (it also re-claims resources from current vision/intel).
  const analysisCache = getAnalysisCache();
  const haveTerritories = !!analysisCache && analysisCache.result.territories.size > 0;
  if (!hasNoNodes && !haveTerritories && !isAnalysisInProgress()) {
    console.log(`[Respawn] Territory cache empty after reset - rebuilding for resource refresh`);
    resetAnalysis();
    runIncrementalAnalysis(colony);
  }

  // Keep node resources current with vision/intel between the (rare) full terrain
  // passes, so a source in a room only just scouted gets claimed by its node and
  // mined like any other - the terrain analysis itself runs at most every 5000
  // ticks, far too coarse for picking up newly discovered sources. Interval-gated
  // and cheap; a no-op until the first terrain pass has been cached.
  if (!isAnalysisInProgress()) {
    refreshNodeResourcesFromCache(colony);
  }

  // ===========================================================================
  // PHASE 2: PLANNING - Survey, Market, Plan
  // ===========================================================================
  //
  // Planning runs on a fixed cadence (every PLANNING_INTERVAL ticks) AND
  // eagerly during bootstrap: as soon as spatial analysis has produced nodes
  // but no harvest corps exist yet, materialize the economy immediately rather
  // than waiting for the first cadence tick. Without this, a fresh colony has
  // no miners/upgraders until tick PLANNING_INTERVAL and never bootstraps.

  const economyHasProducers = allCommissionedCorps().some(e => e.commissionShape === "produce");
  const economyNeedsBootstrap =
    colony.getNodes().length > 0 && !economyHasProducers && !isAnalysisInProgress() && Game.time % 10 === 0;

  // Re-solve the flow economy on a light cadence so it adapts to changes the
  // initial solve couldn't see: RCL-ups, new construction sites, etc. Without
  // this the economy stays frozen on its first solution (the expensive spatial
  // analysis inside is separately gated, so this only re-runs the cheap
  // rebuild+solve+materialize).
  // Cadence from the CPU governor: 50 at full operation, stretched when the
  // bucket falls (the heavy spatial analysis inside is separately gated).
  const economyNeedsResolve =
    colony.getNodes().length > 0 && !isAnalysisInProgress() && Game.time % gov.solveInterval === 0;

  if (shouldRunPlanning(Game.time) || economyNeedsBootstrap || economyNeedsResolve) {
    console.log(`[Planning] Starting planning phase at tick ${Game.time}`);

    // --- SURVEY: Analyze territory and create corps ---
    // Start incremental multi-room spatial analysis if no nodes exist
    if (colony.getNodes().length === 0 && !isAnalysisInProgress()) {
      runIncrementalAnalysis(colony);
    }

    // Run the colony economic coordination (surveying, stats)
    colony.run(Game.time, corps);

    // Expansion campaign (spec 06): open/advance/close Memory.expansion on the
    // planning cadence. When the target room is claimed this places the
    // founding spawn site; the flow solver's NEW_SPAWN_SITE_VALUE sink does
    // the actual funneling - no scripted campaign beyond this state machine.
    updateExpansionCampaign(colony.getNodes());

    // --- FLOW ECONOMY: Rebuild from Memory to pick up new nodes/edges ---
    const planningNodes = colony.getNodes();
    if (planningNodes.length > 0) {
      // Rebuild navigator and economy from current Memory state
      const edgeCount = (Memory.nodeEdges?.length || 0) + Object.keys(Memory.economicEdges || {}).length;
      console.log(`[FlowEconomy] Rebuilding with ${planningNodes.length} nodes, ${edgeCount} edges`);

      const rebuilt = buildFlowEconomyFromMemory(planningNodes);
      nodeNavigator = rebuilt.navigator;
      flowEconomy = rebuilt.economy;

      // Feed live construction sites into the flow as sinks so the solver can
      // allocate energy (and hauler routes) to them. After an RCL-up the
      // priority logic ranks construction above the controller, so the colony
      // builds new structures first and only minimally upgrades.
      addConstructionSitesToFlow(flowEconomy, planningNodes);

      // Update globals for debugging
      global.nodeNavigator = nodeNavigator;
      global.flowEconomy = flowEconomy;

      flowEconomy.update(Game.time); // Force update during planning

      // Log flow economy status
      const solution = flowEconomy.getSolution();
      if (solution) {
        console.log(`[FlowEconomy] Solved: ${solution.miners.length} miners, ${solution.haulers.length} haulers`);
        console.log(
          `[FlowEconomy] Efficiency: ${solution.efficiency.toFixed(1)}%, Sustainable: ${String(solution.isSustainable)}`
        );
        if (solution.warnings.length > 0) {
          console.log(`[FlowEconomy] Warnings: ${solution.warnings.join(", ")}`);
        }

        // Corps are materialized from the solve's commissions by CommissionHost
        // (every tick), so no separate materialize step is needed here.
        console.log(
          `[FlowEconomy] Solved: ${solution.miners.length} miners, ${solution.haulers.length} haulers, ${
            flowEconomy.getCommissions().length
          } commissions`
        );
      }
    }

    setLastPlanningTick(Game.time);
    console.log(`[Planning] Complete`);
  }

  // (The shadow EconomyPlanner overlay that used to re-size haulers here is
  // retired: CorpPlanner sizes each hauler to its full routed flow during the
  // solve, so the materialised assignments are already complete.)

  // Demand-driven spawn scheduling. Each corp declares what it wants via
  // getSpawnDemand(); the scheduler picks the single best creep to spawn per
  // spawn, balancing flow-derived value, affordability and anti-starvation.
  // Runs AFTER planning so materialized assignments/allocations are available.
  bulkhead("spawn-scheduling", () => runSpawnScheduling(corps));

  // ===========================================================================
  // PHASE 3: PERSIST - Save state and update telemetry (every tick)
  // ===========================================================================

  // Persist all state
  bulkhead("persist", () => persistState(colony!, corps, getAnalysisCache()));

  // Update telemetry (write to RawMemory segments for external monitoring).
  // Under governor degradation the heavy export is the FIRST thing shed;
  // the flight recorder always runs (it is how the shedding is observed).
  if (!gov.skipTelemetry) bulkhead("telemetry", () => updateTelemetry(colony!, corps));
  bulkhead("flight-recorder", () => runFlightRecorder());

  // Restore visualization cache from memory if needed (avoids expensive analysis)
  restoreVisualizationCache(colony);

  // Render node visualization
  renderNodeVisuals(colony);

  // Render spatial visualization (territories, edges) for rooms with visual* flags
  renderSpatialVisuals(getAnalysisCache());

  // Log stats periodically
  if (Game.time % 100 === 0) {
    logStats(colony, corps);
  }

  // The CPU ledger's infrastructure half + whole-tick reconciliation anchor.
  publishInfraCpu();
});

// =============================================================================
// COLONY MANAGEMENT
// =============================================================================

/**
 * Gets existing colony or creates a new one.
 *
 * Restores colony state from memory if available.
 */
function getOrCreateColony(): Colony {
  if (colony) {
    return colony;
  }

  const newColony = createColony();

  // Restore from memory if available
  if (Memory.colony) {
    newColony.deserialize(Memory.colony);
  }

  // Restore nodes from memory
  if (Memory.nodes) {
    for (const nodeId in Memory.nodes) {
      const serializedNode = Memory.nodes[nodeId] as SerializedNode;
      if (serializedNode && serializedNode.peakPosition) {
        const node = deserializeNode(serializedNode);
        newColony.addNode(node);
      }
    }
    console.log(`[Colony] Restored ${newColony.getNodes().length} nodes from memory`);
  }

  return newColony;
}

// =============================================================================
// FLOW ECONOMY MANAGEMENT
// =============================================================================

/**
 * Builds navigator and flow economy from current Memory state.
 *
 * This reads edges from Memory.nodeEdges (spatial) and Memory.economicEdges,
 * then creates fresh navigator and economy instances.
 *
 * @param nodes - Current colony nodes
 * @returns New navigator and economy instances
 */
/**
 * Feed the room's live construction sites into the flow economy as construction
 * sinks, each mapped to the nearest node in its room. This makes construction a
 * first-class consumer in the flow solve (with hauler routes), so the local
 * mover delivers energy to builders per the solver's allocation.
 */
function addConstructionSitesToFlow(economy: FlowEconomy, nodes: Node[]): void {
  // PROJECT LEDGER admission (owner 2026-07-22: "construction sites should
  // be part of the corps memory so it can rehydrate and bypass Vision") -
  // the sink set comes from the construction corps' durable ledger, NOT a
  // Game.rooms scan. The scan was the measured cluster flap (t72489078:
  // 15 sinks -> 0 across two captures, the solve keyed to which room
  // happened to be sighted). Vision reconciles the ledger
  // (ConstructionCorp.reconcileProjects); decisions read it here. Spec 25's
  // admission rule is unchanged (any of OUR sites, per-site capacity
  // pool-absorb/cluster bounded in the adapter) - only the data source
  // moved from eyesight to the ledger.
  // TRUNK A/Z AGGREGATION (owner 2026-07-22): collapse each trunk road's
  // per-tile sites into TWO aggregate sinks - Z (source end, the source's
  // builder+hauler) and A (home end, the pool crew) - split proportional to
  // energy flow. A 20-tile trunk was 20 sinks -> 20 micro hauler-edges from
  // one source (t72505602: P2 34/44, P4 +18%); now it is 2 sinks -> one
  // source->Z edge and one home A project. Non-trunk construction
  // (extensions, containers, in-room roads) passes through per-site.
  const graph = economy.getFlowGraph();
  const routes = collectTrunkRoutes(id => graph.getSource(`source-${id}`)?.capacity);
  const admitted = aggregateTrunkRoadSinks(constructionProjectLedger(), routes, homeBankSupply());

  for (const rec of admitted) {
    const roomName = rec.roomName;
    // A room with no analyzed nodes yet (a freshly claimed founding, or a
    // remote road room) still needs its sites in the graph (spec 06 audit) -
    // anchor on the nearest node by room distance until the room's own
    // analysis lands. The anchor only shapes graph topology; haul pricing
    // uses the site's real position either way.
    let roomNodes = nodes.filter(n => n.roomName === roomName);
    if (roomNodes.length === 0) {
      let nearest: Node | undefined;
      let nearestDist = Infinity;
      for (const node of nodes) {
        const d = Game.map.getRoomLinearDistance(node.roomName, roomName);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = node;
        }
      }
      if (nearest) roomNodes = [nearest];
    }
    if (roomNodes.length === 0) continue;

    // Map the site to the nearest node in the same room.
    let best: Node | undefined;
    let bestDist = Infinity;
    for (const node of roomNodes) {
      const dx = node.peakPosition.x - rec.x;
      const dy = node.peakPosition.y - rec.y;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    if (!best) continue;

    economy.addConstructionSite(rec.id, best.id, { x: rec.x, y: rec.y, roomName }, rec.remaining);
  }
}

function buildFlowEconomyFromMemory(nodes: Node[]): {
  navigator: NodeNavigator;
  economy: FlowEconomy;
} {
  // Build edge weights and types from persisted data
  const edgeWeights = new Map<string, number>();
  const edgeTypes = new Map<string, EdgeType>();
  const allEdges: string[] = [];

  // Add spatial edges with their walking distances
  if (Memory.nodeEdges) {
    for (const edgeKey of Memory.nodeEdges) {
      allEdges.push(edgeKey);
      // Use persisted walking distance, or default to 50 (one room) if not available
      const weight = Memory.spatialEdgeWeights?.[edgeKey] ?? 50;
      edgeWeights.set(edgeKey, weight);
      edgeTypes.set(edgeKey, "spatial");
    }
  }

  // Add economic edges with persisted weights
  if (Memory.economicEdges) {
    for (const edgeKey in Memory.economicEdges) {
      if (!allEdges.includes(edgeKey)) {
        allEdges.push(edgeKey);
      }
      const weight = Memory.economicEdges[edgeKey];
      edgeWeights.set(edgeKey, weight);
      edgeTypes.set(edgeKey, "economic");
    }
  }

  // Create navigator and economy
  const navigator = createNodeNavigator(nodes, allEdges, edgeWeights, edgeTypes);
  const economy = new FlowEconomy(nodes, navigator);

  return { navigator, economy };
}

/**
 * Creates or restores the flow economy from persisted edges.
 *
 * The flow economy requires:
 * 1. NodeNavigator - for pathfinding between nodes
 * 2. FlowEconomy - for solving optimal energy allocation
 *
 * Edges are restored from Memory.nodeEdges (spatial) and Memory.economicEdges.
 */
function getOrCreateFlowEconomy(activeColony: Colony): {
  navigator: NodeNavigator;
  economy: FlowEconomy;
} {
  const nodes = activeColony.getNodes();
  const { navigator, economy } = buildFlowEconomyFromMemory(nodes);

  if (nodes.length > 0) {
    const edgeCount = (Memory.nodeEdges?.length || 0) + Object.keys(Memory.economicEdges || {}).length;
    console.log(`[FlowEconomy] Created with ${nodes.length} nodes, ${edgeCount} edges`);
    console.log(
      `[FlowEconomy] Sources: ${economy.getFlowGraph().getSources().length}, Sinks: ${
        economy.getFlowGraph().getSinks().length
      }`
    );

    // Run initial solve if we have sources (don't wait for planning cycle)
    if (economy.getFlowGraph().getSources().length > 0) {
      economy.update(Game.time);

      // Corps come from the solve's commissions via CommissionHost; no separate
      // materialize step.
      const solution = economy.getSolution();
      if (solution) {
        console.log(
          `[FlowEconomy] Initial solve: ${solution.miners.length} miners, ${solution.haulers.length} haulers`
        );
      }
    }
  }

  return { navigator, economy };
}

// =============================================================================
// TELEMETRY & STATS
// =============================================================================

/**
 * Updates telemetry data in RawMemory segments for external monitoring.
 */
function updateTelemetry(activeColony: Colony, activeCorps: CorpRegistry): void {
  const telemetry = getTelemetry();
  // The complete corp census (store + legacy registry kinds), folded in ONE
  // place - completeCensus - so no consumer maintains its own append.
  telemetry.update(activeColony, completeCensus(activeCorps), flowEconomy?.getSolution() ?? undefined);
}

/**
 * The flight recorder's periodic duties (spec 09 phase 4): watch sample,
 * watchdog evaluation (rules in telemetry/watchdogs, unit-tested; the
 * dashboard only displays), and the segment flush. Runs EVERY tick, even
 * under full governor degradation - it is how the shedding is observed.
 */
function runFlightRecorder(): void {
  let alerts: ReturnType<typeof runWatchdogs> = [];
  if (Game.time % 10 === 0) {
    let minDowngrade: number | null = null;
    let maxRcl = 0;
    for (const roomName in Game.rooms) {
      const c = Game.rooms[roomName].controller;
      if (!c?.my) continue;
      if (minDowngrade === null || c.ticksToDowngrade < minDowngrade) minDowngrade = c.ticksToDowngrade;
      if (c.level > maxRcl) maxRcl = c.level;
    }
    blackBoxRecord("watch", {
      dt: minDowngrade,
      bucket: Game.cpu.bucket,
      cpu: Math.round(Game.cpu.getUsed() * 10) / 10,
      creeps: Object.keys(Game.creeps).length
    });
    alerts = runWatchdogs({
      tick: Game.time,
      rcl: maxRcl,
      lastSpawnTick: lastSpawnTick(),
      minDowngradeTicks: minDowngrade,
      bucket: Game.cpu.bucket,
      errRowsInWindow: errRowCount()
    });
    for (const a of alerts) console.log(`[WATCHDOG] ${a.kind}: ${a.message}`);
  }
  blackBoxFlush(Game.time, alerts);
}

/**
 * Logs statistics for monitoring.
 */
function logStats(activeColony: Colony, activeCorps: CorpRegistry): void {
  const stats = activeColony.getStats();

  console.log(`[Colony] Tick ${Game.time}`);
  console.log(`  Nodes: ${stats.nodeCount}, Corps: ${stats.totalCorps} (${stats.activeCorps} active)`);

  logCorpStats(activeCorps);
}

// =============================================================================
// CONSOLE COMMANDS
// =============================================================================

// -----------------------------------------------------------------------------
// ORCHESTRATION COMMANDS
// -----------------------------------------------------------------------------


/**
 * Force run flow economy planning phase.
 * Call from console: `global.plan()`
 *
 * Planning:
 * 1. Rebuilds flow graph from nodes if needed
 * 2. Solves optimal energy allocation (sources -> sinks)
 * 3. Materializes solution into corps (miners, haulers, upgraders)
 */
global.plan = () => {
  if (!colony) {
    console.log("[Planning] No colony exists. Run global.recalculateTerrain() first.");
    return;
  }

  console.log(`[Planning] Running planning phase at tick ${Game.time}...`);

  // --- FLOW ECONOMY: Rebuild from Memory to pick up new nodes/edges ---
  const nodes = colony.getNodes();
  if (nodes.length > 0) {
    // Rebuild navigator and economy from current Memory state
    // This picks up any new nodes, sources, or edges from scouting
    const edgeCount = (Memory.nodeEdges?.length || 0) + Object.keys(Memory.economicEdges || {}).length;
    console.log(`[FlowEconomy] Rebuilding with ${nodes.length} nodes, ${edgeCount} edges`);

    const rebuilt = buildFlowEconomyFromMemory(nodes);
    nodeNavigator = rebuilt.navigator;
    flowEconomy = rebuilt.economy;

    // Update globals for debugging
    global.nodeNavigator = nodeNavigator;
    global.flowEconomy = flowEconomy;

    flowEconomy.update(Game.time); // Force update

    // Get solution and show results
    const solution = flowEconomy.getSolution();
    if (solution) {
      console.log(`\n=== Flow Economy Results ===`);
      console.log(`Miners: ${solution.miners.length}`);
      console.log(`Haulers: ${solution.haulers.length}`);
      console.log(`Total Harvest: ${solution.totalHarvest.toFixed(2)} energy/tick`);
      console.log(`Net Energy: ${solution.netEnergy.toFixed(2)} energy/tick`);
      console.log(`Efficiency: ${solution.efficiency.toFixed(1)}%`);
      console.log(`Sustainable: ${solution.isSustainable ? "YES" : "NO"}`);

      if (solution.warnings.length > 0) {
        console.log(`Warnings: ${solution.warnings.join(", ")}`);
      }

      // Corps are materialized from the commissions by CommissionHost.
      console.log(`\nCommissions: ${flowEconomy.getCommissions().length}`);
    } else {
      console.log(`[FlowEconomy] No solution computed`);
    }
  } else if (!flowEconomy) {
    console.log(`[FlowEconomy] Not initialized`);
  } else {
    console.log(`[FlowEconomy] No nodes available`);
  }

  setLastPlanningTick(Game.time);
};

/**
 * Show orchestration status.
 * Call from console: `global.status()`
 *
 * Shows:
 * - Last survey/planning tick
 * - Active chains and contracts
 * - Corp counts by type
 */
/**
 * Set the colony's GOAL (spec 18): a named profile, optionally blended with
 * the default. `global.setGoal()` reverts to the default profile;
 * `global.setGoal("growController")` commits fully;
 * `global.setGoal("growController", 0.7)` blends 70/30 with the default.
 * Compiled onto the sink ladder next solve (invariants enforced - a bad
 * profile name is ignored by the compiler and default applies).
 */
global.setGoal = (profile?: string, weight?: number) => {
  if (!profile) {
    delete Memory.goal;
    console.log("[Goal] reverted to the default profile");
    return;
  }
  const w = weight === undefined ? 1 : Math.max(0, Math.min(1, weight));
  Memory.goal = w >= 1 ? { blend: { [profile]: 1 } } : { blend: { [profile]: w, default: 1 - w } };
  console.log(`[Goal] set: ${JSON.stringify(Memory.goal.blend)}`);
};

global.status = () => {
  console.log("\n=== Orchestration Status ===");
  console.log(`Current tick: ${Game.time}`);
  console.log(`Last survey: ${Memory.lastSurveyTick ?? "never"}`);
  console.log(`Last planning: ${Memory.lastPlanningTick ?? "never"}`);
  console.log(`Next planning: tick ${Math.ceil(Game.time / PLANNING_INTERVAL) * PLANNING_INTERVAL}`);

  console.log("\n=== Corps ===");
  const corpCountByKind: { [kind: string]: number } = {};
  for (const { kind } of completeCensus(corps)) corpCountByKind[kind] = (corpCountByKind[kind] ?? 0) + 1;
  for (const kind of Object.keys(corpCountByKind).sort()) {
    console.log(`${kind}: ${corpCountByKind[kind]}`);
  }

  if (colony) {
    console.log("\n=== Colony ===");
    console.log(`Nodes: ${colony.getNodes().length}`);
  }
};

/**
 * Show flow economy status.
 * Call from console: `global.flowStatus()`
 *
 * Shows:
 * - Flow graph summary (sources, sinks, edges)
 * - Current solution allocations
 * - Efficiency and sustainability metrics
 * - Miner and hauler assignments
 */
global.flowStatus = () => {
  if (!flowEconomy) {
    console.log("[FlowEconomy] Not initialized. Colony may have no nodes yet.");
    return;
  }

  const graph = flowEconomy.getFlowGraph();
  const solution = flowEconomy.getSolution();

  console.log("\n=== Flow Economy Status ===");
  console.log(`Sources: ${graph.getSources().length}`);
  console.log(`Sinks: ${graph.getSinks().length}`);
  console.log(`Edges: ${graph.getEdges().length}`);

  if (!solution) {
    console.log("\nNo solution computed yet. Run global.plan() to trigger solve.");
    return;
  }

  console.log("\n=== Solution Metrics ===");
  console.log(`Total Harvest: ${solution.totalHarvest.toFixed(2)} energy/tick`);
  console.log(`Mining Overhead: ${solution.miningOverhead.toFixed(2)} energy/tick`);
  console.log(`Hauling Overhead: ${solution.haulingOverhead.toFixed(2)} energy/tick`);
  console.log(`Net Energy: ${solution.netEnergy.toFixed(2)} energy/tick`);
  console.log(`Efficiency: ${solution.efficiency.toFixed(1)}%`);
  console.log(`Sustainable: ${solution.isSustainable ? "YES" : "NO"}`);

  console.log("\n=== Miner Assignments ===");
  for (const miner of solution.miners.slice(0, 5)) {
    console.log(`  ${miner.sourceId.slice(-8)}: spawn=${miner.spawnId.slice(-8)}, dist=${miner.spawnDistance}`);
  }
  if (solution.miners.length > 5) {
    console.log(`  ... and ${solution.miners.length - 5} more miners`);
  }

  console.log("\n=== Hauler Assignments ===");
  for (const hauler of solution.haulers.slice(0, 5)) {
    console.log(
      `  ${hauler.fromId.slice(-8)} -> ${hauler.toId.slice(-8)}: ${hauler.carryParts} CARRY, ${hauler.flowRate.toFixed(
        2
      )} e/tick`
    );
  }
  if (solution.haulers.length > 5) {
    console.log(`  ... and ${solution.haulers.length - 5} more haulers`);
  }

  console.log("\n=== Sink Allocations (by priority) ===");
  const allocations = solution.sinkAllocations.sort((a, b) => b.priority - a.priority);
  for (const alloc of allocations.slice(0, 10)) {
    const pct = alloc.demand > 0 ? ((alloc.allocated / alloc.demand) * 100).toFixed(0) : "N/A";
    console.log(
      `  ${alloc.sinkType}[${alloc.sinkId.slice(-8)}]: ${alloc.allocated.toFixed(1)}/${alloc.demand.toFixed(
        1
      )} (${pct}%) pri=${alloc.priority}`
    );
  }
  if (allocations.length > 10) {
    console.log(`  ... and ${allocations.length - 10} more sinks`);
  }

  if (solution.warnings.length > 0) {
    console.log("\n=== Warnings ===");
    for (const warning of solution.warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }

  // Show unmet demand if any
  if (solution.unmetDemand.size > 0) {
    console.log("\n=== Unmet Demand ===");
    for (const [sinkId, unmet] of solution.unmetDemand) {
      console.log(`  ${sinkId.slice(-12)}: ${unmet.toFixed(2)} energy/tick unmet`);
    }
  }
};

// -----------------------------------------------------------------------------
// LEGACY COMMANDS
// -----------------------------------------------------------------------------

/**
 * Force recalculation of multi-room spatial analysis.
 * Call from console: `global.recalculateTerrain()`
 *
 * This triggers an incremental analysis that spreads work across multiple ticks.
 */
global.recalculateTerrain = () => {
  resetAnalysis();

  if (colony) {
    console.log(`[MultiRoom] Triggering incremental recalculation (will spread across multiple ticks)...`);
    // Start the incremental analysis - it will continue on subsequent ticks
    runIncrementalAnalysis(colony);
  } else {
    console.log("[MultiRoom] Cache cleared - will recalculate when colony exists");
  }
};

/**
 * Reset analysis cache without triggering recalculation.
 * Call from console: `global.resetAnalysis()`
 */
global.resetAnalysis = () => {
  resetAnalysis();
  console.log("[Analysis] Cache cleared. Will recalculate on next tick.");
};

/**
 * Show node summary with ROI scores based on potential corps.
 * Call from console: `global.showNodes()`
 */
global.showNodes = () => {
  if (!colony) {
    console.log("[Nodes] No colony exists yet");
    return;
  }

  const nodes = colony.getNodes();
  if (nodes.length === 0) {
    console.log("[Nodes] No nodes found. Run global.recalculateTerrain() first.");
    return;
  }

  // Sort by ROI score descending
  const sortedNodes = [...nodes].sort((a, b) => (b.roi?.score ?? 0) - (a.roi?.score ?? 0));

  console.log(`\n=== Colony Nodes (${nodes.length} total) ===`);
  console.log("Sorted by ROI score (based on potential corps value)\n");

  for (const node of sortedNodes) {
    const roi = node.roi;
    if (roi) {
      const corpSummary =
        roi.potentialCorps.length > 0
          ? roi.potentialCorps.map(c => `${c.type}(${c.estimatedROI.toFixed(2)})`).join(", ")
          : "none";
      const distStr = roi.distanceFromOwned === Infinity ? "∞" : roi.distanceFromOwned.toString();

      console.log(`${node.id} [${roi.isOwned ? "OWNED" : `dist=${distStr}`}]`);
      console.log(
        `  Score: ${roi.score.toFixed(1)} | Raw Corp ROI: ${roi.rawCorpROI.toFixed(2)} | Openness: ${roi.openness}`
      );
      console.log(`  Resources: ${roi.sourceCount} sources, ${roi.hasController ? "has controller" : "no controller"}`);
      console.log(`  Potential Corps: ${corpSummary}`);
    } else {
      console.log(`${node.id} | (no ROI data)`);
    }
  }

  // Show top expansion targets
  console.log("\n=== Top Expansion Targets ===");
  const expansionTargets = sortedNodes.filter(n => !n.roi?.isOwned && (n.roi?.score ?? 0) > 0);
  if (expansionTargets.length === 0) {
    console.log("No viable expansion targets found.");
  } else {
    for (const node of expansionTargets.slice(0, 5)) {
      const roi = node.roi!;
      const distStr = roi.distanceFromOwned === Infinity ? "∞" : roi.distanceFromOwned.toString();
      console.log(`  ${node.id}: score=${roi.score.toFixed(1)}, corps=${roi.potentialCorps.length}, dist=${distStr}`);
    }
  }
};

/**
 * Export node graph as JSON for external analysis.
 * Call from console: `global.exportNodes()`
 */
global.exportNodes = (): string => {
  if (!colony) {
    console.log("[Export] No colony exists yet");
    return "{}";
  }

  const nodes = colony.getNodes();

  // Build export structure
  const exportData = {
    exportedAt: Game.time,
    nodeCount: nodes.length,
    nodes: nodes.map(node => ({
      id: node.id,
      roomName: node.roomName,
      peakPosition: node.peakPosition,
      territorySize: node.territorySize,
      resources: node.resources.map(r => ({
        type: r.type,
        id: r.id,
        position: r.position,
        capacity: r.capacity,
        mineralType: r.mineralType
      })),
      roi: node.roi,
      spansRooms: node.spansRooms
    })),
    // Summary stats
    summary: {
      totalSources: nodes.reduce((sum, n) => sum + (n.roi?.sourceCount ?? 0), 0),
      ownedNodes: nodes.filter(n => n.roi?.isOwned).length,
      expansionCandidates: nodes.filter(n => !n.roi?.isOwned && (n.roi?.score ?? 0) > 0).length,
      avgROI: nodes.length > 0 ? nodes.reduce((sum, n) => sum + (n.roi?.score ?? 0), 0) / nodes.length : 0
    }
  };

  const json = JSON.stringify(exportData, null, 2);
  console.log(`[Export] Exported ${nodes.length} nodes. Copy from console or use: JSON.parse(global.exportNodes())`);
  console.log(json);
  return json;
};

/**
 * Clear all pending spawn requests.
 * Use this to recover from a deadlocked spawn queue.
 * Call from console: `global.clearSpawnQueue()`
 */
global.clearSpawnQueue = () => {
  let totalCleared = 0;

  for (const id in corps.spawningCorps) {
    const spawningCorp = corps.spawningCorps[id];
    const cleared = spawningCorp.clearPendingOrders();
    totalCleared += cleared;
    if (cleared > 0) {
      console.log(`[GodMode] Cleared ${cleared} orders from ${spawningCorp.id}`);
    }
  }

  console.log(`[GodMode] Cleared ${totalCleared} total pending spawn orders`);
};

/**
 * Show the empirical road-usage heatmap: the tiles where our creeps walked on
 * unpaved ground and paid move-fatigue a road would have saved, ranked hottest
 * first. Paints a RoomVisual heat overlay when the room is visible.
 * Call from console: `global.roadHeatmap()` (all owned rooms) or
 * `global.roadHeatmap("W1N1")`.
 */
global.roadHeatmap = (roomName?: string) => {
  const names = roomName
    ? [roomName]
    : Object.keys(Memory.rooms ?? {}).filter(r => Memory.rooms?.[r]?.roadScores);
  if (names.length === 0) {
    console.log("[roadScores] No road-usage data yet.");
    return;
  }
  for (const name of names) console.log(renderRoadScores(name));
};
