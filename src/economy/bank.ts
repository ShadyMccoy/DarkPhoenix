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

/** Target ticks to drain the spendable surplus (the bank does not decay, so it keeps its own burst pace - unlike scavengeRate's effective-ttl sizing). */
export const SURPLUS_DRAIN_TICKS = 150;

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
 * Energy/tick the planner keeps routing to the controller ONCE THE ROOM HAS A
 * STORAGE bank that is still FILLING; everything above this banks in the
 * storage instead of piling at the controller drop-off (owner 2026-07-11:
 * "once we have a storage, that should be a good destination for a lot of
 * drop-offs, and we deliver it locally from there"). This is the deposit half
 * of the storage bank: the durable storage - not the controller - soaks the
 * surplus, so it can accumulate the expansion CAPEX the capital trigger saves
 * toward. Once the bank passes the reserve target the cap lifts entirely (the
 * controller reverts to mopping up) and the surplus draws back out - see
 * bankSurplusRate.
 *
 * It is the tuning knob for the upgrade-vs-bank balance: raise it to favour
 * faster RCL, lower it to save harder. Below this rate the controller still
 * mops up ALL income (its capacity exceeds the supply, so nothing is left to
 * bank), so a lean single/2-source room upgrades exactly as before and only
 * genuine surplus banks. Comfortably above the anti-downgrade reserve so
 * upgrading always makes progress. Without a storage there is nowhere durable
 * to bank surplus, so the controller keeps absorbing the whole remainder
 * (pre-storage behaviour is unchanged). Lives here (not flowAdapter) so the
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

/** Stable bank source id for a room (one storage per room): "bank-W1N1". */
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
