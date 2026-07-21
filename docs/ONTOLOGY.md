# Colony Economy Ontology

The domain model the bot is built on: the entities, the economic primitives,
the corp-as-operator abstraction, the three architectural layers and their
boundaries, and the contract a new corp kind signs.

It is the reference the code is shaped to match. When code and this document
disagree, that is a bug in one of them — fix it, don't let them drift.
Mechanical enforcement lives in the test suite (see §8); the live pipeline
walkthrough is [PIPELINE.md](./PIPELINE.md); the work items are
[specs/](./specs/README.md).

---

## 1. The three layers

| Layer | Contents | May read | Must never |
|---|---|---|---|
| **PLAN** (pure) | `economy/` core — CorpPlanner, primitives, Commission, CorpKind (contract+registry+dispatch), commissionPlan, siteValue, bank, roadEconomics; `spawn/SpawnScheduler` (the NOW planner); every kind's `propose()` | its arguments: `ColonyProblem`, draft commissions, demands+context | `Game`, `Memory`, `execution/`, live creep positions or room vision |
| **EXECUTE** (dumb) | `corps/`, `corps/kinds/` (materialize/run/body), `execution/` (CommissionHost, SpawnDirector, OrphanRescue, runners) | Game, plus its commission's assignment — "follow your assignment" | invent policy the plan owns; read another kind's naming conventions instead of a shared lens |
| **AUDIT** (passive, pullable) | variance meters (`Memory.corpVariance`), the per-corp CPU ledger (`Memory.corpCpu`), telemetry segments, the spawn agenda + receipts (`Memory.spawnAgenda`), BlackBox flight recorder | everything, generically via the census | feed back into decisions; enumerate kinds by hand |

Two world-adapter modules are the sanctioned PLAN↔world boundary:
`economy/flowAdapter.ts` and `economy/scavenge.ts` read the live world (behind
`typeof Game` guards) to BUILD the pure `ColonyProblem`. Everything else in
`economy/` is Game-free.

The audit layer is deliberately **passive but pullable**: nothing in the bot
reads audit output to make a decision (planner inputs come from the world),
but every plan-vs-actual fact is published uniformly so it can be pulled
through the telemetry API and used as feedback by the operator — that
pullability is the audit layer's acceptance bar.

## 2. Entities (the world)

| Entity | What it is | Key facts |
|--------|-----------|-----------|
| **Room** | A 50×50 tile grid, owned or remote. | Holds sources, a controller, structures. |
| **Source** | An energy producer. | Yields `capacity/300` e/tick (≤10 standard); has `maxMiners` mining spots. A **Producer**. |
| **Sink** | An energy consumer with a *value* and a *capacity*. | Spawn (overhead), Controller (upgrade), ConstructionSite (build), Storage (buffer). A **Consumer**. |
| **Spawn** | A creep factory with a build-time budget. | Builds 1 body part / 3 ticks (`SPAWN_PARTS_PER_TICK`). The scarce resource. |
| **Position / distance** | Real walking distance between two tiles. | `pathDistance` (cached, wall/swamp-aware). The cost driver for hauling. |

These are *physical givens*. The planner does not change them; it decides what
to build on top of them.

## 3. Economic primitives (`src/economy/primitives.ts`)

One definition of every per-tick economic quantity — no module reimplements
them (kind conformance enforces the envelope to 1e-9). Semantics match the
live path: a creep posted `distance` tiles away loses ~`distance` ticks
walking out, so its cost amortises over `effectiveLife(distance)`.

The founding set:

- `roundTripTicks(d) = 2d + 2`
- `carryPartsFor(rate, d) = rate · roundTrip / 50`
- `minerOverhead(d) = MINER_COST / life(d)`
- `haulerOverhead(carry, d) = carry · (CARRY+MOVE) / life(d)`
- `netEnergy(rate, d) = rate − minerOverhead − haulerOverhead` — source profitability
- `spawnPartsFor(rate, d)` — build-time a source's miner+haulers cost
- `miningBudgetPerSpawn()` — build-time a spawn lends to income

