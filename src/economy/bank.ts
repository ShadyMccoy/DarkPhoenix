/**
 * @fileoverview Storage bank draw-down - the SURPLUS half of spec 03.
 *
 * The storage is the colony's warchest: it accumulates the expansion CAPEX
 * (economy/expansion.ts capital trigger) while income exceeds consumption.
 * Without a withdrawal half the bank only ever grows - measured live: 100k+
 * banked while the controller upgraded at the anti-downgrade trickle, because
 * the planner never treats banked energy as supply.
 *
 * The mechanism rides the existing TRANSIENT SOURCE machinery (scavenging):
 * a bank above the warchest target is a ground-stock-shaped supply at the
 * storage position - no miner, a bounded drain rate, re-detected every solve
 * so the draw tapers to zero as the bank approaches the target. The taper IS
 * the hysteresis: no mode flag, no flapping at the boundary.
 *
 * The storage is TWO-SIDED (owner 2026-08-05): its energy is a source and its
 * ullage is a sink, one law over one creep generation in each direction -
 * `bankPressure` is the pair's one home.
 *
 * Anti-pump is STRUCTURAL (spec 03), by ROLE: a storage sink only ever draws
 * DEPOSIT-class sources (CorpPlanner.routeToSinks - `isDeposit` excludes bank
 * ids), so bank->storage circulation is unrepresentable rather than merely
 * priced away. CORRECTED 2026-08-05: this header used to claim the guard was
 * "the room's storage sink is dropped from the problem whenever a bank source
 * is emitted". It is not, and never is - buildColonyProblem keeps every
 * storage sink in every regime deliberately (a hub must stay open to soak
 * remote surplus, #19), which its own comment says and the anti-pump test
 * proves by asserting the sink is present while a bank source stands. Bank
 * flows also never materialize as
 * CarryCorp haulers (commissionPlan skips them): the depot movers already run
 * the last legs - the extension tender (bank -> spawn/extensions) and the
 * LinkCorp (bank -> controller input) - and both size themselves
 * from these same primitives, so plan and runtime cannot drift apart.
 *
 * @module economy/bank
 */

import "../types/Memory"; // Memory augmentation for the expansion import below
import { Position } from "../types/Position";
import { PlannerSource } from "./CorpPlanner";
import { EXPANSION_CAPEX, EXPANSION_SAFETY_RESERVE } from "./expansion";
import { ANTI_DOWNGRADE_DANGER_TICKS, ANTI_DOWNGRADE_RESERVE, CREEP_LIFETIME, storageAbsorbRate } from "./primitives";

/**
 * The colony's HARD liquidity floor: the expansion campaign's full CAPEX plus a
 * single safety reserve. The reserve target never drops below this - a floor
 * under EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE would pin the bank beneath
 * the capital trigger and permanently disable expansion (the exact failure mode
 * the pre-#98 STORAGE_BANK=10k spill caused). Derived, never a second hardcoded
 * number. Doubles as the safe fallback before the first solve publishes a
 * measured reserve target (resolveReserveTarget).
 */
export const BASE_RESERVE = EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE;

/**
 * Coverage horizon (ticks) for the LIQUIDITY reserve above the hard floor: the
 * storage keeps roughly this many ticks of the colony's own income on hand, so
 * a shock that dips income below burn (a raided remote, dead miners) is ridden
 * out of savings before it can starve the spawn - "never bankrupt, never
 * cash-poor". THE tuning knob: raise it to bank harder (more temporal damper,
 * more idle energy), lower it to run leaner (spend more aggressively, thinner
 * buffer). Income is the conservative proxy for the non-discretionary "payroll"
 * that keeps producers alive (income >= payroll), erring toward more damper.
 *
 * Calibrated (gross mined income, ~10 e/t per source) so a mid colony (~40 e/t)
 * reproduces the old flat warchest (~28k), a lean colony (~20 e/t) floors at
 * BASE_RESERVE - freeing the headroom it never needed to spend - and a rich
 * colony (~80 e/t) holds more in proportion to what it has to lose (the
 * asset-rich, cash-poor fix). The reserve now BREATHES with colony size where
 * the flat lump did not.
 */
export const RESERVE_COVERAGE_TICKS = 700;

/**
 * The liquidity reserve the colony keeps banked given its sustained income
 * (energy/tick): cover RESERVE_COVERAGE_TICKS ticks of income, but never below
 * the expansion-safety floor. Pure - the plan measures income once and persists
 * the result (Memory.warchestTarget) so every consumer reads ONE number through
 * resolveReserveTarget, and plan and runtime cannot drift apart.
 */
