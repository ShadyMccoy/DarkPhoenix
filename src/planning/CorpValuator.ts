/**
 * CorpValuator - what is a corp worth?
 *
 * A corp is never valuable in isolation; it is valuable because of the
 * production CHAIN it takes part in. A spawn corp on its own mints nothing -
 * but it staffs the miners, haulers and upgraders that turn free source energy
 * into controller points. So the way to price a corp is to ask: "what chains
 * would exist WITH it that don't exist WITHOUT it, and what are those chains
 * worth per tick?"
 *
 * Rather than invent a second model of the economy, this reuses the strategic
 * planner ({@link planEconomy}). The planner already answers "given this spawn,
 * these sources and these sinks, what is the optimal roster of corps and what
 * does it cost to staff?" - which is exactly the set of hypothetical chains a
 * candidate corp would find. We run the planner twice (with the candidate, and
 * without it) and report the difference:
 *
 *   - marginalValue      strategic value/tick the candidate unlocks
 *                        (energy routed to value sinks, weighted by their value)
 *   - marginalThroughput productive energy/tick the candidate unlocks
 *   - enabledCorps       the corps (the chain) that appear only WITH the candidate
 *
 * For the headline case - valuing a spawn corp - the baseline is "no spawn, so
 * no economy at all", and the valuation is the entire economy the spawn would
 * stand up. {@link valuateSpawnCorp} expresses that directly.
 *
 * Like the planner, this module is pure: distances are injected, no Game
 * globals, so it is deterministic and fully unit-testable.
 */

import {
  CorpSpec,
  EconomyPlan,
  PlannerInput,
  PlannerSink,
  PlannerSource,
  planEconomy,
} from "../flow/EconomyPlanner";

/**
 * The worth of a corp, measured as the marginal economy (the chains) it
 * enables over a baseline that lacks it.
 */
export interface CorpValuation {
  /**
   * Strategic value/tick the candidate unlocks: the extra energy it lets the
   * colony route to value-bearing sinks (construction, controller), each unit
   * weighted by that sink's strategic value. This is the headline number for
   * comparing candidates against one another.
   */
  marginalValue: number;

  /**
   * Productive energy/tick the candidate unlocks - energy that ends up doing
   * real work (building/upgrading) rather than feeding the spawn's own
   * overhead. A capacity-starved candidate (no sink can absorb its energy)
   * scores ~0 here even if it adds raw supply.
   */
  marginalThroughput: number;

  /**
   * The corps that exist WITH the candidate but not without it - the concrete
   * chain it would find. For a spawn corp this is the whole roster it staffs;
   * for an extra source it is the miner + haulers + the upgrader scaled up to
   * absorb the new energy.
   */
  enabledCorps: CorpSpec[];

  /** The full plan with the candidate present. */
  planWith: EconomyPlan;

  /** The baseline plan without the candidate. */
  planWithout: EconomyPlan;
}

/** A plan in which nothing happens - the baseline for valuing a first spawn. */
const EMPTY_PLAN: EconomyPlan = {
  corps: [],
  flows: [],
  unrouted: 0,
  overhead: 0,
};

/**
 * Productive throughput and value of a plan: sum the energy the plan routes to
 * value-bearing sinks (everything except the spawn, whose intake is just the
 * economy's own overhead) and weight it by each sink's strategic value.
 */
function productive(
  plan: EconomyPlan,
  sinks: PlannerSink[]
): { throughput: number; value: number } {
  const byId = new Map(sinks.map((s) => [s.id, s]));
  let throughput = 0;
  let value = 0;
  for (const flow of plan.flows) {
    const sink = byId.get(flow.sinkId);
    // A spawn flow is the economy paying its own overhead, not output. Unknown
    // sinks (shouldn't happen) are ignored rather than silently counted.
    if (!sink || sink.kind === "spawn") continue;
    throughput += flow.amount;
    value += flow.amount * sink.value;
  }
  return { throughput, value };
}

