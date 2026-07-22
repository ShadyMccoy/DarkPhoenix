# 20 — Corp resource accounting: everything the bot does is a corp running

**Status:** phases 1-2 LANDED 2026-07-20 (per-corp CPU metering at the
dispatch seam; named infrastructure buckets via the bulkhead wrapper +
whole-tick reconciliation anchor on Memory.corpCpu); phase 3 (migrate
towers/links/bootstrap/spawning to kinds) is the remaining program.
**Priority:** P1 — the runtime half of spec 15 (waste ledger), organized by
corp. **Depends on:** spec 17 (pure dispatch, registration-only kinds).

## The thesis (owner, 2026-07-20)

> Pretty much everything the bot does should be the corp running. So we can
> track their resource usage including CPU.

The corp is already the planning operator and the creep owner (ONTOLOGY §4);
this spec makes it the **accounting boundary**. Three metered currencies:

| Resource | Where it is tracked | Status |
|---|---|---|
| Energy | commission envelope (`consumes`/`produces`), variance meter | live (spec 17 P4 made consume envelopes truthful) |
| Spawn build-time | commission `spawnPartsPerTick` + the parts ledger | live |
| **CPU** | **per-corp metering at the dispatch seam → `Memory.corpCpu`** | **phase 1 landed** |

## Phase 1 (landed): the metering seam

`runCommissionedCorps(store, tick, meter?)` times every `kind.run(corp)` and
attributes it to (kind, corpId). The dispatch lives in the PURE layer and
never reads Game, so the **clock is injected**: the host passes
`Game.cpu.getUsed`, tests pass a fake (`corpCpuMeter.test.ts`). The host
publishes `Memory.corpCpu` every tick — per-kind totals, `corpsTotal`, and
the top per-corp rows by ~100-tick EMA — pullable through the telemetry API
exactly like `corpVariance`.

**The reconciliation invariant** (same discipline as the creep census's
tracked + untracked = total): `corpsTotal` vs the loop's whole-tick CPU
exposes the *infrastructure residual* — everything not yet attributable to a
corp. The program below shrinks that residual; it can never silently grow
unnoticed because the ledger publishes both sides.

## Phase 2: name the residual

Meter the main-loop's non-corp work into named infrastructure buckets
(`solve`, `spatial`, `host`, `spawnDirector`, `orphanRescue`, `telemetry`,
`persistence`, `links`, `towers`, `visuals`) published beside `corpsTotal`.
No behavior change — this is the map of what phase 3 migrates.

## Phase 3: migrate the migratable

In descending order of "is naturally a corp":

1. **TowerRunner → tower kind** (spec 07 said so): consumes energy at the
   tower, produces defense value; its CPU and energy join the ledger.
2. **LinkRunner → link-transport kind** (spec 02 said so): the framework's
   first structure-only transport corp.
3. **BootstrapCorp, SpawningCorp → registered kinds**: dissolves the last
   legacy-registry exception (`completeCensus` collapses into
   `allCommissionedCorps`).
4. **OrphanRescue as the rescue kind?** Judgement call — it is a colony-wide
   safety net, not an economic unit. Default: it stays infrastructure with a
   named bucket. Revisit only if a real consumer needs it corp-shaped.

NOT corps, ever (the "state", not the market): the planner solve, the host
loop itself, telemetry, spatial analysis, persistence. They stay named
buckets — visible, budgeted by the CPU governor, but not commissions.

## Acceptance tests

1. **Metering (landed):** the dispatch records one (kind, corpId, cpu) row
   per run with exact injected-clock deltas; the unmetered path is untouched.
2. **Reconciliation (phase 2):** corpsTotal + Σ infrastructure buckets ≈
   whole-tick CPU within a small tolerance, asserted in an integration probe.
3. **Migration (phase 3, per item):** the migrated kind passes conformance +
 the registration-only proof; its bucket disappears from the residual and
   its CPU appears under its kind; the full regression gate stays green.
4. **Governor coupling:** the CPU governor's degradation decisions can cite
   the ledger (which kinds are expensive) — but per the audit doctrine, the
   ledger never FEEDS BACK automatically; it informs the operator and specs.

## Non-goals

- No automatic throttling of expensive corps (audit stays passive; the CPU
  governor's existing coarse modes remain the only runtime response).
- No per-creep attribution (corp granularity is the accounting boundary;
  creep-level breakdowns are a diag-probe concern).
