/**
 * @fileoverview Screeps Memory type extensions.
 *
 * Extends the global Screeps memory interfaces to support
 * colony-based economic system persistence.
 *
 * @module types/Memory
 */

import { SerializedBootstrapCorp, SerializedSpawningCorp } from "../corps";
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
     * Tick the CURRENT hostile episode was first sighted (set with the fresh
     * mark, cleared with it). Pairs with hostileUntil to form the closed
     * window the all-clear retains below (v33 attribution).
     */
    hostileMarkedAt?: number;
    /**
     * The last few CLOSED hostile episodes, retained at the all-clear so
     * death attribution outlives the live mark (v33): the home room's
     * standing vision lifts marks within ticks of a fight ending - before
     * the loss meter books the tombstones - which made every home kill read
     * unattributed (measured t72792889: 3.6% of killed cargo caught).
     * Capped at 3; oldest dropped first.
     */
    hostileWindows?: { from: number; until: number }[];
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
    /**
     * Mineral deposit density level 1-4 (Screeps `mineral.density`). Drives the
     * regen-limited extraction rate in the mineral EV estimate (spec 22).
     * Optional: intel written before this field falls back to unknown (no
     * mineral value credited until re-sighted).
     */
    mineralDensity?: number;
    /** Current ore remaining in the deposit (`mineral.mineralAmount`). */
    mineralAmount?: number;
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
     * Room intelligence data from scouting.
     */
    roomIntel?: { [roomName: string]: RoomIntel };

    /**
     * Cached market price snapshot (spec 22): energy buy price and per-mineral
     * sell prices in credits, sampled from Game.market on a cadence. The mineral
     * EV estimate reads this (falling back to a static snapshot when stale or
     * absent) so sims/grid stay deterministic while live tracks real prices.
     */
    marketPrices?: {
      energy: number;
      minerals: { [mineral: string]: number };
      updated: number;
    };

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
      [spawnId: string]: {
        t0: number;
        last: number;
        ticks: number;
        busy: number;
        /** s.spawning at the previous observation - finish-event edge detector. */
        wasBusy?: boolean;
        /** Build-finish events observed WITH a gap after them (a back-to-back
         * restart keeps spawning true, so it never registers - by design:
         * every counted finish is a duty gap to explain). */
        finishes?: number;
        /** Sum over those finishes of energyAvailable/energyCapacityAvailable
         * AT the finish tick (owner 2026-07-21: "refilling should happen
         * while the other creeps are spawning - or we have to measure and
         * fix that"). Low avg = refill lag (tender); high avg = the spawn
         * was affordable and idled anyway (agenda/decision latency). */
        fillSum?: number;
        /** Idle-tick cause tally (owner 2026-07-25): each non-spawning tick
         * classified by the NOW-plan head - empty (no demand), bank (head
         * unaffordable: energy-starved), buy (decided-buy yet idle: exec
         * latency), hold (affordable but held/queued). Names WHERE the
         * steady-state spawn idle goes. See Telemetry.classifySpawnIdle. */
        idleEmpty?: number;
        idleBank?: number;
        idleBuy?: number;
        idleHold?: number;
      };
    };

    /**
     * Rolling upgrade-WORK utilization per controller room (spawn-meter
     * pattern), tallied at the upgradeController call site: `ticks` =
     * parked upgrader creep-ticks observed, `fired` = ticks the intent
     * returned OK, `dry` = ticks it returned ERR_NOT_ENOUGH_RESOURCES (the
     * input starved the buffer). Prod t72482220: 100 WORK stood at both
     * window endpoints with the stock endpoint full, yet burn averaged
     * 48.7 of ~100 e/t - whether the missing half was supply or idling was
     * unmeasurable. workUtil/dryShare in the upgrader sizing stamp read
     * this window.
     */
    upgradeMeter?: {
      [roomName: string]: {
        t0: number;
        ticks: number;
        fired: number;
        dry: number;
        /** Spec 40-B percentile duty histogram; survives the window roll. */
        hist?: { buckets: number[]; windows: number; openTicks: number; openDuty: number };
      };
    };

    /**
     * Rolling pile-gate delay meter per source (upgradeMeter pattern, owner
     * 2026-07-29: "instrument the spawning delay time for the energy piles").
     * Tallied at the miner pile-gate decision site with the gate's ACTUAL
     * verdict: `samples` = evaluated ticks in the window, `held` = ticks the
     * gate deferred, `since` = first tick of the CURRENT consecutive hold
     * (0 = clear; survives window rolls so heldFor spans them), `last`
     * dedupes multi-collection ticks. Fog never tallies - an unmeasurable
     * buffer must neither reset `since` nor inflate the window. Keyed by the
     * source id tail (slice -6), the sourceBuffers telemetry key, so the two
     * instruments join.
     */
    pileMeter?: {
      [sourceTail: string]: { t0: number; last: number; samples: number; held: number; since: number };
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
     * Tower focus-fire memory (spec 07 v2), per owned room: last tick's hits by
     * hostile id, so TowerRunner can read NET damage (hits<prev = the healer
     * isn't covering that creep) and collapse fire on the uncovered wound. `tick`
     * gates staleness — only the immediately-preceding tick's HP is a valid
     * signal; anything older forces a fresh probe. Deleted when a room clears of
     * hostiles.
     */
    towerTargeting?: { [roomName: string]: { tick: number; hits: { [id: string]: number } } };

    /**
     * The colony's GOAL (spec 18): a weighted blend of named goal profiles,
     * compiled onto the sink-value ladder each solve. Absent = the default
     * profile (today's measured ladder). Set via global.setGoal.
     */
    goal?: { blend: { [profileName: string]: number } };

    /**
     * The last solve's realized bank draw (controller + construction
     * allocations) - the feeder-pricing signal (flowAdapter, the starvation
     * loop). In Memory because the FlowEconomy instance is replaced on every
     * graph rebuild: instance-held history never survived to a second solve
     * (prod t72447816).
     */
    lastBankDraw?: number;

    /**
     * The last solve's converged PER-SPAWN fleet charge (the spawn sink's
     * maintenance term). Seeds the next solve's fixed-point iteration, which is
     * what lets a steady-state replan converge without spending extra searches
     * re-deriving a number that barely moved. In Memory for the same reason as
     * `lastBankDraw`: the FlowEconomy instance is replaced on every graph
     * rebuild, so instance-held history never reaches a second solve.
     */
    lastFleetCharge?: number;

    /**
     * The last solve's fleet-mix ENERGY PER PART (fleet energy over the parts
     * ledger's planned parts) - prices the spawn sink's physical conversion
     * ceiling (primitives.spawnEnergyCeiling) on the NEXT solve, threaded
     * exactly like lastFleetCharge. Undefined until the first solve after a
     * wipe: the sink claim stays uncapped for exactly one solve rather than
     * capped at a guessed mix.
     */
    lastFleetEnergyPerPart?: number;

    /**
     * Arms the per-tick hauler flight recorder (telemetry/HaulTrace). Every
     * other hauling instrument is an aggregate, and a mean cannot show a creep
     * standing on one tile for forty ticks. Set from the live console:
     *   Memory.haulTrace = { corp: "mining-W43N24-harvest-cd8e" }
     *   Memory.haulTrace = { creep: "h_1234" }
     * Deleting it stops the recorder. The subject is locked once chosen so the
     * trace follows ONE life rather than hopping between creeps.
     */
    haulTrace?: { corp?: string; creep?: string };

    /**
     * CUMULATIVE loss totals in energy (telemetry/LossMeter), monotonic and
     * surviving global resets. In Memory because the measured window must be
     * bounded by how far apart two captures are, not by VM lifetime: as module
     * state it capped at ~480 ticks against a 1251-tick capture window
     * (t72722670), so a 1500-tick fiscal month was never measurable end to end.
     * The account differences these, exactly as it does gcl.progress.
     */
    lossLedger?: {
      pileDecay: number;
      structureDecay: number;
      repairSpend: number;
      tombstoneGross: number;
      tombstoneRecovered: number;
      /** Additive attribution keys (2026-08-02); absent on older ledgers. */
      tombstoneByRole?: Record<string, number>;
      tombstoneExpired?: number;
      tombstoneKilled?: number;
      tombstoneCauseUnknown?: number;
      tombstoneTtlSum?: number;
      tombstoneTtlKnown?: number;
    };

    /**
     * CUMULATIVE spawn spend by role (telemetry/spawnLedger), monotonic and
     * surviving global resets - the blackbox ring's account-side replacement.
     * The ring is heap state bounded by VM lifetime (~480t after a deploy),
     * so every "measured at the spawn" account line was short-windowed and
     * the account's coherence guard fired on essentially every fiscal close.
     * The account differences these totals between two captures instead,
     * exactly as it does gcl.progress, storage, and lossLedger.
     */
    spawnLedger?: {
      energyByRole: Record<string, number>;
      partsByRole: Record<string, number>;
    };

    /**
     * THE HANDICAP SWEEP (economy/spawnSweep, owner 2026-08-06). The planner's
     * spawn-capacity margin, walked 0%..20% one step per fiscal month so each
     * month's income statement describes exactly one handicap.
     *
     * ABSENT MEANS UNARMED, and that is the safety property: every grid cell,
     * sim and unit test - and a live colony whose Memory was wiped - falls back
     * to the static SPAWN_PLAN_FRACTION (0.9, measured-good), never to the 1.0
     * that overheated the colony on 2026-08-04.
     */
    spawnSweep?: {
      pct: number;
      step: number;
      lastBoundary: number;
      cycle: number;
      lastProgress?: number;
      stepReason?: string;
    };

    /**
     * THE FISCAL ARCHIVE (telemetry/fiscalArchive, spec 50). A ring of
     * month-boundary accounting snapshots the bot takes itself, published to
     * segment 8, so an unattended fiscal month is still closeable long after it
     * ended. Memory-backed for the same reason as lossLedger and spawnLedger
     * above: heap state is bounded by VM lifetime (~480t), which is shorter
     * than the 1500-tick month it would have to survive.
     */
    fiscalArchive?: {
      recs: Record<string, unknown>[];
      pending?: number;
      dropped?: number;
    };

    /**
     * Death watch (telemetry/LossMeter): each own creep's last-seen TTL as
     * `[ttl, tick]`, sampled on the loss stride. A dead creep's object has no
     * ticksToLive, so tombstone cause (expired vs killed) is resolvable only
     * from a record made while the creep lived: lastSeenTtl - (deathTime -
     * lastSeenTick) is exact whenever the creep survived to its recorded
     * deathTime. Entries are pruned once no tombstone for them could still be
     * standing.
     */
    creepDeathWatch?: Record<string, [number, number]>;

    /**
     * The current liquidity reserve target (economy/bank.warchestTarget of the
     * last solve's measured income). Persisted so every consumer - the plan's
     * bank-surplus emission and the execution corps that size off it - reads
     * ONE number and cannot drift. Written by FlowEconomy.update; read through
     * bank.resolveReserveTarget, which falls back to BASE_RESERVE before the
     * first solve publishes one.
     */
    warchestTarget?: number;

    /**
     * The plan's routed controller allocation per room (energy/tick), from the
     * last solve's sink allocations (spec 38 phase B - the plan allocation is
     * the valve). Written by FlowEconomy.update; resolved through the pure
     * lens bank.plannedControllerFlow(Memory.controllerAllocations, room).
     * Runtime readers that ask "how fast does energy reach this controller"
     * (the feeder trunk's road-payback judge) resolve THIS instead of
     * re-deriving a rate from the bank - the feederRelayRate side-channel
     * spec 38 retires.
     */
    controllerAllocations?: Record<string, number>;

    /**
     * Event-triggered replanning state (spec 36 item 1): the previous
     * durable-signal snapshot and the last forced-solve tick, persisted so a
     * global reset re-seeds the baseline instead of misreading the fresh
     * heap as a world transition. Written and read only by
     * execution/planTriggers.checkPlanTriggers.
     */
    planTriggerState?: {
      snap: {
        hostileRooms: string[];
        expansionState?: string;
        rclByRoom: Record<string, number>;
        spawnCount: number;
      };
      lastForced?: number;
    };

    /**
     * Remote rooms the last solve FUNDED miners in (FlowSolution
     * .fundedRemoteRooms). Threaded back into the next solve so infra's
     * reserver upkeep prices the worked set, not every scouted candidate
     * (t72750467: 26 candidates vs 8 funded, ~10 e/t phantom charge).
     * Written by FlowEconomy.update, same lifetime as lastBankDraw.
     */
    fundedRemoteRooms?: string[];

    /**
     * Per-corp CPU ledger (spec 20): the corp is the accounting boundary, so
     * CPU joins energy and spawn build-time as a metered, pullable resource.
     * `corpsTotal` is the sum over every commissioned corp this tick -
     * reconcile it against the loop's whole-tick usage to see the
     * infrastructure residual (planner solve, host, telemetry).
     */
    /**
     * P-CPU meter (spec 23 step 1): moveTo CPU per corp FAMILY this tick,
     * the measured BEFORE number for the cached-routes doctrine. Written by
     * corps/movement.meteredMoveTo, reset on tick change, exported in core
     * telemetry (v10).
     */
    pathMeter?: {
      tick: number;
      calls: number;
      cpu: number;
      byCorp: { [family: string]: { calls: number; cpu: number } };
    };

    corpCpu?: {
      tick: number;
      corpsTotal: number;
      byKind: { [kind: string]: number };
      /** Worst offenders by ~100-tick EMA, dashboard-sized. */
      top: { corpId: string; kind: string; cpu: number; avg: number }[];
      /** Named infrastructure buckets (spec 20 P2): the bulkheaded phases. */
      infra?: { [bucket: string]: number };
      /** Whole-tick CPU at publish - the reconciliation anchor. */
      wholeTick?: number;
    };

    /**
     * Diagnostic: persistState's CPU (execution/Persistence), split so a
     * future hog inside persist is attributable before optimizing.
     */
    /**
     * Debug overlays (node/spatial RoomVisuals) on/off. Undefined/false = off
     * (the default) - they cost ~35 CPU/tick and are only visible with the
     * client open. Toggle from the console via global.visuals().
     */
    visuals?: boolean;

    persistBreakdown?: {
      tick: number;
      total: number;
      serialize: number;
      nodeCount: number;
      edgeCount: number;
    };

    /**
     * Serialized bootstrap corps by room name.
     */
    bootstrapCorps?: { [roomName: string]: SerializedBootstrapCorp };

    /**
     * The commissioned-corp store (execution/CommissionHost): every corp of a
     * REGISTERED kind, keyed by commission corpId, with its commission and
     * kind-serialized state. Grows kind by kind as the framework port
     * progresses (docs/specs/00-corp-framework.md).
     */
    commissionedCorps?: import("../economy/CorpKind").SerializedCorpStore;

    /**
     * Serialized spawning corps by spawn ID (one of the two legacy-registry
     * kinds still outside the commission store - see completeCensus).
     */
    spawningCorps?: { [spawnId: string]: SerializedSpawningCorp };
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
     * not-worth-paving verdict AT the flow it was judged with (`judgedFlow`) so
     * the route is not re-evaluated every cooldown - but the verdict is VOIDED
     * and re-judged when live flow rises materially past the judged level
     * (roadEconomics.declinedVerdictStands; reservation's 5->10 doubling of a
     * remote source clears the bar by design).
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
        /**
         * Trunk build progress, survey-persisted each placement pass:
         * verified built road tiles (RATCHETS up - a vision-lost pass never
         * counts down, or the hauler body would flap around the repricing
         * threshold) out of `total` route tiles. detectPavedSources reads
         * built/total as the paved fraction; at >= 1/2 (roadEconomics.
         * PARTIAL_PAVE_REPRICE_FRACTION) the source's haulers reprice to the
         * 2:1 road body BEFORE the binary `paved` receipt lands.
         */
        built?: number;
        total?: number;
        declined?: boolean;
        /** Flow (e/t) the declined verdict was judged at (absent on legacy entries). */
        judgedFlow?: number;
        /**
         * Last tick a PAVED route was re-surveyed for potholes
         * (ConstructionCorp.resurveyPavedRoutes, cadence
         * ROAD_RESURVEY_INTERVAL). Roads decay and invaders destroy them, so
         * `paved` is a receipt with a shelf life, not a permanent verdict: on
         * the beat the corp re-reads the tiles and, if a road is GONE, drops
         * the receipt and re-places the site. Absent = never re-surveyed
         * (legacy entries and freshly-paved routes are due at once, which
         * costs one cheap sweep and self-stamps).
         */
        resurveyed?: number;
      };
    };

    /**
     * Empirical road-usage heatmap (execution/roadTracker + economy/roadScoring).
     * `scores` maps a packed tile index (x*50+y) to the accumulated move-fatigue
     * a road on that tile would have saved the creeps that stepped on it - the
     * MEASURED counterpart to roadEconomics's a-priori route pricing. Decays on a
     * cadence so it tracks recent traffic, and is trimmed to the hottest tiles to
     * stay bounded. `updated` is the last tick a step was credited. Read via
     * roadCandidateTiles to rank where roads should go.
     */
    roadScores?: {
      scores: { [packed: number]: number };
      updated: number;
    };

    /**
     * LIVENESS: true while a core depot exists AND a live extension tender is
     * draining it. Set by ExtensionTenderCorp each tick; kept for telemetry and
     * the depot-reserve nuances (spawnNetworkHungry's bridge buffer).
     */
    extensionTenderActive?: boolean;

    /**
     * STRUCTURAL (owner 2026-07-22 accountability ruling: "each corp needs to
     * do their job, not cover for each other"): true while a core depot AND
     * extensions exist - extension refill is the tender corp's JOB here,
     * whether or not a tender is alive this tick. Read via the
     * tenderOwnsExtensions lens (corps/regimes.ts, the regime lenses' neutral
     * home): haulers run the dumb source->depot bus and
     * never fan across extensions in a covered room; a dead tender is
     * re-fielded by the corp's own bootstrap demand (value 150), not covered
     * for. Haulers still top the SPAWN STRUCTURE either way, so a tender gap
     * can never deadlock the colony.
     */
    extensionTenderCovered?: boolean;

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
     * Tick this hauler began holding at a FULL deposit port (spec 26, owner
     * 2026-07-24). Set on the first "wait" verdict, cleared once it deposits or
     * falls back - the wait clock that bounds camping at a chronically stuck
     * link (pickStorageDeposit / PORT_WAIT_CAP).
     */
    portWaitSince?: number;

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
     * The controller feeder's current core-link direction (spec 02 feeder-
     * router): "load" = storage -> core (top the relay), "drain" = core ->
     * storage (bank the surplus / keep the core open for source volleys).
     * Decided only while empty-handed so the feeder never flip-flops mid-trip.
     */
    linkMode?: "load" | "drain";

    /**
     * Flagged for retirement: the creep is an undersized runt that its corp
     * wants to replace with a full-size body. It heads to the spawn to recycle
     * itself once the room is maxed out and the spawn would otherwise idle.
     */
    recycling?: boolean;

    /**
     * WHY the recycle flag was set (owner 2026-08-03: "I wanna make sure
     * those are legit - what's actually the cause and does it hold up to
     * scrutiny"). Stamped at the SAME site as `recycling` (a ratchet test
     * pins every flag site), carried by the death watch into the loss
     * meter's tombstoneRecycledByReason - so the account attributes each
     * recycle to its trigger class instead of one opaque bucket.
     */
    recycleReason?: string;

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
    /**
     * The construction site a builder is currently building. The build-side
     * twin of repairTargetId (owner 2026-07-22: "they can't ping-pong around
     * ... they just go to a site, stay there, get tankers coming, and build"):
     * a builder LATCHES to one site and finishes it before moving to the
     * NEAREST next one - a sequential sweep over the project instead of a
     * per-tick findClosestByPath that flips targets as the creep drifts and
     * sites complete. Cleared when the site is gone (built) or none remain.
     */
    buildTargetId?: string;
    /** This crew member IS the standing repair detail (owner 2026-07-18:
     * repair and building are separate functions). Sticky for life. */
    repairDetail?: boolean;

    /**
     * ID of the SpawningCorp that spawned this creep.
     */
    spawnedBy?: string;

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

    /** Hauler duty meter (owner 2026-07-25): last tick's position + carried
     * energy, so CarryCorp can tell a productive tick (moved or transacted)
     * from an idle one (stationary, waiting/blocked to load or unload) and
     * split idle by the load state. Persists across global resets (creep
     * memory), so the meter reads realized movement, not intents. */
    dutyPos?: { x: number; y: number; roomName: string };
    dutyEnergy?: number;

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
