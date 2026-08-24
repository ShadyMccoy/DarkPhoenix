/**
 * sizing.ts — THE body-derivation module (REBOOT.md law 5, owner ruling
 * 2026-08-18: "that should've been a fundamentally solved issue"). Every
 * job kind calls this module and nothing else in src derives a body; a
 * second sizing site anywhere is the v1 thrash coming back. The economics
 * live here — route-based CARRY (#148's law), saturation-capped WORK, the
 * survival floor (spec-01: a colony must be able to buy SOMETHING
 * affordable right now) — and its unit suite is the exhaustive one.
 */
import {
  CARRY_CAP,
  CORE_SERVICE_CARRY_PER_SENDER,
  CREEP_LIFE,
  LINK_PAYLOAD_CARRY,
  PART_COST,
  SOURCE_SATURATION_WORK,
  WorkmanShape
} from "./primitives";

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
 * Hauler sized to A ROUTE AND ITS FLOW — #148's law actually applied at
 * the quote (a budget-sized hauler on a sliver flow is the 24-CARRY-
 * hauler class: its idle capacity inflates the edge's unit cost, and a
 * mis-priced edge invites absurd challengers). Pairs cost the same per
 * CARRY at every size, so sizing to need loses nothing; budget and the
 * 50-part body limit cap it. A ROADED route runs 2C:1M (75e per CARRY
 * against 100) — `roaded` is instance data priced by one formula whose
 * terms shift, never a subclass (REBOOT piece 2, by name). A LINK-FED
 * route (a collector leg unloading into a port) caps at the landing
 * quantum instead: one arrival is one unload intent, and CARRY beyond
 * LINK_PAYLOAD_CARRY buys standing time at the port, never throughput
 * (v1 spec 45 leg 3, the 978–1,851e-into-800 measured class).
 */
export function haulerBodyFor(
  flow: number,
  dist: number,
  budget: number,
  roaded = false,
  linkFed = false
): BodyShape | null {
  if (flow <= 0) return null;
  const need = Math.max(carryPartsFor(flow, dist), 1);
  if (roaded) {
    const roadUnitCost = 2 * PART_COST.carry + PART_COST.move;
    if (budget < roadUnitCost) return null;
    const roadUnits = Math.min(
      Math.ceil(need / 2),
      Math.floor(budget / roadUnitCost),
      linkFed ? LINK_PAYLOAD_CARRY / 2 : 16
    );
    return { work: 0, carry: 2 * roadUnits, move: roadUnits };
  }
  const unitCost = PART_COST.carry + PART_COST.move;
  if (budget < unitCost) return null;
  const units = Math.min(need, Math.floor(budget / unitCost), linkFed ? LINK_PAYLOAD_CARRY : 25);
  return { work: 0, carry: units, move: units };
}

/**
 * The port tender — the THROAT of a haul-fed wire (REBOOT Addendum 4,
 * from v1's porttender; spec 54: "the container is the mouth, the tender
 * is the throat, the link is the pipe — splitting them across owners is
 * how the drain went missing"). It PARKS between the buffer and its link
 * and never walks a route, so it is CARRY-heavy with one MOVE (the
 * commute is a one-time walk). A parked withdraw+transfer cycle is ~2
 * ticks, so CARRY covers 2·flow, floored at one part; one whole volley
 * (LINK_PAYLOAD_CARRY) is the cap — staging more than 800 per cycle
 * cannot outrun the cooldown. It is a SERVICE body: sized to top the
 * link between volleys, never to average flow (v1's named feeder bug
 * class, spec 45 — "sizing it to average relay flow is the bug class").
 */
export function portTenderBody(flowEt: number): BodyShape {
  const carry = Math.min(Math.max(Math.ceil((2 * Math.max(flowEt, 0)) / CARRY_CAP), 1), LINK_PAYLOAD_CARRY);
  return { work: 0, carry, move: 1 };
}

/**
 * The bank hub's service body, PER SENDER — v1's hardened concurrency
 * form (the constant's docblock in primitives carries the owner quote
 * and the A/B). Every wire into the bank employs one: it keeps the hub
 * link EMPTY so any volley lands (arrivals first), and loads it when the
 * plan wants an outbound send. Today its bill rides the wire's fee; the
 * Tier-2 cutover hires it for real (recorded conversion — the
 * porttender wedge, a body charged but never spawned, is the failure
 * mode that conversion must close).
 */
export function hubServiceBody(): BodyShape {
  return { work: 0, carry: CORE_SERVICE_CARRY_PER_SENDER, move: 1 };
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
 * Builder: parks at a FED site and burns BUILD_POWER (5) e/t per WORK — the
 * same W-heavy shape as the upgrader, because the site's supply line is
 * transport's job, never this body's. WORK capped at 10: one 10W body
 * absorbs 50 e/t, more than any v0 project window asks for. Floor
 * [1W,1C,1M] at 200.
 */
export function builderBody(budget: number): BodyShape | null {
  const overhead = PART_COST.carry + PART_COST.move;
  if (budget < overhead + PART_COST.work) return null;
  const work = Math.min(10, Math.floor((budget - overhead) / PART_COST.work));
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
 * The IDEAL fleet's amortized bill for a flow over a route, e/t — the
 * replacement-scale price investment evaluation compares challengers
 * against. The gait composition (1C:1M unpaved, 2C:1M roaded) lives HERE
 * and nowhere else (law 5 — the review caught it re-derived inline in
 * the broker, the second-sizing-site disease returning).
 */
export function haulFleetBillEt(flow: number, dist: number, roaded: boolean): number {
  if (flow <= 0) return 0;
  const pairs = Math.max(carryPartsFor(flow, dist), 1);
  if (roaded) return (Math.ceil(pairs / 2) * (2 * PART_COST.carry + PART_COST.move)) / CREEP_LIFE;
  return (pairs * (PART_COST.carry + PART_COST.move)) / CREEP_LIFE;
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
