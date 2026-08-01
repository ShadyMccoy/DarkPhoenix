/**
 * @fileoverview Core telemetry writer - segment 0 (colony stats, creep census,
 * spawn-meter readout, agenda mirror, room ledger).
 *
 * Charter: the `CoreTelemetry` segment shape and its ONE writer. Owns the
 * creep census reconciliation (tracked/untracked + the unattributed and
 * count-mismatch leak lenses), the room energy ledger, source buffers, remote
 * sites, road receipts, the spawn-meter READOUT (the accumulator lives in
 * telemetry/spawnMeter), the NOW-plan agenda mirror, and the corpCpu rotation.
 * The emitted bytes are a frozen external contract (versioned; an external
 * app parses them) - field order and version numbers never change in a
 * refactor.
 *
 * Layer: telemetry writer (Game/Memory-coupled; writes RawMemory segment 0).
 *
 * @module telemetry/coreSegment
 */

import { Colony } from "../colony/Colony";
import { controllerSideStock, sourceBufferStock, sourceDroppedStock } from "../corps/nodeEnergy";
import { linkLedger } from "./LinkMeter";
import { getCompletedLedger } from "./cpuLedgerCache";
import { SPAWN_PARTS_PER_TICK } from "../economy/primitives";
import { BodyAggregate, CorpCensusEntry } from "./bodyCensus";
import { TELEMETRY_SEGMENTS } from "./segmentIds";

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
   * The DYNAMIC liquidity reserve target (Memory.warchestTarget, income-scaled
   * per spec 129) - the number the economy actually treats as "the warchest".
   * Absent when unset (cold start). Exported so the waste ledger's E4 (idle
   * capital) compares the bank against the reserve the DECISIONS use, not the
   * static BASE_RESERVE floor it fell back to when this was invisible (measured
   * t72555188: bank 54.8k sat AT the dynamic reserve but E4 read it as 32k idle
   * above the 22.65k base - a false WARN).
   */
  warchestTarget?: number;
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
    /** Gapped build-finish events in the window (back-to-back restarts never
     * register - every counted finish is a duty gap). v12. */
    finishes?: number;
    /** Avg energyAvailable/capacity AT those finish ticks: low = refill did
     * not overlap the build (tender lag); high = affordable-but-idle. */
    endFill?: number;
    /** Idle-tick cause tally over the window (v18): empty=no demand (spare
     * capacity, demand-side gap), bank=head unaffordable (energy-starved),
     * buy=decided-buy yet idle (exec latency), hold=affordable but held/
     * queued (chosen wait). Absent when the spawn never idled. Sums to
     * windowTicks - busyTicks. See classifySpawnIdle. */
    idle?: { empty: number; bank: number; buy: number; hold: number };
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
   * Per-source BUFFER levels (v7 additive): energy standing at each visible
   * source's mouth - container store within range 1 plus dropped piles
   * within range 1 - keyed by the source id's last 6 chars. The over/under
   * haul diagnostic (owner 2026-07-20): a buffer pinned near container cap
   * (2000) means mining outruns hauling (rot); chronically ~0 with an
   * active miner means hauling has headroom (or over-provision). Only
   * rooms with vision contribute.
   */
  sourceBuffers?: { [idTail: string]: number };
  /**
   * The DROPPED (rotting) share of each source buffer, same keys as
   * `sourceBuffers` (v19). Container energy keeps; dropped energy loses
   * ceil(amount/1000) per tick, so this is the only part that rots. Exported
   * so the audit's energy account can price ground rot as its own line instead
   * of leaving it inside the unattributed residual.
   */
  sourceDropped?: { [idTail: string]: number };
  /**
   * Our construction sites in visible UNOWNED rooms (v9): the owned-room
   * ledger's siteCount misses cross-room trunk paving entirely - the P8
   * owned-room blindness (owner 2026-07-20). Keyed by room name; rooms with
   * zero sites are omitted.
   */
  remoteSites?: { [roomName: string]: number };
  /**
   * roadRoutes receipts, verbatim per key (v13 - prod t72485595): cd8e's
   * plan price sat 1:1 for three windows after its road stood complete and
   * WHY was uninferable from captures - the pave/dedication lenses both
   * read these room-memory receipts, which no segment carried. Slim:
   * built/total/paved/declined + tile count per key, rooms merged.
   */
  roadReceipts?: {
    [key: string]: { built?: number; total?: number; paved?: boolean; declined?: boolean; tiles?: number };
  };
  /**
   * P-CPU meter snapshot (v10): last tick's moveTo CPU per corp family
   * (Memory.pathMeter verbatim) - the BEFORE number for spec 23's cached
   * routes, naming the top pathing spender.
   */
  pathMeter?: {
    tick: number;
    calls: number;
    cpu: number;
    byCorp: { [family: string]: { calls: number; cpu: number } };
  };
  /**
   * The per-corp CPU ledger snapshot (v15, spec 20): Memory.corpCpu verbatim —
   * whole-tick CPU, corp total, per-kind breakdown, named infra buckets, and
   * the worst per-corp offenders by ~100-tick EMA. The `audit:report`'s CPU
   * section and the external dashboard render the same reconciliation the live
   * `global.cpuReport()` prints. Exported so CPU spend is auditable offline.
   */
  corpCpu?: import("./cpuReport").CorpCpuLedger;
  /** Per-room link throughput (v14, spec-26 instrument): ACTUAL e/t carried -
   * to the hub vs DELIVERED to the controller (the receipt), the 1-hop direct
   * share, and the 3% tax paid. Read-only measurement ahead of the planner. */
  links?: {
    room: string;
    windowTicks: number;
    toHubRate: number;
    toControllerRate: number;
    directShare: number;
    taxRate: number;
  }[];
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
 * Updates core telemetry (Segment 0).
 */
