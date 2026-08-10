/**
 * Flow DTOs - the ONE surviving flow-vocabulary module (spec 35 phase G).
 *
 * The FlowSolution/assignment shapes the live corps, telemetry and the
 * adapter's solve share, plus the FlowSource/FlowSink discovery shapes and
 * their id-minting factories. The discovery + solve driver themselves live in
 * economy/flowAdapter.ts (the sanctioned world adapter - ONTOLOGY §1); this
 * module is declarations and pure mappers only, and stays Game-free (the
 * purity ratchet scans it).
 *
 * Economic constants are homed in economy/primitives (spec 35 phase B
 * inverted the dependency; phase G closed the one-release re-export
 * tolerance - import primitives directly).
 */

import type { CommissionedHauler } from "../economy/CorpPlanner";
import { haulerOverhead } from "../economy/primitives";
import { HaulerRatio } from "../framework/EdgeVariant";
import { Position } from "../types/Position";

// =============================================================================
// CONSTANTS
// =============================================================================

/** Energy produced per tick by a source (3000 capacity / 300 regen) */
export const SOURCE_ENERGY_PER_TICK = 10;

// =============================================================================
// SINK TYPES
// =============================================================================

/**
 * Types of energy sinks (consumers) in the economy. Sinks are VALUED by the
 * planner's ladder (perInstanceSinkValue over DEFAULT_SINK_VALUE - the ONE
 * value model, ONTOLOGY §7); the type only names what the sink is.
 */
export type SinkType =
  | "spawn" // Spawn overhead - keeping creeps alive (CRITICAL)
  | "extension" // Extension fill - spawn capacity
  | "tower" // Tower energy - defense and repair
  | "construction" // Construction sites - building new structures
  | "controller" // Controller upgrading
  | "terminal" // Terminal operations
  | "link" // Link network transfers
  | "storage" // Storage buffer (lowest priority - excess only)
  | "lab" // Lab operations
  | "factory" // Factory production
  | "nuker" // Nuker charging
  | "powerSpawn"; // Power processing

// =============================================================================
// FLOW SOURCE
// =============================================================================

/**
 * A source of energy in the flow network.
 * Each game Source object becomes one FlowSource.
 */
export interface FlowSource {
  /** Unique identifier: "source-{gameId}" */
  id: string;

  /** Node (territory) containing this source */
  nodeId: string;

  /** World position of the source */
  position: Position;

  /** Energy production capacity (default: 10/tick) */
  capacity: number;

  /** Game object ID of the source */
  gameId: string;

  /**
   * Maximum miners that can work this source simultaneously.
   * Determined by counting walkable tiles adjacent to the source.
   * Used for early game when multiple small miners are more efficient.
   */
  maxMiners: number;
}

// =============================================================================
// FLOW SINK
// =============================================================================

/**
 * A consumer of energy in the flow network.
 * Sinks have priorities that determine allocation order.
 */
export interface FlowSink {
  /** Unique identifier: "{type}-{gameId}" */
  id: string;

  /** Node (territory) containing this sink */
  nodeId: string;

  /** World position of the sink */
  position: Position;

  /** Type of sink (determines default priority) */
  type: SinkType;

  /** Current priority (0-100, higher = more important) */
  priority: number;

  /** Energy demand per tick */
  demand: number;

  /** Maximum energy this sink can accept per tick */
  capacity: number;

  /** Energy allocated by the solver (set after solving) */
  allocation: number;

  /** Game object ID (if applicable) */
  gameId?: string;

  /** For construction sites: build progress remaining */
  progressRemaining?: number;
}

// =============================================================================
// FLOW ALLOCATIONS (Solver Output)
// =============================================================================

/**
 * Miner assignment from the solver.
 */
export interface MinerAssignment {
  /**
   * The mouth BUFFER the plan priced this source's drain fleet against (v17).
   *
   * Published because the drain term is otherwise undiagnosable from a capture:
   * `carryParts` carries it folded in and `flowRate` never shows it at all, so
   * "the lens is dead" and "the lens is fine, the uplift is small" print
   * identically. Absent = the plan saw no buffer, which is a DIFFERENT
   * statement from zero.
   */
  staged?: number;
  /** Source being mined */
  sourceId: string;

  /** Node where source is located */
  nodeId: string;

  /** Nearest spawn for this miner */
  spawnId: string;

  /** Distance from spawn to source */
  spawnDistance: number;

  /** Expected harvest rate (usually 10/tick per source) */
  harvestRate: number;

  /** Spawn cost per tick for this miner */
  spawnCostPerTick: number;