export function warchestTarget(incomeRate: number): number {
  return Math.max(BASE_RESERVE, RESERVE_COVERAGE_TICKS * incomeRate);
}

/**
 * The colony's sustained FUNDED mining income (energy/tick): the sum of the
 * solve's own funded producer verdicts. THE income basis for the reserve
 * (FlowEconomy.update publishes warchestTarget over this).
 *
 * FUNDED, not the graph's candidate pool. Every scouted source whose real
 * game id intel has recorded passes isMinedIncomeId - the t72444684 phantom
 * guard's "accepted residual", harmless where it was accepted (the fill's
 * bank-pool cap is funded-credit bounded post-solve) but UNBOUNDED here.
 * Measured t72788704 (the 11->12 remote regression): working the 12th remote
 * gave vision to unworked neighbor rooms, five of their sources gained real
 * ids, and the candidate-pool income read jumped 110 -> 170 e/t against 120
 * funded. The reserve leapt 77k -> 119k (+42k), the bank surplus collapsed
 * 73k -> 46k with 165k banked, and bankFedControllerRate throttled the
 * published controller allocation 48.9 -> 31.0 e/t (delivery 56 -> 34.6) -
 * scouting taxed the controller as if prospects were payroll. It kept
 * compounding as vision spread (income read 185 by t72798237). Coverage is
 * for the payroll income actually sustains (income >= payroll); candidates
 * field no fleets and earn no coverage. Verdict-less solutions (legacy
 * shapes) read 0 and the BASE_RESERVE floor binds - the same safe fallback
 * resolveReserveTarget already guarantees pre-first-solve.
 */
export function fundedMiningIncome(verdicts: readonly { rate: number; verdict: string }[] | undefined): number {
  let sum = 0;
  for (const v of verdicts ?? []) if (v.verdict === "funded") sum += v.rate;
  return sum;
}

/**
 * The reserve target every consumer must use: the plan-persisted value, or
 * BASE_RESERVE as a safe fallback before the first solve has published one. The
 * single home for the fallback, so no call site invents its own default (which
 * would drift from the plan's number - the whole point of this module).
 */
export function resolveReserveTarget(persisted: number | undefined): number {
  return persisted ?? BASE_RESERVE;
}

/**
 * Ticks over which the spendable surplus drains - and the equality with
 * CREEP_LIFETIME is the point (owner 2026-07-29: "drain the bank slightly
 * less aggressively, so upgraders are sized more to the equilibrium ...
 * avoid having to recycle upgraders"). Consumer fleets are SIZED to this
 * draw (bankSurplusRate -> bankFedControllerRate -> upgrader inflow), so the
 * horizon must cover the LIFETIME of the bodies it sizes. At 150 (measured
 * swing t72645498->t72652682): a ~21k surplus sized two 4350e upgraders to
 * a 100 e/t draw that self-extinguished in ~200t; the standing fleet then
 * legally burned the bank BELOW reserve for its remaining ~1200t (slope
 * -1.66/t), EOL'd into floor bodies, and the refill re-armed the swing -
 * plus an X5 phantom-churn artifact from the mid-window staffing shrink.
 * At one lifetime the same surplus is a gentle +14 e/t over equilibrium
 * and the bodies it funds die naturally as it empties. Mirrors
 * sustainableConsumptionRate's stock/CREEP_LIFETIME: ONE drain law at
 * every stock.
 */
export const SURPLUS_DRAIN_TICKS = CREEP_LIFETIME;

/**
 * Runaway GUARD on the surplus draw (energy/tick) - NOT a pacer (owner
 * doctrine 2026-07-18: the bot's goal is to FOCUS energy; surge the current
 * objective - upgrading, construction - as fast as it can physically absorb.
 * A max draw that binds below the absorption ceiling counteracts the bot's
 * whole purpose; measured: at 20 it capped the relay at 35 e/t against a
 * 105 e/t plan while 570k sat banked). Set ABOVE any realistic controller-
 * side absorption (parking tiles x per-body WORK tops out well under 100
 * e/t at mid-game) so it only bounds degenerate fleet math - a 570k bank
 * uncapped would ask the feeder for a ~3800 e/t relay (~107 bodies).
 */
export const MAX_SURPLUS_DRAW = 100;

/** Banked energy above the reserve target - what the colony may spend. */
export function spendableBankSurplus(banked: number, reserveTarget: number): number {
  return Math.max(0, banked - reserveTarget);
}

