/**
 * @fileoverview linkRouting - the pure decision at the heart of the spec-26
 * link economy (stage 2): where does a ready source-link's volley go?
 *
 * The instrument (LinkMeter, stage 1) proved the miss: 100% of controller-bound
 * energy double-hops (source->core->controller) because LinkRunner's direct path
 * only fired on core congestion, which normal operation never reaches. This rule
 * INVERTS that: prefer the cheap 1-hop DIRECT deposit into the controller
 * (withdraw-only) link up to the controller's PLANNED rate, then bank via the
 * core. Production-first is preserved - the bank still receives everything above
 * the controller's allocated share, and the cap (the feeder's relay rate) is the
 * value ladder's decision, not the link's.
 *
 * Pure and unit-pinned. The caller supplies whether direct delivery is still
 * BELOW the plan's controller rate (measured from LinkMeter vs feederRelayRate);
 * this module never reads Game or the meter.
 *
 * Vocabulary (owner-locked): a link is transit, neither source nor sink. A creep
 * DEPOSITS into it or WITHDRAWS from it. "core" is the hub deposit target;
 * "controllerDirect" deposits straight into the controller's withdraw-only link.
 *
 * @module execution/linkRouting
 */

/** Where a ready source-link should deposit its volley this fire. */
export type VolleyTarget = "core" | "controllerDirect" | null;

export interface VolleyContext {
  /** Free capacity in the core (hub) link. */
  coreFree: number;
  /** Free capacity in the controller (withdraw-only) link, or null if none. */
  controllerFree: number | null;
  /** Is direct delivery to the controller still BELOW its planned rate? When
   * false, the controller has its share this window - further fires bank. */
  controllerUnderPlan: boolean;
  /** Minimum volley worth a (taxed, cooldown-long) fire. */
  threshold: number;
  /**
   * Energy the sending link currently holds - what it would deliver if the
   * target had room. THE field the v1 rule lacked: without it the decision
   * compared free capacity against a fixed floor and could not tell "the
   * target absorbs my whole volley" from "the target takes a sliver and I
   * keep the rest, having spent my whole cooldown". Optional so legacy
   * callers/tests behave as before (treated as "fits anywhere").
   */
  payload?: number;
  /** Chebyshev range to the core link - the cooldown a fire there costs. */
  coreRange?: number;
  /** Chebyshev range to the controller link - the cooldown a fire there costs. */
  controllerRange?: number;
}

/**
 * Value of avoiding the second hop when energy lands DIRECTLY in the
 * controller link. Banking via the core means the core must later fire
 * core->controller, which costs the CORE link's own cooldown (a resource
 * shared by every source in the room) plus a second 3% transfer loss. Encoded
 * as a modest throughput bonus on direct delivery rather than an absolute
 * preference - the v1 absolute preference is exactly what let a nearly-full
 * controller link capture fires it could not absorb. 1.15 is a deliberately
 * conservative v1 estimate (one avoided 3% loss plus a share of the shared
 * core cooldown); the LINK ledger's measured tax and relay rates are the
 * calibration signal if it wants tightening.
 */
export const DIRECT_HOP_BONUS = 1.15;

/**
 * Route one source-link volley by THROUGHPUT PER COOLDOWN (owner 2026-07-29:
 * "it fires towards the controller link, causing it to be backed up because
 * there's very little energy capacity there ... it should fire to the core link
 * more so it can fully empty itself").
 *
 * ENGINE GROUND TRUTH (@screeps/engine processor/intents/links/transfer.js):
 * the amount is CLAMPED to the target's free capacity, then
 * `cooldown += LINK_COOLDOWN * range` is charged IN FULL regardless of how
 * little moved. So the sending link's COOLDOWN - not link capacity - is the
 * scarce resource, and the honest objective is delivered energy per cooldown
 * tick:
 *
 *   throughput(target) = min(payload, free(target)) / range(target)
 *
 * plus DIRECT_HOP_BONUS for landing straight in the controller. The v1 rule
 * fired direct whenever the controller held merely `threshold` free, spending a
 * whole cooldown to move a sliver and leaving the source backed up.
 *
 * Priority:
 *  1. DIRECT when under plan AND its throughput beats the core's.
 *  2. Else bank via the core (production-first: the bank gets the residual).
 *  3. Else, if the core cannot take a threshold volley, spill to the controller
 *     - the OLD congestion-relief behavior, so a congested core never strands
 *     income.
 *  4. Else HOLD rather than pay a full cooldown for a dribble.
 */
