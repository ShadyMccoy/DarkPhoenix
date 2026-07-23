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
}

/**
 * Route one source-link volley. Priority:
 *  1. DIRECT to the controller when it has room AND is still under its planned
 *     rate - the 1-hop win, capped by the value ladder (never past the plan).
 *  2. Else bank via the core (production-first: the bank gets the residual).
 *  3. Else, if the core is full, spill to the controller if it has room - the
 *     OLD congestion-relief behavior, preserved as a fallback so a congested
 *     core never strands income.
 *  4. Else a sub-threshold core remainder before holding outright.
 */
export function routeSourceVolley(ctx: VolleyContext): VolleyTarget {
  const ctrlHasRoom = ctx.controllerFree !== null && ctx.controllerFree >= ctx.threshold;

  // 1. Planned direct delivery (the new win).
  if (ctrlHasRoom && ctx.controllerUnderPlan) return "controllerDirect";

  // 2. Bank first for the residual.
  if (ctx.coreFree >= ctx.threshold) return "core";

  // 3. Congestion spill to the controller (owner 2026-07-21), now a fallback.
  if (ctrlHasRoom) return "controllerDirect";

  // 4. Sub-volley core remainder before holding.
  if (ctx.coreFree > 0) return "core";

  return null;
}
