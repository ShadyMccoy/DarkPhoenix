# 18 — Strategy: weighted goals and the supply-chain search

**Status:** PROPOSED (owner direction 2026-07-20, revised same day). Spec
first, build next.
**Priority:** P1 — the strategic planner: the "colony as one organism" thesis.
**Depends on:** spec 17 (pure planner core, enforcement) — landed; spec 20
(three-currency accounting) — phase 1 landed.

## The strategy thesis (owner, 2026-07-20)

> The energy sources and sinks will change, and that should RESTRUCTURE the
> supply chain. That changes the availability of energy and the corps that
> can be funded. This is a core strategy thesis. I don't want rooms as the
> grain — I want nodes as part of a colony. For warfare our thesis is
> economic: we simply bring more resources to bear — CPU, energy, spawning.

Four commitments fall out of this:

1. **The chain is the decision.** The supply-chain STRUCTURE — which sources
   feed which sinks through which nodes, which spawns serve which chains —
   is the strategic variable, not an emergent detail of a per-solve fill.
   Structural events (storage stands, a remote is reserved/lost, a founding
   site appears, a raid zeroes a room) trigger RE-SEARCH over candidate
   structures; funding capacity is downstream of the structure chosen.
2. **Search with transition costs.** Bodies are ~1500-tick sunk capital
   bought serially through one spawn; roads/containers/links reprice edges;
   restructuring strands fleets. A candidate structure is scored as
   `steady-state value (evaluator) − transition cost (what the NOW plan must
   buy/recycle to get there)`. This is what makes it a genuine search rather
   than a memoryless optimization — and why the doctrine's retiring
   hysteresis and upsize transitions already exist at the execution layer.
3. **Node grain, not room grain.** The colony is ONE graph of nodes
   (territories); rooms are engine-imposed constraint annotations
   (controllers, vision, per-room raids), never the funding boundary. Any
   node's surplus can fund any node's sink when the search says it pays.
4. **Warfare is economics.** Military action is corps consuming the three
   currencies (energy, spawn build-time, CPU — spec 20) to protect or
   restore income streams. A military operator's effect is an income delta
   (spec 13 already prices raids as a tax and the guard by protected
   income); the search weighs it like any other operator. We win by
   bringing more resources to bear, measurably.

## The day-one principle (owner, 2026-07-20)

> I'm happy to listen to the right way to solve this, but I want to make
> sure it's a principle and an ABILITY from day one.

Two consequences, binding on the build order:

1. **No non-goal code path.** From the first landed commit, every plan is
   the output of goal + search: `planColony` is called with the DEFAULT
   GOAL everywhere, and the searcher runs live. Today's behavior is
   re-expressed as one point in goal space (the default profile + a
   status-quo-favoring decision rule), never preserved as a bypass beside
   the new machinery. There is nothing to "switch on" later.
2. **Vertical slice first, then widen.** The first phase ships the WHOLE
   loop thin - a goal input, two real profiles, a searcher with at least
   one real restructuring operator, transition costing, live behind the
   decision rule - and every later phase only WIDENS the live loop
   (more operators, more profiles, de-rooming). No phase ships types or
   seams that nothing exercises.

**The decision rule that reconciles "live from day one" with the behavior
pins:** the searcher adopts a candidate structure only when it strictly
beats the status quo by more than the measured noise floor (the multi-draw
±20-30% doctrine), NET of transition costs. On the golden worlds nothing
beats status quo, so every pin holds; the first world where something does
is the ability working - and the grid ratchet is the arbiter of every such
adoption.

## Architecture: searcher, evaluator, executor

```
Goal (weighted profiles)
   │
   ▼
STRATEGIC SEARCH  — candidate chain structures + investment operators
   │                (event-triggered; anytime/beam under the CPU governor;
   │                 scores = evaluator(structure) − transition cost)
   ▼
EQUILIBRIUM EVALUATOR — planColony(problem | structure): the existing pure
   │                    solve, called per candidate in milliseconds
   ▼
GOAL plan (the chosen structure's commissions)
   │
   ▼
NOW plan — planAcquisitions: the transition, bought one body at a time
```

- The **evaluator is landed** (spec 17 made it pure, fast, enforced).
- The **NOW plan is landed** (prescriptive since spec 17 P2) and is exactly
  the transition executor the search needs.
- The **searcher is this spec**: operators = chain restructurings + discrete
  investments (claim, storage, reserve, links, paving, military missions),
  each a pure `(problem) → problem'` effect with preconditions and cost.
- Re-search triggers: the source/sink set changed (assembly delta), a
  structural investment completed, a goal changed. NOT per tick.

## Goal model: profiles, compiled — not raw weights

A **GoalProfile** is a named, pre-tested objective ("grow-controller",
"found-room(target)", "warchest"). A **Goal** is a weighted blend of
profiles. A pure **compiler** turns the blend into the sink-value ladder for
the evaluator.

