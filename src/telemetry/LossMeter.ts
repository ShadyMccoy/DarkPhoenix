/**
 * @fileoverview LossMeter - the instrument that splits the account's RESIDUAL.
 *
 * The energy account (spec 15) balances by construction to a named RESIDUAL:
 * delivered - opex - appropriations. At the 2026-08-01 close it was 31.69 e/t,
 * 32% of gross mining, and it bounded ground decay, rot above the container
 * cap, raid losses, tower burn and measurement error ALL AT ONCE. A residual
 * that cannot be split is itself the work item - so this meter prices the parts
 * that are knowable and hands the account line items instead of a bucket.
 *
 * FOUR MEASUREMENT NATURES, deliberately not blurred (the report states each):
 *
 *   pile decay       EXACT      the engine's own ceil(amount/1000) on an
 *                               observed stock - not an estimate
 *   structure decay  MODELLED   what holding hits constant costs, from the
 *                               engine's decay cadences. A LIABILITY, not a
 *                               payment: unrepaired structures accrue it and
 *                               eventually collapse instead
 *   repair           MEASURED   energy actually spent, recorded at the repair
 *                               site
 *   tombstone        MEASURED   but only after a discriminator, below
 *
 * TOMBSTONES ARE LOST BY DEFAULT (owner 2026-08-01: "we don't have any to
 * recover tombstones so we can assume that it's lost for now"). Three
 * opportunistic recovery paths do exist - scavengeSpot's range-1 withdraw, the
 * builder's PICKUP_RANGE withdraw, and the scavenge corp when the planner funds
 * the stock - but every one of them needs a creep already standing beside the
 * tombstone, so a hauler that dies mid-route in a remote room is simply gone.
 *
 * The energy is therefore booked as LOST at FIRST SIGHT (of a tombstone that
 * APPEARS during the window - a room's first sample is a baseline, never a
 * charge, or the standing backlog becomes a phantom rate), not at disappearance.
 * That needs no theory about why a tombstone vanished (the earlier rule guessed
 * "gone early => somebody looted it", which understates exactly when it matters)
 * and it survives the sample stride - a short-lived tombstone seen once is still
 * counted. Recovery is then a CREDIT, granted only on direct evidence: energy
 * leaving a tombstone that is still standing. If recovery is ever built out, the
 * number self-corrects instead of needing a rewrite.
 *
 * Vision is not a measurement: a room we merely stopped seeing must never be
 * scored as a loss, or every dead scout prints a spike. Rooms are diffed only
 * against their OWN next sample (the "room state from intel, never creep
 * positions" trap wearing a different costume - CLAUDE.md).
 *
 * TOTALS ARE CUMULATIVE AND PERSISTED; only the rate view is module state.
 *
 * The first version kept everything in module state like LinkMeter, which
 * bounded the measured window by VM LIFETIME rather than by how far apart two
 * captures are: live t72722670 reported a 480-tick loss window against a
 * 1251-tick capture window purely because a deploy had reset the globals. A
 * fiscal month is 1500 ticks (spec 41), so NO month was ever measurable end to
 * end and the account's window-incoherence guard fired structurally.
 *
 * So the meter publishes cumulative ENERGY totals in `Memory.lossLedger` and
 * the ledger DIFFERENCES two captures - the same shape the account already uses
 * for gcl.progress and storage. The measured window then equals the capture
 * window by construction, for any length. The since-reset rate view stays for
 * the live console.
 *
 * @module telemetry/LossMeter
 */

import "../types/Memory"; // Memory.lossLedger / creepDeathWatch augmentation
import {
  containerDecayEnergy,
  hitsToEnergy,
  pileDecayRate,
  rampartDecayEnergy
} from "../economy/primitives";
import { ROAD_DECAY_HITS, ROAD_DECAY_INTERVAL, ROAD_HITS } from "../economy/roadEconomics";
import { hostileRooms } from "../utils/RoomDiscovery";

