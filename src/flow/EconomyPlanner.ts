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
  build: 5,
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
  /** Max energy/tick this sink can absorb (its constraint). */
  capacity: number;
  pos: Position;
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
 */
export function planEconomy(input: PlannerInput): EconomyPlan {
  const { sources, sinks, spawnId, dist } = input;

  // Remaining unallocated supply per source.
  const remaining = new Map(sources.map((s) => [s.id, s.supply]));
  const flows: PlannedFlow[] = [];

  // Route to the highest-value sinks first; each draws from its nearest sources
  // until it hits its capacity or the sources run dry. A high-value, low-
  // capacity sink (construction) thus takes its fill and no more; a low-value,
  // high-capacity sink (controller) mops up whatever is left.
  const byValue = [...sinks].sort((a, b) => b.value - a.value);
  for (const sink of byValue) {
    let need = sink.capacity;
    const nearestFirst = sources
      .map((s) => ({ s, d: dist(s.pos, sink.pos) }))
      .sort((a, b) => a.d - b.d);

    for (const { s, d } of nearestFirst) {
      if (need <= 0) break;
      const avail = remaining.get(s.id) ?? 0;
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      remaining.set(s.id, avail - take);
      need -= take;
      flows.push({ sourceId: s.id, sinkId: sink.id, amount: take, distance: d });
    }
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
  for (const sink of sinks) {
    const energy = energyBySink.get(sink.id) ?? 0;
    if (energy <= 0) continue;
    if (sink.kind === "construction") {
      corps.push({ kind: "build", work: Math.max(1, Math.ceil(energy / ENERGY_PER_WORK.build)), sinkId: sink.id, spawnId });
    } else if (sink.kind === "controller") {
      corps.push({ kind: "upgrade", work: Math.max(1, Math.ceil(energy / ENERGY_PER_WORK.upgrade)), sinkId: sink.id, spawnId });
    }
    // spawn: delivered energy is the economy's own overhead - no consuming corp.
  }

  let unrouted = 0;
  for (const v of remaining.values()) unrouted += v;

  return { corps, flows, unrouted };
}
