/**
 * EconomyPlanner - the strategic layer.
 *
 * Two layers of thinking run the colony:
 *
 *   1. STRATEGY (this module): how does the economy see the world? It models
 *      sources (energy supply) and sinks (energy demand, each with a strategic
 *      VALUE and an absorption CAPACITY), then routes energy to maximise value
 *      subject to those constraints. Its OUTPUT is a list of corps - declarative
 *      "strategic initiatives" with a tiny interface, e.g. Haul(5, A->B, spawn).
 *
 *   2. EXECUTION (the corps): how does each initiative get carried out, given
 *      its inputs and outputs? That lives in the corp implementations, which own
 *      all the messy "how" (traffic, buffering, edge cases) behind the interface.
 *
 * The key property is that behaviour like "spillover energy goes to upgrading"
 * is NOT coded as a rule. The controller is simply the lowest-value, highest-
 * capacity sink, so once the higher-value sinks (spawn overhead, construction)
 * are filled to their capacity, the remaining energy lands on it by itself.
 * Change the values and the routing changes with no new code.
 *
 * This module is pure: distances are injected, no Game globals, so it is fully
 * unit-testable and deterministic.
 */

import { Position } from "../types/Position";

/** Energy consumed per WORK part per tick, by what the sink does with it. */
export const ENERGY_PER_WORK = {
  /** upgradeController: 1 energy/tick per WORK part. */
  upgrade: 1,
  /** build: 5 energy/tick per WORK part. */
  build: 5
} as const;

/** A source of energy (a mined Source). */
export interface PlannerSource {
  id: string;
  /** Energy produced per tick (e.g. 10 for a standard source). */
  supply: number;
  pos: Position;
}

/** How a sink turns delivered energy into work (and thus into a corp). */
export type SinkKind = "spawn" | "construction" | "controller";

/** A consumer of energy, with a strategic value and an absorption capacity. */
export interface PlannerSink {
  id: string;
  kind: SinkKind;
  /** Strategic value (higher = filled first). */
  value: number;
  /**
   * Max energy/tick this sink can absorb (its constraint). For a `spawn` sink
   * this is ignored - the planner computes the overhead it must reserve from the
   * corps it commissions (see the fixed-point loop in planEconomy).
   */
  capacity: number;
  /**
   * Guaranteed minimum energy/tick, allocated before any value-based routing.
   * Used for the controller's anti-downgrade floor: a sliver of energy that buys
   * a whole RCL of insurance, claimed ahead of even high-value construction.
   */
  reserve?: number;
  pos: Position;
}

/** Creep lifetime (ticks) used to amortise spawn cost into a per-tick rate. */
const CREEP_LIFETIME = 1500;

/** Per-tick spawn overhead of a miner with `work` WORK parts (2 WORK : 1 MOVE). */
function minerOverhead(work: number): number {
  const move = Math.ceil(work / 2);
  return (work * 100 + move * 50) / CREEP_LIFETIME;
}

/** Per-tick spawn overhead of a hauler with `carry` CARRY parts (1 CARRY : 1 MOVE). */
function haulerOverhead(carry: number): number {
  return (carry * 100) / CREEP_LIFETIME;
}

export interface PlannerInput {
  sources: PlannerSource[];
  sinks: PlannerSink[];
  /** Spawn that staffs every corp in this plan. */
  spawnId: string;
  /** Walking distance between two positions (injected for purity/testability). */
  dist: (a: Position, b: Position) => number;
}

/**
 * A strategic initiative the execution layer must carry out. The interface is
 * deliberately tiny - size + endpoints + spawn - while the corp implementation
 * behind it can grow arbitrarily smart.
 */
export type CorpSpec =
  | { kind: "mine"; work: number; sourceId: string; spawnId: string }
  | { kind: "haul"; carry: number; fromId: string; toId: string; spawnId: string }
  | { kind: "build"; work: number; sinkId: string; spawnId: string }
  | { kind: "upgrade"; work: number; sinkId: string; spawnId: string };

/** One unit of routed energy: `amount`/tick from a source to a sink. */
export interface PlannedFlow {
  sourceId: string;
  sinkId: string;
  amount: number;
  distance: number;
}

export interface EconomyPlan {
  corps: CorpSpec[];
  flows: PlannedFlow[];
  /** Energy that no sink could absorb (all sinks at capacity). */
  unrouted: number;
  /** Energy/tick the economy spends staffing its own miners + haulers. */
  overhead: number;
}

/** Round trip time for a hauler over `distance` (1:1 CARRY:MOVE). */
function roundTrip(distance: number): number {
  return 2 * distance + 2;
}

/** CARRY parts to sustain `flowRate` over a route of `distance`. */
function carryFor(flowRate: number, distance: number): number {
  return Math.max(1, Math.ceil((flowRate * roundTrip(distance)) / 50));
}

/**
 * Plan the economy: route energy by value subject to capacity, then read off
 * the corps that realise that routing.
 *
 * The economy pays for itself: the energy delivered to the spawn is exactly the
 * overhead of staffing the miners and haulers this plan commissions. That makes
 * "how much energy is actually available for projects" an OUTPUT, not an input -
 * so we solve the fixed point. Reserve an overhead estimate for the spawn,
 * route the rest, read off the corps, recompute the overhead they cost, and
 * repeat until it stops moving (a handful of passes; longer hauls cost more, so
 * a far source self-consistently leaves less for its projects).
 */
