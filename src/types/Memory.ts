/**
 * @fileoverview Screeps Memory type extensions.
 *
 * Extends the global Screeps memory interfaces to support
 * colony-based economic system persistence.
 *
 * @module types/Memory
 */

import {
  SerializedBootstrapCorp,
  SerializedCarryCorp,
  SerializedConstructionCorp,
  SerializedExtensionTenderCorp,
  SerializedHarvestCorp,
  SerializedReservationCorp,
  SerializedScoutCorp,
  SerializedSpawningCorp,
  SerializedUpgradingCorp
} from "../corps";
import { SerializedColony } from "../colony/Colony";
import { SerializedNode } from "../nodes/Node";

declare global {
  /**
   * Room intelligence data from scouting.
   */
  interface RoomIntel {
    /** Game tick when this room was last visited */
    lastVisit: number;
    /**
     * The room counts HOSTILE until this tick (defense economics: its corps
     * are defunded). Set from a sighted hostile's ticksToLive - one glimpse
     * bounds the threat's lifetime without standing vision - and cleared
     * early by any fresh sighting of the room with no hostiles.
     */
    hostileUntil?: number;
    /**
     * The room's controller is reserved by the Invader NPC (an invader core
     * holds it) until ~this tick. Same defense economics as hostileUntil: the
     * room's corps are defunded - mining is throttled/contested and our
     * reserver cannot take the controller anyway. Set from the sighted
     * reservation's ticksToEnd; cleared early by a fresh sighting with the
     * reservation gone. A live core RENEWS its reservation, so the bound
     * refreshes on every sighting rather than being exact.
     */
    invaderReservedUntil?: number;
    /**
     * A PLAYER reservation on this room's controller ends ~this tick, held by
     * `reservedBy`. Unlike the invader bound this one is EXACT while blind:
     * a reservation decays 1/tick, the same countdown the bound encodes, so
     * only a hostile CLAIM grind diverges it (next sighting corrects). The
     * ReservationCorp's duty cycle (spec 15 P5) coasts on it: no reserver is
     * bought while our banked reservation sits above the refresh floor.
     */
    reservedUntil?: number;
    reservedBy?: string;
    /**
     * Energy OUR corps harvested in this room since the last observed raid -
     * a tick-exact mirror of the engine's per-room invader fuse (spec 13:
     * the engine fires a raid when its counter crosses a 70k-130k goal).
     * Accrued at HarvestCorp's harvest site (utils/raidMeter); reset by the
     * hostileRooms() vision pass when Invader creeps are sighted. Drives the
     * raid-guard pre-spawn (armed at 65k) and goes "overdue" past 130k -
     * evidence raids can't fire here at all.
     */
    raidDebt?: number;
    /**
     * Tick OUR corps last harvested in this room (stamped with every
     * raidDebt accrual). The guard's "we mine here" gate reads this - a
     * durable Memory signal of ACTUAL economic activity that cannot flap on
     * a miner death, a re-solve, or lost vision (the stranded-reserver trap;
     * measured in def-t4 dev: both the live-creep lens AND the GOAL-plan
     * lens flapped with home-saturation churn and idled the guard into its
     * recycle grace mid-mission).
     */
    lastHarvested?: number;
    /**
     * Tick Invader-owned creeps were last SIGHTED in the room (the raid
     * observation that reset raidDebt). Recent-sighting + active hostile
     * mark = raid in progress: the guard corp's reactive trigger.
     */
    lastRaidSeen?: number;
    /**
     * Whether an invader CORE structure was in sight on the last sighting of
     * an invader-reserved room. Splits the occupation for the buster corp:
     * true = kill the core first; false = the reservation is a corpse
     * decaying 1/tick - send the CLAIM striker. Cleared with the
     * reservation mark.
     */
    invaderCorePresent?: boolean;
    /** Number of energy sources in the room */
    sourceCount: number;
    /** Positions of energy sources */
    sourcePositions: { x: number; y: number }[];
    /**
     * Real game ids of the sources, index-aligned with sourcePositions. The
     * node-resource refresh prefers these over minting positional
     * `intel-ROOM-X-Y` ids, so a source's flow id - and the commission corpId
     * / harvest corp derived from it - is STABLE across losing vision of the
     * room. Without this, a mined remote whose creeps were wiped (invader)
     * re-registered under a different id on the intel fallback, and the
     * re-solve materialized a SECOND corp for the same physical source, which
     * double-spawned its miner. Optional: entries written before this field
     * fall back to positional ids until re-sighted.
     */
    sourceIds?: string[];
    /** Type of mineral in the room (if any) */
    mineralType: MineralConstant | null;
    /** Position of the mineral (if any) */
    mineralPos: { x: number; y: number } | null;
    /** Controller level (0 if unclaimed) */
    controllerLevel: number;
    /** Position of controller (if any) */
    controllerPos: { x: number; y: number } | null;
    /** Username of controller owner (if owned) */
    controllerOwner: string | null;
    /** Username of controller reserver (if reserved) */
    controllerReservation: string | null;
    /** Number of hostile creeps observed */
    hostileCreepCount: number;
    /** Number of hostile structures observed */
    hostileStructureCount: number;
    /** Whether the room appears safe for operations */
    isSafe: boolean;
  }

  /**
   * Extended global memory with colony persistence.
   */
  interface Memory {
    /**
     * Flag set after one-time memory wipe on respawn.
     * Remove this (and the wipe code in main.ts) after confirming respawn works.
     */
    memoryCleared?: boolean;

    /**
     * Serialized colony state for persistence across ticks.
     */
    colony?: SerializedColony;

    /**
     * Serialized nodes (territories) for persistence.
     */
    nodes?: { [nodeId: string]: SerializedNode };

    /**
     * Edges between nodes (adjacent territories).
     * Format: Array of "nodeId1|nodeId2" strings (sorted alphabetically).
     */
    nodeEdges?: string[];

    /**
     * Walking distances for spatial edges between adjacent nodes.
     * Format: Map of "nodeId1|nodeId2" -> distance in tiles.
     * Calculated from node peak positions.
     */
    spatialEdgeWeights?: { [edge: string]: number };

    /**
     * Economic edges between corp-hosting nodes.
     * Format: Map of "nodeId1|nodeId2" -> distance (sorted alphabetically).
     */
    economicEdges?: { [edge: string]: number };

    /**
     * Tick when last planning phase was run.
     */
    lastPlanningTick?: number;

    /**
     * First tick each still-unmet spawn demand was observed, keyed by
     * "spawnId:buyerCorpId:role". The SpawnDirector stamps it so the scheduler
     * can age a demand: a consumption creep (e.g. a builder) that is continuously
     * outranked by the income tier eventually clears it via anti-starvation. An
     * entry is dropped once its demand stops appearing (the creep was spawned, or
     * the work is gone), resetting the timer.
     */
    spawnDemandFirstSeen?: { [key: string]: number };

    /**
     * Tick when last survey phase was run.
     */
    lastSurveyTick?: number;

    /**
     * Best spawn tile found per node by the fine-grained placement sweep,
     * with the economic value of a spawn there. Written when a sweep completes.
     */
    spawnPlacements?: {
      [nodeId: string]: { x: number; y: number; roomName: string; value: number };
    };

    /**
     * Tick when the controller RCL last increased.
     * Used by FlowEconomy to boost construction priority after RCL-up.
     */
    lastRclUpTick?: number;

    /**
     * The active expansion campaign (spec 06): which room we are claiming and
     * where its founding spawn goes. Persisted so the campaign survives global
     * resets; cleared when the new spawn stands or on EXPAND_TIMEOUT.
     */
    expansion?: {
      roomName: string;
      nodeId: string;
      spawnPos: { x: number; y: number; roomName: string };
      sinceTick: number;
    };

    /**
     * Room map cache metadata (tick when last computed).
     */
    roomMapCache?: { [roomName: string]: number };

    /**
     * Room intelligence data from scouting.
     */
    roomIntel?: { [roomName: string]: RoomIntel };

    /**
     * The black box tail (spec 09 phase 4): the last ~40 flight-recorder rows,
     * kept in Memory so a global reset - often the interesting moment - still
     * leaves evidence. The full ring lives in RawMemory segment 5.
     */
    blackBoxTail?: { t: number; k: string; d: Record<string, unknown> }[];

    /**
     * Arms the CPU governor's load-shedding (spec 09 ph5): set to "on" from
     * the live console. Unset/off = DRY RUN - the governor still black-boxes
     * its would-be level, but sheds nothing (sims/grid must stay
     * deterministic; the mockup meters real CPU, so an armed governor would
     * couple cell behavior to host load - measured, six cells regressed).
     */
    cpuGovernor?: "on" | "off";

    /**
     * THE NOW PLAN (docs/specs/11): per spawn, the ordered acquisition queue
     * the scheduler expects to work through (rank order, costs, must-fund
     * flags) plus the outstanding producer fundingNeed. Published by
     * SpawnDirector each evaluation tick; observability first - the
     * agenda-fidelity cell asserts spawns match the head, and the flow
     * adapter (phase 2) routes fundingNeed toward the spawn network.
     */
    /**
     * Spawn-meter windows (spec 14 phase 3): measured busy ticks per spawn
     * over a rolling ~1500-tick window, accumulated every observed tick by
     * telemetry. `last` guards against double-counting a tick.
     */
    spawnMeter?: {
      [spawnId: string]: { t0: number; last: number; ticks: number; busy: number };
    };

    spawnAgenda?: {
      [spawnId: string]: {
        tick: number;
        fundingNeed: number;
        queue: {
          role: string;
          corp: string;
          minCost: number;
          desiredCost: number;
          mustFund: boolean;
          /** First tick the director saw this demand (starvation-age export). */
          since?: number;
          /** The transition this acquisition implements (spec 11 phase 3). */
          why?: string;
          /** "bank>=N" (head, unaffordable) or "after:<corpId>". */
          precondition?: string;
          /** The decision walk's verdict on this entry (spec 17: "buy" IS the action). */
          gate?: string;
        }[];
        /** Execution receipts (actual-vs-NOW): the last ~8 spawns bought here. */
        executed?: { tick: number; role: string; corp: string; cost: number }[];
      };
    };

    /**
     * Per-corp CPU ledger (spec 20): the corp is the accounting boundary, so
     * CPU joins energy and spawn build-time as a metered, pullable resource.
     * `corpsTotal` is the sum over every commissioned corp this tick -
     * reconcile it against the loop's whole-tick usage to see the
     * infrastructure residual (planner solve, host, telemetry).
     */
    corpCpu?: {
      tick: number;
      corpsTotal: number;
      byKind: { [kind: string]: number };
      /** Worst offenders by ~100-tick EMA, dashboard-sized. */
      top: { corpId: string; kind: string; cpu: number; avg: number }[];
    };

    /**
     * Serialized bootstrap corps by room name.
     */
    bootstrapCorps?: { [roomName: string]: SerializedBootstrapCorp };

    /**
     * @deprecated Harvest/carry/upgrade corps live in commissionedCorps since
     * the framework cutover; these keys are no longer written and exist only in
     * old saves.
     */
    harvestCorps?: { [sourceId: string]: SerializedHarvestCorp };
    /** @deprecated see harvestCorps. */
    haulingCorps?: { [sourceId: string]: SerializedCarryCorp };
    /** @deprecated see harvestCorps. */
    upgradingCorps?: { [roomName: string]: SerializedUpgradingCorp };

    /**
     * Serialized scout corps by room name.
     * @deprecated Scout corps live in commissionedCorps since the framework
     * port; this key is no longer written and exists only in old saves.
     */
    scoutCorps?: { [roomName: string]: SerializedScoutCorp };

    /**
     * The commissioned-corp store (execution/CommissionHost): every corp of a
     * REGISTERED kind, keyed by commission corpId, with its commission and
     * kind-serialized state. Grows kind by kind as the framework port
     * progresses (docs/specs/00-corp-framework.md).
     */
    commissionedCorps?: import("../economy/CorpKind").SerializedCorpStore;

    /**
     * Serialized construction corps by room name.
     */
    constructionCorps?: { [roomName: string]: SerializedConstructionCorp };

    /**
     * Serialized reservation corps by room name.
     * @deprecated Reservation corps live in commissionedCorps since the
     * framework port; this key is no longer written and exists only in old saves.
     */
    reservationCorps?: { [roomName: string]: SerializedReservationCorp };

    /**
     * Serialized spawning corps by spawn ID.
     */
    spawningCorps?: { [spawnId: string]: SerializedSpawningCorp };

    /**
     * Serialized extension tender corps (local movers) by room name.
     * @deprecated Tender corps live in commissionedCorps since the framework
     * port; this key is no longer written and exists only in old saves.
     */
    extensionTenderCorps?: { [roomName: string]: SerializedExtensionTenderCorp };
  }

  /**
   * Extended room memory for colony operations.
   */
  interface RoomMemory {
    /**
     * Node IDs associated with this room.
     */
    nodeIds?: string[];

    /**
     * Tiles createConstructionSite proved permanently invalid (-7), keyed
     * "x,y" -> tick recorded. Written by placeSite, excluded by
     * bestAdjacentTile so candidate generators stop proposing them (the
     * eaten-ladder loop: one bad candidate retried every cooldown forever).
     */
    deadTiles?: { [key: string]: number };

    /**
     * Cached refill bus circuit over spawn + extensions (corps/refillCircuit):
     * a stable tour refillers follow (skipping full stops) and spawning
     * drains in the same order. `sig` invalidates on structure-set changes.
     */
    refillCircuit?: { sig: string; tour: string[] };

    /**
     * Last surveyed tick for this room.
     */
    lastSurveyTick?: number;

    /**
     * The source dedicated to construction while a build is active: its miner
     * feeds the builder's tankers and nothing else touches it (its haulers stand
     * down). Set by ConstructionCorp, read by CarryCorp. Cleared when not building.
     */
    dedicatedBuildSourceId?: string;

    /**
     * Road paving state per source (game id), owned by ConstructionCorp. `tiles`
     * is the planned route as flat [x0,y0,x1,y1,...]. `paved` is the receipt that
     * every tile has a built road - read by flowAdapter.detectPavedSources to
     * stamp the route's haulers with the 2:1 road body ratio. `declined` caches a
     * not-worth-paving verdict so the route is not re-evaluated every cooldown.
     */
    roadRoutes?: {
      [sourceId: string]: {
        /** In-room route: flat (x,y) pairs in THIS room (legacy format). */
        tiles: number[];
        /**
         * Cross-room TRUNK route (owner 2026-07-19): flat (x,y,roomIdx)
         * triples indexed into `rooms`. Present only on trunk routes; such
         * routes keep `tiles` empty.
         */
        tiles3?: number[];
        /** Room-name table for tiles3 roomIdx values. */
        rooms?: string[];
        paved?: boolean;
        declined?: boolean;
      };
    };

    /**
     * True while a core depot exists AND a live extension tender is draining it.
     * Set by ExtensionTenderCorp, read by CarryCorp: when set, haulers run the dumb
     * source->depot bus instead of fanning across extensions; when the tender dies
     * it clears and haulers resume filling the spawn network directly (so a dead
     * tender can never deadlock the colony).
     */
    extensionTenderActive?: boolean;

    /**
     * True while a storage bank exists AND a live controller feeder is relaying it
     * to the controller input. Set by ControllerFeederCorp, read by CarryCorp: when
     * set, controller-bound loads stop at the storage (the feeder runs the short
     * last leg to the upgraders); when the feeder dies it clears and haulers resume
     * delivering to the controller directly (so a dead feeder never starves
     * upgrading).
     */
    controllerFeederActive?: boolean;
  }

  /**
   * Extended creep memory with corp assignment.
   */
  interface CreepMemory {
    /**
     * The corp ID this creep is assigned to.
     */
    corpId?: string;

    /**
     * The type of work this creep performs. Values are DECLARED by each corp
     * kind (CorpKind.roles[].workType - e.g. harvest/haul/tank/feed/upgrade/
     * build/scout/reserve/claim/guard/buster/strike), not enumerated here: a
     * closed union at this distance was an undeclared second registration
     * point every new kind had to find (spec 17). Validity is enforced by the
     * kind-conformance suite against the registry's declarations.
     */
    workType?: string;

    /**
     * Target ID for current task.
     */
    targetId?: string;

    /**
     * Receipt of the creep's last completed energy delivery: a coarse target
     * label, the amount moved, and the tick. An INTENT-LEVEL observability
     * seam: harnesses can assert WHERE a mover sent its load even when
     * interleaved same-tick flows make store deltas unreadable from outside
     * (the haul-t4 bank-deposit lesson). Written on successful transfer only.
     */
    lastDeliver?: { to: string; amount: number; tick: number };

    /**
     * Tender reload stagger (ExtensionTenderCorp): this tender currently
     * holds the fleet's single far-reload pass. Sticky across ticks so a
     * mid-walk reloader is never recalled by a name-order re-sort.
     */
    awayReloading?: boolean;

    /**
     * Source ID for hauling tasks.
     */
    sourceId?: string;

    /**
     * Destination ID for hauling tasks.
     */
    destinationId?: string;

    /**
     * Whether creep is currently working (vs traveling).
     */
    working?: boolean;

    /**
     * Flagged for retirement: the creep is an undersized runt that its corp
     * wants to replace with a full-size body. It heads to the spawn to recycle
     * itself once the room is maxed out and the spawn would otherwise idle.
     */
    recycling?: boolean;

    /**
     * Tick a raid guard lost its room assignment (no targeted room left for
     * it). After GUARD_RECYCLE_GRACE quiet ticks it liquidates back into the
     * spawn - working capital, not a standing army. Cleared on reassignment.
     */
    idleSince?: number;

    /**
     * A builder is mid-diversion: it left its construction work to rescue a
     * structure that decayed into the critical band (about to expire), and
     * keeps repairing until that structure clears the danger band before
     * resuming the build. The latch gives the diversion hysteresis so the
     * crew doesn't thrash between a far site and the container each tick.
     */
    repairingCritical?: boolean;

    /**
     * The structure a maintenance builder is currently repairing. It latches to
     * one target and finishes it (repairs to the ceiling) before switching, so
     * the builder doesn't ping-pong between two similarly-decayed structures,
     * topping up neither. Cleared when the target reaches the ceiling or is gone.
     */
    repairTargetId?: string;
    /** This crew member IS the standing repair detail (owner 2026-07-18:
     * repair and building are separate functions). Sticky for life. */
    repairDetail?: boolean;

    /**
     * ID of the SpawningCorp that spawned this creep.
     */
    spawnedBy?: string;

    /**
     * Contract ID this creep was spawned for.
     */
    contractId?: string;

    /**
     * Whether this is a maintenance hauler spawned by SpawningCorp
     * to break energy starvation. These haulers are assigned to the
     * room's HaulingCorp but don't fulfill contract commitments.
     */
    isMaintenanceHauler?: boolean;

    /**
     * Target room for scout creeps.
     * Each scout gets assigned a unique room to explore.
     */
    targetRoom?: string;

    /**
     * Assigned source ID for hauler creeps.
     * Used to prevent thrashing by giving each hauler a stable route.
     */
    assignedSourceId?: string;

    /**
     * Assigned source position for intel-based remote sources.
     * Used when the source object isn't visible (remote room without vision).
     */
    assignedSourcePos?: { x: number; y: number; roomName: string };

    /**
     * The extension tender's sticky fill destination: held until full/gone so
     * the tender tours the cluster deterministically instead of re-picking
     * nearest-every-tick (dither). Adjacent needy targets are always filled
     * opportunistically regardless of this destination.
     */
    tendTargetId?: string;

    /**
     * A refiller's position on the refill bus circuit (corps/refillCircuit):
     * the index of the stop it is currently serving/heading to. Advances in
     * circuit order, wrapping; full stops are skipped.
     */
    circuitIdx?: number;

    /**
     * Consecutive ticks this creep has HELD in a single-file queue behind another
     * creep ahead of it toward a contended target (corps/movement travelToQueued).
     * Bounds the queue: once it exceeds the patience limit the creep stops waiting
     * and force-swaps through, so a mis-detected or head-on stall can never freeze
     * it permanently. Reset the moment it stops holding.
     */
    queueHeld?: number;

    // === Fleet Coordination (Belt/Bus System) ===

    /**
     * Hauler's slot in the fleet circulation.
     * Determines their starting position in the structure rotation.
     * Assigned once when hauler joins corp, persists for their lifetime.
     */
    haulerSlot?: number;

    /**
     * Current rotation offset in the delivery circulation.
     * Increments after each successful delivery, wraps around.
     * Combined with haulerSlot to determine target structure.
     */
    deliveryRotation?: number;

    /**
     * Current delivery target ID.
     * Persists across ticks to prevent reactive switching.
     * Cleared after successful delivery to trigger rotation.
     */
    deliveryTargetId?: string;

    /**
     * Which sink this hauler is delivering its CURRENT load to. Decided once per
     * trip at fill-up (its home circuit, or the spawn if the spawn network is
     * hungry that tick), then held for the whole trip so it never thrashes
     * mid-route. Cleared when the load is emptied.
     */
    deliverSinkId?: "spawn" | "controller" | "founding" | "storage";

    /**
     * The hauler's PERMANENT delivery circuit, assigned once for life in
     * proportion to the flow solver's per-sink allocations. This is its default
     * destination every trip (overridden only to top up a hungry spawn).
     */
    homeSink?: "spawn" | "controller" | "founding" | "storage";

    /** An upgrader's assigned parking tile (ringing the controller input spot);
     * it camps here, withdraws from the single input, and upgrades in place. */
    upgradeSpot?: { x: number; y: number };

    /**
     * Tick this creep was first seen ORPHANED - alive but with a corpId that
     * matches no live corp, so nothing runs it. The orphan-rescue pass
     * (execution/OrphanRescue) sets it on the first orphaned tick, clears it the
     * moment the creep is re-adopted or its corp reappears, and recycles the
     * creep once it has been orphaned past the grace window. The grace window
     * tolerates the brief commission churn around a flow re-solve so a creep is
     * never recycled for a one-tick gap.
     */
    orphanedSince?: number;
  }
}

export {};