export function routeSourceVolley(ctx: VolleyContext): VolleyTarget {
  const ctrlHasRoom = ctx.controllerFree !== null && ctx.controllerFree >= ctx.threshold;
  // No payload/range supplied (legacy callers, pure unit cases): treat the
  // volley as fitting anywhere at equal cost, reproducing the pre-throughput
  // ordering exactly.
  const payload = ctx.payload ?? Number.POSITIVE_INFINITY;
  const deliverCore = Math.min(payload, ctx.coreFree);
  const deliverCtrl = ctx.controllerFree === null ? 0 : Math.min(payload, ctx.controllerFree);
  const coreThroughput = deliverCore / Math.max(1, ctx.coreRange ?? 1);
  const ctrlThroughput = (deliverCtrl / Math.max(1, ctx.controllerRange ?? 1)) * DIRECT_HOP_BONUS;

  // 1. Planned direct delivery - only when it actually moves more per cooldown.
  if (ctrlHasRoom && ctx.controllerUnderPlan && ctrlThroughput >= coreThroughput) return "controllerDirect";

  // 2. Bank first for the residual.
  if (ctx.coreFree >= ctx.threshold) return "core";

  // 3. Congestion spill to the controller (owner 2026-07-21), now a fallback.
  if (ctrlHasRoom) return "controllerDirect";

  // 4. Nothing has a WHOLE-volley's room: HOLD (owner 2026-07-24). Firing the
  // sub-threshold remainder pays the flat 3% tax AND spends the source link's
  // whole cooldown on a fraction of a volley - the reported dribble (core stuck
  // at 799, a source firing 1 e forever, all of it lost to tax). The relay
  // drains the core every tick, so holding one beat opens room for a full
  // >=threshold volley (step 2). Below the minimum-worthwhile volley, don't fire.
  return null;
}

/** The facts the core->CTRL relay hold reads (pure; see holdCoreRelay). */
export interface RelayHoldContext {
  /**
   * Source/port links standing loaded (>= threshold) and OFF COOLDOWN this
   * tick - the volleys that could land in CTRL directly if its space is left
   * for them.
   */
  pendingSenders: number;
  /** The warchest gate (spec 26 stage 2): are ports allowed to fire direct at all? */
  preferControllerDirect: boolean;
  /** CTRL's free capacity, or null when the room has no controller link. */
  controllerFree: number | null;
  /** Minimum worthwhile volley (LINK_FIRE_THRESHOLD). */
  threshold: number;
}

/**
 * ARRIVALS-FIRST: should the core->CTRL relay HOLD this tick because a source
 * port can use CTRL's space more cheaply (spec 45 leg 1, owner-directed
 * 2026-08-05)?
 *
 * Measured t72805426: hubClampShare **0.625** against coreEmptyShare
 * **0.276** - the core clamps arriving volleys 62% of the time while sitting
 * empty 28% of the time. A buffer cannot be both saturated and idle, so this
 * is sequencing, not capacity (and it had worsened from the 0.50 clamp share
 * spec 45 was written against).
 *
 * The relay is the EXPENSIVE controller feed: two hops, two 3% taxes, and it
 * spends the CORE link's cooldown - the one resource every source in the room
 * shares. A port firing direct is one hop, one tax, and PORT B is physically
 * closer to CTRL than to the hub. So while a port stands loaded and ready,
 * CTRL's free space belongs to it and the relay waits one beat; the relay
 * becomes the fallback it should always have been, not the competitor.
 *
 * THE WARCHEST GATE IS NOT REPLACED (spec 45 trap note): below the reserve
 * `preferControllerDirect` is false, ports bank at the core by production-first
 * doctrine (spec 26 stage-2 law), and the relay is then the ONLY controller
 * feed - holding it there would starve the controller outright. Nor does it
 * hold when CTRL lacks room for a whole volley anyway: the port could not fire
 * direct either, so reserving the space buys nothing.
 */
export function holdCoreRelay(ctx: RelayHoldContext): boolean {
  if (ctx.pendingSenders <= 0) return false;
  if (!ctx.preferControllerDirect) return false;
  if (ctx.controllerFree === null || ctx.controllerFree < ctx.threshold) return false;
  return true;
}