/** One room's decaying-asset census for a single sample. */
export interface RoomLossCensus {
  room: string;
  /** Do we own the controller? Remote containers decay 5x faster. */
  owned: boolean;
  /** Every dropped ENERGY pile in the room, by amount. */
  piles: number[];
  /**
   * Live tombstones with the energy they hold, the life they have left, and the
   * ATTRIBUTION the account needs to act on the loss (owner 2026-08-02): which
   * kind of creep died, and whether it expired or was killed.
   */
  tombstones: {
    id: string;
    energy: number;
    ticksToDecay: number;
    /** Our own workType where memory survives, else inferred from the body. */
    role?: string;
    /**
     * Death-watch VERDICT (resolveDeathCause): true = killed with time on the
     * clock, false = clock ran out, ABSENT = no evidence - booked as unknown,
     * never defaulted. (A dead creep's own object has no ticksToLive; v23
     * read it anyway and called everything "expired".)
     */
    killed?: boolean;
    /** Death-watch verdict: the creep was FLAGGED recycling at last sight and
     *  died with time left - a deliberate spawn-side refund, never combat. */
    recycled?: boolean;
    /** The trigger class stamped at the flag site (memory.recycleReason). */
    recycleReason?: string;
    /** TTL the creep still had at death - the raw number behind `killed`. */
    ttlAtDeath?: number;
  }[];
  /** Container count (priced by `owned`). */
  containers: number;
  /** Rampart count. */
  ramparts: number;
  /** Road decay for the room, already terrain-weighted, in energy/tick. */
  roadDecayEnergy: number;
  /**
   * Intel flagged this room hostile when the census was taken (the vision-free
   * RoomDiscovery.hostileRooms lens, host-assembled per the trap list - the
   * fold never reads Game). Splits killed-tombstone energy into
   * evidence-supported raid losses vs kills the raid narrative cannot claim
   * (owner 2026-08-03: "a lot is blamed on raids without sufficient
   * evidence"). Absent = not flagged.
   */
  hostileFlagged?: boolean;
}

interface RoomState {
  lastTick: number;
  /** Energy last seen in each standing tombstone, by id - the drawdown base. */
  tombs: Map<string, number>;
}

interface Totals {
  pileDecay: number;
  structureDecay: number;
  /** Energy booked at first sight of each tombstone (the GROSS loss). */
  tombstoneGross: number;
  /** Energy witnessed leaving a STANDING tombstone (the credit). */
  tombstoneRecovered: number;
  tombstoneStock: number;
  /** Gross tombstone energy by creep role. */
  tombstoneByRole: Record<string, number>;
  /** Gross tombstone energy from creeps that ran out of life. */
  tombstoneExpired: number;
  /** Gross tombstone energy from creeps that still had life left. */
  tombstoneKilled: number;
  /** KILLED energy by the room it was booked in - the WHERE the raid
   *  narrative was missing (owner 2026-08-03). */
  tombstoneKilledByRoom: Record<string, number>;
  /** KILLED energy booked in rooms intel flagged hostile at the time - the
   *  share the invader story can actually claim. */
  tombstoneKilledHostileRoom: number;
  /** Energy from creeps that died RECYCLING (deliberate refund, not combat). */
  tombstoneRecycled: number;
  /** Recycled energy by TRIGGER CLASS (the flag site's stamped reason;
   *  "unstamped" = a pre-stamp record). */
  tombstoneRecycledByReason: Record<string, number>;
  /** Gross tombstone energy whose cause could not be resolved - no death-watch
   *  entry (enemy creep, pre-deploy death, never-sampled room). An honest
   *  bucket, never defaulted into "expired": the v23 collector read
   *  `tombstone.creep.ticksToLive`, which is 0/undefined on every dead creep,
   *  so the split was a constant and its own audit line said SUSPECT. */
  tombstoneCauseUnknown: number;
  /** Sum/max/count of ttlAtDeath, over KNOWN deaths only - an unresolvable
   *  ttl contributes no sample rather than dragging the mean toward zero. */
  tombstoneTtlSum: number;
  tombstoneTtlMax: number;
  tombstoneCount: number;
  repairSpend: number;
  sinceTick: number;
  started: boolean;
}

/** Tombstone ids already booked - a tombstone is charged ONCE, however long it
 *  stands. Colony-wide, so a tombstone seen from two rooms cannot double-book. */
const bookedTombs = new Set<string>();

const rooms = new Map<string, RoomState>();
let totals: Totals = blank();

