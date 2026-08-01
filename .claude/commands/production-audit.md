# Production audit loop

## The goal (what a cycle is FOR)

**THE DELIVERABLE IS THE CODEBASE, NOT THE SCORE** (owner 2026-08-01: *"we
don't care so much about the actual progress so much as the progress of our
codebase, so it's fine to have some regressions in live"*).

The live colony is the **measurement instrument**, not the product. Its score
is how we find out whether the code is right — a number to reason FROM, not a
number to protect. A cycle succeeds when the codebase ends it more correct,
better instrumented, or better understood than it started, and a live
regression that buys a real finding is a good trade.

Two consequences a future session must not re-derive:

- **A failed prediction is a SUCCESSFUL cycle if it is attributable.** The
  two-pass solve missed its predictions by 4× on 2026-08-01 and the cycle was
  worth more than a clean confirmation would have been: it exposed a wrong
  fixed-point argument in the design. Chase the attribution, not the green.
- **Do not revert to protect the score.** Revert when a change is simply wrong
  and has stopped teaching, or when it threatens the INSTRUMENT itself — a dead
  colony, lost rooms, a spawn deadlock, a CPU bucket collapse. Those cost the
  feedback loop, which is the one thing that is actually expensive. Ordinary
  regressions ride.

Controller/GCL progress remains the metric the reports are built around,
because it is the sharpest available signal of whether the economy works.
Concretely, each cycle still drives toward:

1. **Actual progress ≈ planned progress**: `rooms[].rclProgress` /
   `gcl.progress` delta per tick between captures, within tolerance of the
   plan's controller allocation (flow sink `allocated`). A gap IS the work
   item.
2. **Doctrine constraints held**: defense funded, warchest AT its target
   (economy/bank.ts) — a warchest far above target means the spend path is
   broken, not that we're rich; expansion capex ready when GCL allows.
3. **BOT LEVEL ratchet** (test/grid/baseline.json) rising on the dev side.

**Current phase (owner directive 2026-07-18): waste elimination.** The
colony's basic mechanics must sing: identify, measure, and eliminate/minimize
every leak of CPU, energy, or spawn time, in planning and execution. The leak
taxonomy and its measurements live in docs/specs/15-waste-ledger.md — each
cycle computes the ledger from the fresh capture, ranks leaks by magnitude,
and attacks the top line. A leak is eliminated only when its number reaches
target AND a regression test pins it.

A cycle SUCCEEDS if a ledger line went to target, the progress rate was
raised/restored, or a blocker was named with data. A cycle that produces
activity without a measured delta is a failed cycle — say so in the report.

## Method

Run one full audit cycle of the live DarkPhoenix economy: capture telemetry,
triage against invariants, diagnose from decision stamps, fix what's proven,
verify after deploy. This encodes the 2026-07-18 audit method (spec 14) —
**every claim must be a read from data or it is a hypothesis, labeled as such.**
One hypothesis at a time; design the next capture to falsify it.

## 0. Instruments (all reads, no Memory pulls needed)

```
SCREEPS_TOKEN=... npm run capture:telemetry -- --shard shard1 --segments 0,4,5,6
npm run audit:ledger        # ENERGY ACCOUNT + SOURCE P&L + spec 15 leak ledger
npm run fiscal:close        # spec 41: write any newly-crossed fiscal period to docs/fiscal/
```

- Segment 0 (core): `bodyParts` (actual, colony), `rooms[]` ledger
  (`storageEnergy`/`controllerStock`/`feederActive`), `spawns[]` meter
  (`utilization`/`partsPerTick`/`ceiling`/`queueDepth`), `agenda` (NOW-plan
  queue heads + executed receipts).
- Segment 4 (corps): per-corp actual `body`/`bodyParts`, `sizing` stamps
  (decision inputs; infra corps stamp the GATE that fired).
- Segment 5 (blackbox): the rolling spawn log the X5 churn line reads — every
  spawn `{corp, role, cost}` over the window. Capture it every cycle so X5
  computes; without it the line skips silently. Read a HIGH X5 against the
  deploy log — a global reset inflates churn for ~1 window (the recovery
  double-orders and re-plans, not steady state).
- Segment 6 (flow): GOAL plan — `sources[].workParts`, `haulers[].carryParts`,
  sink `workParts`, and `candidates[]` (per-source funding verdicts with
  net/tax pricing).
- Prior captures: `test/fixtures/telemetry/` (committed baselines).
  Segment 5 (blackbox) and 3 (intel raid fields) via `--segments 3,5` when
  churn/raid history is needed.

## 0b. The STANDING REPORT SET (spec 41 — a contract, not a suggestion)

Every cycle produces these, in this order. A future session changes the set
only deliberately, and **bumps `METHODOLOGY` in scripts/waste-ledger.ts when it
does** — two reports are comparable only at the same stamp.

1. **ENERGY ACCOUNT** — income statement, budget vs actual vs variance,
   balancing to a named RESIDUAL.
2. **SOURCE P&L** — the same accounts per source, vs the planner's own net.
3. **CONTROLLER VARIANCE BRIDGE** — top-line variance split into accounting
   terms vs behaviour terms.
4. **WASTE LEDGER** — leak rows ranked, TOP LINE named.
5. **FISCAL CLOSE** — `npm run fiscal:close`, append-only, into `docs/fiscal/`.

**Fiscal calendar:** month = **1500 ticks** (`CREEP_LIFETIME`, the horizon every
body cost amortizes over — so a month is exactly the period a spawn purchase is
expensed across); year = **15000** (ten months). A YEAR averages over the
~9000-tick bank limit cycle; a MONTH is a phase sample of it and must be read
as one. Closes are approximate by nature — they print the ticks actually
measured and the coverage %, refuse anything outside 50–175%, and never
overwrite an existing close.

## 1. Triage checklist (fail ⇒ investigate; numbers from measured incidents)

- **READ THE ENERGY ACCOUNT FIRST**, then the ledger. `audit:ledger` prints a
  standing chart of accounts above the leak rows — the colony's income
  statement in energy/tick over the window:

  ```
  REVENUE          gross mining (plan capacity) + pile drawdown/(build-up)
                   = delivered into the economy
  OPERATING COST   producers / infra / defense / consumers   (MEASURED at the spawn)
  APPROPRIATIONS   controller (score) + construction + to/(from) bank
  ------------------------------------------------------------------
  RESIDUAL         delivered − opex − appropriations
  ```

  It **balances by construction**, so the RESIDUAL is the point, not a rounding
  bucket: it bounds ground decay, rot above the container cap, raid losses,
  tower burn and measurement error, and it inherits spec 20's discipline — a
  named residual that cannot silently grow because both sides are published.
  Read it as the frame for everything else: a leak row tells you WHAT is
  leaking, the account tells you whether the colony's energy is accounted for
  at all. **A residual that grows between cycles is a work item even when every
  leak row is green** (first baseline 2026-08-01: 14% of gross mining).

  Honesty limits to carry when quoting it: revenue is the PLAN's mining
  CAPACITY less the measured pile change — not a delivery meter — so income is
  deliberately NOT derived as the balancing figure (that would make the
  residual circular). Operating cost IS measured (the blackbox ring, by role),
  and the ring and capture windows differ in length; each figure is normalised
  over its own and both are stated in the header.

  **The chart is expected to evolve** (owner 2026-08-01). Add accounts as
  measurement improves — split the residual as decay/rot/raid meters land, add
  a balance-sheet section (reserved / committed / free) when the commitment
  accounting exists. Keep the balancing identity and the named residual; those
  are the invariants, not the specific line items.

- **THEN the SOURCE P&L**, the account one level down: per-source gross, its
  measured miner/hauler/reservation cost, and the resulting net against the
  planner's own `candidates[].net`. Attribution is exact (spec 34 D5 gave each
  miner operation its haulers, so a `mining-*` corp's spawn spend IS that
  source's cost); only reservation is shared, split across its room's sources.
  It reconciles to the colony account — miner and reserve totals match those
  lines exactly, hauler is lower by the standalone scavenge corps. A chronic
  NEGATIVE variance is a funding bug, not a curiosity: the planner's
  per-source net is what admits or rejects a source.

- **LEDGER FIRST among leaks**: `npm run audit:ledger` output outranks everything below.
  Any FAIL line is the cycle's work item unless a live incident preempts; the
  symptomatic checks below localize causes, the ledger finds the leak classes
  (2026-07-18 lesson: plan spawn-infeasibility 1.68×, reserver duty 2× drift,
  and 48 parts of stranded haulers were all invisible to the symptom checks —
  the owner had to ask). Accounting invariants the ledger owns: P4 plan
  parts/tick vs physical ceiling (ALL fleet classes, budgeted or not), P5
  price-vs-behavior drift (every constant encoding a behavioral assumption —
  duty cycles, ratios — checked against measured behavior), E2/E4/E5/P1/P2/
  S3/X3 per spec 15.
- **Spawn**: `utilization` vs steady-state need (Σ bodyParts/1500, reservers
  /(600−travel)). Saturation (>0.95) with steady-state <0.85 ⇒ a purchase loop or
  rebuild churn; read `agenda.executed` role mix — no single role should eat
  >50% of build-time (reserver loop was 53%).
- **Infra gates**: feeder/tender `sizing.gate` stuck at `"demand"` across two
  captures ⇒ queue starvation; `"no-*"` ⇒ that gate's inputs name the cause.
- **Warchest**: `storageEnergy` vs WARCHEST_TARGET (economy/bank.ts, ~27.6k).
  >2× target AND rising AND `feederActive false` ⇒ the spend path is down.
- **Consumers**: upgrader `sizing.allocated` at floor (2) while `planAllocated`
  is large ⇒ stock/inflow starvation, read `stock`/`inflow`/`banked`.
- **Bodies**: plan-vs-actual per role (flow plan carry/work vs segment-4
  actual). Gap >30% ⇒ plan flap or stranded fleets. Runts (≤4 parts, non-claim)
  in receipts ⇒ drained-spawn purchases.
- **Plan stability**: `candidates[]` verdicts vs previous capture. Sources
  flipping funded↔excluded between captures = flap; the verdict names why.
- **Census**: `untracked` >2 ⇒ orphan leak. Creep total swinging >20% between
  captures ⇒ die-off/rebuild oscillation.
- **CPU**: bucket <5000 or `used` near limit ⇒ stop, that's the priority.

## 2. Diagnosis rules

- Trust stamps over inference: a corp's `sizing` IS what its decision read.
  Never recompute a decision input from other fields (drift = staffsPost trap).
- Two captures ≥50 ticks apart distinguish transient vs stuck before any fix.
- If the cause is invisible: the fix is FIRST a stamp (extend spec 14 pattern —
  decision-site record, exported verbatim), deploy, recapture. Never guess
  twice: one falsified hypothesis ⇒ instrument, don't re-theorize.
- Respect the CLAUDE.md trap list; a diagnosis that matches a trap is likely
  that trap.

## 3. Fix protocol

- **Red-first, always**: reproduce in a unit test (the incident's exact shape),
  watch it fail, then fix. Acceptance criteria live in tests only.
- **Telemetry/observability-only** (stamps, exports, version bumps): unit suite
  + build; may ship without asking.
- **Live-behavior** (anything a decision reads: demand lenses, gates, planner
  terms, sink values): full regression gate — `npm run test-unit` PLUS
  `flow-handoff`, `runt-economy`, `storage-depot` (one file at a time,
  `npm run build` FIRST — they run dist/main.js). Bump segment versions on
  schema change. Never nudge a sink value in isolation.
- **Grid verdicts are the `[P]`/`[x]`/`[T]` markers, NEVER exit codes**:
  `npm run grid -- --cell <id>` skips the baseline ratchet and exits 0
  regardless of the cell's verdict (measured 2026-07-18: a deploy gate read
  exit codes and shipped on five unverified cells — four were failing). Parse
  the marker lines; a `--cell` run "passes" only on `[P]`.
- **Attribution before blame**: a red cell gates a deploy only if it is red
  BECAUSE of the pending change — run the cell on the pre-change source
  (checkout src at the last deployed commit, build, rerun). Identical failure
  pre/post acquits the pending change; the regression then becomes its own
  incident against the DEPLOYED build and must not hold the fix hostage.
- Commit with the measured numbers in the message. Update the spec-14 incident
  log for anything found in prod. Commit the capture that proved it as a
  fixture (economy segments only — slim, ~20K).

## 4. Ship + verify (the loop is not done at green tests)

- Push the branch; open/update the PR with plan-vs-actual numbers.
- Deploy: `npm run build && npm run deploy` — executed DIRECTLY from the
  session (standing owner authorization 2026-07-18: "actually push to prod
  straight from here"); never wait for a human once the required gate is
  green, and never deploy before it is. This POSTs the TESTED webpack bundle (dist/main.js) to the account's
  ACTIVE world branch via the code API using the full-access env
  `SCREEPS_TOKEN` (never echo it). Do NOT use `npm run push-main` (rollup
  re-bundles src with a second, broken-here pipeline; the active branch is
  "master", not the sample config's "main"). No token ⇒ stop at the PR and
  say so.
- **Post-deploy verification is mandatory**: wait ~200+ ticks, recapture,
  re-run the triage checklist. Predict the expected deltas BEFORE deploying
  (e.g. "reserver cadence →1/150t, feeder gate →staffed") and check each.
- **Regression handling (revised 2026-08-01, see "The goal").** A checklist
  line getting worse is NOT by itself a revert. Record it, attribute it, and
  keep going — the codebase is the deliverable and a live regression that buys
  understanding is a good trade. Redeploy `origin/master` only when the change
  is wrong AND has stopped teaching, or when it threatens the instrument
  itself: colony death, lost rooms, spawn deadlock, CPU bucket collapse.
  **Always record the failed hypothesis in the spec either way** — that is the
  part with lasting value, not the rollback.
- Record the cycle verdict (fixed / instrumented / falsified) in
  docs/specs/14-telemetry-observability.md.

## 5. Parallel local work (while prod verifies)

Post-deploy verification is a ~30–60 min wait at ~1 tick/s. Never idle it and
never poll it — schedule the check-in (send_later), then spend the wait on
local dev, in this order:

1. **Baseline-red grid cells nearest the changed subsystems** (`npm run grid
   -- --cell <id>`; red cells listed in `test/grid/baseline.json`). A live fix
   often moves a related red cell — e.g. a reserver-cadence fix touches
   `plan-t5-remote-pipeline`. `npm run build` first; update the baseline in
   the SAME commit as the bot change that earned it.
2. **Pre-build the pending hypothesis' test**: whatever the prod check-in will
   confirm or deny, author its red-first repro cell/test NOW (e.g. "tender
   re-fields within N ticks of a rebuild wave" while waiting to see if the
   tender self-heals). If prod confirms the problem, the fix starts from a red
   test already written; if prod self-heals, keep it as a regression cell.
3. Open spec work (docs/specs/README.md priority column) if time remains.

Local results NEVER pre-empt the prod verdict: if the check-in contradicts a
local conclusion, prod wins (sim blind spots are documented in CLAUDE.md).

## 6. Cadence

Single invocation = one cycle. For continuous monitoring run via `/loop`
(30–60 min intervals; captures are cheap, prod moves ~1 tick/s) or a scheduled
Routine that fires this command. Between cycles nothing polls — the game runs
itself; the loop's value is the delta between captures.