Later families (same rule — one home):

- **Delivery contract:** `deliveryLeadTime`, `staffsPost(ttl, parts, travel)` —
  the ONE staffing lens both demand and count sides must share (trap list).
- **Consumer sizing:** `sustainableConsumptionRate` — consumers are sized from
  ACTUAL stock at their site, never from the goal plan (macro doctrine).
- **Ledger charges:** `controllerWorkSpawnLoad`, `constructionWorkSpawnLoad`,
  `infraSpawnLoad` — what the planner's parts ledger charges consumers/infra.
- **Conversions:** `workPartsForEnergyRate`, `energyPerSpawnPart` (the shadow
  price), the invader-tax primitives (spec 13).

Known debt: `planning/EconomicConstants.ts` and `corps/economics.ts` still hold
parallel copies/constants (audited 2026-07-19, spec 17 P5 folds them in).

## 4. The Corp (the operator)

A **Corp** is a *commission*: a unit of economic activity that consumes spawn
build-time (and maybe energy) and produces energy-at-a-place or colony value.
It is simultaneously

- the **planning operator** (a candidate action the planner can take), and
- the **runtime owner** of the creeps that execute it.

Every corp kind is an operator with **preconditions** (its trigger, over the
problem + draft plan — durable signals only), **cost** (spawn build-time,
declared in its commission envelope), and **effect** (energy moved / value
produced). Today the central solver plans the energy economy
(harvest/carry/upgrade) and the other kinds apply themselves via `propose()`;
the contract is shaped so a kind can migrate INTO the planner without rework
(§9 — full GOAP is the endpoint).

The live roster (KINDS, `execution/CommissionHost.ts`):

| Kind | Shape | Role | Spawn roles (workType) |
|------|-------|------|------------------------|
| **harvest** | produce | mine a source | miner (harvest) |
| **carry** | transport | move energy source→sinks | hauler (haul) |
| **upgrade** | consume | controller progress | upgrader (upgrade) |
| **construction** | hybrid (self-proposes, reads draft allocations) | build structures | builder (build), tanker (tank, rescued by tender) |
| **scout** | auxiliary | intel | scout (scout) |
| **reservation** | auxiliary | double remote sources | reserver (reserve) |
| **tender** | auxiliary | refill extensions | tanker (tank) |
| **controllerFeeder** | auxiliary | bank→controller relay | feeder (feed) |
| **raidGuard** | auxiliary (military) | protect remote producers | guard (guard) |
| **coreBuster** | auxiliary (military) | reclaim occupied remotes | buster (buster), striker (strike) |
| **claim** | auxiliary (CAPEX) | expansion claimer | claimer (claim) |

Outside the framework (legacy registry, folded into the census by
`completeCensus`): **bootstrap** (cold-start jacks) and **spawning**
(infrastructure — executes spawn decisions; not really a commission).

## 5. The CorpKind contract (registration-only integration)

A kind declares everything the colony needs; nothing else learns its name.
**Adding a corp kind = one kind file + one `KINDS` entry.** Anything that
requires a third edit is a framework bug (the registration-only test proves
it with a toy kind).

| Verb / declaration | Layer | What it does |
|---|---|---|
| `propose(problem, draft)` | PLAN (pure) | the operator's trigger: commissions this kind wants, from durable signals (the draft plan, intel lenses) — never creep positions or vision |
| `materialize(commission, existing)` | EXECUTE | bind/update the runtime corp; MUST refresh `spawnId` on existing corps (conformance-enforced) |
| `run(corp, tick)` | EXECUTE | one dumb tick — the assignment has everything |
| `serializeCorp` / `deserializeCorp` | EXECUTE | persistence round-trip |
| `body(role, bodyParam, budget, hints)` | EXECUTE | the LIVE body path (SpawningCorp dispatches here; the old role switch is deleted, pinned by the body-equivalence sweep) |
| `roles: { role → {workType, readopt?, deliversEnergy?} }` | declaration | workType stamps, orphan-rescue registry, income-estimate participation |
| `demandGroup(corp, corpId, world)` | declaration (pure) | funding-group policy: which income UNIT a demand joins and whether it is started (harvest/carry share the source key; military/reservation force started — rationale lives in the kind files) |
| `sourceOf(corp)` | declaration | producer's source id — feeds `DemandWorld.isSourceMined` for ANY transport kind |
| `claimsOrphan(creep, corps)` | declaration | orphan re-adoption override (harvest: source underfoot; carry: assigned source); default = same-room corp of the creep's declared workType |

