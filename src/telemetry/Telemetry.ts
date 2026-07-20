/**
 * @fileoverview Telemetry system for exporting game data to RawMemory segments.
 *
 * This module writes telemetry data to RawMemory segments each tick (or periodically),
 * enabling an external app to poll the Screeps HTTP API and visualize colony state.
 *
 * ## Segment Layout
 * - Segment 0: Core telemetry (colony stats, money supply, creep counts)
 * - Segment 1: Node data (territories, resources, ROI)
 * - Segment 2: Edge data (spatial and economic edges with flow rates)
 * - Segment 3: Room intel data (scouted room information)
 * - Segment 4: Corps data (mining, hauling, upgrading corps)
 * - Segment 6: Flow economy (sources, sinks, allocations)
 *
 * ## Data Flow
 * Screeps Game → RawMemory.segments[N] → HTTP API → External App → Dashboard
 *
 * @module telemetry/Telemetry
 */

import { Colony } from "../colony/Colony";
import { Corp, CorpSizingRecord } from "../corps/Corp";
import { controllerSideStock } from "../corps/nodeEnergy";
import { FlowSolution } from "../flow/FlowTypes";
import {
  BUILD_ENERGY_PER_WORK,
  HARVEST_ENERGY_PER_WORK,
  SPAWN_PARTS_PER_TICK,
  UPGRADE_ENERGY_PER_WORK,
  workPartsForEnergyRate
} from "../economy/primitives";

/** Spawn-meter window length: one creep lifetime, the economy's natural period. */
const SPAWN_METER_WINDOW = 1500;

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
 * One corp in the complete census (structurally compatible with
 * CommissionHost.CorpCensusEntry - the caller passes that array here). Kept
 * local so telemetry does not depend on the execution layer.
 */
export interface CorpCensusEntry {
  corpId: string;
  kind: string;
  corp: Corp;
}

/** Live creep count for any corp, whichever accessor it exposes. */
function corpCreepCount(corp: Corp): number {
  const c = corp as unknown as { getCreepCount?: () => number; getPendingOrderCount?: () => number };
  if (typeof c.getCreepCount === "function") return c.getCreepCount();
  if (typeof c.getPendingOrderCount === "function") return c.getPendingOrderCount();
  return 0;
}

/** Room name for a corp, derived from its nodeId prefix. */
function corpRoomName(corp: Corp): string {
  return corp.nodeId.split("-")[0] || "unknown";
}

/**
 * A measured body: total part count plus a per-type breakdown (only non-zero
 * types present). Keys are the raw Screeps part types ("work", "carry", ...).
 */
export interface BodyAggregate {
  total: number;
  byPart: { [part: string]: number };
}

/** Fresh, empty aggregate. */
function emptyBody(): BodyAggregate {
  return { total: 0, byPart: {} };
}

/**
 * Aggregate ACTUAL body parts from every live creep (`Creep.body`), grouped by
 * the corp that owns it (`memory.corpId`). This is measured ground truth - NOT
 * reconstructed from planner harvest rates (the flow segment's `workParts` is
 * the PLAN side; this is the ACTUAL side) - so a dashboard can sit the planner's
 * committed parts next to the parts actually walking around.
 *
 * One pass yields both views: `perCorp` (keyed by corpId, for the corps
 * segment) and `colony` (every creep, orphans included, for the core segment) -
 * a creep we are paying for counts colony-wide even when no live corp claims it.
 */
function aggregateActualBodies(): { perCorp: Map<string, BodyAggregate>; colony: BodyAggregate } {
  const perCorp = new Map<string, BodyAggregate>();
  const colony = emptyBody();

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const body = creep.body ?? []; // spawning/mocked creeps may lack a body
    if (body.length === 0) continue;

    const corpId = creep.memory?.corpId;
    let bucket: BodyAggregate | undefined;
    if (corpId) {
      bucket = perCorp.get(corpId);
      if (!bucket) {
        bucket = emptyBody();
        perCorp.set(corpId, bucket);
      }
    }

    for (const part of body) {
      const t = part.type;
      colony.total++;
      colony.byPart[t] = (colony.byPart[t] || 0) + 1;
      if (bucket) {
        bucket.total++;
        bucket.byPart[t] = (bucket.byPart[t] || 0) + 1;
      }
    }
  }

  return { perCorp, colony };
}

/**
 * Segment assignments for telemetry data.
 */
export const TELEMETRY_SEGMENTS = {
  CORE: 0, // Colony stats, money supply, creep counts
  NODES: 1, // Node territories, resources, ROI
  EDGES: 2, // Spatial and economic edges with flow rates
  INTEL: 3, // Room intel from scouting
  CORPS: 4, // Corps details
  FLOW: 6 // Flow economy: sources, sinks, allocations
};

