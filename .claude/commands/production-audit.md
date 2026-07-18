# Production audit loop

Run one full audit cycle of the live DarkPhoenix economy: capture telemetry,
triage against invariants, diagnose from decision stamps, fix what's proven,
verify after deploy. This encodes the 2026-07-18 audit method (spec 14) —
**every claim must be a read from data or it is a hypothesis, labeled as such.**
One hypothesis at a time; design the next capture to falsify it.

## 0. Instruments (all reads, no Memory pulls needed)

```
SCREEPS_TOKEN=... npm run capture:telemetry -- --shard shard1 --segments 0,4,6
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

- **Spawn**: `utilization` vs steady-state need (Σ bodyParts/1500, reservers
  /600). Saturation (>0.95) with steady-state <0.85 ⇒ a purchase loop or
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
- Deploy: `npm run push-main` — ONLY if `screeps.json` exists and the full
  gate is green. The env `SCREEPS_TOKEN` is full-access; if `screeps.json` is
  missing, generate it (gitignored) with a `main` block
  `{token: $SCREEPS_TOKEN, hostname: screeps.com, branch: main}` — never
  commit it or echo the token. No token ⇒ stop at the PR and say so.
- **Post-deploy verification is mandatory**: wait ~200+ ticks, recapture,
  re-run the triage checklist. Predict the expected deltas BEFORE deploying
  (e.g. "reserver cadence →1/150t, feeder gate →staffed") and check each.
- Regression (a checklist line got worse than pre-deploy) ⇒ redeploy
  `origin/master`, record the failed hypothesis in the spec, stop.
- Record the cycle verdict (fixed / instrumented / falsified) in
  docs/specs/14-telemetry-observability.md.

## 5. Cadence

Single invocation = one cycle. For continuous monitoring run via `/loop`
(30–60 min intervals; captures are cheap, prod moves ~1 tick/s) or a scheduled
Routine that fires this command. Between cycles nothing polls — the game runs
itself; the loop's value is the delta between captures.