Generic plumbing that consumes the declarations (never a kind name):
`materializeCommissions`/`runCommissionedCorps` (dispatch),
`SpawnDirector.collectDemands` (ONE loop), `SpawningCorp.executeSpawn`
(body+workType via kind), `OrphanRescue` (census + declared roles),
`completeCensus` → telemetry/variance/stats/console.

**Id spaces (normative):** planner/commission ids are flow-prefixed
(`source-`/`spawn-` inside assignments); kinds strip prefixes at materialize.
Corp ids and creep `memory.corpId` are LEGACY-STABLE — renaming either
silently orphans live creeps (trap list). Lookups that cross id spaces must
normalize explicitly.

## 6. The two plans (GOAL and NOW)

- **GOAL plan** (`Memory.economyPlan`): `planColony`'s solver equilibrium —
  miners, haulers, sink allocations, the parts ledger. Not a schedule; a
  destination.
- **NOW plan** (`Memory.spawnAgenda`): the transition — the ordered
  acquisition sequence per spawn. Since spec 17 it is **prescriptive**:
  `planAcquisitions(demands, ctx)` (pure, `spawn/SpawnScheduler.ts`) runs ONE
  decision walk that yields both the published agenda (every demand ranked,
  annotated with its gate verdict: buy / no-miner / held / wall / passed /
  deferred / impossible / queued) and this tick's buy — which is by
  construction the agenda's `buy` entry. `SpawnDirector` executes it
  mechanically and files receipts. Agenda and action cannot disagree.

The spawn **doctrine** — tier ladder (income ≫ blocking ≫ started ≫ value),
starvation buckets, hold/wall semantics, miner precedence — is settled,
measured, and lives entirely in `SpawnScheduler` as one swappable pure module.
Tight assertions belong on actual-vs-NOW; NOW-vs-GOAL is a ramp gauge.

## 7. The Plan (GOAP output)

A **ColonyPlan** is a set of commissioned corps with sizes such that:

1. **Energy balance** — delivered energy ≥ consumed energy (sustainable).
2. **Spawn budget** — per spawn, Σ `spawnPartsFor(source)` ≤ `miningBudgetPerSpawn()`;
   consumers/infra charge the parts LEDGER (spec 15).
3. **Value maximised** — Σ (energy delivered × sink.value) − overhead maximised.

Sink values are the strict per-instance ladder (trap list — never nudge one
value in isolation): spawn 100 > new-spawn-site 85 > controller ≤80 (band
40–80 by downgrade pressure) > construction 70 > controller floor 40 >
storage 1. `DEFAULT_SINK_VALUE` (CorpPlanner) holds the defaults;
`perInstanceSinkValue` (flowAdapter) refines per instance.

## 8. Enforcement (the ontology is tested, not aspirational)

- **Conformance suite** (`test/unit/framework/conformance.ts`): every
  registered kind — determinism of propose, serialize round-trip, materialize
  idempotence + spawnId refresh, empty-world run safety, economics envelope.
- **Registration-only proof** (`test/unit/execution/registrationOnly.test.ts`
  + `test/unit/framework/newCorp.test.ts`): a toy kind flows through plan,
  dispatch, demands, orphan registry, census with zero core edits.
- **Behavior pins:** `collectDemandsPolicy.test.ts` (demand decoration),
  `bodyEquivalence.test.ts` (kind bodies vs the retired role switch),
  `nowPlanner.test.ts` (the walk vs its pre-refactor reference),
  `planEquivalence.test.ts` (golden-master commissions),
  `orphanAction.test.ts` (rescue map derivation).
- **The grid** (`npm run grid`, spec 08) is the outer acceptance bar.

