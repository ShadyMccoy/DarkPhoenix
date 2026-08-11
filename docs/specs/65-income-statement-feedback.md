# 65 — The income statement feeds the next budget

**Status: DRAFT 2026-08-11 (owner-directed).** Owner, this session:

> "Corps that for whatever reason are underperforming (or over, sure, but it's
> unlikely) will get that recorded as part of the next planning cycle. This
> might even drop them from the plan, that's ok — or, hopefully, allow them to
> operate smoother (i.e. more hauling, most likely): if hauling is falling
> behind we maybe need a bigger corp on that route. However I think gradual
> changes are better. We shouldn't right away jump to the actual as the budget
> — something more like halfway in between, so over time it can approach the
> asymptote."

This is the lift of **spec 14 directive 2**, which deferred exactly this:

> "Yes eventually we will feed actuals back to inform the budget, but not
> quite yet. We have some poor behavior that's causing variants that we don't
> want to encode as the budget."

A draft, not a build order: §10 lists the questions the owner should rule on
before phase 2 (the behavior-changing half) is implemented. Phase 1 (measure
and publish, change nothing) is implementable as written.

## 1. What the deferral was waiting for, and why the door can open now

The deferral's reason was never "actuals are unclean" in the abstract — it was
that an actuals-fed number, taken raw, **ratifies the defect it measures**
(the wasteLedger pins state it exactly: "an actuals-fed budget reads high
exactly when the fleet is fat"). Three things have changed since it was filed:

1. **There is now ONE budget per month to measure against** (spec 46): the
   boundary solve freezes as the fiscal month's budget, so "actual vs plan"
   stops mixing solve generations. A feedback loop against a 50-tick solve
   cadence would have chased its own churn; against a monthly budget it
   measures a real contract.
2. **The actuals exist at corp grain, bot-side.** Segment 4 v14 carries
   cumulative, reset-surviving `produced` (harvested) and `delivered` (landed)
   per operation; the fiscal archive (`telemetry/fiscalArchive`, segments 8–9)
   snapshots the account's inputs at every boundary, so a month is closeable
   by the bot itself with ~100% coverage — unattended, which the loop must be.
3. **The precedent for actuals crossing into the pure planner is landed.**
   `FieldedFleet` already rides the adapter seam into `ColonyProblem` (spec 39
   phase 2, owner: "Incorporate the actual into the plan... a single
   consistent framework"), and `PlannerSource` already carries measured world
   facts (`swampFraction`, `pavedFraction`, `staged`). The seam is built; this
   spec adds one more measured input through it.

And the deferral's REASON gets a structural answer rather than a hope (§6):
damping, bounds, an exclusion list, and above all **visibility** — a
calibrated number is a named number, so absorbing a defect into the budget
still leaves a standing gauge line pointing at it.

## 2. The loop, end to end

One cycle per fiscal month, entirely at the boundary the code already has
(`isPlanBudgetBoundary`, `fiscalArchive.onTick` — the same seam the handicap
sweep advances on):

```
month m serves its frozen budget
        │
boundary tick t (m closes, m+1 solves):
        │
  1. CLOSE   difference per-corp delivered/produced counters across the
             month's two archive snapshots  →  measured e/t per operation
  2. SAMPLE  measured ÷ the month-m budget's declared rate, winsorized,
             evidence-gated (§4)            →  sample_m per corp
  3. UPDATE  f ← (f + sample_m) / 2         →  Memory.planCalibration
             (the owner's halfway; deadband snaps f to 1 when close)
  4. STAMP   the factor table into the archive record + the CAL gauge
  5. SOLVE   the m+1 boundary solve prices with f (armed mode only):
             flowAdapter stamps per-source calibration → CorpPlanner
             prices vector parts at model/f through the ONE roadEconomics
             seam → bigger fleet on a lagging route, or the route prices
             out of the tranche
        │
month m+1 serves the new frozen budget; repeat
```

Steps 1–4 are telemetry (phase 1, always-on, shadow). Step 5 is the behavior
change (phase 2, armed explicitly, never self-arming — spec 50's fail-safe
pattern).

## 3. What is calibrated in v0 — one factor, one seam

**Grain: the commission (corp), which is the budget row** (spec 51). Keyed by
the commission's `corpId`, which is stable per flow source (`harvest-{id}`) —
the corp-id round-trip probe (spec 61 row 4) is the regression net under the
key space; an id-space migration must migrate calibration keys or the factors
silently reset to 1 (fail-safe direction, but noted).

**Term: DELIVERY, for produce/transport operations.** v0 calibrates exactly
one thing — the ratio between what an operation landed at home and what its
budget said it would land:

```
measured_m = Δ delivered / month          (corps segment cumulative counter)
declared_m = the month-m frozen budget's routed promise for the operation
             (Σ of its vectors' flowRate — the landed basis)
sample_m   = measured_m / declared_m
```

Basis discipline (spec 48's lesson, pinned by a unit test that stages taxes
and decay so the bases differ): landed-vs-landed, never gross-at-source vs
landed. The extraction side stays a GAUGE, not a knob — F3 measures it at
0.6 e/t of gap across 100 e/t declared; extraction is faithful, and the leak
class this loop exists for is evacuation.

**Why the factor prices the TRANSPORT COST, not the source's yield.** The
planner consumes `f` in exactly one place: the vector-parts price. Wherever
the route's CARRY is sized or charged (`roadEconomics.pavedSpawnPartsFor` /
`carryPartsFor`, the same call sizing and admission already share), the
calibrated price is `model / f`. Both of the owner's named outcomes then fall
out of the existing solve with no new mechanism:

- **"a bigger corp on that route"**: the routing pass commissions the fleet at
  the calibrated price, so a route running at f = 0.85 fields ~1.18× the
  CARRY for the same flow. The mouth drains faster; delivered rises; the
  next sample walks f back up. The loop's fixed point is *delivered ==
  promised* — the plan and the runtime meeting — which is a sharper reading
  of "approach the asymptote" than "budget approaches raw actual": jumping to
  the actual would RATIFY the shortfall; the halfway walk converges to the
  point where the shortfall is gone (or the route is).
- **"might even drop them from the plan, that's ok"**: the calibrated parts
  price lowers the candidate's net-per-build-part, so a route that stays
  unprofitable at its measured efficiency loses the tranche to a better
  candidate. This is the CORRECT scarcity class by the trap list's own rule:
  it acts at the SPAWN via pricing (no new bodies), never revokes standing
  assets, and the planner prices — it doesn't gate.

If under-delivery is NOT a capacity problem (a pathing defect, a border
bounce), the bigger fleet doesn't move the sample, f keeps walking down, the
cost keeps rising, and the route eventually defunds — gradually, reversibly,
and with the CAL gauge naming it every month on the way (§6). The loop
degrades into defund-at-the-spawn, never into silence.

## 4. The calibration law (pure, in `economy/primitives`)

All constants are proposals — to be measured, not argued (spec 46's phrase).

```
calibrationStep(f, sample):
  s  = clamp(sample, SAMPLE_FLOOR, SAMPLE_CEIL)     # winsorize: 0.25 .. 4.0
  f' = (f + s) / 2                                  # the owner's halfway
  if |f' - 1| <= CAL_DEADBAND: f' = 1               # 0.05: on-model is the
  return f'                                         # resting state, exactly
```

- **Seed 1.0** — a new corp is priced at the model, always.
- **Asymptote**: against a stationary sample r, the residual halves per month
  (`|f_n − r| = |f_0 − r| / 2ⁿ`) — three months covers 87.5% of any gap. Fast
  enough to matter, slow enough that one bad month moves the budget at most
  halfway, and a transient must persist to be believed.
- **Winsorize the SAMPLE, not the factor**: the 121-tick post-reset window
  that read 26× (spec 13's ramp-body artifact) enters at 4.0, not 26 — and
  the evidence gates below should have voided it anyway.
- **Deadband**: single-window draws vary ±20–30% (the multi-draw rule); the
  EWMA already averages that down (stationary σ ≈ 0.58× sample σ), and the
  deadband keeps the common case — the model is right — EXACT, so calibration
  is the exception that names itself, not a fog of 0.97s.
- **No sample → no step**: f carries unchanged. Evidence gates that VOID a
  month's sample for a corp:
  - the corp was not in the month's frozen budget from boundary to boundary
    (commissioned late, defunded mid-month, hostile-defund trigger fired);
  - either boundary snapshot lacks its counters (pre-v14 capture, id churn);
  - a stamped mid-month re-budget changed the corp's declared rate (v0 rule:
    any mid-month re-budget voids the whole month's samples; refinable later
    to void only corps whose declared moved);
  - the source was `defunded` or transient for any part of the month.
- **Retention**: an entry for a corp absent from the plan for
  `CAL_RETENTION_MONTHS` (proposed 6) is dropped; recommissioning after that
  starts fresh at 1.0.

State (versioned, fail-safe absent):

```ts
Memory.planCalibration?: {
  v: 1;
  armed?: boolean;          // phase 2 gate; absent/false = shadow (publish only)
  corps: { [corpId: string]: {
    f: number;              // the factor
    months: number;         // evidence count behind it
    lastSample?: number;    // winsorized, for the gauge's trend column
    lastAt?: number;        // boundary tick of the last accepted sample
  }};
}
```

Absent `Memory.planCalibration`, or `armed` unset: every factor is 1.0 and
the plan is byte-identical to today's — the same NEVER-self-arms fail-safe as
the sweep, so the grid, the sims, and a wiped Memory all keep the pinned
behavior.

## 5. The exclusion list (each entry is doctrine, and each is a test)

Calibration is for operations whose price can honestly move. These cannot:

| excluded | why (the doctrine that forbids it) |
|---|---|
| tender / LinkCorp feeder + port-tender roles | **The tender is a heartbeat — assume it works.** A calibrated heartbeat is a hedged heartbeat; a measurement suggesting it underperforms is a P0 bug in the tender, fixed there, never priced around. Its instruments are spec 57's watchdog and the F-lines — it is not even SAMPLED. |
| the upgrading corp | **ONE VALVE**: the fleet is sized from the plan's controller allocation and nothing else, and its delivery is physics-pinned (~1 e/t per WORK, measured t72808131). A calibration here is the stock-grounded valve reborn. |
| declared auxiliary unit prices (reserver, guard, tender, feeder, port tender) | These are "full-budget body over the lifetime" DECLARATIONS by design (spec 51 phase 2 made the ledger read the plan precisely so a gap is an F1 signal). The wasteLedger pins — "a fatter fielded fleet does not raise its own budget" — keep their exact subject and stay green verbatim. |
| transient/scavenge sources | Stock drains with no steady rate to calibrate; already bounded by their own law. |
| claim / coreBuster | CAPEX, not a rate (spec 51 §"unit mismatch"); one-shot purchases have no monthly sample. |

Note what the pins actually forbid versus what this spec does: the forbidden
class reads the STANDING FLEET back as its own budget — same-tick circularity,
the budget moving with the thing it judges. This loop reads **delivered
energy vs a promise, over a CLOSED month, damped, at the boundary,
published**. Fleet size is not an input anywhere in it.

## 6. Why this does not bury bugs (the fidelity tension, faced)

CLAUDE.md: "Prefer a fix that makes the plan and the runtime agree over one
that buys points around the disagreement." A calibration factor IS the plan
agreeing with the runtime — from the wrong side, if the runtime is defective.
The border-bounce builder (1.15 e/t delivered against 20 allocated, inside an
"ok" verdict for hours) is the nightmare tenant: fed raw into a budget, a 37×
defect becomes next month's plan. Guards, in order of importance:

1. **The factor is a PUBLISHED, NAMED number.** A new CAL gauge in
   `audit:ledger` prints every f ≠ 1 with its trend, months of evidence, and
   last sample; the fiscal archive stamps the table into every month's
   record, so every close is labeled with the calibration it was planned
   under. Today that 37× defect hides inside an aggregate; under this loop it
   is a row reading `f 0.53 ↓ (2 months)` — the loop doesn't silence the
   evidence, it IS the evidence.
2. **Saturation is an alarm, not a state.** A sample pinned at the winsorize
   bound, or |f − 1| > 0.5 sustained two months, prints as a distress line:
   calibration has left its regime and the MECHANISM is the bug (the
   trap-list rule: if you are writing the second patch — or here, the second
   halving — on the same mechanism, interrogate the mechanism).
3. **Damping bounds the blast radius.** One defective month moves any budget
   at most halfway, and only within the sample clamp; nothing standing is
   revoked on any step.
4. **Fixing the runtime un-prices itself.** When the defect is fixed, the
   next samples run high against the walked-down promise, and f climbs back
   to the deadband and snaps to 1. Calibration is temporary compensation
   with a permanent nameplate — the CAL line is the standing queue of seams
   awaiting a real fix, priced honestly in the meantime.
5. **F1/F2/F3 keep their subject** — actual vs the frozen budget. As f
   converges, F-fidelity improving is TRUE improvement in controllability
   (the plan predicts the runtime); the model-vs-world gap it absorbed did
   not vanish, it moved to the CAL gauge where it is per-corp and named,
   which is strictly more legible than the same gap smeared across F1.

Precedents this generalizes, for the record: spec 13's R1 swap protocol is
this loop done manually for one constant (measured/priced accumulated over
≥10 windows before a hard swap — the high evidence bar exists because the
swap is undamped; per-corp halfway steps can move on one clean month because
each step is half and self-reversing). Spec 55's owner design basis ("fold
the drain into the SOURCE RATE... one auditable number, every downstream term
reprices itself") is the same shape: a measured fact folded into ONE plan
input, everything downstream repricing honestly.

## 7. Where it plugs in (file → symbol)

| piece | home | notes |
|---|---|---|
| `calibrationStep`, clamps, deadband, sample law | `economy/primitives.ts` | pure; ALL economic formulas live here (kind-conformance enforces) |
| `Memory.planCalibration` schema | `types/Memory.ts` | versioned; absent = inert |
| boundary updater (close → sample → step → stamp) | `telemetry/fiscalArchive.ts` | this module already owns the month hook, the ring, and the sweep's persistence — one seam, not two (its own stated doctrine); runs BEFORE the boundary solve so month m's close prices month m+1 |
| declared-side lookup | the month's frozen budget (spec 46 phase B object, or the boundary archive snapshot's corp rows — v17 `consumes`/`produces`) | phase B landing first makes this trivial; the archive route works without it |
| factor → planner | `economy/flowAdapter.ts` (`buildColonyProblem` stamps `PlannerSource.haulCalibration?`) → `economy/CorpPlanner.ts` | the same adapter lane as `swampFraction`/`staged`/`FieldedFleet`; planner stays pure |
| the priced seam | `economy/roadEconomics.ts` vector-parts functions | ONE seam shared by sizing and admission, so the two cannot fork — the spec-51 GAP-1 lesson (one derivation, both sites read it) |
| CAL gauge + saturation alarm | `scripts/waste-ledger.ts` | beside F1/F2/F3; archive round-trip test extended to reproduce the table |

## 8. Worked example — the mouth-pile route (spec 59's world)

A remote operation's budget promises 10 e/t landed; the month lands 7 — the
missing 3 rots at a capped container (L1's business: 13.33 e/t colony-wide
against a budget of 0.00 at t72884395; spec 55 measured 19.48 e/t of decay
rank-correlated with exactly the under-fielded routes).

- **Close m**: sample 0.70 → f: 1.00 → **0.85**. CAL prints it.
- **Budget m+1** (armed): the route's vector prices at 1/0.85 ≈ 1.18× CARRY;
  the routing pass commissions the bigger fleet — the owner's "bigger corp on
  that route" — and its net-per-part drops it two rungs down the tranche
  order, still funded.
- **If it was capacity** (the spec-55/59 class): the fleet drains the mouth,
  the month lands ~9.5, sample 0.95 vs f 0.85 → f 0.90 → 0.93 → deadband →
  **1**. The pile line falls; the calibration retires itself.
- **If it was a defect**: delivery stays 7 despite the parts, f walks 0.85 →
  0.78 → 0.74…, the route's rank sinks until it prices out of the tranche —
  dropped from the plan gradually ("that's ok"), standing haulers work their
  route to end of life (nothing revoked), and the CAL trend line has been
  pointing at the corp the entire time, with the saturation alarm firing
  before month 3.

## 9. Phases and gates

- **Phase 0 — the law.** `calibrationStep` + schema + unit suite (halfway,
  asymptote-geometric, winsorize, deadband, void-sample carry, retention).
  Pure; no behavior.
- **Phase 1 — SHADOW (measure and publish, change nothing).** Boundary
  updater + archive stamp + CAL gauge. Always-on, like all telemetry. The
  archive record gains a field (versioned); METHODOLOGY does not renumber (no
  existing number changes meaning). Deliverable: real factor distributions
  over live months — the evidence the phase-2 ruling wants. Mid-sweep OK
  (nothing the sweep measures moves).
- **Phase 2 — ARMED (the budget consumes f).** Adapter stamp + the one priced
  seam + `armed` console arming. Gate: the full regression set (unit + trio),
  the compat pin (unarmed ⇒ byte-identical plan), the grid cells below — and
  it lands only at a spec-50 sweep CYCLE boundary, since it moves the exact
  quantity the sweep varies.
- **Phase 3 — later, each its own ruling.** Consume-shape fill efficiency
  (the builder class), per-term grain when spec 40 Part A's contract table
  lands (input starvation vs output shortfall vs price overrun are three
  diagnoses one scalar conflates), auxiliary declared prices only by explicit
  owner override.

## 10. Open questions for the owner

1. **α = 1/2 per fiscal month** — confirm the halfway is per-month (three
   months ≈ 87.5% of any gap), or prefer slower (1/3)?
2. **Arming policy**: console-armed per colony after N clean shadow months
   (sweep-style, proposed), or default-armed once phase 2's cells are green?
3. **Symmetry**: overperformance (f > 1) prices routes CHEAPER and can shrink
   fleets/admit more routes. Accept symmetric, or cap upside at 1.0 for a
   first live cycle?
4. **Constants** (`SAMPLE_FLOOR/CEIL`, `CAL_DEADBAND`, saturation threshold,
   `CAL_RETENTION_MONTHS`): proposals above, to be measured in shadow.
5. **v0 grain**: one delivery scalar per operation now, or wait for spec 40
   Part A and calibrate per contract term from the start?

## 11. Acceptance (write these first; they are the contract)

1. **The law** (unit, primitives): `calibrationStep(1.0, 0.5) === 0.75`; a
   constant sample r halves the residual per step; winsorize bounds the step
   under an absurd sample (26× enters as 4.0); deadband snaps; no sample →
   identical state.
2. **The updater** (unit, staged archive ring): a clean month yields the
   landed-vs-landed sample to 1e-9; each void condition in §4 yields NO step;
   a basis-confusable world (staged taxes/decay so gross ≠ landed) fails
   unless both sides read the landed basis.
3. **The plan consumes it** (unit, staged `ColonyProblem`): f = 0.5 on one
   source doubles its vector CARRY through the one roadEconomics seam and
   halves its net-per-part; a two-candidate world flips tranche order at the
   constructed threshold; **f absent or 1.0 produces a byte-identical plan**
   (the compat pin — the door on this whole spec).
4. **Exclusions hold** (unit): a fully-populated factor table moves NO
   heartbeat, upgrader, or declared-auxiliary price; the existing wasteLedger
   no-actuals pins stay green unmodified.
5. **The books still close** (unit): `Σ(commission consumes) === partsLedger`
   (1e-9) with a factor table staged — calibration reprices, it never
   unbalances.
6. **Grid**: an armed cell stages `Memory.planCalibration` (through
   `test/grid/stage.ts` vocabulary) with f < 1 on a staged route and asserts
   the boundary budget fields the bigger vector fleet and stamps the table;
   its shadow twin (unarmed, same world) asserts the plan is unchanged AND
   the table still publishes. (Receipts-gated staging per the sim-blind-spot
   trap: the cell stages its own archive ring.)
7. **Ledger**: CAL prints every f ≠ 1 with trend and evidence months; the
   saturation alarm fires on a staged 2-month pinned factor; the archive
   round-trip test reproduces the stamped table from one capture.

## 12. Related

- **Spec 14** — directive 2 is the deferral this lifts; its reason is
  answered in §6.
- **Spec 46** — the monthly budget is the prerequisite measuring stick;
  phase B's budget object is the clean declared-side source (phase D's
  shadow-variance row is this loop's within-month sibling).
- **Specs 41/50** — the fiscal calendar and the bot-owned archive are the
  instrument; the updater lives at their boundary hook.
- **Specs 51/60** — corp-grain rows (`consumes`/`produces`/`delivered`) are
  the actual side; measurement at the door is why the counters are trustable.
- **Spec 40** — Part A's per-term contract is this loop's v1 grain.
- **Spec 48** — basis discipline for the sample (landed vs landed).
- **Spec 55** — the fold-into-the-rate precedent, and the F2 gap (declared
  vs fielded) that must NOT be laundered through calibration: F2 breach means
  the spawn didn't field the plan — fix the seam, don't reprice around it
  (an f-step on a month with F2 breach is measuring the spawn, not the
  route; consider F2-clean as an evidence gate, owner's call).
- **Spec 13** — the R1 swap protocol, this loop's manual prototype.
- **Spec 32** — graceful backoff prices the SPAWN side of a surplus mouth;
  this loop prices the ROUTE side of the same signal. They meet at the same
  defund-at-spawn class; neither revokes.
