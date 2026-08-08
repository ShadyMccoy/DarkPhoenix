/**
 * @fileoverview replacementSchedule - the plan's answer to "which post do we
 * refill next, and how big" (spec 39 phase 3).
 *
 * THE OWNER'S FRAME (2026-08-07): *"if we just make all those creeps in the
 * right order our colony shouldn't have any of the current body shortages or
 * overages. Isn't that effectively what should be happening continuously as the
 * creeps cycle out?"* — and *"if we put the tender and feeder at the beginning
 * it should ensure all the rest get spawned consistently."*
 *
 * That IS the design. What shipped instead was an AUCTION: every corp bids a
 * value each tick and the highest bid takes whatever energy happens to be in
 * the network. Two consequences, measured t72851251:
 *
 *  - a post whose turn comes while the network is drained buys a RUNT, and that
 *    runt then squats its slot for a full creep lifetime. The extension tender
 *    stands 34 parts against the plan's own 48.
 *  - nothing checks the ask against the contract, so a corp that asks big gets
 *    big. The core-link feeder stood 100 parts against a 32-part price.
 *
 * Both signs of ONE seam, and they compound: an undersized tender refills the
 * extensions slower, which drains the network, which buys the NEXT body small —
 * including the next tender. Spawn2 sat `idle.empty` 210 of 606 ticks; 208
 * parts/month of spawn capacity burned by a supply post that could not detect
 * its own shortfall.
 *
 * WHY IT COULD NOT DETECT IT. Both supply corps promote to the heartbeat lane
 * (`spawnPriority`'s linchpin tier, above every scaling producer) on a COUNT:
 *
 *     tender:  staffing < target && depotStock >= 10_000
 *     feeder:  firstFeeder && !drained
 *
 * A full-COUNT fleet of undersized bodies satisfies both. It is the `staffsPost`
 * trap in different clothes — a lens counting bodies where the deficit is
 * capacity. This module measures the deficit in PARTS, against the commission's
 * own declared price, using the `fielded` actuals that spec 39 phase 2 threaded
 * onto `ColonyProblem` and left unread.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: promote unconditionally. An unconditional
 * lift was tried and measurably recreated the W2N6 stream in the cold-start trio
 * (the tender's top-ups pierced the first-hauler wall three times; hauler
 * delayed to tick 498, hand-off probe red). A correctly-sized supply post reads
 * `false` here and keeps its ordinary rung — 96 for the tender, 95 for the
 * feeder, both below the miner band, which is where they belong when the
 * heartbeat is healthy. The lane opens for a real shortfall and closes again.
 *
 * @module economy/replacementSchedule
 */

import { CREEP_LIFETIME } from "./primitives";

/**
 * Standing body parts a commission's declared price implies.
 *
 * `consumes.spawnPartsPerTick` is a REPLACEMENT RATE — parts the spawn must
 * build per tick to hold the post — so the standing fleet it pays for is that
 * rate over one creep generation. This is the same conversion the corp budget
 * statement uses, kept here as the ONE home so a promotion decision and the
 * account can never disagree about what a corp was priced for.
 *
 * Room-local supply posts (tender, feeder) sit within a tile or two of their
 * work, so `effectiveLife` and `CREEP_LIFETIME` differ by ~0.1% and the flat
 * lifetime is exact enough for a threshold comparison. Do NOT reuse this for a
 * far remote without walking it back through `effectiveLife(distance)` — at
 * d=105 the two differ by 7%.
 */
export function declaredStandingParts(spawnPartsPerTick: number | undefined): number {
  if (spawnPartsPerTick === undefined || !(spawnPartsPerTick > 0)) return 0;
  return spawnPartsPerTick * CREEP_LIFETIME;
}

/**
 * How short of its declared body a post currently stands, in parts. Zero when
 * it is at or over its price — an OVERAGE is not a replacement problem and must
 * not read as one (that is the feeder's case, and it is fixed by pricing, not
 * by scheduling).
 */
export function replacementDeficit(declaredParts: number, fieldedParts: number): number {
  if (!(declaredParts > 0)) return 0;
  return Math.max(0, declaredParts - Math.max(0, fieldedParts));
}

/**
 * Fraction of its declared body a post may stand and still count as staffed.
 *
 * Not 1.0: bodies are built from indivisible CARRY+MOVE pairs and the declared
 * price is continuous, so a correctly-sized post routinely lands a few percent
 * either side of its price. Promoting on that rounding would put the supply
 * posts permanently in the heartbeat lane, which is exactly the unconditional
 * lift the W2N6 stream refuted.
 *
 * 0.85 is one pair of slack on a 3-pair body and comfortably inside the
 * measured shortfall it exists to catch (tender 34/48 = 0.71).
 */
export const POST_STAFFED_FRACTION = 0.85;

/**
 * Is this post materially under the body the plan bought it? THE promotion
 * predicate — the one the supply corps' `linchpin` flag reads.
 *
 * Absent declaration (an auxiliary corp still off-budget, or a harness with no
 * commission) reads FALSE: unknown is not a deficit, and fabricating one here
 * would promote every unpriced corp into the heartbeat lane.
 */
export function isUnderDeclared(declaredParts: number | undefined, fieldedParts: number): boolean {
  if (declaredParts === undefined || !(declaredParts > 0)) return false;
  return fieldedParts < declaredParts * POST_STAFFED_FRACTION;
}
