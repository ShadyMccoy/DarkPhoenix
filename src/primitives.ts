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

/** A spawn builds 1 part per 3 ticks: its machine-time capacity is 1/3
 * part/tick. This is the spawnTime commodity's physical ceiling per spawn. */
export const SPAWN_TICKS_PER_PART = 3;
export const SPAWN_RATE = 1 / SPAWN_TICKS_PER_PART;

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

export function partCount(s: WorkmanShape): number {
  return s.work + s.carry + s.move;
}

/** Per-tick cost of OWNING a body: its price amortized over a 1500-tick
 * life. The parts bill every funded step owes at the spawn's bank branch —
 * the tender heartbeat's obligation is the sum of these. */
export function upkeepEt(s: WorkmanShape): number {
  return bodyCost(s) / CREEP_LIFE;
}

/** Spawn machine time to KEEP a body alive: its parts re-bought once per
 * life, in parts/tick against SPAWN_RATE capacity. */
export function spawnTimeEt(s: WorkmanShape): number {
  return partCount(s) / CREEP_LIFE;
}

/** Delivered e/t of CARRY parts shuttling one-way `distance`: capacity over
 * the round trip. Load/unload ticks are the fidelity line's business until
 * M3 refines the model (same stance as workmanCycleRate below). */
export function haulRate(carry: number, distance: number): number {
  return (carry * CARRY_CAP) / (2 * distance);
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
