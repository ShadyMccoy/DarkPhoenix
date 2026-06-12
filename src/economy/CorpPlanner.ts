/**
 * @fileoverview CorpPlanner - GOAP-style exploratory economy planner whose
 * operators are corps.
 *
 * This is the SINGLE economy authority the colony is being consolidated onto. It
 * replaces two overlapping solvers - FlowSolver (which sources to mine) and the
 * shadow EconomyPlanner (how to value-route energy) - with one pure function over
 * a clean world description.
 *
 * The plan is built in two phases, each a GOAP operator class:
 *
 *   1. PRODUCER SELECTION - commission HarvestCorps. Each source is assigned to
 *      its nearest spawn; unprofitable sources (netEnergy <= 0) are never mined;
 *      per spawn, sources are taken in net-energy-per-build-part order until the
 *      spawn's mining build-time budget is spent (the best source is always
 *      staffed even if it alone exceeds budget). This is the corp-atomic rule -
 *      complete the highest-value income corp before opening the next - per spawn.
 *
 *   2. VALUE ROUTING - commission CarryCorps and size the consumer sinks. The
 *      gross energy the selected sources produce is routed to sinks by value:
 *      a reserve pre-pass guarantees critical floors (anti-downgrade), then a
 *      value-descending pass fills each sink up to its capacity, pulling from the
 *      nearest sources first. Each source->sink flow becomes a hauler.
 *
 * Everything economic comes from economy/primitives. The planner is deterministic
 * (ties broken by id) and free of Screeps globals, so it is fully unit-testable
 * from first principles and generalises from 1 spawn/source to N by construction.
 *
 * @module economy/CorpPlanner
 */

import { Position } from "../types/Position";
import {
  netEnergy,
  spawnPartsFor,
  carryPartsFor,
  minerOverhead,
  haulerOverhead,
  miningBudgetPerSpawn,
  MINER_PARTS
} from "./primitives";

// =============================================================================
// INPUT - a clean description of the world the planner reasons over
// =============================================================================

export interface PlannerSpawn {
  id: string;
  pos: Position;
}

export interface PlannerSource {
  id: string;
  nodeId: string;
  pos: Position;
  /** Gross energy/tick the source yields (capacity/300, <=10 standard). */
  rate: number;
  /** Walkable mining spots adjacent to the source. */
  maxMiners: number;
  /**
   * A transient source - a ground energy stock (dropped pile / tombstone / ruin)
   * that is ALREADY harvested. It needs no miner: only a scavenger hauls it home.
   * Its `rate` is a bounded drain rate; it lasts only until the stock is gone, at
   * which point re-detection drops it from the world and scavenging demobilises.
   */
  transient?: boolean;
}

export type SinkKind = "spawn" | "controller" | "construction" | "storage";

export interface PlannerSink {
  id: string;
  kind: SinkKind;
  pos: Position;
  /** Colony value per energy/tick delivered here. Higher = filled first. */
  value: number;
  /** Max energy/tick the sink wants and can absorb. */
  capacity: number;
  /** Guaranteed floor filled before the value pass (e.g. anti-downgrade). */
  reserve?: number;
}

export interface ColonyProblem {
  spawns: PlannerSpawn[];
  sources: PlannerSource[];
  sinks: PlannerSink[];
  /** Real walking distance between two positions (e.g. cached pathDistance). */
  dist: (a: Position, b: Position) => number;
  /**
   * Income spawn-part budget multiplier in (0, 1], from the stored-energy
   * thermostat (see {@link incomeBudgetScaleForFill}). 1 = fund income fully
   * (default); < 1 = stored energy is backing up, so shrink income's share of the
   * scarce spawn-part budget and let the freed spawn ticks go to consumers.
   * Absent → 1, so every existing caller and test is unchanged.
   */
  incomeBudgetScale?: number;
}

/** Canonical single value model (replaces mintValue/net-energy/effectiveNet/sink.value). */
export const DEFAULT_SINK_VALUE: Record<SinkKind, number> = {
  spawn: 100, // keeping creeps alive - mandatory
  construction: 70, // building raises capacity - worth more than raw upgrade
  controller: 50, // upgrading - mops up the remainder
  storage: 1 // buffer - soaks excess only
};

