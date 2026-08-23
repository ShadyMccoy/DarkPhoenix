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

/** One WORK part builds 5 progress/tick, consuming 5 energy/tick — one
 * energy per progress point (v1's BUILD_ENERGY_PER_WORK, ported). Build
 * absorbs energy five times as fast per WORK as upgrading does. */
export const BUILD_POWER = 5;

/**
 * A construction project's planned burn window, in ticks: one source-regen
 * period. A steady-state plan has no natural build RATE — completion timing
 * is invisible to a rate ledger (session finding 2026-08-23, recorded in
 * REBOOT's Tier-1 findings) — so the plan burns remaining/PROJECT_RATE_WINDOW:
 * fast enough that a project spans a few replans, slow enough not to buy a
 * burst fleet that idles the day it finishes. A tuning constant, not a law;
 * the racing harness prices completion time properly when depth arrives.
 */
export const PROJECT_RATE_WINDOW = 300;

export const CREEP_LIFE = 1500;
export const CARRY_CAP = 50;

/** A spawn builds 1 part per 3 ticks: its machine-time capacity is 1/3
 * part/tick. This is the spawnTime commodity's physical ceiling per spawn. */
export const SPAWN_TICKS_PER_PART = 3;
export const SPAWN_RATE = 1 / SPAWN_TICKS_PER_PART;

/** A dropped pile loses ceil(amount / this) energy per tick (Screeps
 * ENERGY_DECAY; v1-hardened, ported with its docblock). */
export const ENERGY_DECAY_DIVISOR = 1000;

/**
 * Energy/tick a ground pile rots at. CONVEX in the pile size because of
 * the ceiling: a pile one energy over a 1000 boundary pays a whole extra
 * energy per tick forever (ported from v1 primitives — "that convexity is
 * why 'let it pile up and haul it later' is not free"). The v2 corollary
 * (session finding 2026-08-23): a pile-banked warchest asymptotes at
 * 1000·net e/t — capex beyond that is UNREACHABLE at a pile branch.
 */
export function pileDecayRate(amount: number): number {
  return amount > 0 ? Math.ceil(amount / ENERGY_DECAY_DIVISOR) : 0;
}

/** Container: 2000e store, 5000e to build; in an owned room it decays
 * 5000 hits per 500 ticks, and repair restores 100 hits per energy —
 * 0.10 e/t to hold (v1-hardened numbers, ported). */
export const CONTAINER_CAP = 2000;
export const CONTAINER_COST = 5000;
export const CONTAINER_HOLD_ET = 5000 / 500 / 100;

/** Storage: 30000e to build, no decay, a warchest-sized store. Its value
 * in the model is CAPACITY — the holding it saves is the overflow decay
 * above the container cap, which only exists once the warchest wants
 * more than 2000e on hand. */
export const STORAGE_COST = 30000;

/** Roads: 300e per plain tile to build; decay 100 hits per 1000 ticks at
 * 100 hits repaired per energy — 0.001 e/t of upkeep per tile. On road,
 * one MOVE carries TWO other parts at full speed (fatigue halves), so a
 * roaded hauler runs 2C:1M — 75e per CARRY against 100 unpaved. Swamp
 * roading (a 5x build for a 5x speedup) is invisible to route-level
 * pricing — a recorded model gap until the traffic overlay walks real
 * tiles. */
export const ROAD_COST_PER_TILE = 300;
export const ROAD_UPKEEP_ET_PER_TILE = 100 / 1000 / 100;

export type BankBranchKind = "pile" | "container" | "storage";

/**
 * The branch's holding cost at a stock level — piece 9's "each with its
 * own HOLDING COST", one formula home. `vaultFree` is the estate's own
 * DECAY-FREE storage (spawn 300 + extensions — exactly the body budget):
 * charging rot on energy the spawn holds ate the bootstrap workman's
 * whole net and stalled the colony at one body forever (session finding
 * 2026-08-23 — the game's stores are vessels, and the estate is the
 * bank's zeroth branch). A container holds its 2000 above that for
 * upkeep; everything further piles on the ground and rots convexly.
 */
export function branchHoldingEt(branch: BankBranchKind, stock: number, vaultFree: number): number {
  if (branch === "storage") return 0;
  const ground = Math.max(0, stock - vaultFree);
  if (branch === "container") return CONTAINER_HOLD_ET + pileDecayRate(Math.max(0, ground - CONTAINER_CAP));
  return pileDecayRate(ground);
}

/**
 * The stock a branch can actually ACCUMULATE to, given a net saving
 * stream: decay grows with the pile until it eats the whole stream, so a
 * pile bank asymptotes at vault + ~1000·stream, a container 2000 above
 * that line. Capex beyond the asymptote is UNREACHABLE at this branch —
 * the warchest would pause the dividend forever and never arrive
 * (session finding 2026-08-23; the flow-funded-capex redesign this
 * demands is recorded for owner ruling).
 */
export function reachableStock(branch: BankBranchKind, streamEt: number, vaultFree: number): number {
  if (branch === "storage") return Infinity;
  const base = vaultFree + (branch === "container" ? CONTAINER_CAP : 0);
  const overhead = branch === "container" ? CONTAINER_HOLD_ET : 0;
  return base + ENERGY_DECAY_DIVISOR * Math.max(streamEt - overhead, 0);
}

/** An extension costs 3000e to build and holds 50e at RCL ≤ 6 (100 at
 * RCL7, 200 at 8 — RCL gates are a recorded model gap until the world
 * snapshot carries controller level). Each standing extension raises the
 * spawn estate's body budget by its capacity. */
export const EXTENSION_COST = 3000;
export const EXTENSION_CAPACITY = 50;

/** Link physics: 800 capacity per volley, cooldown = 1 tick per tile of
 * distance, 3% lost per send, 5000e to build. Throughput between a
 * standing pair is therefore ~800/distance e/t with the loss riding as a
 * per-flow tax (v1-hardened numbers; REBOOT piece 5). */
export const LINK_CAPACITY = 800;
export const LINK_LOSS = 0.03;
export const LINK_COST = 5000;

/**
 * The objective's horizon: H = 100,000 ticks, flat, nothing counts beyond
 * it (owner ruling 2026-08-18, piece 8: "It's just Screeps. We could pick
 * a horizon like 50,000 or 100,000 ticks"). An investment's value is the
 * stream it adds within H minus its cost; payback beyond H is "never" —
 * the archive's own idiom. ~66 capital generations. Moved only by ruling;
 * the investment fidelity line is the standing check that would motivate
 * moving it.
 */
export const HORIZON = 100000;

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