/**
 * Segments to make publicly readable via API.
 */
export const PUBLIC_SEGMENTS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Core telemetry data structure (Segment 0).
 */
export interface CoreTelemetry {
  /** Telemetry format version */
  version: number;
  /** Current game tick */
  tick: number;
  /** Shard name */
  shard: string;
  /** CPU usage this tick */
  cpu: {
    used: number;
    limit: number;
    bucket: number;
    tickLimit: number;
  };
  /** GCL information */
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
  };
  /** Colony stats */
  colony: {
    nodeCount: number;
    totalCorps: number;
    activeCorps: number;
  };
  /**
   * Creep census. `total` is the ground truth (every creep in the game);
   * `tracked` is the sum of the per-role buckets (creeps claimed by a live
   * corp); `untracked = total - tracked` (orphans, recyclers, newborns not yet
   * claimed). Every creep-owning corp kind has a bucket, so the buckets and
   * `total` reconcile - no kind can hide.
   */
  creeps: {
    total: number;
    tracked: number;
    untracked: number;
    /**
     * Creeps whose memory.corpId matches NO census corp (id-match lens,
     * distinct from the count-difference lens above) - the X3 leak, named.
     * Capped at 8 rows; absent when empty.
     */
    unattributed?: { name: string; corpId: string | null; workType?: string; ttl?: number }[];
    /**
     * Corps whose id-attributed creep count differs from their own
     * getCreepCount - the counting-lens mismatch that explains untracked>0
     * with an empty unattributed roster. Rows only where the two differ,
     * capped at 8.
     */
    countMismatch?: { corpId: string; claimed: number; counted: number }[];
    /**
     * Creep counts keyed by commission KIND (harvest/carry/...), derived from
     * the census generically: a registered kind whose corps expose
     * getCreepCount is counted by construction (the hand-maintained bucket
     * map this replaces had already silently dropped raidGuard + coreBuster).
     * `spawning` never appears (it spawns other corps' creeps and exposes
     * pending orders, not a creep count).
     */
    byKind: { [kind: string]: number };
  };
  /**
   * ACTUAL body parts across every live creep, measured from `Creep.body` (not
   * reconstructed from planner rates). `total` is every part in the world;
   * `byPart` breaks it down by type ("work"/"carry"/"move"/...). This is the
   * measured "what we have" for the plan-vs-actual body-parts gauge.
   */
  bodyParts: BodyAggregate;
  /**
   * Spawn meter (spec 14 phase 3): MEASURED utilization per spawn over a
   * rolling ~1500-tick window. Every busy tick builds exactly 1/3 part, so
   * `partsPerTick = utilization / 3` - no spawn-start detection, no receipt
   * arithmetic. `ceiling` is the physical limit (SPAWN_PARTS_PER_TICK) so
   * "X% of ceiling" is a read, not a derivation.
   */
  spawns: {
    id: string;
    name: string;
    /** Observed ticks in the current window. */
    windowTicks: number;
    /** busyTicks / windowTicks (0 when nothing observed yet). */
    utilization: number;
    /** Actual parts/tick built = utilization / 3. */
    partsPerTick: number;
    /** Physical ceiling (SPAWN_PARTS_PER_TICK = 1/3). */
    ceiling: number;
    /** Current agenda queue length for this spawn (0 when no agenda). */
    queueDepth: number;
  }[];
  /**
   * NOW-plan mirror (spec 14 phase 4): Memory.spawnAgenda queue heads (first
   * 4, VERBATIM) + executed receipts per spawn, so actual-vs-NOW is a
   * telemetry read instead of a /user/memory pull. Absent when no agenda.
   */
  agenda?: {
    [spawnId: string]: {
      tick: number;
      fundingNeed: number;
      queueDepth: number;
      queue: unknown[];
      executed: unknown[];
    };
  };
  /**
   * The home-first remote gate's decision record (v7), copied verbatim from
   * Memory.remoteGate: whether remotes are unlocked, and when not, exactly
   * which home source the live lens found unstaffed (miner/hauler halves
   * named). The warmup remote-drop class is diagnosed from THIS, not from
   * inferring creep assignments out of the census.
   */
  remoteGate?: {
    tick: number;
    saturated: boolean;
    until?: number;
    missing?: { source: string; room: string; miner: boolean; hauler: boolean }[];
  };
  /**
   * Per-source BUFFER levels (v7 additive): energy standing at each visible
   * source's mouth - container store within range 1 plus dropped piles
   * within range 1 - keyed by the source id's last 6 chars. The over/under
   * haul diagnostic (owner 2026-07-20): a buffer pinned near container cap
   * (2000) means mining outruns hauling (rot); chronically ~0 with an
   * active miner means hauling has headroom (or over-provision). Only
   * rooms with vision contribute.
   */
  sourceBuffers?: { [idTail: string]: number };
  /** Owned rooms summary */
  rooms: {
    name: string;
    rcl: number;
    rclProgress: number;
    rclProgressTotal: number;
    energyAvailable: number;
    energyCapacity: number;
    /**
     * Room energy ledger (spec 14 phase 1) - the stocks decisions read, via
     * the same lenses. null = no such store exists (a storage-less room and an
     * empty storage are different facts).
     */
    /** Warchest balance: storage energy, or null when the room has no storage. */
    storageEnergy: number | null;
    /** Energy pooled at the controller side (controllerSideStock lens). */
    controllerStock: number | null;
    /** Is the controller feeder actively relaying storage -> controller? */
    feederActive: boolean;
    /**
     * Construction delivery inputs (v6, ledger P8 "builders not building"):
     * my sites' summed progress / progressTotal and count. A window where
     * sites stand, allocation flows, and siteProgress is FLAT = build crew
     * idle (completions read ambiguous and are skipped by the meter).
     */
    siteProgress: number;
    siteTotal: number;
    siteCount: number;
  }[];
}

