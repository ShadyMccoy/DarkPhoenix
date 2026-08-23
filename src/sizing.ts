/**
 * sizing.ts — THE body-derivation module (REBOOT.md law 5, owner ruling
 * 2026-08-18: "that should've been a fundamentally solved issue"). Every
 * job kind calls this module and nothing else in src derives a body; a
 * second sizing site anywhere is the v1 thrash coming back. The economics
 * live here — route-based CARRY (#148's law), saturation-capped WORK, the
 * survival floor (spec-01: a colony must be able to buy SOMETHING
 * affordable right now) — and its unit suite is the exhaustive one.
 */
import { CARRY_CAP, PART_COST, SOURCE_SATURATION_WORK, WorkmanShape } from "./primitives";

/** One structural body type for every job; the counts differ, the shape
 * doesn't. Alias kept so sizing reads as the general module it is. */
export type BodyShape = WorkmanShape;

/**
 * Size a workman to a budget. The unit is [WORK, CARRY, MOVE, MOVE] (250e):
 * one move per other part keeps full speed off-road, loaded. Floor body is
 * [WORK, CARRY, MOVE] (200e) — half speed loaded, but alive; v1's spec-01
 * lesson is that a colony must be able to buy SOMETHING at the survival
 * floor rather than queue an unaffordable ideal. Returns null below 200.
 */
export function workmanBody(budget: number): BodyShape | null {
  if (budget < 200) return null;
  if (budget < 250) return { work: 1, carry: 1, move: 1 };
  const units = Math.min(5, Math.floor(budget / 250));
  return { work: units, carry: units, move: 2 * units };
}

/**
 * Static miner: WORK plus one MOVE — it walks to the mouth once and sits.
 * Floor [1W,1M] at 150; WORK capped at saturation (5) because a sixth WORK
 * on a source mines nothing. Returns null below the floor.
 */
export function minerBody(budget: number): BodyShape | null {
  if (budget < PART_COST.work + PART_COST.move) return null;
  const work = Math.min(SOURCE_SATURATION_WORK, Math.floor((budget - PART_COST.move) / PART_COST.work));
  return { work, carry: 0, move: 1 };
}

/**
 * Hauler: paired CARRY+MOVE keeps full speed loaded off-road. Floor [1C,1M]
 * at 100; capped at 25 pairs, the 50-part body limit.
 */
export function haulerBody(budget: number): BodyShape | null {
  const unitCost = PART_COST.carry + PART_COST.move;
  if (budget < unitCost) return null;
  const units = Math.min(25, Math.floor(budget / unitCost));
  return { work: 0, carry: units, move: units };
}

/**
 * Upgrader: parks at the bank branch and self-feeds — WORK-heavy, one
 * CARRY buffer, one MOVE (the founding kernel co-locates bank and
 * controller draw, so the last leg is its own body). Floor [1W,1C,1M] at
 * 200; WORK capped at 15, the RCL8 throttle, so no body ever exceeds what
 * any controller can drink.
 */
export function upgraderBody(budget: number): BodyShape | null {
  const overhead = PART_COST.carry + PART_COST.move;
  if (budget < overhead + PART_COST.work) return null;
  const work = Math.min(15, Math.floor((budget - overhead) / PART_COST.work));
  return { work, carry: 1, move: 1 };
}

/**
 * Tender: the spawning corp's own refill body (owner 2026-08-23 — the
 * tender is the spawn corp's, never a haul job). The estate is compact by
 * the founding kernel, so the body stays small: paired C+M, at most two
 * pairs; floor [1C,1M] at 100.
 */
export function tenderBody(budget: number): BodyShape | null {
  const unitCost = PART_COST.carry + PART_COST.move;
  if (budget < unitCost) return null;
  const units = Math.min(2, Math.floor(budget / unitCost));
  return { work: 0, carry: units, move: units };
}

/**
 * #148's route law, generalized — THE logistics formula: CARRY parts to
 * move `flow` e/t over a one-way distance of `dist` tiles (round trip
 * 2·dist, CARRY_CAP per part). Transport pricing quotes through here; the
 * 24-CARRY hauler on a 1.7-CARRY route dies at this line.
 */
export function carryPartsFor(flow: number, dist: number): number {
  return Math.ceil((flow * 2 * dist) / CARRY_CAP);
}
