# Production audit loop

## The goal (what a cycle is FOR)

**Maximize sustained controller/GCL progress — the game's score.** One point
of RCL/GCL = one energy delivered to a controller; everything else here is
instrumental. Concretely, each cycle drives toward:

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
SCREEPS_TOKEN=... npm run capture:telemetry -- --shard shard1 --segments 0,4,6
npm run audit:ledger        # spec 15: latest capture vs previous, every leak a number
```

- Segment 0 (core): `bodyParts` (actual, colony), `rooms[]` ledger
  (`storageEnergy`/`controllerStock`/`feederActive`), `spawns[]` meter
  (`utilization`/`partsPerTick`/`ceiling`/`queueDepth`), `agenda` (NOW-plan
  queue heads + executed receipts).
- Segment 4 (corps): per-corp actual `body`/`bodyParts`, `sizing` stamps
  (decision inputs; infra corps stamp the GATE that fired).
- Segment 6 (flow): GOAL plan — `sources[].workParts`, `haulers[].carryParts`,
  sink `workParts`, and `candidates[]` (per-source funding verdicts with
  net/tax pricing).
- Prior captures: `test/fixtures/telemetry/` (committed baselines).
  Segment 5 (blackbox) and 3 (intel raid fields) via `--segments 3,5` when
  churn/raid history is needed.

## 1. Triage checklist (fail ⇒ investigate; numbers from measured incidents)

- **LEDGER FIRST**: `npm run audit:ledger` output outranks everything below.
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
- Regression (a checklist line got worse than pre-deploy) ⇒ redeploy
  `origin/master`, record the failed hypothesis in the spec, stop.
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