/** Cumulative energy totals, monotonic, surviving global resets. */
export interface LossCumulative {
  pileDecay: number;
  structureDecay: number;
  repairSpend: number;
  tombstoneGross: number;
  tombstoneRecovered: number;
  /** Attribution, cumulative like the gross it decomposes (2026-08-02) - so
   *  the account's by-role/by-cause shares describe the SAME capture-bounded
   *  window as the tombstone line they decorate, not a since-reset subset. */
  tombstoneByRole: Record<string, number>;
  tombstoneExpired: number;
  tombstoneKilled: number;
  /** Killed energy by booking room / by intel-hostile flag (2026-08-03):
   *  cumulative like the cause buckets, so capture pairs difference the
   *  WHERE exactly as they difference the WHAT. */
  tombstoneKilledByRoom: Record<string, number>;
  tombstoneKilledHostileRoom: number;
  /** Energy from creeps that died RECYCLING (deliberate refund, not combat). */
  tombstoneRecycled: number;
  tombstoneRecycledByReason: Record<string, number>;
  tombstoneCauseUnknown: number;
  tombstoneTtlSum: number;
  tombstoneTtlKnown: number;
}

function zeroCumulative(): LossCumulative {
  return {
    pileDecay: 0,
    structureDecay: 0,
    repairSpend: 0,
    tombstoneGross: 0,
    tombstoneRecovered: 0,
    tombstoneByRole: {},
    tombstoneExpired: 0,
    tombstoneKilled: 0,
    tombstoneKilledByRoom: {},
    tombstoneKilledHostileRoom: 0,
    tombstoneRecycled: 0,
    tombstoneRecycledByReason: {},
    tombstoneCauseUnknown: 0,
    tombstoneTtlSum: 0,
    tombstoneTtlKnown: 0
  };
}

/**
 * The persisted ledger. Memory when the game provides it (survives resets),
 * a module-level fallback otherwise so unit tests and Game-free callers work.
 */
let localLedger: LossCumulative = zeroCumulative();

function ledger(): LossCumulative {
  if (typeof Memory === "undefined") return localLedger;
  const mem = Memory as unknown as { lossLedger?: LossCumulative };
  if (!mem.lossLedger) mem.lossLedger = zeroCumulative();
  else if (mem.lossLedger.tombstoneByRole === undefined) {
    // A ledger persisted before the attribution keys existed: backfill in
    // place so every accrual below can assume the full shape.
    const led = mem.lossLedger;
    led.tombstoneByRole = {};
    led.tombstoneExpired = led.tombstoneExpired ?? 0;
    led.tombstoneKilled = led.tombstoneKilled ?? 0;
    led.tombstoneCauseUnknown = led.tombstoneCauseUnknown ?? 0;
    led.tombstoneTtlSum = led.tombstoneTtlSum ?? 0;
    led.tombstoneTtlKnown = led.tombstoneTtlKnown ?? 0;
  }
  if (mem.lossLedger.tombstoneKilledByRoom === undefined) {
    // Pre-location ledger (v26 and earlier): backfill the WHERE keys.
    mem.lossLedger.tombstoneKilledByRoom = {};
    mem.lossLedger.tombstoneKilledHostileRoom = mem.lossLedger.tombstoneKilledHostileRoom ?? 0;
  }
  if (mem.lossLedger.tombstoneRecycled === undefined) mem.lossLedger.tombstoneRecycled = 0;
  if (mem.lossLedger.tombstoneRecycledByReason === undefined) mem.lossLedger.tombstoneRecycledByReason = {};
  return mem.lossLedger;
}

/** The ledger's plain-number keys (the by-role map accrues at its call site). */
type ScalarLossKey = {
  [K in keyof LossCumulative]: LossCumulative[K] extends number ? K : never;
}[keyof LossCumulative];

/** Add to BOTH views: the cumulative ledger and the since-reset window. */
function accrue(key: ScalarLossKey, windowKey: keyof Totals, energy: number): void {
  if (!(energy > 0)) return;
  ledger()[key] += energy;
  (totals[windowKey] as number) += energy;
}

function blank(): Totals {
  return {
    pileDecay: 0,
    structureDecay: 0,
    tombstoneGross: 0,
    tombstoneRecovered: 0,
    tombstoneStock: 0,
    tombstoneByRole: {},
    tombstoneExpired: 0,
    tombstoneKilled: 0,
    tombstoneKilledByRoom: {},
    tombstoneKilledHostileRoom: 0,
    tombstoneRecycled: 0,
    tombstoneRecycledByReason: {},
    tombstoneCauseUnknown: 0,
    tombstoneTtlSum: 0,
    tombstoneTtlMax: 0,
    tombstoneCount: 0,
    repairSpend: 0,
    sinceTick: 0,
    started: false
  };
}

