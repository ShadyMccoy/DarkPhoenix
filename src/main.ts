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
 * Registered once at module load via execution/console.ts (spec 35 phase G):
 * - global.plan() - Force run THE planning phase (same path as the cadence)
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
  createCorpRegistry,
  getAnalysisCache,
  isAnalysisInProgress,
  isSpawnPlacementInProgress,
  logCorpStats,
  persistState,
  refreshNodeResourcesFromCache,
  sampleMarketPrices,
  renderNodeVisuals,
  renderSpatialVisuals,
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
import { registerConsoleCommands } from "./execution/console";
import { assembleEconomyForSolve } from "./economy/planningAssembly";
import { SerializedNode, deserializeNode } from "./nodes";
import { FlowEconomy } from "./economy/flowAdapter";
import { initCorps, setLastPlanningTick, shouldRunPlanning } from "./orchestration";
import { ErrorMapper } from "./utils";
import { getTelemetry } from "./telemetry";
import { disjointInfra } from "./telemetry/cpuReport";
import { stashCompletedLedger } from "./telemetry/cpuLedgerCache";
import { errRowCount, flush as blackBoxFlush, lastSpawnTick, record as blackBoxRecord } from "./telemetry/BlackBox";
import { GovernorPlan, runGovernor } from "./execution/CpuGovernor";
import { runWatchdogs } from "./telemetry/watchdogs";

// =============================================================================
// GLOBALS
// =============================================================================
// The NodeJS.Global augmentation (global.plan/status/... typings) lives with
// the commands in execution/console.ts (spec 35 phase G).

/** The colony instance (persisted across ticks) */
let colony: Colony | undefined;

/** Flow economy coordinator (replaces market-based allocation) */
let flowEconomy: FlowEconomy | undefined;

/** All active corps */
const corps: CorpRegistry = createCorpRegistry();