  /**
   * This source's transport IS the link network (its `haulPos` is the core
   * link), so its creep haul leg is ~1 tile. Published because the cost of that
   * transport is NOT zero - the engine destroys LINK_TRANSFER_LOSS of every hop
   * - and the account cannot budget the link tax without knowing which sources
   * pay it. Inferring it from a short haul distance was the alternative, and
   * inference is what let link haulage read as free in the first place.
   */
  linkServed?: boolean;

  /** Swamp share of this source's haul path, as the planner priced it. */
  swampFraction?: number;

  /**
   * Maximum number of miners that can work this source simultaneously.
   * Determined by counting walkable tiles adjacent to the source.
   * Allows spawning multiple smaller miners in early game when energy capacity is limited.
   */
  maxMiners: number;

  /**
   * Mining efficiency percentage (0-100).
   * Calculated as: (harvestRate - totalOverhead) / harvestRate * 100
   * where totalOverhead = minerOverhead + haulerOverhead.
   * Higher efficiency = more net energy per unit harvested = higher spawn priority.
   */
  efficiency: number;
}

/**
 * Hauler assignment from the solver.
 */
export interface HaulerAssignment {
  /** Edge this hauler serves */
  edgeId: string;

  /** Source of energy */
  fromId: string;

  /** Destination (sink or intermediate node) */
  toId: string;

  /** Walking distance */
  distance: number;

  /** CARRY parts needed */
  carryParts: number;

  /** Energy transported per tick */
  flowRate: number;

  /** Spawn cost per tick for these haulers */
  spawnCostPerTick: number;

  /**
   * Planner's own spawn-PARTS/tick for this route (parts, not energy):
   * `((paved?1.5:2)*carryPartsFor(take,dEff))/effectiveLife(d)`, carried
   * verbatim from the CommissionedHauler so the waste ledger's P4 can ECHO the
   * planner's paved-aware number instead of re-deriving it (owner 2026-07-22:
   * share the code, don't duplicate the pricing). Optional: the corp-side
   * materialization path (haulerAssignmentFromCommissioned) leaves it unset.
   */
  spawnParts?: number;
  /** What this route actually DEBITED from the parts ledger (audit t72846447),
   * against `spawnParts` which is what it is PRICED at. Carried verbatim from
   * CommissionedHauler. */
  charged?: number;

  /** Nearest spawn for these haulers */
  spawnId: string;

  /**
   * Deposit port (spec 26): a link position the plan chose as a shorter delivery
   * leg to the storage hub. When set, this route's `distance`/`carryParts` are
   * already priced to the port leg and CarryCorp delivers HERE first (falling
   * back to the storage on port-full). Carried verbatim from CommissionedHauler.
   */
  depositPos?: Position;

  /** Terrain profile for this route */

  /** Hauler CARRY:MOVE ratio selected by variant optimizer */
  haulerRatio?: HaulerRatio;

  /** Selected EdgeVariant for this hauler assignment */
}

/**
 * Energy allocation to a sink from the solver.
 */
export interface SinkAllocation {
  /** Sink receiving energy */
  sinkId: string;

  /**
   * Spawn-parts ledger remaining when this sink's fill ENDED (spec 15 P4
   * trace) - why filling stopped: capacity met, pool dry, or ledger dry.
   */
  partsLeft?: number;
  /** The consumer-body charge the ROUTING pass debited for this sink (audit
   * t72846447), next to the adapter's independently-computed `spawnLoad`. */
  chargedWork?: number;

  /**
   * The plan's ALL-IN spawn charge for this consumer (parts/tick) and the
   * nearest-spawn distance it was priced at (spec 34 P4) - stamped by the
   * adapter from the commission price (consumerSpawnLoad, the ONE
   * derivation) so telemetry and the waste ledger echo, never re-derive.
   * Today stamped for construction sinks only.
   */
  spawnLoad?: number;
  spawnDist?: number;

  /** Type of sink */
  sinkType: SinkType;

  /**
   * Room the sink stands in (from the planner problem's sink position).
   * Feeds the per-room Memory.controllerAllocations publish (spec 38 phase
   * B) that runtime readers resolve through bank.plannedControllerFlow.
   */
  roomName?: string;

  /** Energy allocated per tick */
  allocated: number;

  /** Original demand */
  demand: number;

  /** Unmet demand (demand - allocated) */
  unmet: number;

  /** Priority at time of allocation */
  priority: number;

  /** Sources contributing to this sink */
  sourceFlows: {
    sourceId: string;
    amount: number;
    distance: number;
  }[];
}

