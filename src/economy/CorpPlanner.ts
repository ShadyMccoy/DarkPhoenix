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
  constructionWorkSpawnLoad,
  controllerWorkSpawnLoad,
  effectiveLife,
  minerOverhead,
  haulerOverhead,
  miningBudgetPerSpawn,
  MINER_PARTS,
  SPAWN_PARTS_PER_TICK
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
   * Where the source's OUTPUT is picked up, when not at the source itself: a
   * link-served source's energy emerges at the core link beside the storage, so
   * its hauling is priced (and routed) from there while the miner's own distance
   * stays the real walk to the source. Defaults to `pos`.
   */
  haulPos?: Position;
  /**
   * A transient source - a ground energy stock (dropped pile / tombstone / ruin)
   * that is ALREADY harvested. It needs no miner: only a scavenger hauls it home.
   * Its `rate` is a bounded drain rate; it lasts only until the stock is gone, at
   * which point re-detection drops it from the world and scavenging demobilises.
   */
  transient?: boolean;
  /**
   * The source's haul route is fully paved (ConstructionCorp's receipt in room
   * memory). Its haulers run the 2:1 road body - 1.5 spawn parts per CARRY
   * instead of 2 - which the routing pass prices in.
   */
  paved?: boolean;
  /**
   * Expected NPC-invader cost per unit harvested (spec 13 phase 5): raids
   * fire as a function of energy harvested, so their defense cost is a
   * per-energy tax. Set by the adapter for sources outside spawn rooms
   * (towers make the home tax ~0); subtracted from the source's net in
   * producer selection so both the profitability gate and the
   * net-per-build-part ranking price the raid reality.
   */
  invaderTax?: number;
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
   * Spawn build-time (parts/tick) of standing infrastructure the plan implies
   * but does not commission here (feeder shuttle, tender detail, reservers) -
   * primitives.infraSpawnLoad, computed by the flow adapter. Deducted from
   * the spawn-parts ledger before the sink fill spends the rest (spec 15 P4).
   */
  infraPartsPerTick?: number;
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
  /** Route is paved: spawn the haulers at the 2:1 road CARRY:MOVE ratio. */
  paved?: boolean;
}

export interface CommissionedSink {
  sinkId: string;
  kind: SinkKind;
  value: number;
  demand: number;
  allocated: number;
  sources: { sourceId: string; amount: number; distance: number }[];
}

/**
 * The pricing verdict for one non-transient mining candidate (spec 14 phase 5
 * - decision symmetry for the planner). selectProducers was the last silent
 * decision in the economy: a source absent from the plan was indistinguishable
 * from one priced out by the invader tax or dropped for build-time budget.
 * `net` and `tax` are the exact terms the funding decision compared;
 * `tax` is the invader-tax TERM in energy/tick (invaderTax * rate).
 */
export interface SourceVerdict {
  sourceId: string;
  rate: number;
  distance: number;
  net: number;
  tax: number;
  parts: number;
  verdict: "funded" | "unprofitable" | "over-budget" | "no-spawn" | "unreachable";
}

export interface ColonyPlan {
  miners: CommissionedMiner[];
  haulers: CommissionedHauler[];
  sinks: CommissionedSink[];
  /** Per-candidate funding verdicts for every non-transient source. */
  sourceVerdicts: SourceVerdict[];
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
    // A non-finite distance is a failed path lens, not a far spawn: letting
    // it through produced an "unprofitable at distance Infinity" verdict with
    // garbage per-part math. Unreachable spawns simply don't compete.
    if (!Number.isFinite(d)) continue;
    if (!best || d < best.distance || (d === best.distance && spawn.id < best.spawn.id)) {
      best = { spawn, distance: d };
    }
  }
  return best;
}

/**
 * Phase 1 - PRODUCER SELECTION. Assign each source to its nearest spawn, drop the
 * unprofitable ones, and per spawn keep sources by net-energy-per-build-part until
 * the spawn's mining budget is spent.
 */
