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

/** The game's room edge length: rooms are 50×50 cells, and they enter
 * the model as LINK-LEGALITY cells (owner 2026-08-24, amending the
 * room-agnostic ruling): a link pair may only stand within one room. */
export const ROOM_SIZE = 50;

/** Chebyshev range between tiles — link cooldown's own metric. The wire
 * fires THROUGH walls: its ration is range, never path, which is why a
 * canyon that triples the haul path never slows the wire. */
export function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Link physics: 800 capacity per volley, cooldown = 1 tick per tile of
 * RANGE (Chebyshev, terrain-immune), 3% lost per send, 5000e to build.
 * Throughput between a standing pair is therefore ~800/range e/t with
 * the loss riding as a per-flow tax (v1-hardened numbers; piece 5). */
export const LINK_CAPACITY = 800;
export const LINK_LOSS = 0.03;
export const LINK_COST = 5000;

/**
 * ONE volley expressed in CARRY parts (800/50 = 16) — the LANDING QUANTUM
 * (ported: v1 `LINK_PAYLOAD_CARRY`, spec 45 leg 3). A creep unloading
 * into a link port places at most this much per arrival, so link-fed
 * hauler bodies cap here — v1 measured 978–1,851e bodies into an 800-cap
 * port standing 2–3 volley cycles per trip: surplus CARRY converts to
 * standing time at the port, never throughput. Deliberately separate
 * from the hub's service body below: the landing quantum and the shuttle
 * are not the same quantity and must not scale together (v1's own
 * correction, after one constant served both).
 */
export const LINK_PAYLOAD_CARRY = LINK_CAPACITY / CARRY_CAP;

/**
 * CARRY per inbound sender for the bank hub's service shuttle (ported:
 * v1 `CORE_SERVICE_CARRY_PER_SENDER`; owner 2026-08-07: "the core link
 * has a feeder tender creep slave. It empties it to ensure incoming
 * links can transfer (links coming off cooldown) and fills it when if
 * necessary when it needs to send energy to the upgraders. I recon it
 * needs 8 carry to do its job well in our room. At lower RCL maybe 4 is
 * good" — that room ran two inbound senders, so 4/sender IS the owner's
 * 8). The t72819265 A/B pinned the mechanism as CONCURRENCY, not
 * capacity — "one creep working harder cannot cover two senders
 * arriving at once" — one small creep PER SENDER, parked a tile from
 * hub and vault (a ~2-tick cycle clears 800 in ~8t, inside any sender's
 * cooldown); the 16C swallow-a-volley floor measured as over-insurance
 * (clamp 0.000, at 100 spawn parts ≈ 15% of the whole fleet).
 */
export const CORE_SERVICE_CARRY_PER_SENDER = 4;

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

/**
 * Effective working life (ticks) of a creep posted `commute` tiles from
 * its spawn (ported: v1 `effectiveLife`, docblock near-verbatim): it
 * spends ~`commute` ticks walking to its post before it can work or be
 * replaced, so its build cost is amortised over the remainder. Floored
 * at 1 so overhead stays finite for absurd distances. This lands the
 * Tier-1 ledger's "commute is still priced at zero" finding — a
 * 150-tile remote chain quoting ~+4.6 e/t and netting ~0 (Addendum 6,
 * owner 2026-08-24: "shouldn't the body be prorated for travel time").
 * A cycling body whose route touches the spawn's own bank commutes ~0:
 * its first empty leg is a cycle, not a posting walk.
 */
export function effectiveLife(commute = 0): number {
  return Math.max(1, CREEP_LIFE - commute);
}

/** Per-tick cost of OWNING a body: its price amortized over its
 * EFFECTIVE life — 1500 ticks less the posting walk. The parts bill
 * every funded step owes at the spawn's bank branch — the tender
 * heartbeat's obligation is the sum of these. */
export function upkeepEt(s: WorkmanShape, commute = 0): number {
  return bodyCost(s) / effectiveLife(commute);
}

/** Spawn machine time to KEEP a body alive: its parts re-bought once per
 * EFFECTIVE life (a commuting body re-spawns more often), in parts/tick
 * against SPAWN_RATE capacity. */
export function spawnTimeEt(s: WorkmanShape, commute = 0): number {
  return partCount(s) / effectiveLife(commute);
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
