/**
 * @fileoverview Scavenging - turn ground energy stocks into transient sources.
 *
 * A pile of dropped energy, a tombstone, or a ruin is already-harvested energy
 * lying around. Above a threshold it becomes a TRANSIENT source (see CorpPlanner):
 * no miner, just a scavenger that hauls it home. Below the threshold it is left to
 * the ordinary source-haulers' opportunistic pickup (nodeEnergy.sourcePickupSpot)
 * - promoting every few-energy trickle to a dedicated scavenger would cost more to
 * run than it recovers.
 *
 * The "short term" is emergent: stocks are re-detected every economy rebuild, so a
 * stock that has been drained or has decayed below the threshold simply stops
 * being a source and its scavengers demobilise. No decay dynamics live in the
 * planner.
 *
 * The economic functions here are pure and unit-tested; only `detectRoomStocks`
 * touches the Screeps room API.
 *
 * @module economy/scavenge
 */

import { Position } from "../types/Position";
import { effectiveLife } from "./primitives";
import { PlannerSource } from "./CorpPlanner";

/** Below this many energy a stock is left to opportunistic source-hauler pickup. */
export const SCAVENGE_THRESHOLD = 750;

/**
 * Chebyshev range around an OWNED controller inside which energy is the
 * upgraders' working buffer, never scavenge supply - WHILE A FEEDER RELAY
 * MANAGES IT (room.memory.controllerFeederActive). Matches upgrade range and
 * the input-spot buffer scan (controllerInputSpot resolves containers within
 * range 3): under a feeder the input stock is held at CONTROLLER_FEED_TARGET,
 * so planning it as supply commissions haulers to carry the upgraders' own
 * buffer home again - an energy circle the feeder immediately refills, paying
 * transport overhead in both directions forever.
 *
 * The gate matters: BEFORE a room has a feeder (no storage - RCL2/3), the
 * controller drop-off is the colony's OVERFLOW buffer (haulers spill the
 * post-spawn surplus there), and scavenging the overgrown pile back into
 * construction is load-bearing recapture - excluding it unconditionally left
 * the spill to rot (measured: fid-t4-preramped gross fidelity 72% -> 53%,
 * decay 5.5 e/t of 20 mined).
 */
export const CONTROLLER_BUCKET_RANGE = 3;

/** Cap on a single stock's drain rate so we never over-provision scavengers. */
export const MAX_SCAVENGE_RATE = 20;

/**
 * A stock fields a DEDICATED corp only when its sized drain rate clears this
 * (owner 2026-07-20, the micro-route sweep): below it, the planned route is
 * sub-1-CARRY, and the corp lifecycle costs more than it recovers - measured
 * as the E2/E5 churn loop (a 100-cost runt spawns for a pile that decays
 * away before the runt's life ends; the corp strands ~40 parts of fleet).
 * Sub-floor stocks stay covered by opportunistic pickup (sourcePickupSpot),
 * exactly like sub-threshold ones - the fid-t4 recapture class (real
 * overflow piles, 2k+ near the controller) sizes ~0.7 e/t and stays above
 * the floor.
 */
export const SCAVENGE_RATE_FLOOR = 0.5;

/**
 * How much faster than a stock's own decay (ceil(amount/1000)/t) its drain
 * rate is priced (audit t72950630): rate 2x decay recovers ~2/3 of what
 * stands and clears the pile in finite time; the half-life law it floors
 * recovered 18-24% over four measured windows while paying full body cost.
 */
export const SCAVENGE_DECAY_DOMINANCE = 2;

/** A scavengeable ground energy stock (dropped pile, tombstone, or ruin). */
export interface GroundStock {
  /** Stable position-encoded id: "scavenge-ROOM-X-Y" (see stockId). */
  id: string;
  /** Where the stock sits. */
  pos: Position;
  /** Energy available right now. */
  amount: number;
}

/** A raw energy find before thresholding - the testable input to collectStocks. */
export interface EnergyFind {
  pos: Position;
  energy: number;
}

