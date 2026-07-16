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
 * Banked energy the colony KEEPS: the expansion campaign's full cost plus a
 * doubled safety reserve. Derived - never a second hardcoded number - because
 * a drain floor below EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE would pin the
 * bank under the capital trigger and permanently disable expansion (the exact
 * failure mode the pre-#98 STORAGE_BANK=10k spill caused). The extra reserve
 * is headroom so consumer-fleet attrition lag (upgraders sized at the peak
 * draw outliving the taper) can overshoot the target without dipping the bank
 * below the trigger.
 */
export const WARCHEST_TARGET = EXPANSION_CAPEX + 2 * EXPANSION_SAFETY_RESERVE;

/** Target ticks to drain the spendable surplus - mirrors SCAVENGE_DRAIN_TICKS. */
export const SURPLUS_DRAIN_TICKS = 150;

/**
 * Cap on the surplus draw (energy/tick) so a 100k bank doesn't commission an
 * absurd consumer fleet - mirrors MAX_SCAVENGE_RATE. A capped draw just takes
 * more solves to drain; the bank persists and is re-detected each cycle.
 */
export const MAX_SURPLUS_DRAW = 20;

/**
 * Energy/tick the planner keeps routing to the controller ONCE THE ROOM HAS A
 * STORAGE bank that is still FILLING; everything above this banks in the
 * storage instead of piling at the controller drop-off (owner 2026-07-11:
 * "once we have a storage, that should be a good destination for a lot of
 * drop-offs, and we deliver it locally from there"). This is the deposit half
 * of the storage bank: the durable storage - not the controller - soaks the
 * surplus, so it can accumulate the expansion CAPEX the capital trigger saves
 * toward. Once the bank passes WARCHEST_TARGET the cap lifts entirely (the
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

/** Banked energy above the warchest target - what the colony may spend. */
export function spendableBankSurplus(banked: number): number {
  return Math.max(0, banked - WARCHEST_TARGET);
}

/**
 * Energy/tick of bank surplus the colony spends this plan cycle: drain the
 * spendable surplus over SURPLUS_DRAIN_TICKS, capped at MAX_SURPLUS_DRAW.
 * Zero while the warchest is still filling. Linear in the surplus, so the
 * draw tapers smoothly to zero at the target instead of flapping a regime
 * switch around it.
 */
export function bankSurplusRate(banked: number): number {
  return Math.min(MAX_SURPLUS_DRAW, spendableBankSurplus(banked) / SURPLUS_DRAIN_TICKS);
}

/**
 * Energy/tick the ControllerFeederCorp must relay storage -> controller input:
 * the save-regime upgrade target plus whatever surplus the plan is drawing.
 * The feeder sizes its shuttle fleet to this, and upgrader sizing uses it as
 * the inflow term while a feeder actively relays a surplus - all three
 * consumers of "how fast does bank energy reach the controller" read this one
 * function, so they cannot disagree.
 */
export function feederRelayRate(banked: number): number {
  return STORAGE_UPGRADE_TARGET + bankSurplusRate(banked);
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
export function bankToTransientSource(roomName: string, storagePos: Position, banked: number): PlannerSource | null {
  const rate = bankSurplusRate(banked);
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