/**
 * Node telemetry data structure (Segment 1).
 * Uses compact keys to minimize size:
 * - id, r=roomName, p=peakPosition, t=territorySize
 * - res=resources, roi, spans=spansRooms
 */
export interface NodeTelemetry {
  version: number;
  tick: number;
  nodes: {
    id: string;
    r: string; // roomName
    p: { x: number; y: number; r: string }; // peakPosition
    t: number; // territorySize
    res: {
      // resources (compact)
      t: string; // type
      x: number;
      y: number;
    }[];
    roi?: {
      s: number; // score
      e: number; // expansionScore
      o: number; // openness
      d: number; // distanceFromOwned
      own: boolean; // isOwned
      src: number; // sourceCount
      ctrl: boolean; // hasController
    };
    spans: string[]; // spansRooms
    econ?: boolean; // is part of economic network (has corps)
    sp?: number; // number of spawn structures in this node's room
  }[];
  /** @deprecated Edges moved to segment 2 (EdgesTelemetry) in version 5 */
  edges?: string[];
  /** @deprecated Economic edges moved to segment 2 (EdgesTelemetry) in version 5 */
  economicEdges?: { [edge: string]: number };
  summary: {
    totalNodes: number;
    ownedNodes: number;
    expansionCandidates: number;
    totalSources: number;
    avgROI: number;
  };
}

/**
 * Edges telemetry data structure (Segment 2).
 * Uses compressed numeric format to minimize size:
 * - nodeIndex maps node position in nodes array to node ID
 * - edges are [idx1, idx2] pairs (indices into nodeIndex)
 * - economicEdges are [idx1, idx2, distance, flowRate?] - flowRate is energy/tick
 */
export interface EdgesTelemetry {
  version: number;
  tick: number;
  /** Node IDs in index order - position = index for edge references */
  nodeIndex: string[];
  /** Spatial edges as [idx1, idx2] pairs (indices into nodeIndex) */
  edges: [number, number][];
  /** Economic edges as [idx1, idx2, distance, flowRate?] - flowRate in energy/tick */
  economicEdges: [number, number, number, number?][];
}

/**
 * Intel telemetry data structure (Segment 3).
 */
export interface IntelTelemetry {
  version: number;
  tick: number;
  rooms: {
    name: string;
    lastVisit: number;
    sourceCount: number;
    sourcePositions: { x: number; y: number }[];
    mineralType: string | null;
    mineralPos: { x: number; y: number } | null;
    controllerLevel: number;
    controllerPos: { x: number; y: number } | null;
    controllerOwner: string | null;
    controllerReservation: string | null;
    hostileCreepCount: number;
    hostileStructureCount: number;
    isSafe: boolean;
    /** Spec 12/13 defense state - previously invisible to dashboards. */
    hostileUntil?: number;
    invaderReservedUntil?: number;
    invaderCorePresent?: boolean;
    raidDebt?: number;
    lastRaidSeen?: number;
    reservedUntil?: number;
    reservedBy?: string;
  }[];
}

/**
 * Corps telemetry data structure (Segment 4).
 */
export interface CorpsTelemetry {
  version: number;
  tick: number;
  corps: {
    id: string;
    /** Commission kind (harvest/carry/reservation/tender/...) - the precise operator */
    kind: string;
    /** CorpType (mining/hauling/moving/...) - note tender & feeder share "moving" */
    type: string;
    nodeId: string;
    roomName: string;
    creepCount: number;
    /** Total ACTUAL body parts across this corp's live creeps (measured, 0 if none). */
    bodyParts: number;
    /** ACTUAL body parts by type for this corp's live creeps; {} when it has none. */
    body: { [part: string]: number };
    /**
     * Inputs of the corp's last sizing decision, exported verbatim from the
     * decision-site stamp (spec 14 phase 2). Absent for corps that don't stamp.
     */
    sizing?: CorpSizingRecord;
    createdAt: number;
    lastActivityTick: number;
  }[];
  summary: {
    totalCorps: number;
    /** Corps with at least one live creep */
    activeCorps: number;
    /** Count of corps by commission kind (every kind, including aux kinds) */
    corpsByKind: { [kind: string]: number };
  };
}