// Live console commands (global.plan/status/flowStatus/...): registered once at
// module load - exactly when the old inline block used to assign them - with
// accessors into this module's live state (colony/flowEconomy are REPLACED
// across ticks, so the console must read through getters). Spec 35 phase G
// moved the command bodies to execution/console.ts; main.ts keeps this wiring.
registerConsoleCommands({
  getColony: () => colony,
  getFlowEconomy: () => flowEconomy,
  corps,
  runPlanningPhase: force => runPlanningPhase(force)
});

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
    // DISJOINT the reconciliation: the "commissions" bulkhead wraps
    // runCommissionedCorps, so its raw time INCLUDES every corp's execution -
    // the very same CPU reported as corpsTotal. Left in, corps is counted twice
    // and the residual whole - corps - infra goes negative on lean ticks.
    ledger.infra = disjointInfra(rounded, ledger.corpsTotal);
    ledger.wholeTick = Number(Game.cpu.getUsed().toFixed(3));
    // The ledger is now COMPLETE (corps + infra + wholeTick). Stash it for next
    // tick's telemetry - the core segment was already serialized earlier this
    // tick (before infra/wholeTick existed), so shipping Memory.corpCpu inline
    // only ever captured the half-built version. See cpuLedgerCache.
    stashCompletedLedger(ledger);
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

  // Initialize or restore flow economy (flow solver)
  if (!flowEconomy) {
    flowEconomy = getOrCreateFlowEconomy(colony);
  }

  // Make state available globally for debugging
  global.colony = colony;
  global.corps = corps;
  global.flowEconomy = flowEconomy;

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
    bulkhead("corp-variance", () => snapshotCorpVariance(corps, Game.time));
  }

  // Cache a live market price snapshot for the mineral EV estimate (spec 22).
  // Self-throttled to MARKET_SAMPLE_INTERVAL; the % gate just skips the Memory
  // peek most ticks. No-op without a live terminal/market (falls back to the
  // static snapshot in economy/mineralValue).
  if (Game.time % 100 === 0) {
    bulkhead("market-sample", () => sampleMarketPrices(Game.time));
  }

  // ===========================================================================
  // INCREMENTAL ANALYSIS - Continue if in progress (runs across multiple ticks)
  // ===========================================================================

  // Terrain analysis + spawn placement + respawn detection: heavy, spread across
  // ticks under a CPU budget, previously all unnamed. One bucket so the ledger
  // attributes it (spec 20: name the residual) and it survives its own throws.
  bulkhead("analysis", () => {
    // Continue incremental analysis if one is in progress
    // This must happen OUTSIDE the planning phase check to spread across ticks
    if (isAnalysisInProgress()) {
      runIncrementalAnalysis(colony!);
    }

    // Fine-grained spawn placement: sweep the top nodes' territories for the best
    // spawn tile, spread across ticks under a CPU budget (like the analysis above).
    // Kick a fresh sweep on the planning cadence once node ROI is available; the
    // results land in Memory.spawnPlacements for expansion/build planning to use.
    if (isSpawnPlacementInProgress()) {
      runSpawnPlacementStep();
    } else if (shouldRunPlanning(Game.time) && !isAnalysisInProgress()) {
      const cache = getAnalysisCache();
      if (cache && colony!.getNodes().length > 0) {
        startSpawnPlacement(colony!.getNodes(), cache.result.territories);
      }
    }

    // Fresh respawn detection: if no nodes exist and no analysis in progress,
    // start terrain analysis immediately (don't wait for planning interval)
    const hasNoNodes = colony!.getNodes().length === 0 && (!Memory.nodes || Object.keys(Memory.nodes).length === 0);
    if (hasNoNodes && !isAnalysisInProgress()) {
      console.log(`[Respawn] No nodes in memory - starting terrain analysis immediately`);
      runIncrementalAnalysis(colony!);
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
      runIncrementalAnalysis(colony!);
    }
  });

  // Keep node resources current with vision/intel between the (rare) full terrain
  // passes, so a source in a room only just scouted gets claimed by its node and
  // mined like any other - the terrain analysis itself runs at most every 5000
  // ticks, far too coarse for picking up newly discovered sources. Interval-gated
  // and cheap; a no-op until the first terrain pass has been cached.
  if (!isAnalysisInProgress()) {
    bulkhead("resource-refresh", () => refreshNodeResourcesFromCache(colony!));
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
    // The planning + flow-solve block: the periodic re-solve is the tick's
    // heaviest work when it runs, and it was entirely unnamed. Bucket it so the
    // ledger shows the solve's cost (spec 20) and one bad solve can't abort the
    // rest of the tick (persist/telemetry still run).
    bulkhead("planning", () => runPlanningPhase(false));
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

  // Visualization. The cache restore is LOAD-BEARING (despite the name): it
  // rehydrates multiRoomAnalysisCache after a global reset, which persist and
  // planning read via getAnalysisCache() - so it always runs (cheap: it
  // early-returns when the cache is warm). The node/spatial OVERLAYS, by
  // contrast, were ~35 CPU/tick for ~480 nodes (measured) drawing pixels nobody
  // sees unless the client is open on the room - so gate them behind
  // Memory.visuals (default off; flip on from the console via global.visuals()).
  bulkhead("visuals", () => {
    restoreVisualizationCache(colony!);
    if (Memory.visuals) {
      renderNodeVisuals(colony!);
      renderSpatialVisuals(getAnalysisCache());
    }
  });

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
// PLANNING PHASE
// =============================================================================

/**
 * THE planning phase - ONE function for both the scheduled cadence and the
 * console-forced path (spec 35 phase G): survey kick, colony coordination,
 * expansion campaign, then the solve-input assembly (economy rebuild ->
 * construction-sink admission -> solve -> commission publish, via
 * economy/planningAssembly's assembleEconomyForSolve) and the planning-tick
 * persist. The CALLER owns the cadence - the CPU governor's solve interval
 * and the bootstrap eager-solve gate stay in the loop - so this always plans
 * when invoked. `force` only labels the log header.
 *
 * THE ONE SANCTIONED BEHAVIOR CHANGE of the phase-G refactor
 * (docs/specs/35-strategic-seam-refactor.md, phase G): before this
 * unification, global.plan() duplicated the rebuild+solve WITHOUT
 * construction-sink admission - a console-forced plan solved with ZERO
 * construction sinks and published a plan that zeroed construction
 * colony-wide until the next scheduled solve. Both paths now run the SAME
 * assembleEconomyForSolve seam (admission included) - pinned by
 * test/unit/economy/planningAssembly.test.ts.
 */
function runPlanningPhase(force: boolean): void {
  console.log(
    force
      ? `[Planning] Running planning phase at tick ${Game.time}...`
      : `[Planning] Starting planning phase at tick ${Game.time}`
  );

  // --- SURVEY: Analyze territory and create corps ---
  // Start incremental multi-room spatial analysis if no nodes exist
  if (colony!.getNodes().length === 0 && !isAnalysisInProgress()) {
    runIncrementalAnalysis(colony!);
  }

  // Run the colony economic coordination (surveying, stats)
  colony!.run(Game.time, corps);

  // Expansion campaign (spec 06): open/advance/close Memory.expansion on the
  // planning cadence. When the target room is claimed this places the
  // founding spawn site; the flow solver's NEW_SPAWN_SITE_VALUE sink does
  // the actual funneling - no scripted campaign beyond this state machine.
  updateExpansionCampaign(colony!.getNodes());

  // --- FLOW ECONOMY: Rebuild from Memory to pick up new nodes/edges ---
  const planningNodes = colony!.getNodes();
  if (planningNodes.length > 0) {
    // Rebuild economy from current Memory state
    const edgeCount = Memory.nodeEdges?.length || 0;
    console.log(`[FlowEconomy] Rebuilding with ${planningNodes.length} nodes, ${edgeCount} edges`);

    // Rebuild -> construction-sink admission -> solve, through the ONE
    // adapter-side assembly seam (economy/planningAssembly).
    flowEconomy = assembleEconomyForSolve(planningNodes, Game.time);

    // Update globals for debugging
    global.flowEconomy = flowEconomy;

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

// =============================================================================
// FLOW ECONOMY MANAGEMENT
// =============================================================================

/**
 * Creates or restores the flow economy (source/sink discovery + solve driver)
 * from the colony's nodes.
 */
function getOrCreateFlowEconomy(activeColony: Colony): FlowEconomy {
  const nodes = activeColony.getNodes();
  const economy = new FlowEconomy(nodes);

  if (nodes.length > 0) {
    const edgeCount = Memory.nodeEdges?.length || 0;
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

  return economy;
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

