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

1. **Default pin:** `planColony(problem)` with no goal and no search produces
   plans deep-equal to today's over the golden worlds — landing the seams
   changes nothing until a goal/search is engaged.
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

## Phases

- **P1** Goal types + profile compiler + `planColony(problem, goal?)` seam;
  default pinned (tests 1, 2, 7).
- **P2** first profiles (grow-controller, found-room, warchest) + goal
  plumbing from FlowEconomy (test 3).
- **P3** operator catalog: chain restructurings + investments as pure
  precondition/cost/effect functions; transition-cost model from the NOW
  plan's own pricing (test 4).
- **P4** the searcher: event-triggered, anytime/beam, CPU-governed; emits
  the GOAL plan's commissions (tests 4, 6).
- **P5** de-rooming the funding seams per the inventory (test 5, the
  organism cell).
- **P6** the goal source (operator console + Memory; a higher-level director
  stays future work).
