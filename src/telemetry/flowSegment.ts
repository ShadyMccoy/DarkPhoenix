/**
 * @fileoverview Flow telemetry writer - segment 6 (flow economy: sources,
 * sinks, allocations).
 *
 * Charter: the `FlowTelemetry` segment shape and its ONE writer - the GOAL-plan
 * side of plan-vs-actual (planned miners/haulers/sinks with their WORK/CARRY
 * sizings, the spawn-parts ledger, producer funding verdicts), plus the
 * read-only deposit-savings link instrument (spec-26 stage 4). The ACTUAL side
 * lives in segments 0/4 (measured bodies). The emitted bytes are a frozen
 * external contract (versioned; an external app parses them) - field order and
 * version numbers never change in a refactor.
 *
 * Layer: telemetry writer (Game/Memory-coupled; writes RawMemory segment 6).
 *
 * @module telemetry/flowSegment
 */

import { coreLink, controllerLink } from "../corps/nodeEnergy";
import { computeDepositSavings, DepositSource, DepositLink, DepositSavingsReport } from "../economy/depositSavings";
import { Position } from "../types/Position";
import { pathDistance } from "../nodes/NodeNavigator";
import { feederRelayRate, resolveReserveTarget } from "../economy/bank";
import { FlowSolution } from "../flow/FlowTypes";
import {
  BUILD_ENERGY_PER_WORK,
  HARVEST_ENERGY_PER_WORK,
  UPGRADE_ENERGY_PER_WORK,
  workPartsForEnergyRate
} from "../economy/primitives";
import { TELEMETRY_SEGMENTS } from "./segmentIds";

/**
 * Energy/tick a single WORK part burns at a WORK-driven consumer sink, keyed by
 * sink type. Sinks absent here are not WORK-driven, so they get no planned WORK
 * figure (their plan currency is the energy allocation itself).
 */
const SINK_ENERGY_PER_WORK: Record<string, number> = {
  controller: UPGRADE_ENERGY_PER_WORK,
  construction: BUILD_ENERGY_PER_WORK
};

/**
 * Flow telemetry data structure (Segment 6).
 * Shows flow economy state: sources, sinks, and energy flow.
 */