export function planEconomy(input: PlannerInput): EconomyPlan {
  let overhead = 0;
  let plan = allocate(input, overhead);

  for (let pass = 0; pass < 8; pass++) {
    const cost = overheadOf(plan.corps);
    if (Math.abs(cost - overhead) < 0.01) {
      overhead = cost;
      break;
    }
    overhead = cost;
    plan = allocate(input, overhead);
  }

  return { ...plan, overhead };
}

/** Per-tick spawn overhead of a WORK consumer (builder/upgrader): W WORK + 1 CARRY + MOVE. */
function workerOverhead(work: number): number {
  const move = Math.ceil(work / 2);
  return (work * 100 + 50 + move * 50) / CREEP_LIFETIME;
}

/**
 * Total per-tick spawn cost of the WHOLE roster - miners, haulers AND the
 * consumers (builders/upgraders). The spawn must be fed enough energy to keep
 * every creep replaced; omitting the consumers (as this used to) under-feeds the
 * spawn, so it never affords the upgraders the plan budgeted and a second source
 * is mined and wasted.
 */
function overheadOf(corps: CorpSpec[]): number {
  let total = 0;
  for (const c of corps) {
    if (c.kind === "mine") total += minerOverhead(c.work);
    else if (c.kind === "haul") total += haulerOverhead(c.carry);
    else if (c.kind === "upgrade" || c.kind === "build") total += workerOverhead(c.work);
  }
  return total;
}

/**
 * One allocation pass: route supply by value subject to capacity (the spawn
 * sink reserves `overhead`), then emit the corps that realise the routing.
 */
function allocate(input: PlannerInput, overhead: number): Omit<EconomyPlan, "overhead"> {
  const { sources, sinks, spawnId, dist } = input;

  // The spawn's "capacity" is the overhead it must absorb to keep creeps alive.
  const effectiveSinks = sinks.map(s => (s.kind === "spawn" ? { ...s, capacity: overhead } : s));

  // Remaining unallocated supply per source.
  const remaining = new Map(sources.map(s => [s.id, s.supply]));
  const flows: PlannedFlow[] = [];
  const allocatedTo = new Map<string, number>();

  /** Route up to `need` energy to `sink` from its nearest sources. */
  const route = (sink: PlannerSink, need: number): void => {
    if (need <= 0) return;
    const nearestFirst = sources.map(s => ({ s, d: dist(s.pos, sink.pos) })).sort((a, b) => a.d - b.d);
    for (const { s, d } of nearestFirst) {
      if (need <= 0) break;
      const avail = remaining.get(s.id) ?? 0;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      remaining.set(s.id, avail - take);
      need -= take;
      flows.push({ sourceId: s.id, sinkId: sink.id, amount: take, distance: d });
      allocatedTo.set(sink.id, (allocatedTo.get(sink.id) ?? 0) + take);
    }
  };

  // Reserve pass: guarantee each sink's floor first, ahead of all value-based
  // allocation. This is how the controller keeps a trickle (anti-downgrade,
  // "a whole RCL for almost nothing") even while higher-value construction would
  // otherwise claim the entire supply.
  for (const sink of effectiveSinks) {
    if (sink.reserve) route(sink, sink.reserve);
  }

  // Value pass: fill the highest-value sinks first, up to their remaining
  // capacity. A high-value, low-capacity sink (construction) takes its fill and
  // no more; a low-value, high-capacity sink (controller) mops up the rest.
  const byValue = [...effectiveSinks].sort((a, b) => b.value - a.value);
  for (const sink of byValue) {
    route(sink, sink.capacity - (allocatedTo.get(sink.id) ?? 0));
  }

  const corps: CorpSpec[] = [];

  // Mining: one initiative per worked source, sized to its routed output.
  for (const src of sources) {
    const routed = src.supply - (remaining.get(src.id) ?? 0);
    if (routed <= 0) continue;
    corps.push({ kind: "mine", work: Math.max(1, Math.ceil(routed / 2)), sourceId: src.id, spawnId });
  }

  // Hauling: one initiative per source->sink route, sized to the route.
  for (const f of flows) {
    if (f.amount <= 0) continue;
    corps.push({ kind: "haul", carry: carryFor(f.amount, f.distance), fromId: f.sourceId, toId: f.sinkId, spawnId });
  }

  // Consuming: one initiative per fed project sink, sized to absorb its energy.
  const energyBySink = new Map<string, number>();
  for (const f of flows) energyBySink.set(f.sinkId, (energyBySink.get(f.sinkId) ?? 0) + f.amount);
  for (const sink of effectiveSinks) {
    const energy = energyBySink.get(sink.id) ?? 0;
    if (energy <= 0) continue;
    if (sink.kind === "construction") {
      corps.push({
        kind: "build",
        work: Math.max(1, Math.ceil(energy / ENERGY_PER_WORK.build)),
        sinkId: sink.id,
        spawnId
      });
    } else if (sink.kind === "controller") {
      corps.push({
        kind: "upgrade",
        work: Math.max(1, Math.ceil(energy / ENERGY_PER_WORK.upgrade)),
        sinkId: sink.id,
        spawnId
      });
    }
    // spawn: delivered energy is the economy's own overhead - no consuming corp.
  }

  let unrouted = 0;
  for (const v of remaining.values()) unrouted += v;

  return { corps, flows, unrouted };
}