// =============================================================================
// FLOW PROBLEM & SOLUTION
// =============================================================================

/**
 * Output from the flow solver.
 */
export interface FlowSolution {
  /** Miner assignments */
  miners: MinerAssignment[];

  /**
   * The plan's spawn-parts ledger, traced (spec 15 P4): capacity, standing
   * deductions, and the routing budget the sink fill worked with.
   */
  partsLedger?: {
    capacity: number;
    plannable?: number;
    minerLoad: number;
    infra: number;
    budget: number;
    /** Parts the routing actually spent of the budget (v9; the type lagged the field). */
    spent?: number;
    /** True when routing exhausted the budget - spawn capacity binds (v9). */
    dry?: boolean;
  };
  /** Problem-assembly counts (flow v5): names the layer that dropped sources. */
  assembly?: { graphSources: number; mined: number; transient: number; bank: number };

  /** Hauler assignments */
  haulers: HaulerAssignment[];

  /** Sink allocations */
  sinkAllocations: SinkAllocation[];

  /** Total gross harvest (before overhead) */
  totalHarvest: number;

  /** Total mining overhead (miner spawn costs) */
  miningOverhead: number;

  /** Total hauling overhead (hauler spawn costs) */
  haulingOverhead: number;

  /** Total overhead (mining + hauling) */
  totalOverhead: number;

  /**
   * PER-SPAWN fleet maintenance the two-pass solve charged the spawn sinks
   * (energy/tick). Published so a capture can DECOMPOSE the spawn demand,
   * which is `max(base 10, maintenance) + agendaFundingRate` - only the sum
   * was exported, and the two-pass solve's first live verification could not
   * attribute a 4x prediction miss between the two terms because of it.
   */
  spawnMaintenance?: number;

  /**
   * The INPUTS the per-spawn charge above was computed from, stamped at the
   * decision site (spec 14). Added after `spawnMaintenance` alone proved
   * insufficient TWICE: the charge is `fleetEnergy / spawnCount`, and a
   * capture could not tell an unconverged iteration from a wrong divisor
   * from a mis-estimated infra term - all three predict "the charge is not
   * the fleet cost". Each of my two diagnoses from the sum alone was wrong.
   *
   * `fleetEnergy` is the CONVERGED plan's total (production overhead + infra),
   * so `charge * spawnCount == fleetEnergy` is the self-consistency identity a
   * reader can check directly, and `passes` says whether the iteration ran out
   * of budget before getting there.
   */
  fleetCharge?: {
    /** Total fleet cost of the plan handed back (totalOverhead + infra). */
    fleetEnergy: number;
    /** Production term only (plan.totalOverhead). */
    production: number;
    /** Infrastructure term only (problem.infraEnergyPerTick). */
    infra: number;
    /** Divisor: spawn sinks the charge is split across. */
    spawnCount: number;
    /** Damped iterations actually run (0 = converged on the seed). */
    passes: number;
    /**
     * The infra term's INPUTS (t72749493: infra published 33.11 while a
     * hand-derivation from assumed inputs gave ~11 - the sum alone cannot be
     * decomposed from a capture, the exact diagnosis failure the stamp
     * exists to prevent). infraSpawnEnergy(pricedRelay, depotRooms,
     * remoteRooms, linkFedRooms) is re-runnable from these four numbers.
     *
     * `remoteRoomsFunded` is the fifth (spec 51, t72828763): the remotes the
     * plan actually funded, next to the `remoteRooms` it was PRICED for. The
     * solve's corrective reserver pass normally makes them equal; when it
     * cannot, the difference is the residual over-charge - one reserver per
     * room - and the pair is what separates "the two books disagree" from "a
     * corp's budget is wrong" straight from a capture.
     */
    infraInputs?: {
      pricedRelay: number;
      depotRooms: number;
      remoteRooms: number;
      linkFedRooms: number;
      remoteRoomsFunded?: number;
      /** Armed rooms carrying a standing guard (spec 51 phase 2) - the sixth
       *  input, and the only one that is usually zero. */
      guardedRooms?: number;
    };
  };

  /**
   * Remote rooms whose sources the plan FUNDED this solve (miner commissions
   * outside spawn rooms). Persisted by the execution layer as
   * Memory.fundedRemoteRooms and threaded back into the next solve's infra
   * pricing - the reserver upkeep charges for rooms actually worked, not
   * every scouted candidate (t72750467: 26 candidates vs 8 funded).
   */
  fundedRemoteRooms?: string[];

  /** Net energy available for sinks */
  netEnergy: number;

  /** Overall efficiency: netEnergy / totalHarvest */
  efficiency: number;