export interface FlowTelemetry {
  version: number;
  tick: number;
  /** The fill's spawn-parts ledger (v4): capacity/minerLoad/infra/budget.
   * v9 adds spent/dry: the spawn shadow-price signal (dry=true => spawn
   * capacity is the binding constraint; the scavenge-gate precondition).
   * v12 adds plannable: the 90% planning margin (SPAWN_PLAN_FRACTION) the
   * fill spends from; capacity stays the PHYSICAL rate P4 audits against. */
  partsLedger?: {
    capacity: number;
    plannable?: number;
    minerLoad: number;
    infra: number;
    budget: number;
    spent?: number;
    dry?: boolean;
  };
  /** Problem-assembly counts (v5): names the layer that dropped sources. */
  assembly?: { graphSources: number; mined: number; transient: number; bank: number };
  /** DEPOSIT-side link instrument (v10, spec-26 stage 4): for each REMOTE
   * source, the nearest deposit-capable home-room link and the haul it would
   * save by dropping there (a creep bridges the rooms; the link does the in-room
   * hop). Plus per-link deposit flow (the throughput headroom). Read-only. */
  depositSavings?: {
    candidates: { sourceId: string; haulDist: number; linkId: string; linkDist: number; saving: number; flowRate: number }[];
    perLink: { linkId: string; depositFlow: number; sources: number }[];
    /** The controller link (a bank-neutral deposit target up to controllerCapacity
     * e/t - it displaces the relay). */
    controllerLinkId?: string;
    controllerCapacity?: number;
  };
  /** Source nodes (energy producers) */
  sources: {
    id: string;
    nodeId: string;
    harvestRate: number;
    workParts: number;
    /** Mining efficiency percentage (0-100) */
    efficiency: number;
    /** Distance from spawn */
    spawnDistance: number;
  }[];
  /**
   * PLANNED haulers (goal-plan side). Each solver hauler assignment with the
   * CARRY parts it is sized to field - the plan-side analog to `sources[].
   * workParts`. Compare `carryParts` here against the actual CARRY on the
   * matching hauling corp in segment 4.
   */
  haulers: {
    edgeId: string;
    /** Energy source (fromId) */
    sourceId: string;
    /** Destination sink (toId) */
    sinkId: string;
    /** PLANNED CARRY parts the solver sized this route to */
    carryParts: number;
    /** Energy/tick transported */
    flowRate: number;
    /** Walking distance one way */
    distance: number;
    /** Spawn these haulers come from */
    spawnId: string;
    /** CARRY:MOVE ratio the variant optimizer chose ("2:1" paved, "1:1", "1:2") */
    ratio?: string;
    /**
     * The planner's OWN spawn-parts/tick for this route (paved-aware). The
     * waste ledger's P4 echoes this instead of re-deriving hauler load, so the
     * ledger cannot drift from the bot it audits (owner 2026-07-22).
     */
    spawnParts?: number;
    /**
     * Deposit port (spec 26): the link this route drops at instead of the storage
     * hub, when the plan priced a shorter port leg. Present only on ported routes,
     * so a dashboard can see which mined deposits turn around early (and compare
     * this route's shrunken `carryParts`/`distance` against the no-port baseline).
     */
    port?: { x: number; y: number; roomName: string };
  }[];
  /** Sink nodes (energy consumers) - spawns, controllers, construction */
  sinks: {
    id: string;
    nodeId?: string; // Optional - may not always be available
    type: string; // "spawn" | "controller" | "construction"
    demand: number;
    allocated: number;
    unmet: number;
    priority: number;
    /** Spawn-parts ledger remaining when this sink's fill ended (spec 15 P4). */
    partsLeft?: number;
    /**
     * PLANNED WORK parts implied by `allocated` for WORK-driven consumer sinks
     * (controller=upgrade, construction=build); absent for non-WORK sinks
     * (spawn/extension/tower/...). This is the GOAL-plan sizing - consumers are
     * actually sized from live stock (sustainableConsumptionRate), so read it as
     * a ramp gauge, and compare against the actual WORK on the matching upgrade/
     * construction corp in segment 4.
     */
    workParts?: number;
  }[];
  /**
   * Planner funding verdicts for every non-transient mining candidate (spec 14
   * phase 5), VERBATIM from producer selection: why each source is in or out
   * of the plan (funded / unprofitable / over-budget / no-spawn) with the
   * net/tax pricing the decision read. "Why are the remotes dead" is a read.
   */
  candidates: {
    sourceId: string;
    rate: number;
    distance: number;
    net: number;
    tax: number;
    parts: number;
    verdict: string;
  }[];
  /** Flow summary */
  summary: {
    totalHarvest: number;
    totalOverhead: number;
    netEnergy: number;
    efficiency: number;
    isSustainable: boolean;
    minerCount: number;
    haulerCount: number;
  };
  /** Warnings from the flow solver */
  warnings: string[];
}

/**
 * DEPOSIT-side link instrument (spec-26 stage 4): for each REMOTE source (a
 * different room from the home link network), the nearest deposit-capable
 * home-room link and the haul a creep would save by dropping there instead of
 * walking to storage. In-room sources are excluded (their own source links are
 * already modeled via haulPos); the terminal controller link is excluded (a
 * bank deposit must not misroute into the controller). Estimate-distance only
 * (read-only knowledge before any routing change).
 */
function buildDepositInstrument(
  sources: FlowTelemetry["sources"],
  haulers: FlowTelemetry["haulers"]
): DepositSavingsReport | undefined {
  try {
    return buildDepositInstrumentUnsafe(sources, haulers);
  } catch {
    return undefined; // a read-only instrument must never break the telemetry tick
  }
}

