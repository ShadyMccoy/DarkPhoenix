# Spec 64 — The test estate: inventory, initial review, and the cull list

**Status: BACKLOG (review COMPLETE 2026-08-11; cull awaiting owner ruling).**
The owner's ask (verbatim, 2026-08-11): *"Review our unit and scenario tests.
I wonder how many are useful and if any should be culled. Create an inventory
and perform an initial reviews on candidates and document your findings in a
new backlog spec."*

This spec is that deliverable: the complete inventory (appendix), the review
method, per-candidate findings with `file:line` evidence, and the cull program
as phased work with acceptance criteria. **Nothing was deleted in the review
session** — tests are this repo's contract layer (specs README: "a task is
DONE exactly when its listed tests pass"), so removals are owner-ruled work
items, not review side-effects.

## The headline

**The estate is healthy.** Of 236 mocha test files (2,595 passing / 19
pending, ~22s for the whole unit suite), the review sustains a cull case
against **4 test files, 2 never-run relic scripts, 1 relic library, and 3
orphaned fixtures** — about 1,100 LOC of test code plus ~195KB of fixture
JSON — and a **trim** case against fake-coverage blocks inside 4 more. Every
other suspicion the review chased (retired-mechanism pins, duplicate seams,
unplugged meters, over-mocked tests, "legacy" SpawnScheduler) came back
NEGATIVE with evidence. The suite's size is earned: the big files map 1:1 to
incident history, and the apparent duplicates are deliberate layerings this
spec documents (§4) so future reviews stop re-litigating them.

The review also surfaced six **product/process gaps** that tests exposed but
cannot fix (§5) — an unplugged instrument read-path, a conformance-enrollment
hole, a stale conformance fixture that quietly stopped checking live
economics, a doc drift about which integration tests form the gate, an
untested CPU accumulator, and a fresh-clone trap that now bites the unit
suite too.

## 1. Suite shape (measured 2026-08-11, this branch)

| tier | files | tests (static `it(`) | LOC | runs via |
|---|---|---|---|---|
| unit (`test/unit/`) | 224 | 2,438 | 45,147 | `npm run test-unit`, ~22s mocha |
| integration (`test/integration/`) | 12 | 18 | 1,464 | one file at a time, minutes each |
| grid cells (`test/grid/cells/`) | 19 cell files (~130 cells) | — | — | `npm run grid` — the ratchet, **out of cull scope** |
| never-run relics (`test/*.js`) | 2 (+1 lib) | 15 | 706 | **nothing** — no glob matches them |

