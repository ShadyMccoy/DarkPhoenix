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
 * Module state that re-inits on a global reset, exactly like LinkMeter: a
 * rolling window since the reset, rates = counter / (now - sinceTick).
 *
 * @module telemetry/LossMeter
 */

import {
  containerDecayEnergy,
  hitsToEnergy,
  pileDecayRate,
  rampartDecayEnergy
} from "../economy/primitives";
import { ROAD_DECAY_HITS, ROAD_DECAY_INTERVAL, ROAD_HITS } from "../economy/roadEconomics";

/** One room's decaying-asset census for a single sample. */
export interface RoomLossCensus {
  room: string;
  /** Do we own the controller? Remote containers decay 5x faster. */
  owned: boolean;
  /** Every dropped ENERGY pile in the room, by amount. */
  piles: number[];
  /** Live tombstones with the energy they hold and the life they have left. */
  tombstones: { id: string; energy: number; ticksToDecay: number }[];
  /** Container count (priced by `owned`). */
  containers: number;
  /** Rampart count. */
  ramparts: number;
  /** Road decay for the room, already terrain-weighted, in energy/tick. */
  roadDecayEnergy: number;
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
  repairSpend: number;
  sinceTick: number;
  started: boolean;
}

/** Tombstone ids already booked - a tombstone is charged ONCE, however long it
 *  stands. Colony-wide, so a tombstone seen from two rooms cannot double-book. */
const bookedTombs = new Set<string>();

const rooms = new Map<string, RoomState>();
let totals: Totals = blank();

function blank(): Totals {
  return {
    pileDecay: 0,
    structureDecay: 0,
    tombstoneGross: 0,
    tombstoneRecovered: 0,
    tombstoneStock: 0,
    repairSpend: 0,
    sinceTick: 0,
    started: false
  };
}

/** Drop all state - a global reset, or a test. Never reports a spike after. */
export function resetLossMeter(): void {
  rooms.clear();
  bookedTombs.clear();
  totals = blank();
}

/**
 * Record energy spent repairing, at the repair site. Called with the ENERGY,
 * not the hits, so the caller owns the conversion its own action defines
 * (a creep pays per WORK part, a tower pays its fixed shot cost).
 */
export function recordRepair(energy: number): void {
  if (energy > 0) totals.repairSpend += energy;
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
    totals.pileDecay += pile * dt;

    const structure =
      census.containers * containerDecayEnergy(census.owned) +
      census.ramparts * rampartDecayEnergy() +
      Math.max(0, census.roadDecayEnergy);
    totals.structureDecay += structure * dt;
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
    if (prev && t.energy > 0) totals.tombstoneGross += t.energy;
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
      if (drawn > 0) totals.tombstoneRecovered += drawn;
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
    tombstoneStock: totals.tombstoneStock
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
        ticksToDecay: t.ticksToDecay ?? 0
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
          roadDecayEnergy: roadDecayFor(roads)
        },
        tick
      );
    } catch {
      // A room that throws mid-census contributes nothing rather than a partial
      // reading - a half-counted room would understate silently.
    }
  }
}
