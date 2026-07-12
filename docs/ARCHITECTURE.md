# Architecture Overview

> **This document was superseded.** The FlowSolver + priority-allocation
> design it used to describe has been deleted. The current architecture is
> documented, with verified `file:line` anchors, in:
>
> - **[PIPELINE.md](PIPELINE.md)** — the economic pipeline end to end
>   (terrain → nodes → graph → planner → commissions → corps → creeps),
>   tick cadences, and the deleted/vestigial list.
> - **[ONTOLOGY.md](ONTOLOGY.md)** — the domain model the code is shaped to
>   match (entities, primitives, the Corp/Commission framing).
> - **[specs/00-corp-framework.md](specs/00-corp-framework.md)** — the
>   CorpKind plug-in contract and its acceptance tests.

## One-paragraph summary (current)

Each solve, `economy/CorpPlanner.ts` (`planColony` — pure, deterministic,
Game-free) selects which sources to mine per spawn under a build-time budget
and value-routes their output to sinks. `economy/flowAdapter.ts` feeds it a
`ColonyProblem` flattened from the `FlowGraph` world survey and emits both a
legacy `FlowSolution` (telemetry) and `Commission` envelopes.
`execution/CommissionHost.ts` materializes commissions through registered
`CorpKind`s into runtime corps, which drive creeps and surface spawn demands
to `execution/SpawnDirector.ts` → the pure `spawn/SpawnScheduler.ts`.
All economic formulas live in `economy/primitives.ts` — nothing else may
reimplement them.

## Design principles that still hold

1. **One planner, pure core** — economics decided in a single global solve
   over pure data; execution is deliberately dumb.
2. **Two currencies** — energy AND spawn build-time, with build-time priced
   in energy (`energyPerSpawnPart`) so distance limits fall out of ranking.
3. **Domain-driven organization** — corps as business units; kinds plug in
   without touching the core (spec 00's extensibility proof pins this).
4. **Measured over assumed** — the inflection grid (spec 08) is the success
   metric; plan-vs-actual fidelity is asserted, not eyeballed.