## 9. Extension paths (declared, not yet implemented)

- **Typed resources** (minerals/labs/factory/market — on the roadmap): the
  Commission envelope's `consumes`/`produces` grow a `resource` field
  defaulting to energy; primitives stay energy-denominated until a second
  resource exists. New surfaces must not hard-code "energy" where
  "rate-at-place" is meant.
- **Mission-shaped commissions** (military campaigns): `shape: "mission"` with
  objective-typed assignments; raidGuard/coreBuster are the proto-missions.
- **Planner absorption** (the full-GOAP endpoint): an auxiliary kind migrates
  into `planColony` by expressing its `propose()` trigger as an operator
  precondition, its envelope as cost, and its output as effect. The declarative
  contract in §5 is already that shape.
- **Day-one goal direction** ([spec 18](specs/18-weighted-goals.md)): the
  bot is goal-directed from the first commit that lands the strategy layer -
  every plan is the output of goal + search, today's behavior is the DEFAULT
  goal profile (one point in goal space, not a legacy bypass), and the
  searcher's adoptions are gated by a strictly-beats-status-quo-net-of-
  transition-costs rule at the measured noise floor.
- **Strategy: goals + the supply-chain search** ([spec 18](specs/18-weighted-goals.md)):
  the objective becomes an input (goal profiles compiled onto the ladder,
  invariants preserved), and the supply-chain STRUCTURE becomes the searched
  decision — structural events (sources/sinks changing) trigger a
  transition-costed re-search; `planColony` is the millisecond evaluator and
  the NOW plan the transition executor. The grain is the NODE within one
  colony, never the room (rooms are engine constraint annotations); warfare
  is priced as economics — military operators are income-delta corps paid in
  the three currencies (spec 20).
- **The delivery contract** ([spec 19](specs/19-delivery-contract.md)):
  spawning delivers newborns to each corp's DECLARED delivery location
  (miners: the mining post; scouts: self-deploying), so work functions
  degenerate toward their primitive (`harvest(source)`) and travel logic
  leaves the work corps. Creeps-as-cargo (pull convoys, zero-MOVE workers) is
  the deferred end state behind the same handover seam.
- **The accounting boundary** ([spec 20](specs/20-corp-accounting.md)):
  everything the bot does trends toward "a corp running", so every resource -
  energy, spawn build-time, and CPU - is attributable per corp and pullable.
  The dispatch meters every `kind.run` (clock injected; the dispatch stays
  pure); the un-attributed remainder is the named infrastructure residual,
  reconciled against the whole tick so nothing hides. Towers/links/bootstrap/
  spawning migrate into kinds under this spec.
- **Known coupling debt:** the RoomMemory regime flags
  (`extensionTenderActive`, `controllerFeederActive`, `dedicatedBuildSourceId`)
  couple mover kinds to CarryCorp/UpgradingCorp branches — the next
  cross-kind protocol to make declarative (spec 17 backlog).

## 10. History (systems collapsed into this model)

The economy once ran two solvers plus market/chain/priority layers. Collapsed
(2026-07, specs 00/04/17): `FlowSolver`, `EconomyPlanner`/`EconomyAdapter`,
`FlowMaterializer`, the market/offer/contract layer, the chain/ROI valuation
layer (`ChainEvaluator`/`ColonyEconomy`), per-corp money accounting,
`framework/FlowEdge`, the EdgeVariant variant search, the per-kind plumbing
mirrors (SpawnDirector blocks, OrphanRescue lists, SpawningCorp's role switch,
telemetry bucket maps), and the duplicate formula call-sites. The
`FlowGraph`/`FlowSolution` shapes survive only as the world-translation layer
and the legacy telemetry DTO. The spec 17 P5 sweep (2026-07-20) deleted the
residuals: PriorityManager's second ladder, NodeFlow, FlowEconomy's dead
query API, the survey/market vestiges and the always-empty `Node.corps` web,
the NodeSurveyor ROI estimators, EdgeVariant beyond the body vocabulary, and
the broken `plan:budget` script.