/**
 * Flow telemetry data structure (Segment 6).
 * Shows flow economy state: sources, sinks, and energy flow.
 */
export interface FlowTelemetry {
  version: number;
  tick: number;
  /** The fill's spawn-parts ledger (v4): capacity/minerLoad/infra/budget. */
  partsLedger?: { capacity: number; minerLoad: number; infra: number; budget: number };
  /** Problem-assembly counts (v5): names the layer that dropped sources. */
  assembly?: { graphSources: number; mined: number; transient: number; bank: number };
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
 * Telemetry configuration.
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;
  /** Tick interval for full telemetry update (0 = every tick) */
  updateInterval: number;
  /** Tick interval for terrain update (expensive, should be infrequent) */
  terrainInterval: number;
}

/**
 * Default telemetry configuration.
 */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  updateInterval: 1, // Every tick for core data
  terrainInterval: 1000 // Every 1000 ticks for terrain (rarely changes)
};

/**
 * Telemetry system for exporting game data to RawMemory segments.
 */
export class Telemetry {
  private config: TelemetryConfig;

  public constructor(config: Partial<TelemetryConfig> = {}) {
    this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
  }

  /**
   * Updates all telemetry data in RawMemory segments.
   * Call this from the main game loop.
   */
  public update(colony: Colony | undefined, census: CorpCensusEntry[], flowSolution?: FlowSolution): void {
    if (!this.config.enabled) return;

    // Set public segments for API access
    RawMemory.setPublicSegments(PUBLIC_SEGMENTS);

    // Request segments we'll be writing to
    RawMemory.setActiveSegments(PUBLIC_SEGMENTS);

    // Spawn meter accumulates EVERY observed tick, before the interval gate -
    // sampling busy state on an interval would systematically undercount.
    this.meterSpawns();

    // Check if we should update based on interval
    const shouldUpdate = this.config.updateInterval === 0 || Game.time % this.config.updateInterval === 0;

    if (!shouldUpdate) return;

    // Measure ACTUAL bodies once (single pass over Game.creeps); core wants the
    // colony total, corps wants the per-corp breakdown.
    const bodies = aggregateActualBodies();

    // Update core telemetry (always)
    this.updateCoreTelemetry(colony, census, bodies.colony);

    // Update nodes telemetry
    this.updateNodesTelemetry(colony);

    // Update edges telemetry (segment 2 - with flow rates)
    this.updateEdgesTelemetry(colony, flowSolution);

    // Update intel telemetry
    this.updateIntelTelemetry();

    // Update corps telemetry
    this.updateCorpsTelemetry(census, bodies.perCorp);

    // Update flow telemetry (sources, sinks, allocations)
    this.updateFlowTelemetry(flowSolution);
  }

  /**
   * Accumulate the spawn meter: one observation per spawn per tick (the `last`
   * guard makes a second update() call in the same tick a no-op). Windows roll
   * after SPAWN_METER_WINDOW ticks.
   */
  private meterSpawns(): void {
    const spawns = Game.spawns ?? {};
    const meter = (Memory.spawnMeter = Memory.spawnMeter ?? {});
    for (const name in spawns) {
      const s = spawns[name];
      let w = meter[s.id];
      if (!w || Game.time - w.t0 >= SPAWN_METER_WINDOW) {
        w = meter[s.id] = { t0: Game.time, last: -1, ticks: 0, busy: 0 };
      }
      if (w.last === Game.time) continue;
      w.last = Game.time;
      w.ticks++;
      if (s.spawning) w.busy++;
    }
  }