// =============================================================================
// OUTPUT - the commissioned corps (the plan)
// =============================================================================

export interface CommissionedMiner {
  sourceId: string;
  nodeId: string;
  spawnId: string;
  distance: number;
  rate: number;
  spawnParts: number;
  netEnergy: number;
  efficiency: number;
  maxMiners: number;
}

export interface CommissionedHauler {
  sourceId: string;
  sinkId: string;
  spawnId: string;
  distance: number;
  flowRate: number;
  carryParts: number;
  spawnParts: number;
}

export interface CommissionedSink {
  sinkId: string;
  kind: SinkKind;
  value: number;
  demand: number;
  allocated: number;
  sources: { sourceId: string; amount: number; distance: number }[];
}

export interface ColonyPlan {
  miners: CommissionedMiner[];
  haulers: CommissionedHauler[];
  sinks: CommissionedSink[];
  /** Gross energy/tick produced by selected sources. */
  totalProduced: number;
  /** Energy/tick actually delivered to sinks. */
  totalDelivered: number;
  /** Miner + hauler spawn overhead (energy/tick). */
  totalOverhead: number;
  /** Build-time (parts/tick) committed per spawn. */
  spawnPartsUsed: Map<string, number>;
  /** Sum of delivered energy weighted by sink value - the objective. */
  valueDelivered: number;
  /** delivered >= overhead: the income covers the creeps that earn it. */
  sustainable: boolean;
}

// =============================================================================
// PLANNER
// =============================================================================

interface SourceCandidate {
  source: PlannerSource;
  spawn: PlannerSpawn;
  distance: number;
  rate: number;
  net: number;
  parts: number;
}

/** Nearest spawn to a position; ties broken by spawn id for determinism. */
function nearestSpawn(pos: Position, spawns: PlannerSpawn[], dist: ColonyProblem["dist"]): { spawn: PlannerSpawn; distance: number } | null {
  let best: { spawn: PlannerSpawn; distance: number } | null = null;
  for (const spawn of spawns) {
    const d = dist(pos, spawn.pos);
    if (!best || d < best.distance || (d === best.distance && spawn.id < best.spawn.id)) {
      best = { spawn, distance: d };
    }
  }
  return best;
}

/** Below this fill, fund income fully; above INCOME_THROTTLE_HIGH, hold it at the floor. */
export const INCOME_THROTTLE_LOW = 0.5;
/** At/above this fill the reservoir is full enough that income is clearly over-allocated. */
export const INCOME_THROTTLE_HIGH = 0.9;
/** Income's spawn-part budget never drops below this share - the base economy keeps mining. */
export const INCOME_BUDGET_FLOOR = 0.5;

/**
 * Income spawn-part budget multiplier from the stored-energy fill level (0..1).
 *
 * We are spawn-bound: the spawn's part-budget is the scarce resource, split
 * between income (mining/hauling) and consumption (build/upgrade). A full
 * reservoir is the signal that income is OVER-allocated that budget - the colony
 * collects faster than it consumes - so we shrink income's share, freeing spawn
 * parts (and thus spawn ticks) for the consumers that drain the surplus. This
 * sheds the MARGINAL sources first (selectProducers fills the budget
 * highest-net-per-part first and always keeps a spawn's best source), so the base
 * economy is never starved - only far/remote expansion stands down.
 *
 * A smooth ramp on the (already smooth) level signal, so no hysteresis is needed:
 *   fill <= LOW  -> 1.0    (climbing / draining: fund income fully)
 *   fill >= HIGH -> FLOOR  (full: income at its floor, spawn parts to consumers)
 * linear between. FLOOR > 0, so income is throttled, never cut off. fill = 0 (a
 * bare room with no reservoir) returns 1, so cold start is unaffected.
 */
export function incomeBudgetScaleForFill(fill: number): number {
  if (fill <= INCOME_THROTTLE_LOW) return 1;
  if (fill >= INCOME_THROTTLE_HIGH) return INCOME_BUDGET_FLOOR;
  const t = (fill - INCOME_THROTTLE_LOW) / (INCOME_THROTTLE_HIGH - INCOME_THROTTLE_LOW);
  return 1 - t * (1 - INCOME_BUDGET_FLOOR);
}

