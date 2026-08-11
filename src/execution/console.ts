/**
 * @fileoverview The live console (`global.*` commands) — operator I/O only.
 *
 * Spec 35 phase G moved the command block out of main.ts: the commands'
 * behavior is unchanged, they just live in a module whose charter is the live
 * console. main.ts calls {@link registerConsoleCommands} once at module load,
 * handing over accessors into its live state (colony / flowEconomy are
 * REPLACED across ticks, so the console reads through getters, never through
 * captured references) plus THE planning phase entry point.
 *
 * @module execution/console
 */

import "../types/Memory";
import { Colony } from "../colony";
import { CorpRegistry } from "./CorpRunner";
import { armSpawnContractBypass } from "../corps/spawnContract";
import { FlowEconomy } from "../economy/flowAdapter";
import { completeCensus } from "./CommissionHost";
import { resetAnalysis, runIncrementalAnalysis } from "./IncrementalAnalysis";
import { renderRoadScores } from "./roadTracker";
import { formatCpuReport } from "../telemetry/cpuReport";
import { PLANNING_INTERVAL } from "../orchestration";

// =============================================================================
// GLOBALS
// =============================================================================

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- augmenting NodeJS.Global has no ES-module equivalent
  namespace NodeJS {
    interface Global {
      colony: Colony | undefined;
      corps: CorpRegistry;
      // Flow economy (new integration)
      flowEconomy: FlowEconomy | undefined;
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
      roadHeatmap: (roomName?: string) => void;
      cpuReport: () => void;
      visuals: (on?: boolean) => void;
      spawnContractBypass: (calls?: number) => void;
    }
  }
}

/**
 * main.ts's live state, read through accessors: the colony and flow economy
 * instances are replaced across ticks/planning passes, so the console must
 * never capture them directly.
 */
export interface ConsoleDeps {
  /** The colony instance (undefined until the first loop initializes it). */
  getColony: () => Colony | undefined;
  /** The flow economy driver (rebuilt on every planning pass). */
  getFlowEconomy: () => FlowEconomy | undefined;
  /** The corp registry (one instance for the process lifetime). */
  corps: CorpRegistry;
  /**
   * THE planning phase (main.ts `runPlanningPhase`). `force=true` runs the
   * same rebuild -> construction-sink admission -> solve -> commission-publish
   * sequence as the scheduled cadence — the spec 35 phase G fix (the old
   * console-forced plan skipped sink admission and zeroed construction
   * colony-wide until the next scheduled solve).
   */
  runPlanningPhase: (force: boolean) => void;
}

/**
 * Register every `global.*` console command. Called once from main.ts at
 * module load (exactly when the old inline block used to assign them).
 */
