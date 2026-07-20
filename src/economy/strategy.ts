/**
 * @fileoverview The strategic searcher, v0 (spec 18 P1) - the supply-chain
 * STRUCTURE as the searched decision.
 *
 * planColony is the millisecond EVALUATOR; this module searches over candidate
 * structures and adopts one only under the decision rule. The v0 operator is
 * the greedy assignment's known blind spot: selectProducers binds every source
 * to its NEAREST spawn, so a source the nearest spawn's budget drops
 * ("over-budget" verdict) stays unmined even when another spawn has slack.
 * The candidate structure pins that source to an alternate spawn
 * (PlannerSource.assignedSpawnId) and re-evaluates.
 *
 * THE DECISION RULE (spec 18, the day-one reconciliation): adopt a candidate
 * only when it strictly beats the incumbent by more than the adoption margin,
 * NET of transition costs. v0 candidates only ACTIVATE dropped sources - they
 * never tear down an existing chain - so their transition cost is zero beyond
 * the new chain's own spawn investment, which the evaluator already prices.
 * The margin here guards model-space churn (near-ties flapping structure
 * between solves); it is NOT the sim noise floor - that ±20-30% doctrine
 * governs how the FEATURE is validated (multi-draw A/B), not each adoption,
 * because evaluator-vs-evaluator comparisons are deterministic.
 *
 * Pure (purity-ratchet enforced), deterministic (candidates in id order),
 * budgeted (MAX_EVALUATIONS caps the solves per search).
 *
 * @module economy/strategy
 */

import { ColonyPlan, ColonyProblem, PlannerSource, planColony } from "./CorpPlanner";

/** Relative value gain a candidate must clear to be adopted (churn guard). */
export const STRUCTURE_ADOPTION_MARGIN = 0.02;

/** Evaluator calls a single search may spend (each is a full pure solve). */
export const MAX_EVALUATIONS = 8;

/** One adopted restructuring: this source now works from this spawn. */
export interface AdoptedPin {
  sourceId: string;
  spawnId: string;
  /** Relative value gain over the structure without this pin. */
  gain: number;
}

export interface StructureSearchResult {
  /** The final plan - the incumbent's, or the adopted structure's. */
  plan: ColonyPlan;
  /** The problem the final plan was solved from (pins applied). */
  problem: ColonyProblem;
  /** Restructurings adopted this search (empty = status quo). */
  adopted: AdoptedPin[];
  /** Evaluator calls spent (1 = baseline only, no candidates existed). */
  evaluations: number;
}

/** The problem with one more source pinned to a spawn (pure copy). */
function withPin(problem: ColonyProblem, sourceId: string, spawnId: string): ColonyProblem {
  const sources: PlannerSource[] = problem.sources.map(s =>
    s.id === sourceId ? { ...s, assignedSpawnId: spawnId } : s
  );
  return { ...problem, sources };
}

/**
 * Search the chain structure: evaluate the incumbent, then candidate pins for
 * every budget-dropped source on every alternate spawn (nearest alternates
 * first), greedily adopting the best strict improvement per round until no
 * candidate clears the margin or the evaluation budget is spent.
 */
export function searchStructure(
  problem: ColonyProblem,
  evaluate: (p: ColonyProblem) => ColonyPlan = planColony
): StructureSearchResult {
  let currentProblem = problem;
  let currentPlan = evaluate(currentProblem);
  let evaluations = 1;
  const adopted: AdoptedPin[] = [];

  // Greedy rounds: each adopts at most one pin, then re-derives candidates
  // from the NEW plan's verdicts (an adoption can free or consume budget).
  for (;;) {
    if (evaluations >= MAX_EVALUATIONS) break;

    const dropped = currentPlan.sourceVerdicts
      .filter(v => v.verdict === "over-budget")
      .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
    if (dropped.length === 0) break;

    let best: { pin: AdoptedPin; plan: ColonyPlan; problem: ColonyProblem } | null = null;
    for (const v of dropped) {
      if (evaluations >= MAX_EVALUATIONS) break;
      const source = currentProblem.sources.find(s => s.id === v.sourceId);
      if (!source) continue;
      // Alternate spawns, nearest first - the cheapest chains are the most
      // plausible wins, and determinism needs a total order (dist, then id).
      const alternates = currentProblem.spawns
        .filter(s => s.id !== (source.assignedSpawnId ?? "") )
        .map(s => ({ spawn: s, d: currentProblem.dist(s.pos, source.pos) }))
        .sort((a, b) => a.d - b.d || (a.spawn.id < b.spawn.id ? -1 : 1));

      for (const alt of alternates) {
        if (evaluations >= MAX_EVALUATIONS) break;
        // Pinning a source to its own nearest spawn re-derives the incumbent;
        // skip only exact re-pins (assignedSpawnId check above covers rounds).
        const candidateProblem = withPin(currentProblem, v.sourceId, alt.spawn.id);
        const candidatePlan = evaluate(candidateProblem);
        evaluations += 1;

        const incumbent = currentPlan.valueDelivered;
        const gain = incumbent > 0 ? (candidatePlan.valueDelivered - incumbent) / incumbent : candidatePlan.valueDelivered > 0 ? 1 : 0;
        if (gain > STRUCTURE_ADOPTION_MARGIN && (!best || candidatePlan.valueDelivered > best.plan.valueDelivered)) {
          best = {
            pin: { sourceId: v.sourceId, spawnId: alt.spawn.id, gain },
            plan: candidatePlan,
            problem: candidateProblem
          };
        }
      }
    }

    if (!best) break;
    adopted.push(best.pin);
    currentPlan = best.plan;
    currentProblem = best.problem;
  }

  return { plan: currentPlan, problem: currentProblem, adopted, evaluations };
}