// ---------------------------------------------------------------------------
// THE DEATH WATCH - cause of death from the meter's own evidence
// ---------------------------------------------------------------------------
//
// A dead creep's object carries NO ticksToLive, so "expired vs killed" is
// resolvable only from a record made while the creep still lived - the trap
// list's "durable signals" doctrine wearing one more costume. The watch
// samples every live own creep's TTL on the loss stride into Memory (a global
// reset must not blind the deaths that follow a deploy - often the most
// interesting ones). TTL decrements exactly 1/tick, so
// `lastSeenTtl - (deathTime - lastSeenTick)` is EXACT whenever the creep
// survived to its recorded deathTime: zero left = expired, time left = killed.

/** Last-seen record per creep name: [ttl, tick]. */
/** Per-creep last sighting: [ttl, tick, recycling?, reason?]. The third
 *  element is 1 when memory.recycling stood at last sight (the recycle path
 *  flags BEFORE the death); the fourth is memory.recycleReason - the trigger
 *  class stamped at the flag site (owner 2026-08-03: "make sure those are
 *  legit"). Old shorter tuples persisted in Memory read as not-recycling /
 *  unstamped. */
type DeathWatch = Record<string, [number, number] | [number, number, 1] | [number, number, 1, string]>;

/**
 * How long a dead creep's entry is kept. A tombstone stands 5 ticks per body
 * part (max 250), so anything older than this can no longer be resolved
 * against a standing tombstone - prune it, or the map grows with every death
 * forever.
 */
const DEATH_WATCH_RETENTION = 300;

let localWatch: DeathWatch = {};

function deathWatch(): DeathWatch {
  if (typeof Memory === "undefined") return localWatch;
  const mem = Memory as unknown as { creepDeathWatch?: DeathWatch };
  if (!mem.creepDeathWatch) mem.creepDeathWatch = {};
  return mem.creepDeathWatch;
}

/**
 * Record every live creep's TTL and prune entries no standing tombstone could
 * still need. Creeps mid-spawn have no TTL yet and are skipped rather than
 * recorded as garbage.
 */
export function watchCreepTtls(
  creeps: Record<string, { ticksToLive?: number; memory?: { recycling?: boolean; recycleReason?: string } }>,
  tick: number
): void {
  const watch = deathWatch();
  for (const name in creeps) {
    const ttl = creeps[name].ticksToLive;
    if (typeof ttl === "number" && ttl > 0) {
      // The recycle flag rides the record: a deliberate spawn-side death must
      // not masquerade as combat (t72755898: 4,844e of recycle cargo booked
      // "killed" in the home room fed the raid narrative). The REASON rides
      // beside it so the account can attribute each recycle to its trigger.
      const mem = creeps[name].memory;
      watch[name] =
        mem?.recycling === true
          ? mem.recycleReason
            ? [ttl, tick, 1, mem.recycleReason]
            : [ttl, tick, 1]
          : [ttl, tick];
    }
  }
  for (const name in watch) {
    if (!(name in creeps) && tick - watch[name][1] > DEATH_WATCH_RETENTION) delete watch[name];
  }
}

/** The watch record for one creep name (test/collector seam). */
export function deathWatchEntry(
  name: string
): [number, number] | [number, number, 1] | [number, number, 1, string] | undefined {
  return deathWatch()[name];
}

/**
 * Resolve a death's cause from the watch record and the tombstone's own
 * deathTime. Pure; returns {} when the evidence cannot support a verdict -
 * no record, no deathTime, or a record NEWER than the death (a reused name).
 * The caller books {} as UNKNOWN, never as a default cause.
 */
export function resolveDeathCause(
  watch: readonly [number, number] | readonly [number, number, 1] | readonly [number, number, 1, string] | undefined,
  deathTime: number | undefined
): { killed?: boolean; recycled?: boolean; recycleReason?: string; ttlAtDeath?: number } {
  if (!watch || typeof deathTime !== "number") return {};
  const [ttlSeen, tickSeen] = watch;
  if (deathTime < tickSeen) return {};
  const ttlAtDeath = Math.max(0, ttlSeen - (deathTime - tickSeen));
  // A creep FLAGGED recycling that died with time left died at the spawn on
  // purpose - a deliberate refund, not combat. One that ran the clock out
  // anyway books expired exactly as before (the flag never hides a real
  // expiry, and combat during the walk-to-spawn is indistinguishable from
  // the recycle by design - the flag is the better evidence either way).
  if (watch.length > 2 && ttlAtDeath > 0) {
    return { recycled: true, ttlAtDeath, ...(watch.length > 3 ? { recycleReason: watch[3] } : {}) };
  }
  return { killed: ttlAtDeath > 0, ttlAtDeath };
}