function selectProducers(problem: ColonyProblem): { miners: CommissionedMiner[]; verdicts: SourceVerdict[] } {
  const { sources, spawns, dist } = problem;
  const verdicts: SourceVerdict[] = [];
  if (spawns.length === 0) {
    for (const source of sources) {
      if (source.transient) continue;
      verdicts.push({ sourceId: source.id, rate: source.rate, distance: 0, net: 0, tax: 0, verdict: "no-spawn", parts: 0 });
    }
    return { miners: [], verdicts };
  }

  const candidates: SourceCandidate[] = [];
  for (const source of sources) {
    if (source.transient) continue; // transient stocks need no miner (already harvested)
    const near = nearestSpawn(source.pos, spawns, dist);
    if (!near) {
      // The formerly verdict-LESS skip (spec 14: no invisible decisions).
      // Spawns exist but none is reachable: the path lens failed for this
      // source. Measured live t72416041+: five worked, reserved, mark-free
      // remotes silently absent from candidates for 1000+ ticks while their
      // miners kept mining - without this row the drop cause was guesswork
      // between graph exclusion and path failure.
      verdicts.push({ sourceId: source.id, rate: source.rate, distance: 0, net: 0, tax: 0, verdict: "unreachable", parts: 0 });
      continue;
    }
    // Net of the invader tax (spec 13): a remote's expected raid-defense
    // cost scales with what we harvest there, so it lands here - where both
    // the mine/don't-mine gate and the ranking read it.
    const tax = (source.invaderTax ?? 0) * source.rate;
    const net = netEnergy(source.rate, near.distance) - tax;
    const parts = spawnPartsFor(source.rate, near.distance);
    if (net <= 0) {
      // never mine a source that costs more than it yields - stamped, not silent
      verdicts.push({ sourceId: source.id, rate: source.rate, distance: near.distance, net, tax, parts, verdict: "unprofitable" });
      continue;
    }
    verdicts.push({ sourceId: source.id, rate: source.rate, distance: near.distance, net, tax, parts, verdict: "over-budget" });
    candidates.push({
      source,
      spawn: near.spawn,
      distance: near.distance,
      rate: source.rate,
      net,
      parts
    });
  }

  // Per spawn, fill the mining build-time budget highest-value-first.
  const budget = miningBudgetPerSpawn();
  const bySpawn = new Map<string, SourceCandidate[]>();
  for (const c of candidates) {
    const list = bySpawn.get(c.spawn.id) ?? [];
    list.push(c);
    bySpawn.set(c.spawn.id, list);
  }

  const miners: CommissionedMiner[] = [];
  // Profitable candidates were provisionally stamped "over-budget"; funding
  // flips the stamp, so a candidate's final verdict is exactly its fate here.
  const verdictById = new Map(verdicts.map(v => [v.sourceId, v]));
  for (const [, list] of bySpawn) {
    // value per build-part, then by source id for stable ties
    list.sort((a, b) => b.net / b.parts - a.net / a.parts || (a.source.id < b.source.id ? -1 : 1));
    let spent = 0;
    for (const c of list) {
      // Always staff a spawn's best source even if it alone exceeds budget; after
      // that, only take a source if its build-time fits the remaining budget.
      if (spent > 0 && spent + c.parts > budget) continue;
      spent += c.parts;
      const v = verdictById.get(c.source.id);
      if (v) v.verdict = "funded";
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
  return { miners, verdicts };
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
  supply: SupplyPoint[],
  partsBudget: number
): { haulers: CommissionedHauler[]; sinks: CommissionedSink[] } {
  const { sinks, dist } = problem;
  const sourceById = new Map(problem.sources.map(s => [s.id, s]));
  const spawnBySource = new Map(supply.map(s => [s.sourceId, s.spawnId]));

  // THE SPAWN-PARTS LEDGER (spec 15 P4): every unit of energy allocated here
  // implies standing bodies - the haulers that move it and, at a controller,
  // the upgraders that burn it. The ledger starts at the spawn's physical
  // build-rate minus what miners and standing infra already claim, and each
  // allocation below spends it. When it runs dry the fill STOPS: the plan is
  // an equilibrium the spawn can actually maintain, with the value order
  // deciding who got the scarce parts (measured 2026-07-18: without this the
  // plan implied 0.56 parts/t against the 0.333 ceiling and the colony
  // self-limited via starvation queues instead of by value).
  let partsRemaining = Math.max(0, partsBudget);
  // A consumer sink's bodies walk from the spawn nearest it.
  const nearestSpawnDist = (pos: Position): number =>
    problem.spawns.length === 0 ? 0 : Math.min(...problem.spawns.map(s => dist(s.pos, pos)));

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

    // Sources with energy left, nearest to this sink first (ties by id). A
    // source's output is hauled from its haulPos (the core link for a
    // link-served source), not necessarily the source tile itself.
    const order = [...pool.keys()]
      .filter(id => (pool.get(id) ?? 0) > 1e-9)
      .map(id => {
        const s = sourceById.get(id)!;
        return { id, d: dist(s.haulPos ?? s.pos, sink.pos) };
      })
      .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));

    // Consumer bodies for THIS sink walk from the nearest spawn: upgraders at
    // a controller, builders at construction (5x cheaper per e/t - BUILD is
    // 5 energy per WORK-tick). Spawn/storage sinks have no standing body.
    const workPerUnit =
      sink.kind === "controller"
        ? controllerWorkSpawnLoad(1, nearestSpawnDist(sink.pos))
        : sink.kind === "construction"
        ? constructionWorkSpawnLoad(1, nearestSpawnDist(sink.pos))
        : 0;

    for (const { id, d } of order) {
      if (acc.allocated >= target - 1e-9) break;
      const avail = pool.get(id) ?? 0;
      // A paved route's 2:1 hauler needs 1.5 parts per CARRY, not 2 - the
      // spawn-budget payoff that makes roads worth building at all.
      const paved = sourceById.get(id)?.paved === true;
      // Parts/tick per unit of flow on this route: haul bodies + sink work bodies.
      const chargePerUnit = ((paved ? 1.5 : 2) * carryPartsFor(1, d)) / effectiveLife(d) + workPerUnit;
      const maxByParts = chargePerUnit > 1e-12 ? partsRemaining / chargePerUnit : Infinity;
      const take = Math.min(avail, target - acc.allocated, maxByParts);
      if (take <= 1e-9) {
        if (maxByParts <= 1e-9) return; // ledger dry - the fill is over for this sink
        continue;
      }
      partsRemaining -= take * chargePerUnit;
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
        spawnParts: ((paved ? 1.5 : 2) * carryPartsFor(take, d)) / effectiveLife(d),
        ...(paved ? { paved } : {})
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
  const { miners, verdicts: sourceVerdicts } = selectProducers(problem);
  // Supply = staffed sources + scavengeable transient stocks (no miner needed).
  const supply: SupplyPoint[] = [
    ...miners.map(m => ({ sourceId: m.sourceId, rate: m.rate, spawnId: m.spawnId })),
    ...selectTransientSupply(problem)
  ];
  // The spawn-parts ledger for the sink fill: physical build-rate minus the
  // committed miners and the standing infra (feeder/tender/reservers - see
  // ColonyProblem.infraPartsPerTick). Production is funded first in BOTH
  // currencies; routing and consumers spend what remains.
  const minerLoad = miners.reduce((s, m) => s + MINER_PARTS / effectiveLife(m.distance), 0);
  const partsBudget = problem.spawns.length * SPAWN_PARTS_PER_TICK - minerLoad - (problem.infraPartsPerTick ?? 0);
  const { haulers, sinks } = routeToSinks(problem, supply, partsBudget);

  const totalProduced = supply.reduce((s, p) => s + p.rate, 0);
  const totalDelivered = sinks.reduce((s, k) => s + k.allocated, 0);
  const miningOverhead = miners.reduce((s, m) => s + minerOverhead(m.distance), 0);
  const haulOverhead = haulers.reduce((s, h) => s + haulerOverhead(h.carryParts, h.distance), 0);
  const totalOverhead = miningOverhead + haulOverhead;
  const valueDelivered = sinks.reduce((s, k) => s + k.allocated * k.value, 0);

  const spawnPartsUsed = new Map<string, number>();
  for (const m of miners) {
    spawnPartsUsed.set(m.spawnId, (spawnPartsUsed.get(m.spawnId) ?? 0) + MINER_PARTS / effectiveLife(m.distance));
  }
  for (const h of haulers) {
    spawnPartsUsed.set(h.spawnId, (spawnPartsUsed.get(h.spawnId) ?? 0) + h.spawnParts);
  }

  return {
    miners,
    haulers,
    sinks,
    sourceVerdicts,
    totalProduced,
    totalDelivered,
    totalOverhead,
    spawnPartsUsed,
    valueDelivered,
    sustainable: totalDelivered >= totalOverhead
  };
}
