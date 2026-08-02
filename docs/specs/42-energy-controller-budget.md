# Spec 42 — The energy controller budget (the end state)

**Status:** BACKLOG 2026-08-01 (owner: *"since it seems some of this is a little
bit flaky write a spec on the backlog... basically describe the end result of
this energy controller budget we're working on"*).

**Deliberately overlaps specs 14, 15, 20, 38, 39, 40 and 41.** Those describe
mechanisms, mostly built one incident at a time. This one describes the
DESTINATION — what the finished thing is, and how a future session knows whether
it has arrived. Where a piece already exists it is marked ✅ and named, so the
spec doubles as the map of what is left.

---

## 1. The thesis

**The colony is a firm, and its energy account is the accounting system that
makes it controllable.**

Owner, 2026-07-30: *"more than points what we're chasing is a controllable
economy... so that we can plan it all on the abstract level and then it gets
implemented faithfully... we end up having to chase down why is this or that
thing happening. That's something to optimize for as well."*

Controller progress is the P&L bottom line, but the target is not "more score".
The target is that **we can state a budget in advance and the colony executes
it**, so that when it does not, the account says WHERE rather than THAT.

Every leak we have chased this program was invisible for the same reason: no
account had a line for it. A cost with nowhere to go does not show up as a
variance — it shows up as a mystery, months later, when someone asks the right
question.

## 2. The end state, in one page

```
  ENERGY ACCOUNT              BUDGET      ACTUAL    VARIANCE
    mining capacity            100.00      100.00      +0.00
    - forgone (miners held)      0.00       -0.00      +0.00   <- goes to zero
    = gross mining             100.00      100.00      +0.00
    - operating cost            -X.XX       -X.XX       small
    - measured losses           -Y.YY       -Y.YY       small   <- BUDGETED too
    = appropriations            +Z.ZZ       +Z.ZZ       small
  ----------------------------------------------------------
    RESIDUAL                        -        ~0.00              <- the goal
```

Four properties define "done":

1. **Every line has a BUDGET, not just an actual.** A line the plan does not
   price is a line the plan cannot control. Today the whole MEASURED LOSSES
   block prints `-` in the budget column.
2. **The residual is ~0 and stays there.** Not small because we stopped
   measuring — small because every joule has a named home.
3. **Variances are attributable to ONE of two natures:** plan accounting, or
   runtime behaviour. The controller variance bridge already makes this split;
   the end state is that it explains ~100% instead of leaving an "unexplained
   (window mismatch)" term.
4. **The same numbers survive comparison over time** — fiscal periods, one
   methodology stamp, append-only closes. ✅ spec 41.

## 2b. The finished report, line by line

Owner 2026-08-02: *"even if we don't have the numbers show me what the report
would look like ie in terms of line items."* This is the target layout.
`OK` = live today, `~` = measured but unbudgeted, `--` = does not exist yet.

```
ENERGY ACCOUNT   e/tick   (window 1500t - all sides cumulative)   [methodology #N]
                                                    BUDGET     ACTUAL   VARIANCE
  REVENUE
 OK  mining capacity (reserved rate)                 100.00     100.00     +0.00
 OK  - forgone: miner held, buffer full                0.00     -17.13    -17.13 U
 --  - forgone: source unstaffed (no miner alive)      0.00      -X.XX
 --  - forgone: room unreserved (10->5 e/t)            0.00      -X.XX
 OK  = gross mining                                  100.00      82.87
 OK  + pile drawdown / (build-up)                          -      +0.04
 OK  = DELIVERED INTO THE ECONOMY                    100.00      82.91

  DIRECT COST OF MINING            (measured at the spawn)
 OK  extraction    miner                              -4.47      -1.46
 OK  evacuation    hauler                            -13.52     -30.83 U
 OK  reservation   reserver                          -16.85     -13.54
 OK  link transfer tax (3% per hop)                   -0.60      -3.04 U
 OK  = NET MINING MARGIN

  OPERATING OVERHEAD               (measured at the spawn)
 OK  infrastructure  feeder, tender, scout             -1.55      -0.83
 ~   defense         guard, tower refill                    -      -4.06
 OK  consumers       upgrader, builder                 -6.68      -0.63
 OK  = TOTAL SPAWN (the fleet charge)                 -40.25     -51.35 U

  LOSSES                           (energy destroyed, not spent)
 ~   ground pile decay                                      -     -11.85
 ~   tombstone - creeps died carrying                       -      -4.98
 ~   repair - energy spent holding hits                     -      -3.61
 --  raid losses (invader theft + kills)                    -      -X.XX
 --  tower burn (energy fired, not repaired)                -      -X.XX
 --  overfill / dropped in transit                          -      -X.XX
 ~   = TOTAL LOSSES                                         -     -20.44

  APPROPRIATIONS
 OK  controller (score)                               81.19      38.78 U
 OK  construction (site progress)                      0.00       0.00
 --  expansion capex (claim + founding)                0.00       0.00
 OK  to/(from) bank                                  -32.14      +8.81
 OK  = TOTAL                                          49.05      47.59
  ------------------------------------------------------------------------
 OK  RESIDUAL (unattributed)                                -      ~0.00

  DEPRECIATION MEMO                (not cash - never book wear twice)
 ~   structure decay accruing                                       4.26
 ~   repair actually paid                                           3.99
 ~   = shortfall, deferred to rebuild price                         0.27

  BALANCE SHEET                    (energy, at close)
 --  free        storage + terminal above reserve                   X,XXX
 OK  reserved    warchest target                                   70,000
 --  committed   in-flight: creep cargo, tombstones, ground piles   X,XXX
 --  standing    fleet at replacement body cost                     X,XXX
 --  fixed       structures at rebuild cost, net of decay           X,XXX
 --  less: accrued decay (deferred repair)                         -X,XXX
 --  = NET WORTH
```

The RESIDUAL line is the whole test: in the end state it reads **~0.00 because
every joule has a home**, not because measurement stopped.

## 3. What the budget IS

The **controller budget** is the plan's controller sink allocation: the energy
the planner says is available to burn at controllers after everything else is
paid. It is the residual of the *plan*, exactly as score is the residual of the
*colony*. Those two must converge.

```
  controller budget = mined
                    - fleet maintenance      (spawn sink charge)
                    - infrastructure         (feeders, tenders, reservers)
                    - construction
                    - losses                 (decay, rot, tombstones, transfer tax)
                    - bank accumulation      (or + bank drawdown)
```

**Every term on the right must be priced by the planner, at the decision site
that reads it.** The recurring failure of this program is a cost that is real,
measured, and priced NOWHERE — so the controller silently absorbs it, because
the controller sits below the spawn on the value ladder and receives whatever is
left.

| term | priced? | where |
|---|---|---|
| fleet maintenance | ✅ | spawn sink charge, converged fixed point (`convergeFleetCharge`) |
| infrastructure | ✅ | `infraSpawnEnergy` — **33 e/t, 65% of the fleet charge, never audited** |
| per-source haul | ✅ | `netEnergy(rate, distance)` |
| invader tax | ✅ | per-source `tax` term |
| link transfer tax | ✅ 2026-08-01 | per-source `tax` term, one hop |
| construction | ✅ | all-in commission price (spec 34 D4) |
| bank accumulation | ⚠️ | three drain rates disagree — **spec 38** |
| **ground pile decay** | ❌ | measured 15.67 e/t, priced nowhere |
| **tombstone losses** | ❌ | measured 12.21 e/t, priced nowhere |
| **structure decay** | ❌ | accrues 4.26 e/t; repair 3.99 e/t is spent but unbudgeted |
| **forgone mining** | ❌ | 30.28 e/t of capacity never harvested; now *reported*, still unpriced |
| **link throughput ceiling** | ❌ | 58% of hub fires clamped; the plan assumes full flow |

The unpriced rows sum to roughly **60 e/t against 100 e/t of capacity.** That is
the size of the prize, and it is why the controller allocation and the measured
score have never agreed.

## 4. The invariants (what must never regress)

- **The account balances by construction.** Revenue − costs − appropriations =
  residual, published on both sides so the residual cannot silently grow.
  ✅ spec 15.
- **Revenue is MINED, never capacity.** A miner held at a full buffer is not
  producing; `heldFrac` says so at the decision site. ✅ methodology #3.
- **No line is derived as the balancing figure.** Deriving income from the other
  terms would make the residual circular and therefore meaningless.
- **Measurement natures are stated, never blurred:** EXACT / MEASURED / MODELLED
  / PLANNED. A modelled liability (structure decay) must not be booked as cash
  next to the repair that services it — that double-counts the same wear.
  ✅ methodology #2.
- **Window coherence.** The residual is a difference of rates; rates from
  different windows may not be differenced. ✅ methodology #3 guard — and
  STRUCTURALLY satisfied since #7 (2026-08-02): every account side now
  differences CUMULATIVE Memory-persisted totals between the capture pair
  (gcl/storage always did; losses since #5 / core v22; spawn costs since #7 /
  core v25 `spawnSpend`), so on modern capture pairs the guard is quiet by
  construction and fires only on pre-#7 baselines, where the ring fallback
  still applies.
- **One formula, one home.** Every economic formula lives in
  `economy/primitives.ts`. The link tax living only in `telemetry/LinkMeter` is
  exactly how the plan came to treat link haulage as free for months.
- **Plan and runtime share the valve formula.** ⚠️ P12 currently FAILS at
  **2.74×** divergence on the non-bank term.

## 5. Acceptance — how we know it is done

Ordered so each stage is independently shippable and independently useful.

### Stage A — every loss has a budget *(next)*
`MEASURED LOSSES` prints a BUDGET column. The planner prices pile decay from the
buffer levels its own gate creates, tombstone loss from fleet turnover, repair
from the decay it must service, and link tax from routed link flow.

- **Test:** for each loss line, `budget` is a number, never `-`.
- **Test:** each budget is computed from a `primitives` function, and the
  kind-conformance suite pins meter and planner to the same one (1e-9).
- **Ledger:** a row FAILS when any loss line's |variance| exceeds 25% of budget.

### Stage B — the residual closes
`|residual| ≤ 5% of gross mining` on a window-coherent capture, sustained across
two consecutive fiscal months. *(Window-coherent captures exist by construction
since #7 — any v25+ capture pair qualifies, so this stage is unblocked.)*

- **Test:** a grid cell asserting the identity closes on a synthetic world where
  every loss is stageable and therefore exactly known.
- Raid losses and tower burn get meters, or an explicit `unmeasured` line — a
  named gap, never silent absorption.

### Stage C — budget equals actual
`|controller actual − controller budget| ≤ 10%` over a fiscal month, and the
variance bridge explains ≥ 90% (today: an unexplained term remains).

- **Prerequisite:** P12 unified — plan and runtime compute the valve from the
  same function on the same inputs.
- **Prerequisite:** spec 38 — one bank-drain rate.
- **Test:** `fid-*` grid cells assert budget-vs-actual, not just plan-vs-fielded.

### Stage D — the budget is a control surface
Changing a goal weight moves the controller budget, and the colony's measured
score follows within one fiscal month.

- This is the point of the whole program: the plan becomes a **lever**, not a
  forecast.
- **Test:** an A/B harness run where a goal change predicts a score delta and
  the measured delta lands inside the predicted band.

## 6. Why "flaky", and what fixes it

The owner's word for the current state is right, and the cause is structural
rather than sloppy: **the account has been extended one incident at a time, and
each extension changed what the numbers mean.** Four methodology bumps landed in
a single day (2026-08-01) — each individually correct, and collectively a report
whose two halves are not comparable across a few hours.

Three rules, adopted from that experience:

1. **`METHODOLOGY` bumps in the same commit as any chart change**, and the
   bump note states what is NOT comparable. ✅ enforced by convention today;
   should become a test that fails when the account's line labels change without
   a bump.
2. **A new line lands with its budget, or it lands explicitly as
   `unbudgeted`.** Actual-only lines are how the residual got to 32% of gross
   mining without anyone noticing.
3. **Instrument before pricing.** Every pricing term added this program that was
   argued from structure rather than measured was wrong — twice in one day on
   the fleet charge alone. Measure the response, then price it.

## 7. Open questions

**RESOLVED 2026-08-02 — is the link tax a mining cost or a loss?** It is
TRANSPORT (owner: *"link tax is similar to haul body"*). A hauler body and a
link hop are the same kind of thing: a per-source cost that scales with the flow
it moves. Only the CURRENCY differs — the body is paid in spawn parts, the hop
in delivered energy. Booking it as a loss put the transport bill for
link-served sources in a different section from the transport bill for walked
ones, which is precisely what let link haulage read as free: `cd90`/`cd92`
showed `hauler 0.00` and `net 10.00` for months. It now sits in DIRECT COST OF
MINING beside evacuation, nets against NET MINING MARGIN, and carries a `link`
column in the source P&L so **no source can show zero transport**. Methodology #6.

The same test should be applied to every remaining "loss": *is this energy
destroyed by accident, or is it the price of a service the colony is buying?*
Ground rot and tombstones are accidents. The link tax was a price.

- **Should forgone mining be a REVENUE contra or an operating cost?** It is
  currently a contra (capacity − forgone = gross). If the haul deficit is the
  cause, it is arguably a hauling cost — and putting it there would make the
  evacuation line carry its true price. Deferred until E6 is fixed, because the
  answer changes once the number is small.
- **Does the bank belong in appropriations or in a balance sheet?** Today it is
  an appropriation (`to/(from) bank`). A balance-sheet section
  (reserved / committed / free) was the owner's suggestion 2026-07-31 and needs
  commitment accounting first.
- **What is the unit of the budget — energy, or spawn parts/tick?** The account
  is in energy; the parts ledger (P4) is in parts. They measure the same
  scarcity through different constraints, and F1 lives in the seam between them.
