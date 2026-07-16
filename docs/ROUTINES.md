# Corps System (current reference)

> The market/offer/contract design this document once described is deleted.
> A **corp** today is a *commission*: a unit of economic activity that
> consumes spawn build-time (± energy) and produces energy-at-a-place or
> colony value. See [ONTOLOGY.md](ONTOLOGY.md) §3 and
> [PIPELINE.md](PIPELINE.md) hops 5-7 for the full contract.

## Lifecycle

`propose → materialize → run → serialize` via each corp's `CorpKind`
(`src/corps/kinds/`), hosted by `execution/CommissionHost.ts` and persisted
under `Memory.commissionedCorps`. Solver-backed kinds (harvest/carry/upgrade)
receive their commissions from the planner; auxiliary kinds propose their own
when preconditions hold. Run order: produce (10) → transport (20) →
consume (30) → auxiliary (40).

## Live corps

| Corp | Kind | Shape | Notes |
|------|------|-------|-------|
| HarvestCorp | `harvest` | produce | static miners; runt-recycle upsizing; remote vision walk |
| CarryCorp | `carry` | transport | one corp per source, aggregating its routes; paved 2:1 bodies |
| UpgradingCorp | `upgrade` | consume | sized from actual controller-side stock |
| ConstructionCorp | `construction` | hybrid | proposes per owned room (container maintenance) + reads solver build commissions |
| ExtensionTenderCorp | `extensionTender` | auxiliary | depot→spawn/extensions local mover; SLA fleet = max(clusters, coverage) |
| ControllerFeederCorp | `controllerFeeder` | auxiliary | storage→controller-input relay once a bank exists |
| ScoutCorp | `scout` | auxiliary | BFS intel, hostile stamps (`roomIntel.hostileUntil` / `.invaderReservedUntil`) |
| ReservationCorp | `reservation` | auxiliary | remote reservers (value 115, holdToFund) |
| ClaimCorp | `claim` | auxiliary | capital-gated expansion claiming (spec 06) |
| SpawningCorp | — | infrastructure | spawn queue execution; still registry-hosted |
| BootstrapCorp | — | infrastructure | cold-start jacks + anti-downgrade rescue; registry-hosted |

## Spawn demand

Every corp exposes `getSpawnDemand()` → `SpawnDirector.collectDemands`
(grouping a source's miner + haulers into one income unit) → the pure
`SpawnScheduler.scheduleSpawn` (income ≫ blocking ≫ started tiers; breadth
before depth). The **delivery contract** (`staffsPost`,
`economy/primitives.ts`) makes replacement demand surface one lead time
early, so posts hand off gaplessly — and every consumer of "how many creeps
does this post have" must use that same lens (see CLAUDE.md trap list).
