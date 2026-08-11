# Corps System (current reference)

> The market/offer/contract design this document once described is deleted.
> A **corp** today is a *commission*: a unit of economic activity that
> consumes spawn build-time (± energy) and produces energy-at-a-place or
> colony value. See [ONTOLOGY.md](ONTOLOGY.md) §4 and
> [PIPELINE.md](PIPELINE.md) hops 5-7 for the full contract.

## Lifecycle

`propose → materialize → run → serialize` via each corp's `CorpKind`
(`src/corps/kinds/`), hosted by `execution/CommissionHost.ts` and persisted
under `Memory.commissionedCorps`. Solver-backed kinds (harvest/carry/upgrade)
receive their commissions from the planner; auxiliary kinds propose their own
when preconditions hold. Run order: produce (10) → transport (20) →
consume (30: upgrade + construction) → auxiliary (40: scout, reservation,
raidGuard, coreBuster, tender; controllerFeeder 41; claim 45).

## Live corps

| Corp | Kind | Shape | Notes |
|------|------|-------|-------|
| HarvestCorp | `harvest` | produce | static miners; runt-recycle upsizing; remote vision walk |
| CarryCorp | `carry` | transport | one corp per source, aggregating its routes; paved 2:1 bodies |
| UpgradingCorp | `upgrade` | consume | sized from the plan's controller allocation — ONE VALVE (owner 2026-08-02; see CLAUDE.md) |
| ConstructionCorp | `construction` | hybrid | proposes per owned room (container maintenance) + reads solver build commissions |
| ExtensionTenderCorp | `tender` | auxiliary | depot→spawn/extensions local mover; SLA fleet = max(clusters, coverage) |
| LinkCorp | `controllerFeeder` | auxiliary | link network: bank→controller relay + hub/port drains (kind string frozen — trap list) |
| ScoutCorp | `scout` | auxiliary | BFS intel, hostile stamps (`roomIntel.hostileUntil` / `.invaderReservedUntil`) |
| ReservationCorp | `reservation` | auxiliary | remote reservers (holdToFund) |
| RaidGuardCorp | `raidGuard` | auxiliary (military) | protects remote producers from invader raids |
| CoreBusterCorp | `coreBuster` | auxiliary (military) | reclaims invader-core-occupied remotes |
| ClaimCorp | `claim` | auxiliary | capital-gated expansion claiming (spec 06) |
| SpawningCorp | — | infrastructure | executes spawn decisions through the spawn contract; registry-hosted |
| BootstrapCorp | — | infrastructure | cold-start jacks + anti-downgrade rescue; registry-hosted |

## Spawn demand

Every corp exposes its spawn demand → `SpawnDirector.collectDemands`
(ONE generic loop; the kind's `demandGroup` groups a source's miner + haulers
into one income unit) → the pure NOW planner `SpawnScheduler.planAcquisitions`
(income ≫ blocking ≫ started tiers; one decision walk that yields the
published agenda AND the buy). The **delivery contract** (`staffsPost`,
`economy/primitives.ts`) makes replacement demand surface one lead time
early, so posts hand off gaplessly — and every consumer of "how many creeps
does this post have" must use that same lens (see CLAUDE.md trap list).
The physical spawn call is the corp spawn contract's one site
(`corps/spawnContract.ts`; naked `spawn.spawnCreep` throws — ONTOLOGY §8).