export function updateCoreTelemetry(
  colony: Colony | undefined,
  census: CorpCensusEntry[],
  bodyParts: BodyAggregate
): void {
  // Creep census keyed by kind, summed generically from the complete corp
  // list: every creep-owning kind is counted by construction. Only corps
  // that expose getCreepCount contribute (spawning owns no creeps).
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
  const sourceDropped: NonNullable<CoreTelemetry["sourceDropped"]> = {};
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    let sources: Source[] = [];
    try {
      sources = room.find(FIND_SOURCES);
    } catch {
      continue; // partial mocks without FIND_SOURCES wired
    }
    for (const source of sources) {
      // ONE lens with the miner pile gate (HarvestCorp): the number this
      // dashboard shows is the number the defer decision read.
      const stock = sourceBufferStock(source);
      if (stock === null) continue; // partial mocks without wired finds
      sourceBuffers[source.id.slice(-6)] = stock;
      const dropped = sourceDroppedStock(source);
      if (dropped !== null && dropped > 0) sourceDropped[source.id.slice(-6)] = dropped;
    }
  }

  // Remote construction sites (v9): the rooms[] ledger below covers OWNED
  // rooms only, which left the P8 build read blind to cross-room trunk
  // paving - a healthy remote build looked like "no sites standing"
  // (owner 2026-07-20). Visible unowned rooms with our sites, counted.
  const remoteSites: NonNullable<CoreTelemetry["remoteSites"]> = {};
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) continue;
    let count = 0;
    try {
      count = room.find(FIND_MY_CONSTRUCTION_SITES).length;
    } catch {
      continue; // partial mocks
    }
    if (count > 0) remoteSites[roomName] = count;
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
    const finishes = w?.finishes ?? 0;
    const idleEmpty = w?.idleEmpty ?? 0;
    const idleBank = w?.idleBank ?? 0;
    const idleBuy = w?.idleBuy ?? 0;
    const idleHold = w?.idleHold ?? 0;
    const idleTotal = idleEmpty + idleBank + idleBuy + idleHold;
    spawns.push({
      id: s.id,
      name,
      windowTicks: ticks,
      utilization,
      partsPerTick: utilization * SPAWN_PARTS_PER_TICK,
      ceiling: SPAWN_PARTS_PER_TICK,
      queueDepth: Memory.spawnAgenda?.[s.id]?.queue?.length ?? 0,
      // Gapped build-finishes + avg fill AT the finish (v12): low endFill =
      // refill lag; high = affordable-but-idle. Absent until a gap occurs.
      ...(finishes > 0 ? { finishes, endFill: +((w!.fillSum ?? 0) / finishes).toFixed(3) } : {}),
      // Idle-cause attribution (v18): where the idle ticks went.
      ...(idleTotal > 0 ? { idle: { empty: idleEmpty, bank: idleBank, buy: idleBuy, hold: idleHold } } : {})
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
        // The WHOLE queue, not 4 heads (v11 - prod t72483599): the upgrader
        // demand sat at rank 5+ through a 550t staffing collapse and its
        // `since` age - the anti-starvation clock, THE datum for "why no
        // lift" - was invisible. ~100B/entry; depth is single digits.
        queue: a.queue,
        executed: a.executed ?? []
      };
    }
  }

  const telemetry: CoreTelemetry = {
    // v15 collided on two branches (corpCpu vs link core-fill/hub-clamp); both
    // shipped, so the merge advances to v16 to name the combined schema.
    version: 19, // v18 spawns[].idle cause tally; v19 sourceDropped (the rotting share of each source buffer)
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
    ...(Memory.warchestTarget !== undefined ? { warchestTarget: Memory.warchestTarget } : {}),
    creeps,
    bodyParts,
    spawns,
    agenda,
    ...(Object.keys(sourceBuffers).length > 0 ? { sourceBuffers } : {}),
    ...(Object.keys(remoteSites).length > 0 ? { remoteSites } : {}),
    ...(() => {
      // roadRoutes receipts (v13): the exact records the pave-fraction and
      // dedication lenses read, exported verbatim so a stuck pricing names
      // its own state (entry deleted vs fractionless vs paved).
      const receipts: NonNullable<CoreTelemetry["roadReceipts"]> = {};
      for (const roomName in Game.rooms ?? {}) {
        const routes = Game.rooms[roomName]?.memory?.roadRoutes;
        for (const key in routes ?? {}) {
          const e = routes![key];
          receipts[key] = {
            ...(e.built !== undefined ? { built: e.built } : {}),
            ...(e.total !== undefined ? { total: e.total } : {}),
            ...(e.paved ? { paved: true } : {}),
            ...(e.declined ? { declined: true } : {}),
            ...(e.tiles3 ? { tiles: e.tiles3.length / 3 } : {})
          };
        }
      }
      return Object.keys(receipts).length > 0 ? { roadReceipts: receipts } : {};
    })(),
    ...(Memory.pathMeter ? { pathMeter: Memory.pathMeter } : {}),
    // corpCpu ledger: ship the last COMPLETED ledger (cpuLedgerCache), not
    // Memory.corpCpu - which is only half-built at this point in the tick
    // (infra + wholeTick are added at loop end, AFTER this serialization), so
    // embedding it inline captured a ledger with no reconciliation. The cache
    // holds the prior tick's whole ledger; one tick stale, but complete.
    //
    // On a 10-tick ROTATION keyed to the ledger's own tick: the ledger
    // (byKind + infra + top-12) is the single largest add-on to core, so
    // embedding every tick 10x's the trailing-fixture footprint for a datum
    // audit:report only reads one recent copy of. The live `global.cpuReport()`
    // reads Memory.corpCpu directly and is unaffected by this gate.
    ...(() => {
      const led = getCompletedLedger();
      return led && led.tick % 10 === 0 ? { corpCpu: led } : {};
    })(),
    ...(() => {
      const links = linkLedger(Game.time);
      return links.length > 0 ? { links } : {};
    })(),
    rooms
  };

  RawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify(telemetry);
}