  /** Sinks with unmet demand */
  unmetDemand: Map<string, number>;

  /** Is the economy self-sustaining? */
  isSustainable: boolean;

  /** Warnings from the solver */
  warnings: string[];

  /** Tick when this solution was computed */
  computedAt: number;

  /**
   * Per-candidate funding verdicts from producer selection (spec 14 phase 5) -
   * why each non-transient source was funded or excluded (unprofitable /
   * over-budget / no-spawn), with the net/tax pricing the decision read.
   * Shape: economy/CorpPlanner.SourceVerdict[]. Optional: absent on legacy
   * solutions.
   */
  sourceVerdicts?: {
    sourceId: string;
    rate: number;
    distance: number;
    net: number;
    tax: number;
    parts: number;
    verdict: string;
  }[];
}

// =============================================================================
// PRIORITY CONTEXT
// =============================================================================


// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a flow source from a game source.
 */
export function createFlowSource(
  gameId: string,
  nodeId: string,
  position: Position,
  capacity: number = SOURCE_ENERGY_PER_TICK,
  maxMiners = 1
): FlowSource {
  return {
    id: `source-${gameId}`,
    nodeId,
    position,
    capacity,
    gameId,
    maxMiners
  };
}

/**
 * Create a flow sink.
 */
export function createFlowSink(
  type: SinkType,
  gameId: string,
  nodeId: string,
  position: Position,
  demand: number,
  capacity: number,
  priority?: number
): FlowSink {
  return {
    id: `${type}-${gameId}`,
    nodeId,
    position,
    type,
    // Vestigial: sinks are VALUED by the planner's ladder (perInstanceSinkValue
    // over DEFAULT_SINK_VALUE - the ONE value model, ONTOLOGY §7). This field
    // survives only as a telemetry passthrough; nothing routes on it.
    priority: priority ?? 0,
    demand,
    capacity,
    allocation: 0,
    gameId
  };
}

/**
 * Create an edge ID from two node/source/sink IDs.
 * Always sorts alphabetically for consistent bidirectional keys.
 */
export function createEdgeId(fromId: string, toId: string): string {
  return fromId < toId ? `${fromId}|${toId}` : `${toId}|${fromId}`;
}

// (Round-trip / carry-part / hauler-cost formulas live in economy/primitives -
// the single canonical home for economic math. See docs/ONTOLOGY.md § 2.)

// =============================================================================
// THE ONE CommissionedHauler -> HaulerAssignment MAPPER
// =============================================================================

/**
 * Reconstruct a flow-shaped HaulerAssignment from one commissioned route.
 *
 * The planner emits CommissionedHaulers; two runtime paths reconstruct the
 * flow-shaped HaulerAssignment from them - the live adapter (flowAdapter.
 * solveColony, building the FlowSolution) and the framework materialization
 * (carryKind.materialize). They MUST stay identical, so both call this: a new
 * hauler field (paved, depositPos, ...) is a one-place change and the
 * solver-bridge pin can never drift. spawnCostPerTick is the one derived field,
 * recomputed from the canonical primitive (no private formula).
 *
 * Cycle-free: imports only the CommissionedHauler TYPE (from the pure planner,
 * which never imports flow/) and primitives. Folded into this DTO module by
 * spec 35 phase G (its own flow/haulerAssignment.ts home dissolved with the
 * translation layer).
 *
 * spawnId is carried verbatim (the flow "spawn-" prefix is stripped separately,
 * when the CORP's spawnId is set - not here).
 */
export function haulerAssignmentFromCommissioned(h: CommissionedHauler): HaulerAssignment {
  return {
    edgeId: createEdgeId(h.sourceId, h.sinkId),
    fromId: h.sourceId,
    toId: h.sinkId,
    distance: h.distance,
    carryParts: h.carryParts,
    flowRate: h.flowRate,
    spawnCostPerTick: haulerOverhead(h.carryParts, h.distance),
    // Carry the planner's paved-aware parts/tick verbatim (P4 ledger echoes it).
    spawnParts: h.spawnParts,
    // ...and what the ledger ACTUALLY debited for it (audit t72846447).
    ...(h.charged !== undefined ? { charged: h.charged } : {}),
    spawnId: h.spawnId,
    // A paved route spawns road haulers: 2 CARRY per MOVE (SpawningCorp.getPartRatios).
    ...(h.paved ? { haulerRatio: "2:1" as const } : {}),
    // The deposit port the plan chose (spec 26): CarryCorp delivers here first.
    ...(h.depositPos ? { depositPos: h.depositPos } : {})
  };
}
