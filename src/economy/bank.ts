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
 * Anti-pump is STRUCTURAL (spec 03): whenever a room emits a bank source, that
 * room's storage sink is dropped from the problem for that solve
 * (flowAdapter.buildColonyProblem), so bank->storage circulation is impossible
 * by construction, not by tuning. Bank flows also never materialize as
 * CarryCorp haulers (commissionPlan skips them): the depot movers already run
 * the last legs - the extension tender (bank -> spawn/extensions) and the
 * ControllerFeederCorp (bank -> controller input) - and both size themselves
 * from these same primitives, so plan and runtime cannot drift apart.
 *
 * @module economy/bank
 */

import "../types/Memory"; // Memory augmentation for the expansion import below
import { Position } from "../types/Position";
import { PlannerSource } from "./CorpPlanner";
import { EXPANSION_CAPEX, EXPANSION_SAFETY_RESERVE } from "./expansion";
import { ANTI_DOWNGRADE_RESERVE, CREEP_LIFETIME, sustainableConsumptionRate } from "./primitives";

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
 * draw (bankSurplusRate -> feederRelayRate -> upgrader inflow), so the
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

/**
 * The save-regime controller FLOOR (energy/tick): the upgrade rate the plan
 * keeps guaranteed to a storage room's controller (controllerFloorRate wires
 * it as the controller sink's reserve, bounded by what the bank can sustain),
 * and the level upgrading RELEGATES to under spec 33 wartime (a standing
 * construction backlog). Comfortably above the anti-downgrade reserve so
 * upgrading always makes progress.
 *
 * HISTORY (owner 2026-08-03, "approach the equilibrium asymptotically"): this
 * was also the save-regime controller CAP - a filling warchest hard-limited
 * the controller here and the storage soaked everything else, which swung the
 * published allocation 85 -> 15 in one solve at the target crossing. That cap
 * is retired: saving is now the storage sink's refill RESERVE
 * (bankRefillRate, the surplus drain's mirror), so the bank approaches its
 * target asymptotically and this constant survives only as the floor/wartime
 * level and the feeder's price floor. Lives here (not flowAdapter) so the
 * feeder and upgrader sizing derive from the same module without cycles.
 */
export const STORAGE_UPGRADE_TARGET = 15;

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
export function bankFedControllerRate(banked: number, reserveTarget: number): number {
  return controllerFloorRate(banked) + bankSurplusRate(banked, reserveTarget);
}

/**
 * Energy/tick the ControllerFeederCorp must relay storage -> controller input:
 * the save-regime upgrade target plus whatever surplus the plan is drawing.
 * The feeder sizes its shuttle fleet to this, and upgrader sizing uses it as
 * the inflow term while a feeder actively relays a surplus - all three
 * consumers of "how fast does bank energy reach the controller" read this one
 * function, so they cannot disagree.
 */
export function feederRelayRate(banked: number, reserveTarget: number): number {
  return STORAGE_UPGRADE_TARGET + bankSurplusRate(banked, reserveTarget);
}

/**
 * The controller floor the PLAN itself guarantees (spec 38 phase A): the
 * save-regime upgrade target, but only as fast as the standing bank can
 * sustain for one creep generation (the ONE drain law - the same
 * stock/CREEP_LIFETIME behind bankSurplusRate and consumer sizing), floored
 * at the anti-downgrade trickle. Wired as the controller SINK RESERVE in the
 * adapter, so the reserve pre-pass wins the floor's parts before value greed
 * - the planner-side half of retiring feederRelayRate's
 * +STORAGE_UPGRADE_TARGET side-channel (P12's measured 3.30x non-bank
 * divergence). A cold storage room floors at the trickle: its spawn is never
 * out-reserved by its own controller.
 */
export function controllerFloorRate(banked: number): number {
  return Math.max(ANTI_DOWNGRADE_RESERVE, Math.min(STORAGE_UPGRADE_TARGET, sustainableConsumptionRate(banked)));
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
