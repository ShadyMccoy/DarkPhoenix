/**
 * primitives.ts — the economic constants and pure formulas. v2 law: every
 * economic number lives here, screeps-type-free so the math is testable
 * without game globals. Facts v1 hardened are PORTED (with their reasoning),
 * never re-derived from memory; each is pinned in test/unit/primitives.test.ts.
 */

/** A source holds 3000 energy and refills every 300 ticks: 10 e/t ceiling. */
export const SOURCE_CAPACITY = 3000;
export const SOURCE_REGEN_TICKS = 300;
export const SOURCE_RATE = SOURCE_CAPACITY / SOURCE_REGEN_TICKS;

/** One WORK part harvests 2 e/t; saturating a source takes 5 WORK on-site. */
export const HARVEST_POWER = 2;
export const SOURCE_SATURATION_WORK = SOURCE_RATE / HARVEST_POWER;

/** One WORK part upgrades 1 e/t (progress == energy below RCL8). */
export const UPGRADE_POWER = 1;

export const CREEP_LIFE = 1500;
export const CARRY_CAP = 50;

export const PART_COST: Record<"work" | "carry" | "move", number> = {
  work: 100,
  carry: 50,
  move: 50
};

/** A workman body as counts. The only body shape v2 knows until M2. */
export interface WorkmanShape {
  work: number;
  carry: number;
  move: number;
}

export function bodyCost(s: WorkmanShape): number {
  return s.work * PART_COST.work + s.carry * PART_COST.carry + s.move * PART_COST.move;
}

/**
 * Size a workman to a budget. The unit is [WORK, CARRY, MOVE, MOVE] (250e):
 * one move per other part keeps full speed off-road, loaded. Floor body is
 * [WORK, CARRY, MOVE] (200e) — half speed loaded, but alive; v1's spec-01
 * lesson is that a colony must be able to buy SOMETHING at the survival
 * floor rather than queue an unaffordable ideal. Returns null below 200.
 */
export function workmanBody(budget: number): WorkmanShape | null {
  if (budget < 200) return null;
  if (budget < 250) return { work: 1, carry: 1, move: 1 };
  const units = Math.min(5, Math.floor(budget / 250));
  return { work: units, carry: units, move: 2 * units };
}

/** Body counts as the part-name list spawnCreep wants (WORK first so the
 * body degrades carry-first under damage — conventional, not load-bearing). */
export function bodyList(s: WorkmanShape): ("work" | "carry" | "move")[] {
  const out: ("work" | "carry" | "move")[] = [];
  for (let i = 0; i < s.work; i++) out.push("work");
  for (let i = 0; i < s.carry; i++) out.push("carry");
  for (let i = 0; i < s.move; i++) out.push("move");
  return out;
}

/**
 * The workman cycle model — the planner's expected-rate primitive and the
 * fidelity line's denominator. A workman fills its carry at the source
 * (carry·50 energy at 2·work e/t), walks `distance` to the sink, unloads
 * (1 tick), walks back. Delivered per cycle = carry·50.
 *
 * `distance` is the snapshot's range estimate, not a path — the F1 line
 * exists precisely to measure how wrong this model is before M3 refines it.
 */
export function workmanCycleRate(s: WorkmanShape, distance: number): number {
  const fill = (s.carry * CARRY_CAP) / (HARVEST_POWER * s.work);
  const cycle = fill + 2 * distance + 1;
  return (s.carry * CARRY_CAP) / cycle;
}

/**
 * Workmen needed to saturate one source through the cycle model: only the
 * fill fraction of a cycle is spent harvesting, so effective on-site WORK
 * per body = work · fill/cycle. Clamped to the source's standing room.
 */
export function workmenPerSource(s: WorkmanShape, distance: number, spots: number): number {
  const fill = (s.carry * CARRY_CAP) / (HARVEST_POWER * s.work);
  const cycle = fill + 2 * distance + 1;
  const effectiveWork = s.work * (fill / cycle);
  const wanted = Math.ceil(SOURCE_SATURATION_WORK / Math.max(effectiveWork, 0.01));
  return Math.max(1, Math.min(spots, wanted));
}