/**
 * Drop the module-state view - what a global reset does to the globals.
 *
 * `keepTotals` models the real thing: Memory survives a reset, the globals do
 * not. Tests use the default (drop everything) for isolation.
 */
export function resetLossMeter(opts: { keepTotals?: boolean } = {}): void {
  rooms.clear();
  bookedTombs.clear();
  totals = blank();
  if (!opts.keepTotals) {
    localLedger = zeroCumulative();
    localWatch = {};
    if (typeof Memory !== "undefined") {
      (Memory as unknown as { lossLedger?: LossCumulative }).lossLedger = zeroCumulative();
      (Memory as unknown as { creepDeathWatch?: DeathWatch }).creepDeathWatch = {};
    }
  }
}

/**
 * Record energy spent repairing, at the repair site. Called with the ENERGY,
 * not the hits, so the caller owns the conversion its own action defines
 * (a creep pays per WORK part, a tower pays its fixed shot cost).
 */
export function recordRepair(energy: number): void {
  accrue("repairSpend", "repairSpend", energy);
}

/**
 * Fold one room's census into the meter. `dt` is derived per-room from that
 * room's OWN previous sample, so an irregular cadence (or a room sampled only
 * while visible) still integrates correctly and a gap never double-counts.
 */
export function sampleRoomLosses(census: RoomLossCensus, tick: number): void {
  if (!totals.started) {
    totals.started = true;
    totals.sinceTick = tick;
  }

  const prev = rooms.get(census.room);
  const dt = prev ? Math.max(0, tick - prev.lastTick) : 0;

  if (dt > 0) {
    // Rates observed at the PREVIOUS sample held over the interval. Integrating
    // the old stock (not the new one) keeps a pile that was hauled away mid-
    // interval from being charged as if it had rotted the whole time.
    let pile = 0;
    for (const amount of census.piles) pile += pileDecayRate(amount);
    accrue("pileDecay", "pileDecay", pile * dt);

    const structure =
      census.containers * containerDecayEnergy(census.owned) +
      census.ramparts * rampartDecayEnergy() +
      Math.max(0, census.roadDecayEnergy);
    accrue("structureDecay", "structureDecay", structure * dt);
  }

  // --- tombstones: book at FIRST SIGHT, credit only witnessed recovery ---
  //
  // A room's FIRST sample is a baseline, never a charge. The tombstones already
  // standing when the window opens are a BACKLOG - those creeps died before the
  // meter existed - and booking them makes a rate out of a stock. Measured
  // live t72721419: 1596e of standing tombstones re-booked on the deploy's
  // global reset, 2.85 of the 12.21 e/t reported (~23% phantom), and every
  // deploy did it again.
  const now = new Map<string, number>();
  for (const t of census.tombstones) {
    now.set(t.id, t.energy);
    if (bookedTombs.has(t.id)) continue;
    bookedTombs.add(t.id);
    // `prev` absent = this room's baseline sample; adopt without charging.
    if (prev && t.energy > 0) {
      accrue("tombstoneGross", "tombstoneGross", t.energy);
      const led = ledger();
      // Attribution rides with the booking, so it is counted exactly once and
      // can never disagree with the total it decomposes - and it accrues into
      // the cumulative ledger beside the gross, so the account's shares span
      // the same capture window as the line they decorate.
      const role = t.role && t.role.length > 0 ? t.role : "unknown";
      totals.tombstoneByRole[role] = (totals.tombstoneByRole[role] ?? 0) + t.energy;
      led.tombstoneByRole[role] = (led.tombstoneByRole[role] ?? 0) + t.energy;
      // CAUSE is a verdict, not a default: true/false come only from the death
      // watch's evidence (resolveDeathCause); absent evidence is UNKNOWN. The
      // v23 rule defaulted everything into "expired" off a field that is
      // 0/undefined on every dead creep - its own audit line read SUSPECT.
      if (t.recycled === true) {
        // A deliberate spawn-side refund (memory.recycling stood at last
        // sight): its own bucket, OUT of killed and out of the WHERE split -
        // it is not combat evidence anywhere (t72755898: 4,844e of recycle
        // cargo booked "killed" at home fed the raid narrative). Attributed
        // to the flag site's stamped trigger class so "are these legit" is a
        // read, not an inference (owner 2026-08-03).
        totals.tombstoneRecycled += t.energy;
        led.tombstoneRecycled += t.energy;
        const reason = t.recycleReason && t.recycleReason.length > 0 ? t.recycleReason : "unstamped";
        totals.tombstoneRecycledByReason[reason] = (totals.tombstoneRecycledByReason[reason] ?? 0) + t.energy;
        led.tombstoneRecycledByReason[reason] = (led.tombstoneRecycledByReason[reason] ?? 0) + t.energy;
      } else if (t.killed === true) {
        totals.tombstoneKilled += t.energy;
        led.tombstoneKilled += t.energy;
        // The WHERE (owner 2026-08-03): killed energy by booking room, and
        // the share intel can actually attribute to hostiles. Kills in quiet
        // rooms falsify the raid narrative rather than feeding it.
        totals.tombstoneKilledByRoom[census.room] = (totals.tombstoneKilledByRoom[census.room] ?? 0) + t.energy;
        led.tombstoneKilledByRoom[census.room] = (led.tombstoneKilledByRoom[census.room] ?? 0) + t.energy;
        if (census.hostileFlagged === true) {
          totals.tombstoneKilledHostileRoom += t.energy;
          led.tombstoneKilledHostileRoom += t.energy;
        }
      } else if (t.killed === false) {
        totals.tombstoneExpired += t.energy;
        led.tombstoneExpired += t.energy;
      } else {
        totals.tombstoneCauseUnknown += t.energy;
        led.tombstoneCauseUnknown += t.energy;
      }
      // TTL distribution over KNOWN deaths only - an unresolvable ttl
      // contributes no sample instead of dragging the mean toward zero,
      // which is exactly how a constant field masqueraded as data.
      if (t.ttlAtDeath !== undefined) {
        const ttl = Math.max(0, t.ttlAtDeath);
        totals.tombstoneTtlSum += ttl;
        totals.tombstoneTtlMax = Math.max(totals.tombstoneTtlMax, ttl);
        totals.tombstoneCount += 1;
        led.tombstoneTtlSum += ttl;
        led.tombstoneTtlKnown += 1;
      }
    }
  }

  if (prev) {
    for (const [id, wasEnergy] of prev.tombs) {
      const stillEnergy = now.get(id);
      // A tombstone that DISAPPEARED tells us nothing: with no reliable
      // recovery the default is loss, and the loss was already booked at first
      // sight. Only a drawdown while the tombstone still STANDS is evidence
      // that a creep took the energy.
      if (stillEnergy === undefined) continue;
      const drawn = wasEnergy - stillEnergy;
      if (drawn > 0) accrue("tombstoneRecovered", "tombstoneRecovered", drawn);
    }
  }

  rooms.set(census.room, { lastTick: tick, tombs: now });

  // Stock is a level, not a flow: recomputed across all known rooms each time.
  let stock = 0;
  for (const st of rooms.values()) for (const e of st.tombs.values()) stock += e;
  totals.tombstoneStock = stock;
}