Runtime test count (2,595) exceeds the static count because
`describeCorpKindConformance` and shared behavior suites generate tests.
19 pending = the deliberate `it.skip` idiom (fixture-gated tests whose
fixtures ARE present run for real; the skips are aspirational seams in
`organismScenario`/`corpBudget` plus `clusterROI`'s stubs — see §4.2).

Per-directory rollup:

| dir | files | tests | LOC | | dir | files | tests | LOC |
|---|---|---|---|---|---|---|---|---|
| corps | 77 | 791 | 14,419 | | spawn | 11 | 117 | 2,141 |
| economy | 47 | 643 | 10,539 | | harness | 4 | 23 | 319 |
| telemetry | 23 | 190 | 3,430 | | spatial | 6 | 87 | 2,326 |
| framework | 20 | 111 | 3,596 | | audit | 4 | 209 | 3,584 |
| execution | 17 | 154 | 2,584 | | others | 15 | 113 | 2,209 |

## 2. Method (and its epistemics)

Five parallel review sweeps covered every file: (a) spatial/planning/nodes/
flow/sim, (b) integration + test tooling + harnesses, (c) spawn + corps
behavior clusters, (d) telemetry + audit, (e) economy + framework + execution.
Each file got: what it pins; whether the mechanism is live (traced by READING
the src call chain, never by grep-absence — CLAUDE.md's two "the instrument
is missing" incidents were both grep-absence claims, and this review nearly
minted a third: `raidMeterState` has zero external callers by grep but is
consumed INTERNALLY by `guardTargetsFor` ← `RaidGuardCorp.ts:82`); overlap
against neighbors and grid cells; and a verdict. Claims that drive deletions
were then independently re-verified in a second pass (docstrings, glob
behavior, referrer greps, fixture usage, the stale-fixture diff).

Cullable classes used: **(A)** never runs, **(B)** asserts nothing in src,
**(C)** superseded by a grid cell and not in the regression gate, **(D)**
fake-coverage blocks inside otherwise-live files, **(E)** stale fixture that
no longer checks the live contract, **(F)** small dead residue (unused
imports, duplicated asserts, one redundant scenario).

## 3. The cull list (owner ruling requested)

### Phase A — zero-risk deletions (class A + B). ~1,300 LOC + 195KB.

Nothing here is executed by any npm script, imported by any live test, or
referenced by any doc. Deleting it cannot change a single test result:

- `test/economic-analysis.test.js` (154 LOC) + `test/lib/economic-analysis.js`
  (237 LOC) + `test/find-best-node.js` (315 LOC, a SCRIPT not a test) +
  `test/fixtures/econ-network.json` (96KB). Pre-corp-planner relics of the
  retired chain-layer economics (spec 04 deleted the src side); they test a
  standalone lib under `test/lib/`, import zero src modules, and **no mocha
  glob has ever matched them** (`test-unit` = `test/unit/**/*.ts`,
  `test-integration` = `test/integration/**/*.test.ts`). All three arrived in
  the repo-rooting commit and were never touched again.
- `test/unit/planning/clusterROI.test.ts` (113 LOC) +
  `test/fixtures/node-network-snapshot.json` (99KB). A design sketch dressed
  as a test: its header frames a Problem/Solution proposal, its only 2 live
  tests assert properties of the static fixture (loaded at `:23`) using graph
  code defined inside the test file, and lines 72–99 are ~16 empty `it.skip`
  stubs. **Zero `src/` imports.** The fixture has no other referrer. If
  cluster-ROI planning is ever built, spec 18's structure search is where it
  lives now — the sketch's ideas are already superseded there.
- `test/unit/spatial/roomMap1.test.ts` (155 LOC) + `test/sim/roomMap1.txt`.
  Docstring: *"Test to investigate why roomMap1.txt produces no peaks"* — a
  debugging investigation, console.log-driven, whose generic assertions
  (`greaterThan(0)`) duplicate `peakDetection.test.ts` basic coverage on a
  fixture nothing else uses. Optional: fold ONE precise regression pin into
  `peakDetection.test.ts` if the historical zero-peaks bug deserves a guard.

### Phase B — integration-tier rationalization (class C). 123 LOC deleted, 2 reclassified.

The grid (spec 08) superseded the pre-grid integration tests selectively; the
gate trio (`flow-handoff`, `runt-economy`, `storage-depot`) plus the two
gap-fillers (`remote-mining`, `tower-defense`, see §4.6) stay untouched.

- **`test/integration/bootstrap.test.ts` — verdict FLIPPED to KEEP by #168
  (post-review drift, §6).** The review's original finding stands for its
  viability assertions: it boots a degenerate ALL-PLAIN 50×50 room — the
  exact terrain `docs/TESTING_THE_ECONOMY.md` warns produces zero nodes —
  strictly dominated by `test/grid/cells/resilience.ts`'s real-terrain
  cold-start ladder. But #168 (spec 60 phase A, merged mid-review) repurposed
  the file as its acceptance vehicle: cold-start jack purchases must land in
  BOTH the spawn ledger and the forensic BlackBox ring — population-parity
  coverage no grid cell has. If that assertion later moves into a resilience
  cell, the cull re-opens.
- **CULL `test/integration/integration.test.ts`** (25 LOC): asserts the
  mockup server ticks and Memory round-trips — harness liveness, which
  `npm run probe:mockup` (the documented sandbox smoke check, CLAUDE.md) and
  every other integration file's shared `helper.ts` already prove.
- **CULL `test/integration/two-source-economy.test.ts`** (98 LOC): its single
  assertion (both sources eventually mined) is strictly weaker than grid
  `plan-t2-asymmetric-both-staffed` (`planner.ts:117`) and the many T1–T4
  cells staged on the identical `twoSourceRoom` geometry
  (`construction.ts:168`). Zero references anywhere.
- **ARCHIVE `test/integration/scenario-economy.test.ts`** (103 LOC): overlaps
  the same grid cells, BUT `docs/TESTING_THE_ECONOMY.md:107-111` still names
  it as one of its three canonical integration probes — a **doc drift**
  against CLAUDE.md's actual gate trio (`storage-depot`, not
  `scenario-economy`) that must be reconciled in the same commit. Its one
  non-grid-covered assertion (hauler production per geometry) can move into a
  cell if wanted.
- **ARCHIVE `test/integration/world-layout.test.ts`** (143 LOC): spec 06's own
  text moved acceptance to the T5 grid cells; the two `loadLayout` helpers it
  pins (`terrainMatrixFromPattern`, `layoutFromNodeFixture`) have **zero other
  callers repo-wide** (the grid's `fixtureRoom.ts` loads fixtures its own
  way) — deleting the test makes those helpers dead-code candidates too.
- **RECLASSIFY `test/integration/game-physics.test.ts`** (341 LOC): pins
  ENGINE facts (road wear = body.length and load-independent; swamp
  empty/loaded speeds; border-crossing mirror geometry) via a hand-written
  micro-bot that **never loads `dist/main.js`** — it cannot regress from any
  bot change, so it does not belong in a live-behavior regression tier. It IS
  the sole empirical proof of constants `roadEconomics.ts` builds on. Keep
  the file; document it as the **engine-fidelity pin**, run on
  `screeps-server-mockup`/`@screeps/engine` version bumps only.

"ARCHIVE" here means: keep the file runnable, drop it from routine
gate/documentation status, and say so in `TESTING_THE_ECONOMY.md` — or, if
the owner prefers a smaller estate over an attic, CULL both archives after
folding the two named uncovered assertions into cells. The review's own lean
is **cull after folding**: an attic that nothing runs rots into exactly the
class-A relics phase A is deleting.

### Phase C — trims, merges, and the stale fixture (classes D/E/F). No behavior change.

**D — fake-coverage blocks (the review's most interesting test-quality
finding).** Three of the six spatial files define LOCAL reimplementations of
the algorithm inside the test file and route whole describe blocks through
them — those blocks pass even if `src/spatial/algorithms.ts` is broken:

- `distanceTransform.test.ts`: delete `"small room patterns"` (:174, its own
  comment says *"local implementation"*) and `"edge cases"` (:309 — lines
  310–328 set grid values in a loop then assert them back, calling no
  function at all). Keep :29–173 and :403–434 (real).
- `peakDetection.test.ts`: local `analyzeSmallTerrain` at :28; delete the
  fake blocks (:193–209, :228–261 — one `it` has zero `expect` calls —
  :263–295, :297–345). Keep `"basic behavior"` and ALL of `filterPeaks`
  (:348–488) — sole owner of the exclusion-radius contract.
- `territoryDivision.test.ts`: local `analyzeTerritory` at :29 used at
  :265/:292/:397; delete those blocks, keep the rest.
