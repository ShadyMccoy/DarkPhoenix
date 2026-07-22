/**
 * @fileoverview Goals (spec 18 P1) - the objective as a planner INPUT.
 *
 * A GoalProfile is a named, pre-tested objective; a Goal is a weighted blend
 * of profiles; compileGoal turns the blend into the ONE sink-valuation the
 * evaluator prices sinks with (flowAdapter.perInstanceSinkValue). Day-one
 * principle: there is no non-goal code path - the default profile IS today's
 * measured ladder, and every solve compiles a goal (absent = default).
 *
 * Why compiled profiles instead of raw per-sink weights: the ladder's
 * orderings are measured invariants (the 90-vs-85 founding incident zeroed
 * colony-wide construction when one value was nudged past another). Profiles
 * satisfy the invariants by construction and blending is CONVEX - a weighted
 * average of valuations that each satisfy a strict ordering satisfies it too
 * - so no expressible goal can recreate the incident class. compileGoal
 * still asserts the invariants defensively: a violation is a wiring bug in a
 * profile definition, and it throws rather than plans.
 *
 * PLAN-layer pure (purity ratchet enforced): who SETS the goal lives in the
 * execution layer (Memory.goal via FlowEconomy); this module only computes.
 *
 * @module economy/goals
 */

/**
 * The six anchors the adapter prices every sink instance from - the whole
 * ladder as data. `controllerStatic` is the no-vision fallback (harness/unit
 * paths without a live controller); the live controller prices on the
 * [controllerMin, controllerMax] band by remaining progress.
 */
export interface SinkValuation {
  spawn: number;
  newSpawnSite: number;
  controllerMax: number;
  construction: number;
  controllerStatic: number;
  controllerMin: number;
  storage: number;
}

/**
 * The measured ladder (CLAUDE.md: spawn 100 > new-spawn-site 85 >
 * controller <=80 > construction 70 > controller floor 40 > storage 1) -
 * the DEFAULT goal. These numbers moved live behavior when they moved;
 * change them only through a new profile, never in place.
 */
export const DEFAULT_VALUATION: SinkValuation = {
  spawn: 100,
  newSpawnSite: 85,
  controllerMax: 80,
  construction: 70,
  controllerStatic: 50,
  controllerMin: 40,
  storage: 1
};

/**
 * Named goal profiles. Each must satisfy the ladder invariants (asserted by
 * the property suite AND at compile time). Profiles move the bands BETWEEN
 * the invariants; they can never reorder them.
 *
 * - default:        today's measured ladder, byte-for-byte.
 * - growController: controller progress is the objective - the controller
 *   band rises toward its ceiling and ordinary construction yields to it
 *   (still above the controller floor; founding sites still outrank both).
 * - foundRoom:      a founding push (spec 18 P2). The build set is the
 *   objective: construction rises past the controller CEILING (under default
 *   a nearly-done level's 80 outranks construction's 70; here that reverses)
 *   and the founding site itself closes on spawn overhead. WHICH room is
 *   founded is not the profile's business - founding sinks are instances in
 *   the target room (the expansion campaign places them); the profile only
 *   re-prices the classes.
 * - warchest:       banking is the objective. Invariant I4 pins storage
 *   strictly bottom - the bank can never be a sink to CHASE - so the profile
 *   LOWERS the consumer bands instead: fewer marginal consumer chains clear
 *   their transport cost, and the un-consumed residual banks (the macro
 *   doctrine: fund producers, bank the rest, consumers burn residual).
 */
export const GOAL_PROFILES: { [name: string]: SinkValuation } = {
  default: DEFAULT_VALUATION,
  growController: {
    spawn: 100,
    newSpawnSite: 85,
    controllerMax: 84,
    construction: 60,
    controllerStatic: 65,
    controllerMin: 55,
    storage: 1
  },
  foundRoom: {
    spawn: 100,
    newSpawnSite: 95,
    controllerMax: 70,
    construction: 80,
    controllerStatic: 50,
    controllerMin: 40,
    storage: 1
  },
  warchest: {
    spawn: 100,
    newSpawnSite: 85,
    controllerMax: 60,
    construction: 55,
    controllerStatic: 48,
    controllerMin: 42,
    storage: 1
  }
};

/** A goal: a weighted blend of named profiles (weights need not sum to 1). */
export interface Goal {
  blend: { [profileName: string]: number };
}

/** The default goal - the profile today's pinned behavior compiles from. */
export const DEFAULT_GOAL: Goal = { blend: { default: 1 } };

/**
 * The ladder invariants (incident-derived; ONTOLOGY §7). A valuation that
 * violates any of these is a bug by definition:
 *  I1 spawn overhead is strictly the top of the ladder;
 *  I2 a new-spawn founding site strictly outranks ordinary construction
 *     (the 90-vs-85 incident class);
 *  I3 the controller band is sane: max >= static >= min;
 *  I4 storage is strictly the bottom (the residual buffer).
 */
export function assertValuationInvariants(v: SinkValuation): void {
  const top = Math.max(v.newSpawnSite, v.controllerMax, v.construction, v.controllerStatic, v.controllerMin, v.storage);
  if (!(v.spawn > top)) throw new Error(`goal invariant I1: spawn (${v.spawn}) must be strictly top`);
  if (!(v.newSpawnSite > v.construction)) {
    throw new Error(`goal invariant I2: newSpawnSite (${v.newSpawnSite}) must outrank construction (${v.construction})`);
  }
  if (!(v.controllerMax >= v.controllerStatic && v.controllerStatic >= v.controllerMin)) {
    throw new Error(`goal invariant I3: controller band must order max >= static >= min`);
  }
  const floor = Math.min(v.newSpawnSite, v.controllerMax, v.construction, v.controllerStatic, v.controllerMin);
  if (!(v.storage < floor)) throw new Error(`goal invariant I4: storage (${v.storage}) must be strictly bottom`);
}

/**
 * Compile a goal into the valuation the evaluator uses: normalize the blend
 * weights, average the profiles anchor-wise (convexity preserves every
 * strict invariant each profile satisfies), and assert the invariants.
 * Absent/empty goal = the default profile - the pinned behavior.
 */
export function compileGoal(goal?: Goal): SinkValuation {
  const entries = Object.entries(goal?.blend ?? {}).filter(([name, w]) => w > 0 && GOAL_PROFILES[name]);
  if (entries.length === 0) return DEFAULT_VALUATION;

  const total = entries.reduce((s, [, w]) => s + w, 0);
  const out: SinkValuation = {
    spawn: 0,
    newSpawnSite: 0,
    controllerMax: 0,
    construction: 0,
    controllerStatic: 0,
    controllerMin: 0,
    storage: 0
  };
  for (const [name, w] of entries) {
    const p = GOAL_PROFILES[name];
    const f = w / total;
    out.spawn += p.spawn * f;
    out.newSpawnSite += p.newSpawnSite * f;
    out.controllerMax += p.controllerMax * f;
    out.construction += p.construction * f;
    out.controllerStatic += p.controllerStatic * f;
    out.controllerMin += p.controllerMin * f;
    out.storage += p.storage * f;
  }
  assertValuationInvariants(out);
  return out;
}