/**
 * Energy/tick of bank surplus the colony spends this plan cycle: drain the
 * spendable surplus over SURPLUS_DRAIN_TICKS, capped at MAX_SURPLUS_DRAW.
 * Zero while the warchest is still filling. Linear in the surplus, so the
 * draw tapers smoothly to zero at the target instead of flapping a regime
 * switch around it.
 */
export function bankSurplusRate(banked: number, reserveTarget: number): number {
  return Math.min(MAX_SURPLUS_DRAW, spendableBankSurplus(banked, reserveTarget) / SURPLUS_DRAIN_TICKS);
}

/**
 * The bank's TWO-SIDED pressure: what the storage offers as a SOURCE and what
 * it can accept as a SINK, at one bank level.
 */
export interface BankPressure {
  /** e/t the bank offers as supply - the spendable surplus over one creep
   *  generation, under the runaway guard (bankSurplusRate). */
  source: number;
  /** e/t the bank can accept - its ullage over one creep generation
   *  (primitives.storageAbsorbRate). Infinity when the ullage is unknown. */
  sink: number;
}

/**
 * THE STORAGE AS A SOURCE AND A SINK (owner 2026-08-05: "model the energy in
 * the storage as a source and the ullage as a sink (although obviously they
 * can't be applied to each other)").
 *
 * Both halves already existed, and both are the SAME law over one creep
 * generation: the stock drains at stock/1500 (bankSurplusRate, net of the
 * liquidity reserve), the room fills at ullage/1500 (storageAbsorbRate). They
 * lived in different modules with nothing tying them together, which is
 * exactly how the sink half stayed dimensionally wrong for so long - it min'd
 * an e/t rate against an absolute energy until spec 58. This is their ONE
 * home: one storage read in, both rates out, so the pair cannot drift and the
 * invariants have somewhere to be tested.
 *
 * The pressure metaphor is exact, and the scenarios pin it: the source RISES
 * and the sink FALLS with the stock, and at least one of them is always open
 * (a bank that could neither give nor take would strand the colony with
 * income it cannot bank and savings it cannot spend). Both saturate - the
 * source at MAX_SURPLUS_DRAW, the sink above whatever supply the routing pass
 * has - so the bank is a plain buffer through the middle of its range and a
 * regulator only near the two ends.
 *
 * THE CAVEAT IS STRUCTURAL, NOT ARITHMETIC. Nothing here stops the two halves
 * being applied to each other; that guard lives where routing happens
 * (CorpPlanner.routeToSinks gives the bank a non-deposit ROLE, so a storage
 * sink only ever draws deposit-class sources and bank -> its own store is
 * unrepresentable). Deliberately NOT encoded here: a rate pair is the wrong
 * place for a routing rule, and the role-based guard already holds for every
 * source class instead of special-casing the bank.
 *
 * THE SOURCE HALF INHERITS THE RESERVE'S INCOME BASIS. `reserveTarget` comes
 * from warchestTarget(fundedMiningIncome(...)) since 2026-08-06 - FUNDED
 * verdicts, not the graph's candidate pool. That matters to this pair: the
 * source half is (stock - reserveTarget)/1500, so an inflating reserve
 * throttles the draw directly. Measured before the fix (t72788704): scouting
 * new rooms gave five unworked sources real ids, the income read jumped
 * 110 -> 170 e/t, the reserve leapt 77k -> 119k and the surplus collapsed
 * 73k -> 46k on an unchanged 165k bank - the source half fell because the
 * colony looked at rooms it never worked. Funded basis makes the pair's
 * give-side a function of the economy rather than of vision.
 *
 * ASYMMETRY, ON PURPOSE: the source subtracts the liquidity reserve; the sink
 * has no mirror-image "fill target". Banking beyond a level is not something
 * the colony refuses - storage sits at the BOTTOM of the value ladder (value
 * 1), so it already receives only what nothing else wants, and that ladder
 * position is the reserve's true mirror. The rate-shaped alternative was
 * built and measured: spec 38 phase C claimed a refill through the storage
 * sink's RESERVE and was retired the same day (M10: unbudgeted burns ate the
 * claim before the bank saw it, 76k -> 27.5k straight through the target).
 * The bank holds its floor by being the residual claimant, not by claiming a
 * rate.
 */
export function bankPressure(stock: number, ullage: number, reserveTarget: number): BankPressure {
  return {
    source: bankSurplusRate(stock, reserveTarget),
    sink: storageAbsorbRate(ullage)
  };
}