  /**
   * Updates core telemetry (Segment 0).
   */
  private updateCoreTelemetry(colony: Colony | undefined, census: CorpCensusEntry[], bodyParts: BodyAggregate): void {
    // Creep census keyed by kind, summed generically from the complete corp
    // list: every creep-owning kind is counted by construction. Only corps
    // that expose getCreepCount contribute (spawning tracks pending orders,
    // not creeps of its own).
    const creeps: CoreTelemetry["creeps"] = {
      total: Object.keys(Game.creeps).length,
      tracked: 0,
      untracked: 0,
      byKind: {}
    };
    for (const { kind, corp } of census) {
      const counter = corp as unknown as { getCreepCount?: () => number };
      if (typeof counter.getCreepCount !== "function") continue;
      const n = counter.getCreepCount();
      creeps.byKind[kind] = (creeps.byKind[kind] ?? 0) + n;
      creeps.tracked += n;
    }
    creeps.untracked = Math.max(0, creeps.total - creeps.tracked);
    // NAME the leak (X3 sat at 3-4 for days with no names): creeps whose
    // memory.corpId resolves to NO census corp, listed with the id they
    // claim. This is its OWN lens (id-match), deliberately separate from the
    // count difference above (corp-side getCreepCount) - the two disagreeing
    // is itself a diagnostic (a corp counting creeps it doesn't own, or one
    // owning creeps it doesn't count).
    const censusIds = new Set(census.map(c => (c.corp as unknown as { id?: string }).id).filter(Boolean));
    const unattributed: NonNullable<CoreTelemetry["creeps"]["unattributed"]> = [];
    for (const name in Game.creeps) {
      const m = (Game.creeps[name].memory ?? {}) as { corpId?: string; workType?: string };
      if (m.corpId && censusIds.has(m.corpId)) continue;
      if (unattributed.length >= 8) break;
      unattributed.push({
        name,
        corpId: m.corpId ?? null,
        ...(m.workType ? { workType: m.workType } : {}),
        ...(Game.creeps[name].ticksToLive !== undefined ? { ttl: Game.creeps[name].ticksToLive } : {})
      });
    }
    if (unattributed.length > 0) creeps.unattributed = unattributed;
    // The two lenses disagreeing NAMES the leak class (t72445817: untracked 3,
    // unattributed EMPTY - so corps exist that don't COUNT creeps they own,
    // the newborn/recycling counting-lens class, not orphans). This export
    // names the corp: id-attributed creep count vs the corp's own
    // getCreepCount, rows only where they differ.
    const claimedByCorp = new Map<string, number>();
    for (const name in Game.creeps) {
      const cid = ((Game.creeps[name].memory ?? {}) as { corpId?: string }).corpId;
      if (cid) claimedByCorp.set(cid, (claimedByCorp.get(cid) ?? 0) + 1);
    }
    const countMismatch: NonNullable<CoreTelemetry["creeps"]["countMismatch"]> = [];
    for (const { corp } of census) {
      const c = corp as unknown as { id?: string; getCreepCount?: () => number };
      if (!c.id || typeof c.getCreepCount !== "function") continue;
      const claimed = claimedByCorp.get(c.id) ?? 0;
      const counted = c.getCreepCount();
      if (claimed !== counted && countMismatch.length < 8) countMismatch.push({ corpId: c.id, claimed, counted });
    }
    if (countMismatch.length > 0) creeps.countMismatch = countMismatch;

    // Get colony stats
    const stats = colony?.getStats() || {
      nodeCount: 0,
      totalCorps: 0,
      activeCorps: 0
    };

    // Build rooms array
    const rooms: CoreTelemetry["rooms"] = [];
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (room.controller?.my) {
        rooms.push({
          name: roomName,
          rcl: room.controller.level,
          rclProgress: room.controller.progress,
          rclProgressTotal: room.controller.progressTotal,
          energyAvailable: room.energyAvailable,
          energyCapacity: room.energyCapacityAvailable,
          storageEnergy: room.storage?.my ? room.storage.store.energy ?? 0 : null,
          controllerStock: controllerSideStock(room.controller),
          feederActive: !!room.memory.controllerFeederActive,
          ...(() => {
            const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
            return {
              siteProgress: sites.reduce((a, st) => a + (st.progress ?? 0), 0),
              siteTotal: sites.reduce((a, st) => a + (st.progressTotal ?? 0), 0),
              siteCount: sites.length
            };
          })()
        });
      }
    }