/**
 * Bounded drain rate (energy/tick) to assign a stock of `amount` energy at
 * `distance` from its spawn (owner 2026-07-20): "scavenging IS better than
 * mining. Especially if it's closer" - the energy is already extracted, so a
 * stock competes with mined routes on plain route economics, not behind
 * them. But the FLEET is sized waste-free like every other crew: "size the
 * scavenger fleet to work through the pile in effective ttl", planning
 * against the pile as it stands at the drain's TEMPORAL MIDPOINT (owner:
 * "750 tick decay") - ground decay is proportional to the standing amount
 * (ceil(amount/1000)/t, ~an exponential at 1/1000), so ~750 ticks into a
 * ~1500-tick drain the pile sits at A*e^(-0.75) ~ 0.47*A; amount/2 is that
 * midpoint within 6%. What decay takes anyway was never recoverable at
 * this pace; a right-sized fleet cannot crowd standing production out of
 * the parts ledger (the t72447104 displacement came from the old 150-tick
 * burst target asking 20 e/t per pile). MAX_SCAVENGE_RATE stays as the
 * absurdity cap. If a marginal remote still yields a route to a closer
 * stock, that is the correct trade (owner: "not necessarily wrong - we
 * sort of lose on the capex or the room reservation a bit").
 */
export function scavengeRate(amount: number, distance = 0, mature = false): number {
  const halfLife = amount / 2 / effectiveLife(distance);
  // DECAY DOMINANCE, MATURE COLONIES ONLY (audit t72950630). The half-life
  // term alone drains at rate/decay = 1000/(2*effectiveLife) ~ 0.36-0.42 at
  // EVERY pile size - it structurally loses to the engine's
  // ceil(amount/1000) decay, and four consecutive audit windows measured
  // the outcome: 18/20/24/24% collected, the engine taking the rest,
  // scavenger bodies paid to lose the race (recovery net +0.31 e/t against
  // 8.06 e/t of standing pile decay). A MATURE colony's rate now DOMINATES
  // decay so ~2/3 of a funded stock is recovered; a stock this ask makes
  // unprofitable simply loses funding (an honest write-off beats a paid
  // loss). MAX_SCAVENGE_RATE still caps the absurd - the retired 150-tick
  // burst (t72447104 displacement) asked 20 e/t per pile, dominance asks
  // 2-10.
  //
  // BOOTSTRAP KEEPS THE HALF-LIFE LAW (the same split CarryCorp's drain
  // term rides): in a 300-cap cold-start world the dominance ask displaces
  // the miner upsize from the spawn's tiny bank - the runt-economy canary
  // went red on exactly this (a 1901e mouth pile asking 4 e/t, upsize
  // "never afforded", t72950630 gate run). The ramp is waste-TOLERANT by
  // doctrine: piles may rot while every spare unit buys the escape.
  const decayBeating = mature ? SCAVENGE_DECAY_DOMINANCE * Math.ceil(amount / 1000) : 0;
  return Math.min(MAX_SCAVENGE_RATE, Math.max(halfLife, decayBeating));
}

/**
 * Stable, position-encoded id for a stock: "scavenge-ROOM-X-Y". Mirrors the
 * "intel-ROOM-X-Y" source id so the CarryCorp can parse the pickup position from
 * the id alone, with no live game object to look up. THE encoder for the
 * scavenge id space - the matching lenses (economy/ids.ts isScavengeId /
 * parsePositionalId) decode exactly this form; change one only with the other.
 */
export function stockId(pos: Position): string {
  return `scavenge-${pos.roomName}-${pos.x}-${pos.y}`;
}

/**
 * Filter raw finds to stocks worth a dedicated scavenger (>= threshold) and tag
 * each with its position-encoded id. Pure.
 */
export function collectStocks(finds: EnergyFind[], threshold = SCAVENGE_THRESHOLD): GroundStock[] {
  return finds
    .filter(f => f.energy >= threshold)
    .map(f => ({ id: stockId(f.pos), pos: f.pos, amount: f.energy }));
}

/**
 * Chebyshev radius around a source inside which ground energy is the MINING
 * corp's business, not scavenge's (covers the mouth container and drop
 * spread). See excludeSourceMouths.
 */
export const SOURCE_MOUTH_RANGE = 2;

/**
 * Drop finds at source mouths (audit t72958467). Since the staged-mouth
 * drain term (2026-08-07) a mouth pile is priced into the MINING corp's own
 * routes and gated by E6 - a scavenge stock there is DOUBLE COVERAGE, and at
 * decay-dominance rates the recovery fleet (7.08 e/t of bodies) fought the
 * mining corps at three mouths: forgone mining 39.09 e/t, recovery net
 * -4.21, one source's haul fractured into 8 micro-routes. Mouths leave the
 * scan; orphan piles (tombstones mid-route, port spills, core-adjacent
 * drops) remain scavenge's domain. Pure - callers pass the room's source
 * positions.
 */
