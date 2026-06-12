# 04 — Retire the chain/market layer (last ONTOLOGY § 6 row)

**Status:** not started. The final "systems being collapsed" row. NOTE: this
layer is **not dead code** — earlier assumptions that it could simply be
deleted were wrong.
**Priority:** P1 (it blocks trusting "one economy authority" end-to-end).

## Current reality (verified call-sites)

The market-era valuation layer is live in exactly these places:

| Consumer | Uses | Purpose |
|----------|------|---------|
| `execution/IncrementalAnalysis.ts:23,432` | `marginalNodeValue` (`planning/ColonyEconomy.ts`) | scores a candidate node's marginal colony value (with cannibalization) during terrain analysis → node ROI |
| `nodes/NodeSurveyor.ts`, `planning/SpawnPlacement.ts`, `scripts/probe-spawn-placement.ts` | `evaluateSpawnChain` (`corps/ChainEvaluator.ts`) | scores a spawn site by standing up the corps it would run |
| `corps/*.project(scene)` (`Corp`, `HarvestCorp`, `CarryCorp`, `UpgradingCorp`) | `ChainScene`/`CorpEconomics` (`corps/economics.ts`) | hypothetical corp economics feeding ChainEvaluator |

So "retiring" means **re-basing node/spawn-site valuation on the CorpPlanner**,
then deleting the old layer — not deletion first.

## Design

`ChainEvaluator.evaluateSpawnChain(scene)` answers: "if a spawn stood HERE,
what value-rate would the colony around it produce?" `planColony` answers
exactly that, purely, from a `ColonyProblem`. Replace the chain machinery with
a thin builder:

```ts
// economy/siteValue.ts
export function spawnSiteValue(
  spawnPos: Position,
  sources: Array<{ id: string; pos: Position; rate: number; maxMiners: number }>,
  controllerPos: Position | null,
  dist: (a: Position, b: Position) => number
): number; // = planColony(problem).valueDelivered - totalOverhead
```

- `marginalNodeValue(existing, candidate, sources)` becomes
  `spawnSiteValue(with candidate) - spawnSiteValue(without)` over the combined
  source set — same cannibalization semantics (a source already served by an
  existing node contributes to both solves and nets out).
- `SpawnPlacement` / `NodeSurveyor` swap `evaluateSpawnChain` for
  `spawnSiteValue`.
- `corps/*.project()` and `ChainScene` survive only if something else needs
  them after the swap — audit then delete `ChainEvaluator`,
  `ColonyEconomy`, the `effectiveNet`/`SPAWN_PART_ENERGY_VALUE` family in
  `corps/economics.ts` (keep `travelTicksPerTile`, used by live corps), and
  their tests.

Numbers WILL shift (the old layer has its own formulas — that's the point).
Expected churn: node ROI ordering and spawn-placement picks in
`Memory.spawnPlacements`.

## Acceptance tests

### Unit (new): `test/unit/economy/siteValue.test.ts`

1. **Monotonic in distance:** same one-source world, spawn at distance 10 vs
   40 from the source → `value(10) > value(40)`, both > 0.
2. **Unprofitable nets zero:** a source at distance 320 (beyond the
   `netEnergy <= 0` cutoff) → `spawnSiteValue === 0` exactly (no miners
   commissioned ⇒ nothing delivered).
3. **Cannibalization:** candidate node whose only source is already served by
   an existing node → marginal value `closeTo(0, 1e-6)`; with one NEW source
   added, marginal value `> 0` and `closeTo(value of the new source alone,
   5%)`. (Port the two pins from `test/unit/planning/ColonyEconomy.test.ts`,
   re-deriving the expected numbers from primitives — do NOT carry the old
   layer's constants over.)

### Unit (port): `test/unit/planning/SpawnPlacement.test.ts`

Keep every behavioral pin (best-tile selection ordering), updated to the new
scorer. Pass = the *ordering* assertions hold; absolute scores may change and
should be re-pinned, each with a one-line derivation comment.

### Deletion gate (the "tight" part)

Done means ALL of:

1. `grep -r "ChainEvaluator\|ColonyEconomy\|marginalNodeValue\|evaluateSpawnChain" src/`
   returns **zero** hits.
2. `planning/ColonyEconomy.ts`, `corps/ChainEvaluator.ts` and their test files
   are deleted (not orphaned).
3. Unit suite green; `flow-handoff` + `world-layout` integration green
   (world-layout exercises multi-room node scoring).
4. `docs/ONTOLOGY.md` § 6 row updated to ✅ DELETED with the replacement named.

## Risks

- Spawn placement picks may shift on live colonies; `Memory.spawnPlacements`
  is regenerated on the planning cadence, so no migration needed — but eyeball
  one `sim:scenario` run before/after.
- `scripts/probe-spawn-placement.ts` must be ported or deleted in the same
  change (no broken scripts left behind, per the compare-efficiency.ts lesson).