/** The meter's published shape - rates in energy/tick, stock in energy. */
export interface LossReport {
  windowTicks: number;
  /** EXACT: the engine's ceil rule applied to observed piles. */
  pileDecay: number;
  /** MODELLED liability: energy/tick to hold every decaying structure at hits. */
  structureDecay: number;
  /** MEASURED: energy/tick actually spent repairing. */
  repairSpend: number;
  /**
   * NET energy/tick lost to tombstones: booked at first sight, less any
   * recovery actually witnessed. Lost is the DEFAULT - see the header.
   */
  tombstoneLost: number;
  /** Energy/tick witnessed leaving a standing tombstone (credited, not a loss). */
  tombstoneRecovered: number;
  /** Energy sitting in live tombstones right now (at risk, not yet lost). */
  tombstoneStock: number;
  /**
   * Gross tombstone energy by creep ROLE, and by CAUSE of death. Both decompose
   * the gross booking (not the net of recovery), so they sum to the same total
   * the loss line is built from. Answers whether the tombstone line is haulers
   * expiring mid-route - which folds it into the carry deficit - or anything
   * being killed, which is a defense question instead.
   */
  tombstoneByRole: Record<string, number>;
  tombstoneExpired: number;
  tombstoneKilled: number;
  /** KILLED energy by booking room / by intel-hostile flag - the WHERE
   *  (owner 2026-08-03: kills in quiet rooms falsify the raid narrative). */
  tombstoneKilledByRoom: Record<string, number>;
  tombstoneKilledHostileRoom: number;
  /** Energy from creeps that died RECYCLING (deliberate refund, not combat). */
  tombstoneRecycled: number;
  /** Recycled energy by trigger class (flag-site stamp; "unstamped" = pre-stamp). */
  tombstoneRecycledByReason: Record<string, number>;
  /** Gross energy whose cause could not be resolved (no death-watch record). */
  tombstoneCauseUnknown: number;
  /** Mean/max TTL remaining at death, over KNOWN deaths only. */
  tombstoneTtlMean: number;
  tombstoneTtlMax: number;
  /**
   * CUMULATIVE energy totals, monotonic and surviving global resets. The
   * account differences these between two captures, so the measured window
   * equals the capture window for any length - including a full fiscal month,
   * which the since-reset rates above can never span.
   */
  cumulative: LossCumulative;
}