    // Source buffers (owner 2026-07-20): container + pile at each visible
    // source's mouth - the over/under-haul read.
    const sourceBuffers: NonNullable<CoreTelemetry["sourceBuffers"]> = {};
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      let sources: Source[] = [];
      try {
        sources = room.find(FIND_SOURCES);
      } catch {
        continue; // partial mocks without FIND_SOURCES wired
      }
      for (const source of sources) {
        let stock = 0;
        for (const s of source.pos.findInRange(FIND_STRUCTURES, 1)) {
          if (s.structureType === STRUCTURE_CONTAINER) {
            stock += (s as StructureContainer).store?.[RESOURCE_ENERGY] ?? 0;
          }
        }
        for (const r of source.pos.findInRange(FIND_DROPPED_RESOURCES, 1)) {
          if (r.resourceType === RESOURCE_ENERGY) stock += r.amount ?? 0;
        }
        sourceBuffers[source.id.slice(-6)] = stock;
      }
    }

    // Spawn meter readout (phase 3): measured utilization from the Memory windows.
    const spawns: CoreTelemetry["spawns"] = [];
    const gameSpawns = Game.spawns ?? {};
    for (const name in gameSpawns) {
      const s = gameSpawns[name];
      const w = Memory.spawnMeter?.[s.id];
      const ticks = w?.ticks ?? 0;
      const busy = w?.busy ?? 0;
      const utilization = ticks > 0 ? busy / ticks : 0;
      spawns.push({
        id: s.id,
        name,
        windowTicks: ticks,
        utilization,
        partsPerTick: utilization * SPAWN_PARTS_PER_TICK,
        ceiling: SPAWN_PARTS_PER_TICK,
        queueDepth: Memory.spawnAgenda?.[s.id]?.queue?.length ?? 0
      });
    }

    // NOW-plan mirror (phase 4): agenda heads + receipts, verbatim.
    let agenda: CoreTelemetry["agenda"];
    if (Memory.spawnAgenda) {
      agenda = {};
      for (const spawnId in Memory.spawnAgenda) {
        const a = Memory.spawnAgenda[spawnId];
        agenda[spawnId] = {
          tick: a.tick,
          fundingNeed: a.fundingNeed,
          queueDepth: a.queue.length,
          queue: a.queue.slice(0, 4),
          executed: a.executed ?? []
        };
      }
    }

    const telemetry: CoreTelemetry = {
      version: 7, // v6 site progress (ledger P8); v7 remoteGate decision record
      tick: Game.time,
      shard: Game.shard?.name || "shard0",
      cpu: {
        used: Game.cpu.getUsed(),
        limit: Game.cpu.limit,
        bucket: Game.cpu.bucket,
        tickLimit: Game.cpu.tickLimit
      },
      gcl: {
        level: Game.gcl.level,
        progress: Game.gcl.progress,
        progressTotal: Game.gcl.progressTotal
      },
      colony: {
        nodeCount: stats.nodeCount,
        totalCorps: stats.totalCorps,
        activeCorps: stats.activeCorps
      },
      creeps,
      bodyParts,
      spawns,
      agenda,
      ...(Memory.remoteGate ? { remoteGate: Memory.remoteGate } : {}),
      ...(Object.keys(sourceBuffers).length > 0 ? { sourceBuffers } : {}),
      rooms
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify(telemetry);
  }

  /**
   * Updates nodes telemetry (Segment 1).
   * Uses compact keys to fit more nodes in the 100KB segment limit.
   */
  private updateNodesTelemetry(colony: Colony | undefined): void {
    const nodes = colony?.getNodes() || [];

    // Calculate summary stats from full node list
    const ownedNodes = nodes.filter(n => n.roi?.isOwned).length;
    const expansionCandidates = nodes.filter(n => !n.roi?.isOwned && (n.roi?.score || 0) > 0).length;
    const totalSources = nodes.reduce((sum, n) => sum + (n.roi?.sourceCount || 0), 0);
    const avgROI = nodes.length > 0 ? nodes.reduce((sum, n) => sum + (n.roi?.score || 0), 0) / nodes.length : 0;

    // Sort nodes: owned first, then by ROI score descending
    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.roi?.isOwned && !b.roi?.isOwned) return -1;
      if (!a.roi?.isOwned && b.roi?.isOwned) return 1;
      return (b.roi?.score || 0) - (a.roi?.score || 0);
    });

    // Build set of economic node IDs (nodes that appear in economic edges)
    const econNodeIds = new Set<string>();
    for (const edge of Object.keys(Memory.economicEdges || {})) {
      const [id1, id2] = edge.split("|");
      econNodeIds.add(id1);
      econNodeIds.add(id2);
    }

    // Count spawn structures per room
    const spawnCountsByRoom: { [roomName: string]: number } = {};
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (room.controller?.my) {
        const spawns = room.find(FIND_MY_SPAWNS);
        if (spawns.length > 0) {
          spawnCountsByRoom[roomName] = spawns.length;
        }
      }
    }

    // Build compact node data
    const nodeData: NodeTelemetry["nodes"] = sortedNodes.map(node => ({
      id: node.id,
      r: node.roomName,
      p: { x: node.peakPosition.x, y: node.peakPosition.y, r: node.peakPosition.roomName },
      t: node.territorySize,
      res: node.resources.map(r => ({
        t: r.type,
        x: r.position.x,
        y: r.position.y
      })),
      roi: node.roi
        ? {
            s: node.roi.score,
            e: node.roi.expansionScore,
            o: node.roi.openness,
            d: node.roi.distanceFromOwned,
            own: node.roi.isOwned,
            src: node.roi.sourceCount,
            ctrl: node.roi.hasController
          }
        : undefined,
      spans: node.spansRooms,
      econ: econNodeIds.has(node.id) || undefined,
      sp: spawnCountsByRoom[node.roomName] || undefined
    }));

    const telemetry: NodeTelemetry = {
      version: 5, // Version 5: edges moved to segment 2
      tick: Game.time,
      nodes: nodeData,
      summary: {
        totalNodes: nodes.length,
        ownedNodes,
        expansionCandidates,
        totalSources,
        avgROI
      }
    };

    const json = JSON.stringify(telemetry);
    if (json.length > 100000) {
      console.log(`[Telemetry] Warning: Node segment ${json.length} bytes exceeds 100KB limit`);
    }
    RawMemory.segments[TELEMETRY_SEGMENTS.NODES] = json;
  }

  /**
   * Updates edges telemetry (Segment 2).
   * Uses compressed numeric format: edges as index pairs instead of string IDs.
   * Includes flow rates from flow solution when available.
   */
  private updateEdgesTelemetry(colony: Colony | undefined, flowSolution?: FlowSolution): void {
    const nodes = colony?.getNodes() || [];

    // Build node ID to index map (sorted same as nodes telemetry)
    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.roi?.isOwned && !b.roi?.isOwned) return -1;
      if (!a.roi?.isOwned && b.roi?.isOwned) return 1;
      return (b.roi?.score || 0) - (a.roi?.score || 0);
    });

    const nodeIdToIndex = new Map<string, number>();
    const nodeIndex: string[] = [];
    sortedNodes.forEach((node, idx) => {
      nodeIdToIndex.set(node.id, idx);
      nodeIndex.push(node.id);
    });

    // Build flow rate map from hauler assignments (edge key → total flow rate)
    const flowRateByEdge = new Map<string, number>();
    if (flowSolution) {
      for (const hauler of flowSolution.haulers) {
        // Extract node IDs from flow IDs (e.g., "source-abc|sink-xyz" or use fromId/toId)
        const fromNodeId = this.extractNodeId(hauler.fromId);
        const toNodeId = this.extractNodeId(hauler.toId);
        if (fromNodeId && toNodeId) {
          // Create consistent edge key (sorted alphabetically)
          const edgeKey = [fromNodeId, toNodeId].sort().join("|");
          const existing = flowRateByEdge.get(edgeKey) || 0;
          flowRateByEdge.set(edgeKey, existing + hauler.flowRate);
        }
      }
    }

    // Convert spatial edges to index pairs
    const edges: [number, number][] = [];
    for (const edge of Memory.nodeEdges || []) {
      const [id1, id2] = edge.split("|");
      const idx1 = nodeIdToIndex.get(id1);
      const idx2 = nodeIdToIndex.get(id2);
      if (idx1 !== undefined && idx2 !== undefined) {
        edges.push([idx1, idx2]);
      }
    }

    // Convert economic edges to index tuples with distance and optional flow rate
    const economicEdges: [number, number, number, number?][] = [];
    for (const [edge, distance] of Object.entries(Memory.economicEdges || {})) {
      const [id1, id2] = edge.split("|");
      const idx1 = nodeIdToIndex.get(id1);
      const idx2 = nodeIdToIndex.get(id2);
      if (idx1 !== undefined && idx2 !== undefined) {
        const flowRate = flowRateByEdge.get(edge);
        if (flowRate !== undefined && flowRate > 0) {
          economicEdges.push([idx1, idx2, distance, flowRate]);
        } else {
          economicEdges.push([idx1, idx2, distance]);
        }
      }
    }

    const telemetry: EdgesTelemetry = {
      version: 2, // Version 2: includes flow rates
      tick: Game.time,
      nodeIndex,
      edges,
      economicEdges
    };

    const json = JSON.stringify(telemetry);
    if (json.length > 100000) {
      console.log(`[Telemetry] Warning: Edges segment ${json.length} bytes exceeds 100KB limit`);
    }
    RawMemory.segments[TELEMETRY_SEGMENTS.EDGES] = json;
  }

  /**
   * Extract node ID from a flow ID (e.g., "source-abc123" → node ID from Memory).
   * Flow IDs reference game objects; we need to map them back to nodes.
   */
  private extractNodeId(_flowId: string): string | undefined {
    // For sources: "source-{gameId}" → find node containing this source
    // For sinks: "spawn-{gameId}" or "controller-{gameId}" → find node
    // This is a simplified mapping - in practice, we'd need the flow graph's node mappings

    // Try to find the node by checking if any node's ID matches or contains the source/sink
    // For now, return undefined and rely on economicEdges which already have node-to-node mappings
    return undefined;
  }

  /**
   * Updates intel telemetry (Segment 3).
   */
  private updateIntelTelemetry(): void {
    const rooms: IntelTelemetry["rooms"] = [];

    if (Memory.roomIntel) {
      for (const roomName in Memory.roomIntel) {
        const intel = Memory.roomIntel[roomName];
        rooms.push({
          name: roomName,
          lastVisit: intel.lastVisit,
          sourceCount: intel.sourceCount,
          sourcePositions: intel.sourcePositions,
          mineralType: intel.mineralType,
          mineralPos: intel.mineralPos,
          controllerLevel: intel.controllerLevel,
          controllerPos: intel.controllerPos,
          controllerOwner: intel.controllerOwner,
          controllerReservation: intel.controllerReservation,
          hostileCreepCount: intel.hostileCreepCount,
          hostileStructureCount: intel.hostileStructureCount,
          isSafe: intel.isSafe,
          // Defense state (spec 12/13): the active defund marks and the raid
          // meter, so dashboards can see live windows without Memory access.
          ...(intel.hostileUntil !== undefined ? { hostileUntil: intel.hostileUntil } : {}),
          ...(intel.invaderReservedUntil !== undefined ? { invaderReservedUntil: intel.invaderReservedUntil } : {}),
          ...(intel.invaderCorePresent !== undefined ? { invaderCorePresent: intel.invaderCorePresent } : {}),
          ...(intel.raidDebt !== undefined ? { raidDebt: intel.raidDebt } : {}),
          ...(intel.lastRaidSeen !== undefined ? { lastRaidSeen: intel.lastRaidSeen } : {}),
          // Our reservation bank (spec 15 P5): the duty-cycle lens, exported
          // so a capture shows what the reserver gate coasts on.
          ...(intel.reservedUntil !== undefined ? { reservedUntil: intel.reservedUntil } : {}),
          ...(intel.reservedBy !== undefined ? { reservedBy: intel.reservedBy } : {})
        });
      }
    }

    const telemetry: IntelTelemetry = {
      version: 1,
      tick: Game.time,
      rooms
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.INTEL] = JSON.stringify(telemetry);
  }

  /**
   * Updates corps telemetry (Segment 4).
   */
  private updateCorpsTelemetry(census: CorpCensusEntry[], perCorpBody: Map<string, BodyAggregate>): void {
    const corps: CorpsTelemetry["corps"] = [];
    const corpsByKind: { [kind: string]: number } = {};
    let activeCorps = 0;

    for (const { kind, corp } of census) {
      const creepCount = corpCreepCount(corp);
      // ACTUAL body of this corp's live creeps (measured), or empty when it owns
      // none - never a reconstruction from planned rates.
      const body = perCorpBody.get(corp.id) ?? emptyBody();
      corps.push({
        id: corp.id,
        kind,
        type: corp.type,
        nodeId: corp.nodeId || "",
        roomName: corpRoomName(corp),
        creepCount,
        bodyParts: body.total,
        body: body.byPart,
        sizing: corp.lastSizing,
        createdAt: corp.createdAt,
        lastActivityTick: corp.lastActivityTick
      });
      corpsByKind[kind] = (corpsByKind[kind] || 0) + 1;
      if (creepCount > 0) activeCorps++;
    }

    const telemetry: CorpsTelemetry = {
      version: 4, // Version 4: sizing records (decision-site inputs, spec 14 phase 2)
      tick: Game.time,
      corps,
      summary: {
        totalCorps: corps.length,
        activeCorps,
        corpsByKind
      }
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.CORPS] = JSON.stringify(telemetry);
  }

  /**
   * Updates flow telemetry (Segment 6).
   * Shows flow economy state: sources, sinks, and energy allocations.
   */
  private updateFlowTelemetry(flowSolution?: FlowSolution): void {
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
          ratio: hauler.haulerRatio
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
          workParts: perWork === undefined ? undefined : workPartsForEnergyRate(sink.allocated, perWork)
        });
      }
    }

    const telemetry: FlowTelemetry = {
      // v4: the fill's spawn-parts ledger trace (partsLedger + per-sink
      // partsLeft). v5: problem-assembly counts (graphSources/mined/
      // transient/bank) - names the layer that dropped sources in one
      // capture (the warmup remote-drop lens).
      version: 5,
      tick: Game.time,
      sources,
      haulers,
      sinks,
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
}

/**
 * Global telemetry instance.
 */
let telemetryInstance: Telemetry | null = null;

/**
 * Gets or creates the global telemetry instance.
 */
export function getTelemetry(config?: Partial<TelemetryConfig>): Telemetry {
  if (!telemetryInstance) {
    telemetryInstance = new Telemetry(config);
  }
  return telemetryInstance;
}

/**
 * Reconfigures telemetry with new settings.
 */
export function configureTelemetry(config: Partial<TelemetryConfig>): void {
  telemetryInstance = new Telemetry(config);
}