Why compiled profiles instead of operator-set raw per-sink weights: the
ladder's orderings are measured invariants (the 90-vs-85 founding incident
zeroed colony-wide construction). The compiler preserves them under every
blend — spawn overhead on top, anti-downgrade floor present, founding class
above the construction band, storage the residual floor. Weights move the
bands BETWEEN invariants, never the orderings. Raw weights + a validator is
the rejected-for-now alternative.

## Node grain: the de-rooming inventory

**Prerequisite — node identity stability (owner principle 2026-07-20: "nodes
should be stable because the world terrain is stable").** Terrain IS static,
so stability is enforceable - but today node ids are positional
(`${room}-${peakX}-${peakY}`, nodes/Node.ts) and the analysis window is a
7x7 box around OWNED rooms (IncrementalAnalysis.ts), so claiming a room can
shift edge peaks and rename nodes exactly at expansion moments. Before any
funding seam keys on nodes: (a) persist-and-match identity - re-analysis
matches peaks/territories to EXISTING nodes by terrain-stable anchors
(source/controller ids, peak-within-old-territory) and keeps their ids;
only new territory mints ids; (b) the invariant as a unit test - analyzing
a grown window never renames a node interior to the old one. Same medicine
as the roomIntel.sourceIds churn fix.

Rooms leak into the funding seams today; each moves to node/path grain as
the search lands (rooms stay as constraint annotations only):

| Seam | Today | Target |
|---|---|---|
| Serving-spawn choice (`commissionPlan.servingSpawnId`) | same-ROOM first | nearest by path distance, colony-wide |
| Construction corps (`constructionKind`) | one per owned ROOM | per node-cluster with a spawn assignment |
| Consumer locality (upgrade/tender/feeder) | room-local | sink-instance grain (engine already forces one controller per room; the FUNDING is what de-rooms) |
| Income estimate (`SpawnDirector.estimateIncome`) | per room | per spawn's supply chains |
| Remote gating (`remoteMinedRooms`, hostile marks) | per room | per node, room-annotated (engine raids are per-room facts) |

## Non-goals

- No change to execution: corps/kinds/primitives untouched (an energy miner
  is still an energy miner). Structures reach them only as different
  commission sets.
- No change to the NOW plan's doctrine (tiers, holds, starvation — pinned).
- No automatic feedback from the audit layer into the search (audit stays
  passive; the search reads the WORLD and the goal).
- Who sets the Goal (console, Memory, a future director) is the last phase.

## Acceptance tests (the spec is DONE when these pass)

1. **Default pin:** under the DEFAULT goal with the searcher LIVE (the only
   code path - no bypass exists), plans over the golden worlds deep-equal
   today's: the decision rule keeps status quo wherever nothing strictly
   beats it net of transition costs and noise floor.
2. **Compiler invariants (property test):** randomized profile blends can
   never express a forbidden ladder ordering (the 90-vs-85 class).
3. **Profile semantics (pure):** "found-room(W)" shifts allocation toward W's
   founding sinks while spawn overhead holds; "grow-controller" holds the
   controller band at its ceiling. Asserted on `ColonyPlan.sinks`.
4. **Restructuring (pure):** a two-node fixture where a structural event
   (storage appears; a remote is lost) changes the optimal chain: the search
   emits the restructured commissions, and the score accounting shows
   `evaluator gain − transition cost > 0` for the chosen move.
5. **Organism (grid):** a two-room world, east surplus + west founding goal:
   with the goal weighted up, east energy funds west sinks; with the default
   goal it does not. Cell staged red-first.
6. **Warfare pricing (pure):** a guard/buster mission operator is chosen
   exactly when the protected/restored income (net of the three-currency
   cost) beats the alternative use of the same spawn time — extending the
   spec 13 tax math into the search.
7. **Purity:** searcher, compiler, operators, and effects join the PLAN
   layer's purity ratchet.

## Phases (walking skeleton: the ability ships in P1, later phases widen it)

- **P1 — the vertical slice, LIVE.** Goal type + compiler with TWO real
  profiles (default = today's ladder, grow-controller), the searcher with
  ONE real restructuring operator (candidate: activate/deactivate a source
  chain when the set changes) + transition costing + the noise-floor
  decision rule, wired into the live solve path. Default behavior pinned
  bit-for-bit by the golden worlds (tests 1, 2, 7, and a thin test 4).
  After P1 there is no non-goal code path.
- **P2 — widen profiles:** found-room(target), warchest; goal set from the
  operator console + Memory (test 3).
- **P3 — widen operators:** the investment catalog (claim, storage,
  reserve, links, paving) as pure precondition/cost/effect functions
  (test 4 in full).
- **P4 — widen the search:** beam/anytime under the CPU governor; military
  mission operators priced by income delta (test 6).
- **P5 — de-room the funding seams** per the inventory (test 5, the
  organism cell - staged red first).

The old bottom-up order (types -> profiles -> operators -> searcher) is
explicitly REJECTED: it delivers the ability last, which is how a capability
becomes permanent scaffolding.