export function lossReport(tick: number): LossReport {
  const w = totals.started ? Math.max(0, tick - totals.sinceTick) : 0;
  const rate = (n: number): number => (w > 0 ? n / w : 0);
  return {
    windowTicks: w,
    pileDecay: rate(totals.pileDecay),
    structureDecay: rate(totals.structureDecay),
    repairSpend: rate(totals.repairSpend),
    tombstoneLost: rate(Math.max(0, totals.tombstoneGross - totals.tombstoneRecovered)),
    tombstoneRecovered: rate(totals.tombstoneRecovered),
    tombstoneStock: totals.tombstoneStock,
    tombstoneByRole: { ...totals.tombstoneByRole },
    tombstoneExpired: totals.tombstoneExpired,
    tombstoneKilled: totals.tombstoneKilled,
    tombstoneKilledByRoom: { ...totals.tombstoneKilledByRoom },
    tombstoneKilledHostileRoom: totals.tombstoneKilledHostileRoom,
    tombstoneRecycled: totals.tombstoneRecycled,
    tombstoneRecycledByReason: { ...totals.tombstoneRecycledByReason },
    tombstoneCauseUnknown: totals.tombstoneCauseUnknown,
    tombstoneTtlMean: totals.tombstoneCount > 0 ? totals.tombstoneTtlSum / totals.tombstoneCount : 0,
    tombstoneTtlMax: totals.tombstoneTtlMax,
    cumulative: {
      ...ledger(),
      tombstoneByRole: { ...ledger().tombstoneByRole },
      tombstoneKilledByRoom: { ...ledger().tombstoneKilledByRoom },
      tombstoneRecycledByReason: { ...ledger().tombstoneRecycledByReason }
    }
  };
}

// ---------------------------------------------------------------------------
// GAME-COUPLED COLLECTION
// ---------------------------------------------------------------------------

/**
 * Sample cadence. The census walks every visible room's dropped resources,
 * tombstones and decaying structures - three FINDs per room - so it runs on a
 * stride rather than every tick. The meter integrates against each room's OWN
 * last sample, so the stride costs resolution, never correctness: a pile is
 * charged at the rate observed at the start of the interval.
 *
 * 10 ticks against a decay cadence measured in hundreds is far finer than the
 * quantity it measures. The one thing it bounds is the tombstone
 * discriminator: a tombstone must be seen with <= SAMPLE_STRIDE ticks of life
 * left to be scored as expired, which is exactly the `ticksToDecay <= dt` rule.
 */
export const LOSS_SAMPLE_STRIDE = 10;

/**
 * Which kind of creep this tombstone was.
 *
 * OUR OWN MEMORY FIRST - `workType` is the exact answer and it is the same
 * field every other lens keys off, so the attribution cannot disagree with the
 * census. Memory is cleaned up for dead creeps, so it is present only while the
 * cleanup has not yet run; the BODY is the durable fallback and is good enough
 * to separate the classes that matter (a hauler is CARRY, a miner is WORK).
 */