export function registerConsoleCommands(deps: ConsoleDeps): void {
  // ---------------------------------------------------------------------------
  // ORCHESTRATION COMMANDS
  // ---------------------------------------------------------------------------

  /**
   * Force run flow economy planning phase.
   * Call from console: `global.plan()`
   *
   * Runs THE planning phase (main.ts `runPlanningPhase`) with force=true —
   * the same economy rebuild, construction-sink admission, solve and
   * commission publish as the scheduled cadence — then prints the results.
   */
  global.plan = () => {
    const colony = deps.getColony();
    if (!colony) {
      console.log("[Planning] No colony exists. Run global.recalculateTerrain() first.");
      return;
    }

    deps.runPlanningPhase(true);

    const flowEconomy = deps.getFlowEconomy();
    const nodes = colony.getNodes();
    if (nodes.length > 0) {
      const solution = flowEconomy?.getSolution();
      if (solution && flowEconomy) {
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
  };

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

  /**
   * Show orchestration status.
   * Call from console: `global.status()`
   *
   * Shows:
   * - Last survey/planning tick
   * - Active chains and contracts
   * - Corp counts by type
   */
  global.status = () => {
    console.log("\n=== Orchestration Status ===");
    console.log(`Current tick: ${Game.time}`);
    console.log(`Last planning: ${Memory.lastPlanningTick ?? "never"}`);
    console.log(`Next planning: tick ${Math.ceil(Game.time / PLANNING_INTERVAL) * PLANNING_INTERVAL}`);

    console.log("\n=== Corps ===");
    const corpCountByKind: { [kind: string]: number } = {};
    for (const { kind } of completeCensus(deps.corps)) corpCountByKind[kind] = (corpCountByKind[kind] ?? 0) + 1;
    for (const kind of Object.keys(corpCountByKind).sort()) {
      console.log(`${kind}: ${corpCountByKind[kind]}`);
    }

    const colony = deps.getColony();
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
    const flowEconomy = deps.getFlowEconomy();
    if (!flowEconomy) {
      console.log("[FlowEconomy] Not initialized. Colony may have no nodes yet.");
      return;
    }

    const graph = flowEconomy.getFlowGraph();
    const solution = flowEconomy.getSolution();

    console.log("\n=== Flow Economy Status ===");
    console.log(`Sources: ${graph.getSources().length}`);
    console.log(`Sinks: ${graph.getSinks().length}`);

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

  // ---------------------------------------------------------------------------
  // LEGACY COMMANDS
  // ---------------------------------------------------------------------------

  /**
   * Force recalculation of multi-room spatial analysis.
   * Call from console: `global.recalculateTerrain()`
   *
   * This triggers an incremental analysis that spreads work across multiple ticks.
   */
  global.recalculateTerrain = () => {
    resetAnalysis();

    const colony = deps.getColony();
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
   * Show node summary with ROI scores.
   * Call from console: `global.showNodes()`
   */
  global.showNodes = () => {
    const colony = deps.getColony();
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
    console.log("Sorted by ROI score (planner-backed economic value)\n");

    for (const node of sortedNodes) {
      const roi = node.roi;
      if (roi) {
        const distStr = roi.distanceFromOwned === Infinity ? "∞" : roi.distanceFromOwned.toString();

        console.log(`${node.id} [${roi.isOwned ? "OWNED" : `dist=${distStr}`}]`);
        console.log(`  Score: ${roi.score.toFixed(1)} | Openness: ${roi.openness}`);
        console.log(
          `  Resources: ${roi.sourceCount} sources, ${roi.hasController ? "has controller" : "no controller"}`
        );
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
        console.log(`  ${node.id}: score=${roi.score.toFixed(1)}, dist=${distStr}`);
      }
    }
  };

  /**
   * Export node graph as JSON for external analysis.
   * Call from console: `global.exportNodes()`
   */
  global.exportNodes = (): string => {
    const colony = deps.getColony();
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
   * Show where CPU is actually being spent this tick: the spec-20 reconciliation
   * (whole-tick = corps + named infra + unnamed residual), a per-kind and
   * per-bucket breakdown, and the worst per-corp offenders by ~100-tick EMA.
   * Reads the `Memory.corpCpu` ledger the host publishes every tick, so the
   * numbers are last-tick-accurate. Call from console: `global.cpuReport()`.
   */
  global.cpuReport = () => {
    const bucket = typeof Game.cpu?.bucket === "number" ? Game.cpu.bucket : undefined;
    const limit = typeof Game.cpu?.limit === "number" ? Game.cpu.limit : undefined;
    for (const line of formatCpuReport(Memory.corpCpu, { bucket, limit })) console.log(line);
  };

  /**
   * Toggle the debug overlays (node/spatial RoomVisuals), OFF by default because
   * they cost ~35 CPU/tick to draw pixels only visible with the client open on the
   * room. `global.visuals()` flips the current state; `global.visuals(true/false)`
   * sets it explicitly. The load-bearing analysis-cache restore is unaffected.
   */
  global.visuals = (on?: boolean) => {
    Memory.visuals = on === undefined ? !Memory.visuals : on;
    console.log(`[visuals] overlays ${Memory.visuals ? "ON" : "OFF"}`);
  };

  /**
   * Break-glass: admit the next `calls` naked spawnCreep invocations (default
   * 1) past the spawn-contract guard (corps/spawnContract). For operator
   * rescue expressions only - bot code always buys through the contract.
   * Call from console: `global.spawnContractBypass()`, then run the naked
   * spawn in the same or a later expression.
   */
  global.spawnContractBypass = (calls?: number) => {
    const admitted = armSpawnContractBypass(calls ?? 1);
    console.log(`[SpawnContract] bypass armed for ${admitted} naked spawn(s)`);
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
}