/**
 * THE BANK IS THE INCOME MOP-UP (owner 2026-08-04: "The bank should be the
 * income mop up not the upgrade"): a storage-backed room's controller
 * allocation is this - its guaranteed floor plus the ONE drain law over the
 * standing surplus - and NOTHING else. Upgrade is proportional to surplus
 * (plus floor); the BANK is the residual claimant on income by construction,
 * because a bounded controller leaves everything above this rate to the
 * storage sink.
 *
 * One formula, no regime branch, continuous in the bank level - which is
 * what makes it honor the 2026-08-03 asymptotic ruling ("I don't think it
 * should swing hard from 85 to 15... approach the equilibrium
 * asymptotically"): the allocation follows the SLOW-MOVING bank stock, never
 * instantaneous income, so the bank is the low-pass filter for every income
 * shock and the published number cannot cliff. Equilibrium sits where the
 * draw equals the income residual (bank ~ target + residual x
 * SURPLUS_DRAIN_TICKS), and approaches from either side with tau =
 * SURPLUS_DRAIN_TICKS.
 *
 * HISTORY: phase C (2026-08-03) tried the other assignment of the same two
 * rulings - controller mops up income, bank claims deficit/1500 via a sink
 * reserve. Measured M10: every unbudgeted burn (fleet churn, raids, decay)
 * ate the claim before the bank saw it, 76k -> 27.5k through the target.
 * The owner inverted the residual claimant same-day; the claim machinery
 * (bankRefillRate / storageRefillReserve / the hub draw-out shrink) is
 * retired with it.
 */
export function bankFedControllerRate(
  banked: number,
  reserveTarget: number,
  ticksToDowngrade?: number
): number {
  return controllerFloorRate(ticksToDowngrade) + bankSurplusRate(banked, reserveTarget);
}


/**
 * The controller floor the PLAN guarantees: ZERO unless the controller is
 * actually in danger of downgrading (owner 2026-08-04: "Even the anti
 * downgrade. We don't need it UNLESS the controller is in danger of
 * downgrading, which often is not for many thousands of ticks. Not the
 * constant trickle"). The timer read arrives from the adapter's live lens;
 * below ANTI_DOWNGRADE_DANGER_TICKS the sip arms (wired as the controller
 * SINK RESERVE, won by the pre-pass, and the whole allocation in wartime),
 * restoring ~100 timer ticks per upgrade tick until the danger clears.
 * Undefined (harness, no read) means no evidence of danger - the floor
 * stays 0; an owned room always has vision live, so the lens never fogs in
 * production.
 */
export function controllerFloorRate(ticksToDowngrade?: number): number {
  return ticksToDowngrade !== undefined && ticksToDowngrade < ANTI_DOWNGRADE_DANGER_TICKS
    ? ANTI_DOWNGRADE_RESERVE
    : 0;
}

/**
 * The plan's routed controller allocation for a room (energy/tick), or
 * undefined before the first solve publishes one (spec 38 phase B). THE
 * runtime lens for "how fast does energy reach this controller": call sites
 * pass Memory.controllerAllocations (published by FlowEconomy.update) - the
 * feeder corp gets the same solve's number through its commission, and every
 * other reader (the feeder trunk's road-payback flow in ConstructionCorp)
 * resolves this instead of re-deriving a rate from the bank - the
 * feederRelayRate consumer side-channel this spec retires. Pure, persisted
 * value as argument: the exact resolveReserveTarget shape, keeping the
 * planning core Memory-free (spec 17 purity).
 */
export function plannedControllerFlow(
  published: Record<string, number> | undefined,
  roomName: string
): number | undefined {
  return published?.[roomName];
}

/**
 * Stable bank source id for a room (one storage per room): "bank-W1N1". THE
 * encoder for the bank id space - the matching lenses (economy/ids.ts
 * isBankSourceId / bankRoomFromId) decode exactly this form; change one only
 * with the other (and note the id is LEGACY-STABLE, trap list).
 */
export function bankSourceId(roomName: string): string {
  return `bank-${roomName}`;
}

/**
 * Turn a room's banked storage energy into a transient PlannerSource (no
 * miner; bounded drain), or null while the warchest is still filling. The
 * planner then routes it like any scavenge stock - value routing, not a
 * script, decides where the surplus goes.
 */
export function bankToTransientSource(
  roomName: string,
  storagePos: Position,
  banked: number,
  reserveTarget: number
): PlannerSource | null {
  const rate = bankSurplusRate(banked, reserveTarget);
  if (rate <= 0) return null;
  return {
    id: bankSourceId(roomName),
    nodeId: `${roomName}-bank`,
    pos: storagePos,
    rate,
    maxMiners: 0,
    transient: true
  };
}