function tombRole(t: Tombstone): string {
  const name = (t.creep as { name?: string } | undefined)?.name;
  if (name && typeof Memory !== "undefined") {
    const wt = Memory.creeps?.[name]?.workType;
    if (wt) return String(wt);
  }
  const body = (t.creep as { body?: { type: string }[] } | undefined)?.body ?? [];
  let work = 0;
  let carry = 0;
  let claim = 0;
  for (const p of body) {
    if (p.type === WORK) work += 1;
    else if (p.type === CARRY) carry += 1;
    else if (p.type === CLAIM) claim += 1;
  }
  if (claim > 0) return "reserve";
  if (work > 0 && work >= carry) return "harvest";
  if (carry > 0) return "haul";
  return body.length > 0 ? "other" : "unknown";
}

/** Terrain-weighted road decay for a room, in energy/tick to hold hits. */
function roadDecayFor(roads: { hitsMax: number }[]): number {
  let hitsPerTick = 0;
  for (const r of roads) {
    // A road's hitsMax IS its terrain multiplier (plain 5k, swamp 25k, tunnel
    // 750k) and decay scales with it identically, so the ratio recovers the
    // multiplier without a terrain lookup per tile.
    const multiplier = Math.max(1, (r.hitsMax || ROAD_HITS) / ROAD_HITS);
    hitsPerTick += (ROAD_DECAY_HITS * multiplier) / ROAD_DECAY_INTERVAL;
  }
  return hitsToEnergy(hitsPerTick);
}

/**
 * Census every visible room into the meter. Cheap no-op off the stride.
 * Traffic decay is deliberately EXCLUDED: creep steps drain a road's decay
 * timer on top of the base cadence, so this figure is a LOWER BOUND on road
 * maintenance and the report says so rather than modelling traffic twice
 * (economy/roadEconomics already prices it plan-side).
 */
export function collectLosses(tick: number): void {
  if (tick % LOSS_SAMPLE_STRIDE !== 0) return;
  if (typeof Game === "undefined" || !Game.rooms) return;

  // Refresh the death watch FIRST, so a creep that dies later in this same
  // stride window resolves against a record at most one stride old.
  if (Game.creeps) watchCreepTtls(Game.creeps, tick);

  // One intel read per stride, shared across the room loop.
  const hostileSet = hostileRooms();

  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    try {
      const piles: number[] = [];
      for (const r of room.find(FIND_DROPPED_RESOURCES)) {
        if (r.resourceType === RESOURCE_ENERGY) piles.push(r.amount ?? 0);
      }

      const tombstones = room.find(FIND_TOMBSTONES).map(t => ({
        id: t.id as string,
        energy: t.store?.[RESOURCE_ENERGY] ?? 0,
        ticksToDecay: t.ticksToDecay ?? 0,
        role: tombRole(t),
        // Cause from the DEATH WATCH, never from the dead creep's object: its
        // ticksToLive is 0/undefined on every tombstone, which made the old
        // split a constant ("expired 100%") that its own audit line called
        // SUSPECT. No watch record (enemy creep, pre-deploy death) resolves
        // to neither field, and the meter books the energy as cause-UNKNOWN.
        ...resolveDeathCause(
          deathWatchEntry((t.creep as { name?: string } | undefined)?.name ?? ""),
          (t as { deathTime?: number }).deathTime
        )
      }));

      let containers = 0;
      let ramparts = 0;
      const roads: { hitsMax: number }[] = [];
      for (const s of room.find(FIND_STRUCTURES)) {
        if (s.structureType === STRUCTURE_CONTAINER) containers += 1;
        else if (s.structureType === STRUCTURE_RAMPART) ramparts += 1;
        else if (s.structureType === STRUCTURE_ROAD) roads.push({ hitsMax: s.hitsMax });
      }

      sampleRoomLosses(
        {
          room: name,
          owned: room.controller?.my === true,
          piles,
          tombstones,
          containers,
          ramparts,
          roadDecayEnergy: roadDecayFor(roads),
          // The WHERE flag from the vision-free intel lens (trap list: room
          // state from intel, never vision) - host-assembled here so the
          // fold stays pure.
          hostileFlagged: hostileSet.has(name)
        },
        tick
      );
    } catch {
      // A room that throws mid-census contributes nothing rather than a partial
      // reading - a half-counted room would understate silently.
    }
  }
}