- `multiRoomTerritory.test.ts`: one vacuous `it` (:337–385) conditionally
  logs "BUG CONFIRMED" and asserts nothing — delete or give it a real
  expect. The rest is the highest-value spatial file (sole cross-room
  coverage).

**E — the stale conformance fixture (do this one FIRST; it is a live hole,
not housekeeping).** `test/unit/framework/claimKind.test.ts:35` hand-authors
its commission with `consumes: { spawnPartsPerTick: 0 }` and checks
`expectedSpawnPartsPerTick: 0` — against its own fixture. Spec 06's 2026-08-11
work moved the claimer ON budget (`src/corps/kinds/claimKind.ts:51` now prices
`claimerSpawnLoad()` ≈ 0.0033), so the conformance suite no longer proves
claimKind's live commission derives from primitives; it compares a stale zero
with itself. Fix like `coreBusterKind.test.ts:58` does: derive the commission
from `claimKind.propose(...)[0]` and expect `claimerSpawnLoad()`. Same
pattern-audit for `carryKind.test.ts:61` (hand-authored, currently accurate —
converting it to propose-derived makes drift impossible).

**F — residue.**
- `upgraderTargetCount.test.ts` imports `bankBehindFeeder`,
  `CONTROLLER_STARVE_FLOOR`, `sustainableConsumptionRate` and uses none of
  them (each appears only in the import line) — residue of the file's
  pre-ONE-VALVE version. Drop the imports; the file itself is a keeper (it
  asserts the retired valve's ABSENCE).
- `execution/spawnReceipt.test.ts:62,68` re-assert two `declaredStandingParts`
  cases pinned (with more cases) in `economy/replacementSchedule.test.ts:27,32`.
  Drop the two lines, keep the file's unique receipt-ratio scenarios.
- `corps/reserverEconomics.test.ts` (13 LOC, one assert:
  `RESERVER_BODY_COST === 650`) — a pure `economy/primitives` constant test
  filed under corps/. MERGE into `economy/primitives.test.ts` beside its
  sibling reserver-economics block (~:165).
- `integration/corp-cop.test.ts`: its own docstring calls `remoteSource` "the
  load-bearing case"; the `twoSourceRcl3` case adds little over the heavy
  existing coverage of that geometry. Optional trim to one case (halves its
  runtime); the file stays — CorpCop is wired into ZERO grid cells today
  (spec 09 phases 2–3 open), so this is the only automated exerciser.

### Acceptance (each phase independently)

- `npm run test-unit` green; count drops by exactly the deleted tests.
- Gate trio green (`flow-handoff`, `runt-economy`, `storage-depot`).
- `npm run grid` baseline **byte-identical** — no cell claims change (phase A
  and C touch nothing any cell stages; phase B deletes only un-gated,
  un-referenced integration files).
- `test/unit/docs/specNumbers.test.ts` green (this spec's links resolve).
- Phase B additionally: `TESTING_THE_ECONOMY.md` names the SAME trio as
  CLAUDE.md, and names `game-physics` as the engine-bump pin.

## 4. What the review CLEARED (so it isn't re-litigated)

Every suspicion below was chased to evidence and came back negative. The next
"should we cull X?" session starts from here:

1. **No test pins a retired mechanism.** The three files that name retired
   mechanisms most loudly — `feederRelayTarget.test.ts` (:63 "ONE law, no
   regime branch"), `upgraderTargetCount.test.ts`, `upgraderRelegation.test.ts`
   (:41 "a fat bank does NOT re-open the throttle, which is exactly what the
   removed valve did") — were rewritten AT retirement time to assert the old
   formula's ABSENCE. They are the guards that make a silent revert fail, i.e.
   the most valuable tests in their cluster. Culling by grep-hit on
   "feederBodyRate"/"surplus regime" would delete exactly the wrong files.
2. **`SpawnScheduler.test.ts` (847 LOC) is not pre-two-plans legacy.**
   `scheduleSpawn` IS `walkDemands` (`SpawnScheduler.ts:695`), the same walk
   `planAcquisitions` (the only director entry) runs; `nowPlanner.test.ts`
   proves them bit-identical over 600 randomized cases against a frozen
   reference. Corps import only TYPES from the module.
3. **The telemetry tier is fully wired.** All 23 telemetry + 4 audit files
   trace write→export→read into live call chains; `wasteLedger.test.ts`'s
   185 tests reference only row ids the script still computes (P10, the one
   retired row, is absent from both sides). The apparent pairs are deliberate
   two-layer designs whose docblocks cite the specific bug the other layer
   cannot catch (spawnLedger/spawnMeter; lossMeter/lossesPublish).
4. **Same-name files are not duplicates.** `economy/planCadence.test.ts`
   (PLAN_BUDGET_INTERVAL=1500, spec 46) vs `framework/planCadence.test.ts`
   (Corp.PLANNING_INTERVAL=100, spec 35-D) — two constants, two layers; a
   third unrelated `PLANNING_INTERVAL=5000` lives in `orchestration/Phases.ts`.
   Rename candidates, not culls. Likewise the four `road*` test files map 1:1
   to four disjoint src modules (zero export collisions), the movement trio
   (`movement`/`bypass`/`stepOffRoad`) partitions one src file with zero
   tested-function overlap, `workSpot` vs `scavengePickup` split `workSpot()`
   by branch, and the four link-seam files test four disjoint modules.
5. **Cross-file re-derivations are the shared-lens discipline, not
   redundancy** (`buildPoolAbsorb` vs `builderSizing`'s wartime case, etc.) —
   two readers of one formula asserted from both ends is the exact defense
   the staffsPost/two-readers incident class demands.
6. **Integration gap-fillers earn their slot**: `remote-mining.test.ts` is
   the ONLY organic scout→claim→mine→reserve run left — the grid's
   `plan-t5-remote-pipeline` deliberately STAGES those preconditions
   (`multiroom.ts:330` records the owner-approved conversion), so the organic
   chain has no other proof. `tower-defense.test.ts` is the only tower-COMBAT
   exercise in the repo (grid tower cells are placement/repair/fill only) and
   spec 07 names it as acceptance.
7. **Harness/fixture layer all live**: the three fleet-harness tests are the
   documented altitude-1 layer (`TESTING_THE_ECONOMY.md:80`),
   `screepsConstants.test.ts` pins the mock against real engine values after
   two real silent-failure incidents, `grid/judge+pack` test the success
   metric's own machinery, `RoomBuilder` backs every scenario and cell.
   `spatial/spawnPlacement.test.ts` and `sim/extensionSim.test.ts` test
   TOOL-ONLY code (`sim:real`/`fixtures:index`/`lab`, `scripts/extension-sim`)
   that is alive in scripts — worth a comment or directory hint marking them
   tool-tier, not culls (`src/spatial/spawnPlacement.ts`'s docstring already
   forbids wiring it into the live founding path).
8. **No over-mocked pass-anything tests found** in the corps/spawn sweep: the
   heavily-mocked files mock peripherals (Game/Memory/Room) while the subject
   under test is always the real corp code.

## 5. Product gaps the review surfaced (backlog items, NOT test defects)

1. **`dutyHistogram`'s read half is unplugged** (spec 40-B's own point).
   Write side is live — `recordDutyTick` accumulates per-tick duty into
   `Memory.upgradeMeter[room].hist` on every upgrade attempt
   (`UpgradingCorp.ts:65`) — but `dutyPercentile`/`dutyBimodal` have ZERO
   callers outside the module and its test. The waste ledger's X1 row still
   reads `workUtil`, the plain mean the histogram was built to distrust
   ("a mean over bimodal data lies"). Either wire the percentile/bimodal
   verdict into X1 (finishing 40-B) or retire the read half and its 3 tests;
   today the histogram is written every tick and read by nothing.
2. **`linkKind` is not enrolled in `describeCorpKindConformance`** — the one
   concrete violation of the spec-17 "enroll every kind" rule found. It is a
   registered production kind (`CommissionHost.ts:70`) exercised only
   piecemeal. Add `framework/linkKind.test.ts` with the standard enrollment.
3. **The conformance suite checks fixtures, not `propose()` output, for
   hand-authored commissions** — the mechanism behind the claimKind hole
   (§3-E). Consider a conformance-level rule: commissions passed to
   `describeCorpKindConformance` should be derived from `kind.propose()`
   where a problem fixture exists, so economics drift cannot go quiet again.
4. **Doc drift**: `TESTING_THE_ECONOMY.md:107` names
   flow-handoff/scenario-economy/runt-economy as the integration probes;
   CLAUDE.md's gate is flow-handoff/runt-economy/storage-depot. One of them
   is wrong about what the project actually runs — reconcile (phase B).
5. **`corpCpuMeter()` (the per-corp CPU accumulator closure,
   `CommissionHost.ts:285`) has no dedicated unit test** — exercised only
   incidentally. Small, but it feeds `Memory.corpCpu`, which spec 51 already
   found reading null in captures.
6. **Fresh-clone trap, now measured for the UNIT suite too**: `test/unit/grid/
   pack.test.ts` → `test/grid/pack.ts:21` → `integration/loadLayout` →
   mockup driver → `isolated-vm`, so a fresh clone that skipped
   `setup:test-env` fails `test-unit` AT LOAD with the native-build error.
   CLAUDE.md mandates the setup script "before any grid/integration run" —
   in practice it is required before ANY suite run on a fresh sandbox.

## 6. Review limits — and the mid-review drift (#168)

The review swept the tree at `d2497fd`; commit #168 (spec 60 phases A+B+C-cop)
merged onto master DURING the review and touched 12 test files. All numbers in
this spec are updated to the merged tree. Material effects: `bootstrap.test.ts`
repurposed as spec 60-A acceptance (verdict flipped, §3-B);
`test/unit/framework/legacyBoundary.test.ts` is NEW (97 LOC — it IS spec 60's
C-cop, shrink-only boundary pin: KEEP); `describeCorpKindConformance` grew the
account-declaration probe (spec 60-B) — which does NOT close the claimKind
stale-fixture hole in §3-E (the fixture-vs-propose() mechanism is untouched).


- Grid cells and `baseline.json` were treated as out of scope (the ratchet is
  the success metric, spec 08 owns its own hygiene).
- Fixtures were audited only for orphanhood (two found, both phase A);
  `test/fixtures/real-rooms/`, `journey/`, `telemetry/` are all referenced.
- `wasteLedger.test.ts` (3,304 LOC) was audited at row-id granularity, not
  line-by-line.
- The 19 `pending` are all deliberate (`it.skip` staging or fixture gates);
  the fixture-gated fiscalArchive tests currently RUN (fixtures are tracked).
  Named risk: `--bail` plus fixture-gating means a rotted fixture degrades
  those tests to pending silently — they can never turn the suite red.

## Appendix — the roster

Verdict key: KEEP (default) · CULL/ARCHIVE/RECLASSIFY/TRIM/FIX/MERGE per §3
(letter = cullable class). Files not listed in §3 are KEEP. LOC and static
test counts measured 2026-08-11.


**test/integration/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| bootstrap.test.ts | 78 | 1 | 2026-07-22 | KEEP (flipped by #168) |
| corp-cop.test.ts | 34 | 1 | 2026-07-22 | KEEP+trim |
| flow-handoff.test.ts | 111 | 1 | 2026-07-22 | KEEP |
| game-physics.test.ts | 341 | 3 | 2026-07-22 | RECLASSIFY (C) |
| integration.test.ts | 25 | 2 | 2026-07-22 | CULL (C) |
| remote-mining.test.ts | 85 | 1 | 2026-07-22 | KEEP |
| runt-economy.test.ts | 208 | 1 | 2026-07-31 | KEEP |
| scenario-economy.test.ts | 103 | 1 | 2026-07-22 | ARCHIVE (C) |
| storage-depot.test.ts | 86 | 1 | 2026-07-22 | KEEP |
| tower-defense.test.ts | 152 | 1 | 2026-07-22 | KEEP |
| two-source-economy.test.ts | 98 | 1 | 2026-07-22 | CULL (C) |
| world-layout.test.ts | 143 | 4 | 2026-07-22 | ARCHIVE (C) |

**test/unit/audit/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| fiscal.test.ts | 134 | 16 | 2026-08-03 | KEEP |
| scavengeDecaySplit.test.ts | 63 | 5 | 2026-08-08 | KEEP |
| scriptLoadability.test.ts | 59 | 2 | 2026-08-07 | KEEP |
| wasteLedger.test.ts | 3328 | 186 | 2026-08-10 | KEEP |

**test/unit/corps/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| CarryCorp.behavior.test.ts | 1504 | 85 | 2026-08-10 | KEEP |
| ClaimCorp.test.ts | 78 | 5 | 2026-07-22 | KEEP |
| HarvestCorp.planning.test.ts | 134 | 5 | 2026-07-22 | KEEP |
| ReservationCorp.test.ts | 457 | 31 | 2026-07-27 | KEEP |
| SpawningCorp.receipt.test.ts | 79 | 2 | 2026-08-03 | KEEP |
| Squad.test.ts | 188 | 17 | 2026-07-22 | KEEP |
| UpgradingCorp.behavior.test.ts | 209 | 1 | 2026-07-22 | KEEP |
| buildLadderBatch.test.ts | 125 | 13 | 2026-07-31 | KEEP |
| buildPool.test.ts | 134 | 6 | 2026-08-11 | KEEP |
| buildPoolAbsorb.test.ts | 63 | 4 | 2026-07-27 | KEEP |
| buildPoolReceipts.test.ts | 143 | 4 | 2026-07-27 | KEEP |
| builderAssignment.test.ts | 361 | 21 | 2026-07-31 | KEEP |
| builderEnRouteRepair.test.ts | 77 | 4 | 2026-07-22 | KEEP |
| builderHandoff.test.ts | 124 | 8 | 2026-07-28 | KEEP |
| builderSizing.test.ts | 390 | 12 | 2026-08-06 | KEEP |
| builderUnladenRelocation.test.ts | 92 | 3 | 2026-07-27 | KEEP |
| bypass.test.ts | 119 | 15 | 2026-07-22 | KEEP |
| cohortRelease.test.ts | 206 | 5 | 2026-07-28 | KEEP |
| controllerInputSpot.test.ts | 229 | 12 | 2026-07-23 | KEEP |
| controllerLinkNetwork.test.ts | 462 | 21 | 2026-08-06 | KEEP |
| coreBuster.test.ts | 126 | 7 | 2026-07-22 | KEEP |
| coreDepot.test.ts | 71 | 5 | 2026-07-22 | KEEP |
| dedicatedSourceDrain.test.ts | 38 | 5 | 2026-07-28 | KEEP |
| driveRecycle.test.ts | 164 | 7 | 2026-08-03 | KEEP |
| dualSpawn.test.ts | 307 | 12 | 2026-07-31 | KEEP |
| extensionTender.test.ts | 442 | 24 | 2026-08-10 | KEEP |
| feederRelayTarget.test.ts | 77 | 6 | 2026-08-08 | KEEP |
| feederRouter.test.ts | 304 | 7 | 2026-08-08 | KEEP |
| feederStaffingLens.test.ts | 106 | 4 | 2026-08-08 | KEEP |
| getSpawnDemand.test.ts | 487 | 16 | 2026-08-08 | KEEP |
| haulDrainTerm.test.ts | 129 | 5 | 2026-08-10 | KEEP |
| haulLinkPlacement.test.ts | 445 | 21 | 2026-08-10 | KEEP |
| jackBody.test.ts | 34 | 3 | 2026-07-22 | KEEP |
| minerApproach.test.ts | 25 | 4 | 2026-07-22 | KEEP |
| minerBufferGate.test.ts | 337 | 18 | 2026-07-31 | KEEP |
| minerOperation.test.ts | 136 | 7 | 2026-07-28 | KEEP |
| movement.test.ts | 587 | 37 | 2026-07-25 | KEEP |
| parkedBuilderBurn.test.ts | 109 | 4 | 2026-07-28 | KEEP |
| pathMeter.test.ts | 52 | 2 | 2026-07-22 | KEEP |
| pickSinkByAllocation.test.ts | 59 | 6 | 2026-07-27 | KEEP |
| poolTankerDelivery.test.ts | 159 | 5 | 2026-07-22 | KEEP |
| portBufferLens.test.ts | 160 | 12 | 2026-08-08 | KEEP |
| portContainerRung.test.ts | 229 | 6 | 2026-08-08 | KEEP |
| portContainerTile.test.ts | 98 | 9 | 2026-08-06 | KEEP |
| portTenderDemand.test.ts | 155 | 6 | 2026-08-08 | KEEP |
| projectLedger.test.ts | 118 | 4 | 2026-07-27 | KEEP |
| raidGuard.test.ts | 199 | 12 | 2026-07-22 | KEEP |
| reclaimableContainer.test.ts | 139 | 9 | 2026-08-08 | KEEP |
| recycleReasonRatchet.test.ts | 44 | 2 | 2026-08-03 | KEEP |
| remoteSourceContainer.test.ts | 390 | 16 | 2026-08-06 | KEEP |
| repair.test.ts | 243 | 24 | 2026-07-22 | KEEP |
| reserverEconomics.test.ts | 13 | 1 | 2026-08-11 | MERGE (F) |
| roadPotholeResurvey.test.ts | 187 | 7 | 2026-07-29 | KEEP |
| runtRecycling.test.ts | 54 | 3 | 2026-07-22 | KEEP |
| scavengeCorpIdCollision.test.ts | 63 | 4 | 2026-08-08 | KEEP |
| scavengePickup.test.ts | 184 | 12 | 2026-07-22 | KEEP |
| scavengerContainerStock.test.ts | 173 | 3 | 2026-07-24 | KEEP |
| scoutIntel.test.ts | 118 | 7 | 2026-07-22 | KEEP |
| sourceContainerPlacement.test.ts | 140 | 4 | 2026-07-23 | KEEP |
| sourceHarvestSpot.test.ts | 380 | 24 | 2026-07-23 | KEEP |
| sourcePickupSpot.test.ts | 176 | 7 | 2026-07-27 | KEEP |
| sourcePileupStamp.test.ts | 98 | 5 | 2026-07-27 | KEEP |
| spawnContract.test.ts | 224 | 15 | 2026-08-11 | KEEP |
| spawnDirections.test.ts | 67 | 6 | 2026-08-08 | KEEP |
| spawnNetworkCritical.test.ts | 43 | 5 | 2026-07-27 | KEEP |
| spawnRefillStock.test.ts | 59 | 4 | 2026-08-03 | KEEP |
| spawnRung.test.ts | 165 | 21 | 2026-08-10 | KEEP |
| stepOffRoad.test.ts | 112 | 5 | 2026-07-22 | KEEP |
| tankerFuel.test.ts | 79 | 2 | 2026-07-27 | KEEP |
| tankerSizing.test.ts | 53 | 6 | 2026-07-28 | KEEP |
| tenderRateMatch.test.ts | 209 | 25 | 2026-08-03 | KEEP |
| tenderSlotCarry.test.ts | 46 | 4 | 2026-07-22 | KEEP |
| trunkRejudge.test.ts | 91 | 4 | 2026-07-22 | KEEP |
| upgradeMeter.test.ts | 89 | 6 | 2026-08-03 | KEEP |
| upgraderRelegation.test.ts | 69 | 4 | 2026-08-03 | KEEP |
| upgraderTargetCount.test.ts | 298 | 25 | 2026-08-06 | KEEP+trim |
| workSpot.test.ts | 86 | 3 | 2026-07-22 | KEEP |

**test/unit/diagnostics/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| CorpCop.test.ts | 112 | 9 | 2026-07-22 | KEEP |

**test/unit/docs/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| specNumbers.test.ts | 78 | 3 | 2026-08-07 | KEEP |

**test/unit/economy/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| CorpPlanner.test.ts | 1659 | 75 | 2026-08-11 | KEEP |
| auxiliaryBudget.test.ts | 378 | 20 | 2026-08-11 | KEEP |
| bank.test.ts | 394 | 35 | 2026-08-08 | KEEP |
| bankPressure.test.ts | 295 | 18 | 2026-08-10 | KEEP |
| commissionFleet.test.ts | 218 | 8 | 2026-08-08 | KEEP |
| commissionPlanLinkServed.test.ts | 79 | 5 | 2026-08-08 | KEEP |
| constructionCommissionPrice.test.ts | 87 | 3 | 2026-08-08 | KEEP |
| corpBudget.test.ts | 379 | 10 | 2026-08-08 | KEEP |
| corpBudgetRollup.test.ts | 124 | 7 | 2026-08-07 | KEEP |
| crossHubTransfer.test.ts | 330 | 14 | 2026-08-10 | KEEP |
| depositPortHeadroom.test.ts | 88 | 8 | 2026-08-06 | KEEP |
| depositSavings.test.ts | 106 | 7 | 2026-08-08 | KEEP |
| drainTerm.test.ts | 95 | 4 | 2026-08-10 | KEEP |
| expansion.test.ts | 83 | 4 | 2026-07-22 | KEEP |
| fleetCharge.test.ts | 124 | 8 | 2026-08-02 | KEEP |
| flowAdapter.test.ts | 1639 | 65 | 2026-08-10 | KEEP |
| fundedRemoteFlows.test.ts | 88 | 3 | 2026-08-10 | KEEP |
| goalPlanSemantics.test.ts | 92 | 2 | 2026-07-22 | KEEP |
| goals.test.ts | 98 | 7 | 2026-07-22 | KEEP |
| infraSpawnEnergy.test.ts | 35 | 3 | 2026-08-02 | KEEP |
| linkTransferTax.test.ts | 64 | 4 | 2026-08-02 | KEEP |
| lossPrimitives.test.ts | 135 | 10 | 2026-08-03 | KEEP |
| minerOperationCommission.test.ts | 125 | 5 | 2026-07-28 | KEEP |
| mineralValue.test.ts | 84 | 12 | 2026-07-26 | KEEP |
| operationPrimitives.test.ts | 156 | 16 | 2026-07-31 | KEEP |
| organismScenario.test.ts | 311 | 9 | 2026-08-08 | KEEP |
| planCadence.test.ts | 52 | 3 | 2026-08-06 | KEEP |
| planHeadroom.test.ts | 66 | 5 | 2026-08-06 | KEEP |
| planningAssembly.test.ts | 110 | 2 | 2026-08-03 | KEEP |
| primitives.test.ts | 550 | 67 | 2026-08-10 | KEEP |
| purity.test.ts | 270 | 13 | 2026-08-11 | KEEP |
| replacementSchedule.test.ts | 94 | 12 | 2026-08-07 | KEEP |
| roadEconomics.test.ts | 411 | 39 | 2026-08-05 | KEEP |
| roadScoring.test.ts | 132 | 14 | 2026-07-22 | KEEP |
| roadSegments.test.ts | 189 | 16 | 2026-07-22 | KEEP |
| roadSegmentsGame.test.ts | 184 | 9 | 2026-07-23 | KEEP |
| scavenge.test.ts | 103 | 10 | 2026-07-22 | KEEP |
| siteValue.test.ts | 92 | 8 | 2026-07-22 | KEEP |
| spawnSinkDemand.test.ts | 108 | 11 | 2026-08-05 | KEEP |
| spawnSweep.test.ts | 200 | 17 | 2026-08-07 | KEEP |
| strategy.test.ts | 114 | 4 | 2026-08-05 | KEEP |
| swampCarrySizing.test.ts | 137 | 13 | 2026-08-07 | KEEP |
| terminalEconomics.test.ts | 128 | 11 | 2026-08-10 | KEEP |
| transientFloor.test.ts | 66 | 3 | 2026-08-03 | KEEP |
| vectorGait.test.ts | 57 | 5 | 2026-08-03 | KEEP |
| volleyServiceCarry.test.ts | 107 | 9 | 2026-08-07 | KEEP |
| wartimeControllerRung.test.ts | 103 | 10 | 2026-08-08 | KEEP |

**test/unit/execution/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| SpawnPlacementScheduler.test.ts | 147 | 5 | 2026-08-11 | KEEP |
| collectDemandsPolicy.test.ts | 152 | 6 | 2026-08-08 | KEEP |
| cpuGovernor.test.ts | 97 | 8 | 2026-08-11 | KEEP |
| demandCostGuard.test.ts | 98 | 5 | 2026-08-08 | KEEP |
| fieldedFleets.test.ts | 134 | 6 | 2026-08-07 | KEEP |
| linkRouting.test.ts | 274 | 28 | 2026-08-06 | KEEP |
| nodeMineralValue.test.ts | 47 | 4 | 2026-07-26 | KEEP |
| orphanAction.test.ts | 80 | 8 | 2026-07-28 | KEEP |
| planTriggers.test.ts | 154 | 17 | 2026-08-11 | KEEP |
| refreshNodeResources.test.ts | 368 | 11 | 2026-08-10 | KEEP |
| registrationOnly.test.ts | 151 | 5 | 2026-07-22 | KEEP |
| roadTracker.test.ts | 165 | 9 | 2026-07-22 | KEEP |
| spawnDirectorPool.test.ts | 266 | 5 | 2026-08-03 | KEEP |
| spawnReceipt.test.ts | 70 | 5 | 2026-08-07 | KEEP+trim |
| terminalRunner.test.ts | 162 | 10 | 2026-08-10 | KEEP |
| towerFocusFire.test.ts | 76 | 8 | 2026-07-22 | KEEP |
| towerRunner.test.ts | 143 | 14 | 2026-07-31 | KEEP |

**test/unit/flow/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| lastBankDraw.test.ts | 86 | 3 | 2026-08-03 | KEEP |
| pathDistanceProfitability.test.ts | 172 | 3 | 2026-07-27 | KEEP |

**test/unit/framework/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| bodyEquivalence.test.ts | 183 | 2 | 2026-08-10 | KEEP |
| carryKind.test.ts | 240 | 8 | 2026-07-28 | KEEP |
| claimKind.test.ts | 60 | 2 | 2026-07-22 | FIX (E) |
| commissionHost.test.ts | 134 | 5 | 2026-07-22 | KEEP |
| constructionKind.test.ts | 458 | 19 | 2026-07-27 | KEEP |
| controllerFeederKind.test.ts | 341 | 10 | 2026-08-08 | KEEP |
| coreBusterKind.test.ts | 103 | 3 | 2026-07-22 | KEEP |
| corpCpuMeter.test.ts | 95 | 2 | 2026-07-22 | KEEP |
| extensionTenderKind.test.ts | 206 | 5 | 2026-07-27 | KEEP |
| harvestKind.test.ts | 215 | 6 | 2026-07-28 | KEEP |
| legacyBoundary.test.ts | 97 | 2 | 2026-08-11 | KEEP |
| newCorp.test.ts | 201 | 7 | 2026-07-28 | KEEP |
| planCadence.test.ts | 100 | 1 | 2026-07-28 | KEEP |
| planEquivalence.test.ts | 34 | 1 | 2026-07-22 | KEEP |
| raidGuardKind.test.ts | 106 | 3 | 2026-07-22 | KEEP |
| reservationKind.test.ts | 298 | 12 | 2026-07-27 | KEEP |
| scoutKind.test.ts | 205 | 6 | 2026-07-27 | KEEP |
| solverBridge.test.ts | 139 | 4 | 2026-08-03 | KEEP |
| spawnAuthority.test.ts | 169 | 7 | 2026-08-11 | KEEP |
| upgradeKind.test.ts | 212 | 6 | 2026-07-28 | KEEP |

**test/unit/grid/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| judge.test.ts | 106 | 8 | 2026-07-22 | KEEP |
| pack.test.ts | 119 | 9 | 2026-07-22 | KEEP |

**test/unit/harness/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| haulerFleet.test.ts | 70 | 6 | 2026-07-22 | KEEP |
| minerFleet.test.ts | 59 | 6 | 2026-07-22 | KEEP |
| screepsConstants.test.ts | 112 | 5 | 2026-08-10 | KEEP |
| upgraderFleet.test.ts | 78 | 6 | 2026-08-03 | KEEP |

**test/unit/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| main.test.ts | 95 | 3 | 2026-08-07 | KEEP |

**test/unit/nodes/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| calculateNodeROI.test.ts | 64 | 4 | 2026-07-27 | KEEP |
| pathDistance.test.ts | 85 | 5 | 2026-07-22 | KEEP |

**test/unit/planning/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| SpawnPlacement.test.ts | 223 | 8 | 2026-08-11 | KEEP |
| clusterROI.test.ts | 113 | 2 | 2026-07-22 | CULL (B) |

**test/unit/scenario/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| RoomBuilder.test.ts | 65 | 7 | 2026-07-22 | KEEP |

**test/unit/sim/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| extensionSim.test.ts | 318 | 15 | 2026-07-24 | KEEP |

**test/unit/spatial/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| distanceTransform.test.ts | 434 | 14 | 2026-07-22 | TRIM (D) |
| multiRoomTerritory.test.ts | 679 | 23 | 2026-07-22 | TRIM (D) |
| peakDetection.test.ts | 488 | 22 | 2026-07-22 | TRIM (D) |
| roomMap1.test.ts | 155 | 7 | 2026-07-22 | CULL (B) |
| spawnPlacement.test.ts | 68 | 7 | 2026-07-22 | KEEP |
| territoryDivision.test.ts | 502 | 14 | 2026-07-22 | TRIM (D) |

**test/unit/spawn/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| BodyBuilder.test.ts | 44 | 4 | 2026-07-22 | KEEP |
| SpawnScheduler.test.ts | 847 | 49 | 2026-07-24 | KEEP |
| builderBody.test.ts | 65 | 7 | 2026-07-27 | KEEP |
| demandLadder.test.ts | 173 | 8 | 2026-08-07 | KEEP |
| feederLinchpinPriority.test.ts | 99 | 6 | 2026-08-06 | KEEP |
| minerPrecedence.test.ts | 63 | 5 | 2026-07-22 | KEEP |
| nextSpawn.test.ts | 176 | 8 | 2026-07-22 | KEEP |
| nowPlanner.test.ts | 177 | 2 | 2026-07-24 | KEEP |
| reserverPriority.test.ts | 68 | 4 | 2026-07-22 | KEEP |
| spawnAgenda.test.ts | 206 | 14 | 2026-07-27 | KEEP |
| starvationBackstop.test.ts | 223 | 10 | 2026-07-26 | KEEP |

**test/unit/telemetry/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| agendaMirror.test.ts | 80 | 2 | 2026-07-22 | KEEP |
| blackBox.test.ts | 127 | 11 | 2026-08-03 | KEEP |
| census.test.ts | 214 | 7 | 2026-08-03 | KEEP |
| containerCensus.test.ts | 139 | 9 | 2026-08-06 | KEEP |
| cpuReport.test.ts | 112 | 11 | 2026-07-24 | KEEP |
| cpuRotation.test.ts | 66 | 3 | 2026-07-24 | KEEP |
| creepCargo.test.ts | 97 | 5 | 2026-08-10 | KEEP |
| departMeter.test.ts | 47 | 4 | 2026-08-05 | KEEP |
| dutyHistogram.test.ts | 71 | 5 | 2026-08-03 | KEEP (flag: unplugged read half) |
| fiscalArchive.test.ts | 268 | 8 | 2026-08-08 | KEEP |
| flowPlan.test.ts | 160 | 9 | 2026-08-08 | KEEP |
| haulTrace.test.ts | 95 | 7 | 2026-08-02 | KEEP |
| linkMeter.test.ts | 145 | 12 | 2026-08-10 | KEEP |
| lossMeter.test.ts | 615 | 42 | 2026-08-05 | KEEP |
| lossesPublish.test.ts | 70 | 2 | 2026-08-03 | KEEP |
| portTenderCheck.test.ts | 97 | 9 | 2026-08-08 | KEEP |
| roomLedger.test.ts | 169 | 5 | 2026-08-10 | KEEP |
| sizingRecord.test.ts | 198 | 6 | 2026-08-08 | KEEP |
| sourceDropped.test.ts | 130 | 4 | 2026-08-10 | KEEP |
| sourceMouth.test.ts | 171 | 6 | 2026-08-10 | KEEP |
| spawnLedger.test.ts | 96 | 7 | 2026-08-03 | KEEP |
| spawnMeter.test.ts | 182 | 13 | 2026-08-10 | KEEP |
| throughputCounters.test.ts | 81 | 3 | 2026-08-03 | KEEP |

**test/unit/utils/**

| file | LOC | tests | last touched | verdict |
|---|---|---|---|---|
| raidMeter.test.ts | 76 | 6 | 2026-07-22 | KEEP |
| roomDiscovery.test.ts | 497 | 28 | 2026-08-05 | KEEP |
Never-run relics (phase A, outside the mocha roster):
`test/economic-analysis.test.js` (154 LOC), `test/find-best-node.js` (315),
`test/lib/economic-analysis.js` (237), `test/fixtures/econ-network.json`,
`test/fixtures/node-network-snapshot.json`, `test/sim/roomMap1.txt`.