/** Stable structural key for a corp spec, so two plans' rosters can be diffed. */
function corpKey(c: CorpSpec): string {
  switch (c.kind) {
    case "mine":
      return `mine:${c.sourceId}:${c.work}:${c.spawnId}`;
    case "haul":
      return `haul:${c.fromId}->${c.toId}:${c.carry}:${c.spawnId}`;
    case "build":
      return `build:${c.sinkId}:${c.work}:${c.spawnId}`;
    case "upgrade":
      return `upgrade:${c.sinkId}:${c.work}:${c.spawnId}`;
  }
}

/**
 * Corps present in `withCorps` but not in `withoutCorps`. A corp that merely
 * grows (e.g. the upgrader gaining WORK parts to absorb a new source's energy)
 * has a different key and so correctly shows up as "enabled" - the candidate
 * is responsible for the larger corp.
 */
function diffCorps(withCorps: CorpSpec[], withoutCorps: CorpSpec[]): CorpSpec[] {
  const baseline = new Set(withoutCorps.map(corpKey));
  // Each baseline corp may only be cancelled once, so count duplicates.
  const counts = new Map<string, number>();
  for (const c of withoutCorps) counts.set(corpKey(c), (counts.get(corpKey(c)) ?? 0) + 1);

  const enabled: CorpSpec[] = [];
  for (const c of withCorps) {
    const key = corpKey(c);
    const remaining = counts.get(key) ?? 0;
    if (baseline.has(key) && remaining > 0) {
      counts.set(key, remaining - 1);
      continue;
    }
    enabled.push(c);
  }
  return enabled;
}

/**
 * Marginal valuation: the difference between an economy WITH a candidate and
 * one WITHOUT it. The `sinks` are those used to score productive value (they
 * must include any sink the candidate itself adds).
 */
function marginalValuation(
  planWith: EconomyPlan,
  planWithout: EconomyPlan,
  sinks: PlannerSink[]
): CorpValuation {
  const withProd = productive(planWith, sinks);
  const withoutProd = productive(planWithout, sinks);
  return {
    marginalValue: withProd.value - withoutProd.value,
    marginalThroughput: withProd.throughput - withoutProd.throughput,
    enabledCorps: diffCorps(planWith.corps, planWithout.corps),
    planWith,
    planWithout,
  };
}

/**
 * Value a SPAWN corp: the entire economy it would stand up from nothing.
 *
 * This is the headline use case - "evaluate the value of a spawn corp by
 * calculating the hypothetical corps chains it would find". The baseline is the
 * empty economy (no spawn means nothing can be staffed), so the valuation's
 * `enabledCorps` is the full roster the spawn enables and `marginalValue` is the
 * total strategic value/tick of the chains it finds.
 *
 * `input` describes the world as the spawn would see it: the sources it can
 * reach, the sinks it would feed (including its own `spawn` sink), and the
 * distances between them.
 */
export function valuateSpawnCorp(input: PlannerInput): CorpValuation {
  const planWith = planEconomy(input);
  return marginalValuation(planWith, EMPTY_PLAN, input.sinks);
}

/**
 * Value an extra SOURCE in an existing economy: the marginal chains that open
 * up once this source can be mined. Worth ~0 if every sink is already at
 * capacity (the new energy would be unrouted), and worth less the further the
 * source sits from the spawn (longer hauls cost more overhead).
 */
export function valuateSourceCorp(
  candidate: PlannerSource,
  base: PlannerInput
): CorpValuation {
  const planWithout = planEconomy(base);
  const planWith = planEconomy({ ...base, sources: [...base.sources, candidate] });
  return marginalValuation(planWith, planWithout, base.sinks);
}

/**
 * Value an extra SINK in an existing economy (e.g. a new construction project,
 * or an unclaimed controller): the marginal value of letting the colony route
 * energy somewhere new. A high-value sink can pull energy away from lower-value
 * ones, so the marginal value is the NET re-routing gain, not the gross.
 */
export function valuateSinkCorp(
  candidate: PlannerSink,
  base: PlannerInput
): CorpValuation {
  const sinksWith = [...base.sinks, candidate];
  const planWithout = planEconomy(base);
  const planWith = planEconomy({ ...base, sinks: sinksWith });
  return marginalValuation(planWith, planWithout, sinksWith);
}
