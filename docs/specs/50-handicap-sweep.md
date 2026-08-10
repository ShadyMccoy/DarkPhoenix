# 50 — The spawn-handicap sweep, and the archive that makes it readable

**Status: LANDED 2026-08-06** (owner: *"We used to have a spawn capacity handicap
of 10% for the planner. When I lifted that, I feel like the economy got
overheated, and it's no longer able to execute everything that it wants to due to
various little inefficiencies. I want to set up an experiment with every fiscal
month. We add 1% of handicap. From 0 to 20 over the course of two fiscal years.
We will then examine the income statements across all 20 months. Although RCL 8
may hit before then - so if necessary let's plan to accelerate that with 2% per
month. And I wanna make sure all those income statements will be recoverable by
the end. I want the bot to set the handicap on its own. I don't want to re-deploy
or monitor from here. It can cycle back to zero and around again if it does get
all the way to the end"*)

## 1. The owner's read is confirmed, not assumed

The instinct — lifting the handicap overheated the economy — was already measured
before this spec existed, and the constant was reverted on 2026-08-05. The
before/after is the reason the sweep is worth running rather than a debate worth
having:

| | handicap 0% (lifted) | handicap 10% (reverted) |
|---|---|---|
| spawn utilization | 0.97–0.98, queue depth 4–8, sustained ~2000t | **0.64**, S3 "not a stall" |
| forgone mining | climbed 8–20 → **44.5 e/t** over five months | **9.71 e/t** |
| P4 plan-infeasibility | 0.83–0.91× (circular: prices the plan's own estimate) | **0.73×** |
| X5 rebuild churn | elevated | **0%** |
| commission fidelity | F2 fielded 38 of 84 declared parts | F2 0.26, F3 0.09 |

*(lifted era: t72798237–t72800193 and the FY4852-M06→FY4853-M02 closes; reverted:
t72823437.)*

"Overheated" has a mechanism. The plan prices its own declared fleet but not the
REPLACEMENT overhead execution actually pays (F1: haulers +0.116 p/t, miners
+0.028). Plan-priced demand 0.607 p/t + ~0.14 measured overhead ≈ 0.75 against a
0.667 physical ceiling. The margin was the buffer for exactly the cost the plan
does not price; removing it exposed the mispricing as an unfillable queue.

**So the handicap is a blunt instrument standing in for an honest per-route
replacement price.** The sweep's job is not to defend it — it is to measure the
shape of the curve so the eventual honest pricing has something to be checked
against.

## 2. What the sweep does

`SPAWN_PLAN_FRACTION` (0.9) stops being the operative number when the experiment
is armed. `economy/spawnSweep` walks a handicap **0% → 20%, one step per fiscal
month**, and `primitives.spawnPlanFraction()` resolves `1 - pct/100`. One step per
month means each month's income statement describes exactly one handicap.

At the top it **wraps to 0 and runs again**. That is the owner's instruction and
it is also the methodology fix: a fiscal month is a phase sample of the ~9000-tick
bank limit cycle (spec 41), so a single 21-month pass aliases the bank oscillation
against the handicap ramp and cannot separate the two. The second cycle re-samples
each handicap at a different bank phase. **One cycle is suggestive; two are
comparable.**

### The step, and the RCL-8 race

Default 1%/month (ramp = 21 months ≈ 31,500 ticks). The bot escalates itself to
2%/month when its OWN measured controller rate — progress gained between the last
two month boundaries, no constant, no model — projects RCL 8 landing before the
ramp ends. At RCL 8 the controller caps at 15 e/t and statements either side are
not comparable.

Measured at t72823437 the answer is **don't accelerate**: 3,652,926 points remain
at ~37.4/tick ⇒ RCL 8 is ~97,700 ticks out against ~31,500 ticks of ramp, a 3×
margin. The rule would have to see the controller rate roughly triple to flip. It
exists because nobody will be watching if it does.

### Arming, and why the bot never self-arms

The sweep is opt-in: with no `Memory.spawnSweep`, `spawnPlanFraction()` returns
the static 0.9. Two consequences, both deliberate:

- **The grid, the sims and the unit suite are untouched** by the experiment's
  existence — no baseline moves because a constant became a function.
- **A wiped Memory fails safe to 0.9**, the measured-good value, never to the 1.0
  that overheated the colony.

Arming is one Memory write, done once. Advancing is the bot's, forever.

### Purity (spec 17)

`economy/primitives` is on the PLAN-layer PURE list and resolves the margin
through `spawnSweep`, so `spawnSweep` must be pure too. It is: the state lives in
`Memory`, owned by `telemetry/fiscalArchive` (already Game-coupled), and the pure
module keeps a mirror the adapter refreshes **every tick, before planning**. The
mirror being empty after a global reset is the same fail-safe as above.

The month hook also runs **before** the planning phase, so a boundary tick's
re-solve is the first plan OF the month it labels — stepping afterwards would give
every month one plan priced at the previous month's handicap.

#### "Before planning" was not early enough (measured t72828763)

The hook shipped at the top of PHASE 2 and that was a bug, caught on the first
post-deploy capture: `plannable` read `0.6667 × 0.90` — the unarmed fail-safe —
while `Memory.spawnSweep.pct` said 3. The mirror refresh had run; it had just run
too late. `getOrCreateFlowEconomy` **solves inside PHASE 0**, deliberately ("don't
wait for the planning cycle"), so on a global reset the VM's first plan is priced
before PHASE 2 exists.

The cost is set by the plan's TERM, and that is what makes this worth a rule
rather than a patch. Under the old 50-tick cadence it was one mislabelled plan,
gone in a tick. Under the fiscal-month term (spec 46 phase A) the same plan is the
month's budget and **stands until the next boundary** — so one deploy at a random
tick mis-prices up to a whole month of the sweep, which is the experiment's own
unit of measurement, and does it invisibly (the archive's `pct` label comes from
Memory and stays correct while the plan under it does not).

The rule, then, is not "before planning" but **before any solve**. The hook is now
the first statement in PHASE 0, and `test/unit/main.test.ts` pins the ordering
against a named list of solve entry points, because no behavioural test can see
this: by the end of the tick the mirror is correct either way.

## 3. The archive — the part that makes the experiment legible

`fiscal-close` brackets a month with the committed CAPTURES nearest its ends. That
needs someone capturing on a ~monthly cadence, and this experiment has nobody
watching for 31,500 ticks. A month with no capture near either end is closed at
bad coverage or not at all, and the record is append-only — **it can never be
filled in later.**

So the bot brackets its own months. `telemetry/fiscalArchive` snapshots at every
boundary into a Memory-backed ring published to **segments 8–9**; one capture at
the end yields every month in it.

Three properties worth stating:

- **Coverage is ~100% by construction.** The snapshot lands ON the boundary, where
  a capture-bracketed close has never been better than approximate. The archived
  path is the more accurate one, not a fallback.
- **No second derivation path.** A snapshot is pruned out of the segments
  `Telemetry.update` just wrote, so the archive cannot carry a number a live
  capture would not. Both paths then render through the same `formatAccounts` /
  `formatSourcePnL` / `formatLedger` at the same methodology stamp.
- **It is Memory-backed, not heap.** Heap state is bounded by VM lifetime (~480
  ticks measured, t72722670) — shorter than the month it would have to survive.
  This is the defect LossMeter and spawnLedger already paid for.

### What is pruned, and what that costs

Kept: cumulative spawn spend and losses, source buffers/piles, rooms, bodies, the
spawn meter, the plan's sources / haulers / sinks / parts-ledger / summary, link
meter rows, every ADJUDICATED candidate verdict, and the corp kinds the plan
prices.

Dropped: unscouted `prospect` candidates, corps outside the priced kinds, the
per-room and per-reason loss attribution maps, and intel / blackbox / creep census
entirely. Consequences: the tombstone "killed where" and "recycled why"
decorations go absent, and X3 (untracked creeps) reads a stub. **Nothing reads a
confident zero** — the failure mode spec 41 exists to prevent.

Rejected candidate verdicts are kept deliberately: raising the handicap shrinks the
spawn budget, and the first thing that budget does is stop admitting marginal
sources. *"Two remotes fell out at 12%"* is the sweep's primary observable and it
lives only in those rows.

### The acceptance test

`test/unit/telemetry/fiscalArchive.test.ts` prunes two REAL captures, rehydrates
them, and asserts the ENERGY ACCOUNT built from the archived pair matches the one
built from the full captures, line by line, to 0.02 e/t.

That test is not ceremony — it found four real gaps, each of which would have
silently produced a wrong income statement for every month of the sweep:

1. the plan's **hauler rows** (the entire evacuation budget read 0.00);
2. **`core.links` + the hauler `port` flag** (the link-transfer budget line, −4.76
   read as −0.60 — and `port` is a POSITION, so a `=== true` test silently zeroed
   the deposit-port term);
3. the **non-harvest corps** the budget prices its reservation / infra / defense /
   consumer lines from;
4. source **`nodeId`**, which splits remote from home for the reservation uplift
   (9 remotes read as 11).

Every one of those is a BUDGET-side field. The actual column was right from the
first attempt — which is exactly the trap, because the handicap acts on the plan.
An archive that loses the budget column cannot measure this experiment at all.

## 4. Reading the result

`npm run fiscal:archive` lists the ring and writes any month it can close into
`docs/fiscal/`, append-only, each report stamped with the handicap that produced
it and the sweep cycle. Compare like handicap against like handicap ACROSS cycles
before comparing different handicaps within one.

Expected primary signals, in the order they should be trusted:

1. **Admitted source count and the excluded-capacity line** — the direct effect.
2. **Spawn utilization and queue depth** — the overheating mechanism itself.
3. **Forgone mining + pile decay** — what overheating costs in energy.
4. **Controller allocation vs actual (P7, the variance bridge)** — the score
   consequence, and the noisiest of the four.

## 5. Honesty limits, stated up front

- **One month per handicap per cycle is a phase sample, not a rate.** Spec 41 says
  it; the bank cycle is ~6 months long. Do not rank adjacent handicaps off a single
  cycle.
- **The ramp is confounded with time.** Anything else drifting monotonically —
  road completion, RCL progress, a construction backlog draining — enters the same
  regression as the handicap. Cycling is the control; a handicap that looks good in
  cycle 0 and bad in cycle 1 is measuring the drift, not the handicap.
- **21 steps, not 20.** The owner said "from 0 to 20", and 0..20 inclusive at 1% is
  21 months. The 20% endpoint is kept because it brackets the retired 10% handicap
  at the exact midpoint of the sweep.
- **The sweep does not fix the mispricing it measures.** The successor stands:
  price measured per-route replacement overhead into admission, and then the margin
  is redundant rather than merely tuned.