function buildDepositInstrumentUnsafe(
  sources: FlowTelemetry["sources"],
  haulers: FlowTelemetry["haulers"]
): DepositSavingsReport | undefined {
  if (typeof Game === "undefined" || !Game.rooms) return undefined;
  let home: Room | undefined;
  for (const name in Game.rooms) {
    const r = Game.rooms[name];
    if (r.controller?.my && r.storage?.my && coreLink(r)) {
      home = r;
      break;
    }
  }
  if (!home || !home.storage) return undefined;
  const ctrl = controllerLink(home);
  // Include the CONTROLLER link as a candidate (owner 2026-07-23): a deposit
  // there displaces an equal core->controller relay feed (bank-neutral, up to
  // the controller's feed rate) - not a misroute. Exclude only the CORE link
  // itself (it sits on storage; depositing there saves nothing and the core is
  // the hub, not a shortcut).
  const core = coreLink(home);
  const links: DepositLink[] = (
    home.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_LINK && (!core || s.id !== core.id)
    }) as StructureLink[]
  ).map(l => ({ id: l.id, pos: { x: l.pos.x, y: l.pos.y, roomName: home!.name } }));
  if (links.length === 0) return undefined;

  const storagePos: Position = { x: home.storage.pos.x, y: home.storage.pos.y, roomName: home.name };
  const banked = home.storage.store?.[RESOURCE_ENERGY] ?? 0;
  const flowBySource = new Map<string, number>();
  for (const h of haulers) flowBySource.set(h.sourceId, (flowBySource.get(h.sourceId) ?? 0) + h.flowRate);

  const depSources: DepositSource[] = [];
  for (const s of sources) {
    const m = /^(.+)-(\d+)-(\d+)$/.exec(s.nodeId);
    if (!m) continue;
    const pos: Position = { roomName: m[1], x: +m[2], y: +m[3] };
    if (pos.roomName === home.name) continue; // in-room sources use haulPos already
    depSources.push({
      id: s.id,
      pos,
      flowRate: flowBySource.get(s.id) ?? s.harvestRate,
      // REAL walking distance (PathFinder, cached) - the crude
      // estimateCrossRoomDistance mis-composed the in-room term across rooms
      // and undercounted savings (owner saw 3 routes >5 tiles vs my 2 @5).
      haulDist: pathDistance(pos, storagePos)
    });
  }
  const report = computeDepositSavings(depSources, links, pathDistance);
  if (ctrl) {
    // A deposit at the controller link is bank-neutral only up to the
    // controller's feed rate (it displaces that much relay draw); beyond it
    // the terminal link fills. Surface the cap so the DEP line never over-
    // counts controller-bound deposit flow.
    report.controllerLinkId = ctrl.id;
    report.controllerCapacity = feederRelayRate(banked, resolveReserveTarget(Memory.warchestTarget));
  }
  return report;
}

/**
 * Updates flow telemetry (Segment 6).
 * Shows flow economy state: sources, sinks, and energy allocations.
 */