/**
 * Phase 1 - PRODUCER SELECTION. Assign each source to its nearest spawn, drop the
 * unprofitable ones, and per spawn keep sources by net-energy-per-build-part until
 * the spawn's mining budget is spent.
 */
function selectProducers(problem: ColonyProblem): CommissionedMiner[] {
  const { sources, spawns, dist } = problem;
  if (spawns.length === 0) return [];

  const candidates: SourceCandidate[] = [];
  for (const source of sources) {
    if (source.transient) continue; // transient stocks need no miner (already harvested)
    const near = nearestSpawn(source.pos, spawns, dist);
    if (!near) continue;
    const net = netEnergy(source.rate, near.distance);
    if (net <= 0) continue; // never mine a source that costs more than it yields
    candidates.push({
      source,
      spawn: near.spawn,
      distance: near.distance,
      rate: source.rate,
      net,
      parts: spawnPartsFor(source.rate, near.distance)
    });
  }

  // Per spawn, fill the mining build-time budget highest-value-first. The budget
  // shrinks when stored energy is backing up (incomeBudgetScale < 1): income is
  // over-allocated the scarce spawn parts, so the marginal sources fall out of
  // contention (the sort keeps the best ones, and the first source is always
  // staffed below) and those parts free up for consumers.
  const budget = miningBudgetPerSpawn() * (problem.incomeBudgetScale ?? 1);
  const bySpawn = new Map<string, SourceCandidate[]>();
  for (const c of candidates) {
    const list = bySpawn.get(c.spawn.id) ?? [];
    list.push(c);
    bySpawn.set(c.spawn.id, list);
  }

  const miners: CommissionedMiner[] = [];
  for (const [, list] of bySpawn) {
    // value per build-part, then by source id for stable ties
    list.sort((a, b) => b.net / b.parts - a.net / a.parts || (a.source.id < b.source.id ? -1 : 1));
    let spent = 0;
    for (const c of list) {
      // Always staff a spawn's best source even if it alone exceeds budget; after
      // that, only take a source if its build-time fits the remaining budget.
      if (spent > 0 && spent + c.parts > budget) continue;
      spent += c.parts;
      miners.push({
        sourceId: c.source.id,
        nodeId: c.source.nodeId,
        spawnId: c.spawn.id,
        distance: c.distance,
        rate: c.rate,
        spawnParts: c.parts,
        netEnergy: c.net,
        efficiency: (c.net / c.rate) * 100,
        maxMiners: c.source.maxMiners
      });
    }
  }
  return miners;
}

/** A unit of energy available to route: a staffed source or a scavengeable stock. */
interface SupplyPoint {
  sourceId: string;
  rate: number;
  spawnId: string;
}

/**
 * Transient supply - SCAVENGING. Each transient source (a ground stock) is free
 * energy needing no miner, so it joins the routing pool directly. It is worth
 * scavenging whenever hauling it home nets positive (no miner cost to offset), so
 * a reachable stock essentially always qualifies. The scavenger's home spawn is
 * the nearest one.
 */
function selectTransientSupply(problem: ColonyProblem): SupplyPoint[] {
  const { sources, spawns, dist } = problem;
  if (spawns.length === 0) return [];
  const supply: SupplyPoint[] = [];
  for (const source of sources) {
    if (!source.transient) continue;
    const near = nearestSpawn(source.pos, spawns, dist);
    if (!near) continue;
    const net = source.rate - haulerOverhead(carryPartsFor(source.rate, near.distance), near.distance);
    if (net <= 0) continue; // even free energy isn't worth a scavenger that costs more to run
    supply.push({ sourceId: source.id, rate: source.rate, spawnId: near.spawn.id });
  }
  return supply;
}

/**
 * Phase 2 - VALUE ROUTING. Route the gross output of all supply (staffed sources
 * plus scavengeable stocks) to sinks: a reserve pre-pass for critical floors, then
 * a value-descending pass filling each sink to capacity from the nearest sources
 * first. Each source->sink flow becomes a hauler.
 */