export function excludeSourceMouths(
  finds: EnergyFind[],
  sourcePositions: Position[],
  range = SOURCE_MOUTH_RANGE
): EnergyFind[] {
  if (sourcePositions.length === 0) return finds;
  return finds.filter(
    f =>
      !sourcePositions.some(
        sp =>
          sp.roomName === f.pos.roomName &&
          Math.max(Math.abs(f.pos.x - sp.x), Math.abs(f.pos.y - sp.y)) <= range
      )
  );
}

/**
 * Drop finds inside the controller bucket (see CONTROLLER_BUCKET_RANGE). Pure:
 * pass null when the room has no owned controller and everything is kept.
 */
export function excludeControllerBucket(finds: EnergyFind[], controllerPos: Position | null): EnergyFind[] {
  if (!controllerPos) return finds;
  return finds.filter(
    f =>
      Math.max(Math.abs(f.pos.x - controllerPos.x), Math.abs(f.pos.y - controllerPos.y)) > CONTROLLER_BUCKET_RANGE
  );
}

/** Turn a detected stock into a transient PlannerSource (no miner; bounded drain rate). */
export function stockToTransientSource(stock: GroundStock, nodeId: string, distance = 0, mature = false): PlannerSource {
  return {
    id: stock.id,
    nodeId,
    pos: stock.pos,
    rate: scavengeRate(stock.amount, distance, mature),
    maxMiners: 0,
    transient: true
  };
}

/**
 * Scan a room for scavengeable stocks: dropped energy, plus tombstone and ruin
 * energy. Thin wrapper over the room API; the thresholding/rate logic is the pure
 * functions above.
 */
export function detectRoomStocks(
  room: Room,
  threshold = SCAVENGE_THRESHOLD,
  includeContainers = true
): GroundStock[] {
  let finds: EnergyFind[] = [];

  for (const r of room.find(FIND_DROPPED_RESOURCES)) {
    if (r.resourceType === RESOURCE_ENERGY && r.amount > 0) {
      finds.push({ pos: r.pos, energy: r.amount });
    }
  }
  for (const t of room.find(FIND_TOMBSTONES)) {
    const energy = t.store[RESOURCE_ENERGY];
    if (energy > 0) finds.push({ pos: t.pos, energy });
  }
  for (const ruin of room.find(FIND_RUINS)) {
    const energy = ruin.store[RESOURCE_ENERGY];
    if (energy > 0) finds.push({ pos: ruin.pos, energy });
  }

  // The FEEDER-MANAGED controller bucket is not scavengeable: that energy
  // already reached its destination and the feeder would just refill it (the
  // circle). Without a feeder the drop-off is the overflow buffer and stays
  // scavengeable - recapture of over-spill into construction is load-bearing.
  const ctrl = room.controller;
  const feederManaged = !!ctrl && ctrl.my && !!room.memory.controllerFeederActive;
  finds = excludeControllerBucket(
    finds,
    feederManaged ? { x: ctrl!.pos.x, y: ctrl!.pos.y, roomName: room.name } : null
  );

  // SOURCE MOUTHS ARE THE MINING CORP'S TERRITORY (audit t72958467; see
  // excludeSourceMouths). Applies to owned AND remote scans - the staged
  // drain term prices mouth clearing into the mining routes everywhere.
  finds = excludeSourceMouths(
    finds,
    room.find(FIND_SOURCES).map(s => ({ x: s.pos.x, y: s.pos.y, roomName: room.name }))
  );

  // ONE SUMMED STOCK (owner 2026-07-10): a pile sitting on/next to a stocked
  // container is a single quantity of energy for planning - the container's
  // contents join the pile's find so thresholding and drain-rate sizing see
  // the true stock (execution drains the decaying pile first; nodeEnergy).
  // REMOTE callers pass includeContainers=false: the container is a route's
  // own supply (scavenging it was the 2026-07-19 warchest-bleed siphon), so
  // remote stocks are DROPPED-ONLY - the spill that decays if nobody comes.
  if (includeContainers) {
    for (const find of finds) {
      const pos = new RoomPosition(find.pos.x, find.pos.y, find.pos.roomName);
      for (const s of pos.findInRange(FIND_STRUCTURES, 0)) {
        if (s.structureType === STRUCTURE_CONTAINER) {
          find.energy += (s as StructureContainer).store[RESOURCE_ENERGY];
        }
      }
    }
  }

  return collectStocks(finds, threshold);
}