export function updateFlowTelemetry(flowSolution?: FlowSolution): void {
  // Build source data from miner assignments
  const sources: FlowTelemetry["sources"] = [];
  const haulers: FlowTelemetry["haulers"] = [];
  const sinks: FlowTelemetry["sinks"] = [];

  if (flowSolution) {
    // Collect sources from miner assignments
    for (const miner of flowSolution.miners) {
      sources.push({
        id: miner.sourceId,
        nodeId: miner.nodeId || "",
        harvestRate: miner.harvestRate,
        // PLANNED work parts, from the solver's harvest rate via the shared
        // energy-rate->WORK primitive (harvest = 2 energy/tick per WORK). The
        // ACTUAL work parts spawned are the measured bodies on the matching
        // harvest corp in segments 0/4.
        workParts: workPartsForEnergyRate(miner.harvestRate, HARVEST_ENERGY_PER_WORK),
        efficiency: miner.efficiency,
        spawnDistance: miner.spawnDistance
      });
    }

    // Collect PLANNED haulers - the plan-side carry-part budget per route, the
    // analog of sources[].workParts for the hauling half of the economy.
    for (const hauler of flowSolution.haulers) {
      haulers.push({
        edgeId: hauler.edgeId,
        sourceId: hauler.fromId,
        sinkId: hauler.toId,
        carryParts: hauler.carryParts,
        flowRate: hauler.flowRate,
        distance: hauler.distance,
        spawnId: hauler.spawnId,
        ratio: hauler.haulerRatio,
        ...(hauler.spawnParts !== undefined ? { spawnParts: hauler.spawnParts } : {}),
        ...(hauler.depositPos ? { port: hauler.depositPos } : {})
      });
    }

    // Collect sinks from sink allocations
    for (const sink of flowSolution.sinkAllocations) {
      // WORK-driven consumers (upgrade/build) get a planned WORK figure derived
      // from their energy allocation; others carry none (undefined is dropped
      // from the JSON, keeping non-WORK sinks unchanged).
      const perWork = SINK_ENERGY_PER_WORK[sink.sinkType];
      sinks.push({
        id: sink.sinkId,
        // nodeId not available in SinkAllocation - could be derived from sinkId if needed
        type: sink.sinkType,
        demand: sink.demand,
        allocated: sink.allocated,
        unmet: sink.unmet,
        priority: sink.priority,
        ...(sink.partsLeft !== undefined ? { partsLeft: sink.partsLeft } : {}),
        // v11 (spec 34 P4): the plan's all-in consumer charge, echoed
        // verbatim from the adapter's stamp (consumerSpawnLoad) - the P4
        // waste ledger reads THIS, never a re-derivation.
        ...(sink.spawnLoad !== undefined ? { spawnLoad: sink.spawnLoad, spawnDist: sink.spawnDist } : {}),
        workParts: perWork === undefined ? undefined : workPartsForEnergyRate(sink.allocated, perWork)
      });
    }
  }

  const telemetry: FlowTelemetry = {
    // v4: the fill's spawn-parts ledger trace (partsLedger + per-sink
    // partsLeft). v5: problem-assembly counts (graphSources/mined/
    // transient/bank) - names the layer that dropped sources in one
    // capture (the warmup remote-drop lens). v6 carried dedicatedToBuild;
    // v7 RETIRES it (spec 25 phase 3: dedication is emergent routing -
    // the audit reads source->construction ROUTES, not a flag). v8 exports
    // haulers[].spawnParts (the planner's paved-aware parts/tick) so the P4
    // ledger echoes it instead of re-deriving - drift eliminated at the root.
    // v9 adds partsLedger.spent/dry - the spawn shadow-price signal for the
    // scavenge economic gate (instrument-first, 2026-07-23). v10 adds
    // depositSavings - the deposit-side link instrument (spec-26 stage 4).
    // v11 adds sinks[].spawnLoad/spawnDist - the all-in consumer charge
    // echo (spec 34 P4: the ledger charges construction THROUGH the plan).
    // v12 adds partsLedger.plannable - the 90% planning margin
    // (SPAWN_PLAN_FRACTION, owner 2026-07-30) the fill spends from.
    version: 12,
    tick: Game.time,
    sources,
    haulers,
    sinks,
    ...(() => {
      const dep = buildDepositInstrument(sources, haulers);
      return dep && dep.candidates.length > 0 ? { depositSavings: dep } : {};
    })(),
    ...(flowSolution?.partsLedger ? { partsLedger: flowSolution.partsLedger } : {}),
    ...(flowSolution?.assembly ? { assembly: flowSolution.assembly } : {}),
    candidates: flowSolution?.sourceVerdicts ?? [],
    summary: flowSolution
      ? {
          totalHarvest: flowSolution.totalHarvest,
          totalOverhead: flowSolution.totalOverhead,
          netEnergy: flowSolution.netEnergy,
          efficiency: flowSolution.efficiency,
          isSustainable: flowSolution.isSustainable,
          minerCount: flowSolution.miners.length,
          haulerCount: flowSolution.haulers.length
        }
      : {
          totalHarvest: 0,
          totalOverhead: 0,
          netEnergy: 0,
          efficiency: 0,
          isSustainable: false,
          minerCount: 0,
          haulerCount: 0
        },
    warnings: flowSolution?.warnings || []
  };

  RawMemory.segments[TELEMETRY_SEGMENTS.FLOW] = JSON.stringify(telemetry);
}
