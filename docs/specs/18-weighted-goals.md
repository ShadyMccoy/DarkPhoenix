# 18 — Weighted goals: the objective becomes a planner input

**Status:** PROPOSED (owner direction 2026-07-20). Spec first, build next.
**Priority:** P1 — the planner half of the "colony as one organism" vision.
**Depends on:** spec 17 (pure planner core, enforcement tests) — landed.

## The thesis (owner, 2026-07-20)

> The goals may change over time — maximize upgrade points at the controller,
> or maximize construction points at a new spawn we're building. And it's not
> binary: a mix of weighted goals. The GOAP planner searches for the optimal
> solution. That doesn't change the operation of the primitives — an energy
> miner is still an energy miner.

Today the objective is FROZEN into the sink-value ladder (spawn 100 >
new-spawn-site 85 > controller 40–80 > construction 70 > storage 1;
`DEFAULT_SINK_VALUE` + `perInstanceSinkValue`). The planner maximizes against
it, but nothing can *say* "right now, founding W5N5 matters three times as
much as controller progress." This spec makes the objective an explicit,
pure input:

```ts
planColony(problem: ColonyProblem, goal?: Goal): ColonyPlan
```

with **today's ladder as the default Goal**, pinned bit-for-bit.

## Goal model: profiles, compiled — not raw weights

A **GoalProfile** is a named, pre-tested objective ("grow-controller",
"found-room", "warchest", "balanced"). A **Goal** is a weighted blend of
profiles (e.g. `{ "grow-controller": 0.7, "found-W5N5": 0.3 }`, with a
profile parameterized by its target where applicable). A pure **compiler**
turns the blend into one concrete sink-value ladder for the solve.

Why compiled profiles instead of operator-set raw per-sink weights: the
ladder's orderings are measured invariants, not preferences. The trap list
records the 90-vs-85 founding incident — one nudged value inverted
new-spawn-site vs construction and zeroed colony-wide construction. The
compiler makes that entire bug class unrepresentable:

- **Invariants preserved under every blend** (the compiler's contract):
  1. spawn overhead is always the top of the ladder;
  2. the anti-downgrade controller floor always exists;
  3. new-spawn-site outranks the general construction band (founding class);
  4. storage stays the residual floor.
- Weights move the BANDS between invariants (how much the controller band
  yields to a founding push), never the invariant orderings themselves.

The rejected-for-now alternative — raw weights plus a validator — is more
expressive but reintroduces the footgun surface at every use; it can be
revisited once profiles prove insufficient.

## The organism (phase 3)

The primitives already amortize every cost over real walking distance
(`effectiveLife`, `netEnergy`, the parts ledger), so the planner can PRICE an
east-room spawn funding a west-room goal today. What blocks the organism
behavior is only the assignment heuristics: sources bind to their nearest
spawn and consumers are room-local. Under a Goal that values a remote
objective highly enough, `selectProducers`/`routeToSinks` relax those
constraints (bounded by profitability — the same `netEnergy > 0` rule), and
"the east rooms send their energy west" becomes an emergent solution, not a
feature.

## Non-goals

- No change to execution: corps/kinds/primitives are untouched (an energy
  miner is still an energy miner). Goals reach them only as different
  commission sizes/targets.
- No change to the NOW plan's doctrine: goals shift demand VALUES; the walk
  (tiers, holds, starvation) is spec-17-pinned.
- Who SETS the goal (operator console, Memory schema, or a future
  higher-level director reading room state) is phase 4 — the planner just
  takes the argument.

## Acceptance tests (the spec is DONE when these pass)

1. **Default pin:** `planColony(problem)` with no goal produces plans
   deep-equal to today's over the golden worlds (extends
   `planEquivalence.test.ts`) — landing the seam changes nothing.
2. **Compiler invariants (property test):** for randomized profile blends
   (including degenerate weights 0/1 and parameterized targets), the compiled
   ladder satisfies every invariant above — no blend can express the
   90-vs-85 incident class.
3. **Profile semantics (pure planner tests):** under "found-room(W5N5)" the
   founding room's construction sinks gain allocation and controller
   allocation yields, while spawn overhead allocation is unchanged; under
   "grow-controller" the controller band sits at its ceiling. Assertions on
   `ColonyPlan.sinks`, not on internal numbers.
4. **Purity:** the compiler and Goal types live in the PLAN layer and join
   the purity ratchet's pure list (`test/unit/economy/purity.test.ts`).
5. **Organism gate (phase 3 only):** a two-room fixture where room E has
   surplus and room W has the goal target: with the founding goal weighted
   up, the plan routes E-energy to W sinks; with the default goal it does
   not. Grid cell staged before the phase lands (write the failing cell
   first).

## Phases

- **P1** `Goal`/`GoalProfile` types + compiler + `planColony(problem, goal?)`
  seam; default pinned (tests 1, 2, 4).
- **P2** the first real profiles: grow-controller, found-room(target),
  warchest (test 3); goal plumbed from `FlowEconomy.solve` (still a constant
  default at this phase).
- **P3** assignment relaxation under goal pressure (test 5; grid cell).
- **P4** the goal SOURCE: operator console command + Memory persistence;
  future higher-level director explicitly out of scope here.