function routeToSinks(
  problem: ColonyProblem,
  supply: SupplyPoint[]
): { haulers: CommissionedHauler[]; sinks: CommissionedSink[] } {
  const { sinks, dist } = problem;
  const sourceById = new Map(problem.sources.map(s => [s.id, s]));
  const spawnBySource = new Map(supply.map(s => [s.sourceId, s.spawnId]));

  // Remaining gross energy each supply point can still ship.
  const pool = new Map<string, number>(supply.map(s => [s.sourceId, s.rate]));

  const out = new Map<string, CommissionedSink>();
  const haulers: CommissionedHauler[] = [];

  const fill = (sink: PlannerSink, target: number): void => {
    const acc = out.get(sink.id) ?? {
      sinkId: sink.id,
      kind: sink.kind,
      value: sink.value,
      demand: sink.capacity,
      allocated: 0,
      sources: [] as { sourceId: string; amount: number; distance: number }[]
    };
    out.set(sink.id, acc);

    // Sources with energy left, nearest to this sink first (ties by id).
    const order = [...pool.keys()]
      .filter(id => (pool.get(id) ?? 0) > 1e-9)
      .map(id => ({ id, d: dist(sourceById.get(id)!.pos, sink.pos) }))
      .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));

    for (const { id, d } of order) {
      if (acc.allocated >= target - 1e-9) break;
      const avail = pool.get(id) ?? 0;
      const take = Math.min(avail, target - acc.allocated);
      if (take <= 1e-9) continue;
      pool.set(id, avail - take);
      acc.allocated += take;
      acc.sources.push({ sourceId: id, amount: take, distance: d });
      haulers.push({
        sourceId: id,
        sinkId: sink.id,
        spawnId: spawnBySource.get(id) ?? "",
        distance: d,
        flowRate: take,
        carryParts: carryPartsFor(take, d),
        spawnParts: (2 * carryPartsFor(take, d)) / Math.max(1, 1500 - d)
      });
    }
  };

  // Reserve pre-pass: guarantee critical floors before value greed drains the pool.
  for (const sink of [...sinks].filter(s => (s.reserve ?? 0) > 0).sort((a, b) => b.value - a.value)) {
    fill(sink, Math.min(sink.reserve!, sink.capacity));
  }
  // Value pass: highest value first, up to capacity.
  for (const sink of [...sinks].sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1))) {
    fill(sink, sink.capacity);
  }

  return { haulers, sinks: [...out.values()] };
}

/**
 * Plan the whole colony economy: which corps to commission and at what size.
 * Pure and deterministic; see the module doc for the GOAP framing.
 */
export function planColony(problem: ColonyProblem): ColonyPlan {
  const miners = selectProducers(problem);
  // Supply = staffed sources + scavengeable transient stocks (no miner needed).
  const supply: SupplyPoint[] = [
    ...miners.map(m => ({ sourceId: m.sourceId, rate: m.rate, spawnId: m.spawnId })),
    ...selectTransientSupply(problem)
  ];
  const { haulers, sinks } = routeToSinks(problem, supply);

  const totalProduced = supply.reduce((s, p) => s + p.rate, 0);
  const totalDelivered = sinks.reduce((s, k) => s + k.allocated, 0);
  const miningOverhead = miners.reduce((s, m) => s + minerOverhead(m.distance), 0);
  const haulOverhead = haulers.reduce((s, h) => s + haulerOverhead(h.carryParts, h.distance), 0);
  const totalOverhead = miningOverhead + haulOverhead;
  const valueDelivered = sinks.reduce((s, k) => s + k.allocated * k.value, 0);

  const spawnPartsUsed = new Map<string, number>();
  for (const m of miners) {
    spawnPartsUsed.set(m.spawnId, (spawnPartsUsed.get(m.spawnId) ?? 0) + MINER_PARTS / Math.max(1, 1500 - m.distance));
  }
  for (const h of haulers) {
    spawnPartsUsed.set(h.spawnId, (spawnPartsUsed.get(h.spawnId) ?? 0) + h.spawnParts);
  }

  return {
    miners,
    haulers,
    sinks,
    totalProduced,
    totalDelivered,
    totalOverhead,
    spawnPartsUsed,
    valueDelivered,
    sustainable: totalDelivered >= totalOverhead
  };
}
