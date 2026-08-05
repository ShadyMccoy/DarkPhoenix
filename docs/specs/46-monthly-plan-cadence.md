# Spec 46 — Monthly plan cadence (the budget IS the month's plan)

**Owner directive (2026-08-05):** "Another concept we are going to introduce
is in the code we take the budget/plan and we use that for the next fiscal
month. We can still resolve along the way and identify large variances as
signals to adapt, but for now let's set the plan month to month to avoid
thrashing and provide clarity in reporting. It's kind of setting the plan
solving from 50 to 1500 effectively."

## The problem this solves (measured)

The solve cadence (~50t) re-decides the whole economy ~30x per fiscal month.
Measured costs, all from this incident stream:

- **Boundary flap**: d017 funded at t72801354, over-budget at t72801208,
  funded again a solve later — a route exactly at the tranche edge flaps
  with solve-to-solve noise in OTHER candidates' parts estimates (paved
  fractions, drain terms). Every flip is commission churn risk (P1's
  business) and re-based capacity in the reports.
- **Reporting opacity**: a fiscal close currently spans dozens of budgets;
  "budget vs actual" columns compare actuals against whichever solve the
  capture happened to sample (methodology #11's stamp-comparability rule is
  partly a workaround for this).
- **The knapsack gap**: the greedy fill's residual slot changes occupant per
  solve (the phantom-funding incident rode exactly this).

## Design

**The month's solve is the month's BUDGET.** At each fiscal month boundary
(spec 41 calendar: 1500t = CREEP_LIFETIME, so a budget spans exactly the
horizon every body purchase amortizes over) the solve runs and its outputs
FREEZE as `Memory.fiscalBudget`:

- the funded producer set (sourceVerdicts) and route sizes,
- sink allocations (controller / construction / spawn claims),
- the published valves (controllerAllocations, warchestTarget),
- the commission set.

Execution serves that budget for the month. The NOW plan (spawnAgenda)
stays live tick-to-tick as today — it is the transition machinery, not the
plan (spec 11's two-plans doctrine unchanged).

**Shadow solves continue on the old cadence** but publish NOTHING. Their
divergence from the frozen budget becomes a ledger row — the variance
signal the owner names. A LARGE variance is a signal to adapt: an early
re-solve replaces the budget mid-month, stamped with its trigger (never
silent).

**Early re-solve triggers** (proposed; thresholds to be measured, not
argued):
- structural: a funded room flips hostile (defund is IMMEDIATE — defense
  never waits on a calendar), a funded source's room is lost, a spawn dies,
  RCL/GCL transition, expansion campaign events;
- variance: shadow-solve funded income diverging from budget beyond the
  ±30% multi-draw band, sustained (not one draw);
- danger: anti-downgrade floors arm regardless of budget (the reserve
  pre-pass is not calendar-gated);
- operator: console force (`global.plan()`) always re-budgets.

**Cold start / bootstrap:** the eager-solve gate keeps its fast cadence
until the first stable month closes — a founding colony re-plans by events,
not by calendar.

**Mid-month world changes:** construction sites placed mid-month build from
the standing budget's residual/bank policy and are formally admitted at the
next boundary ("banking excess is fine" — owner 2026-08-05). Newly scouted
sources wait for the boundary by construction (prospects are already
non-candidates).

## What this buys the reports

Every fiscal close measures ONE budget. The ENERGY ACCOUNT's BUDGET column
becomes literally the month's frozen plan; F1/F2/F3 fidelity reads stop
mixing solve generations; P1 flap should go structurally quiet (a flip
requires a stamped trigger); the CONTROLLER VARIANCE BRIDGE decomposes
against a stable baseline.

## Phases

- **A (cadence)**: month-aligned solve in main.ts's planning trigger +
  the trigger list above + the trigger stamp. The interval alone kills the
  flap class.
- **B (budget object)**: persist the frozen solve outputs as
  `Memory.fiscalBudget` with `{month, solvedAt, trigger}`; consumers read
  the budget, not the latest solve.
- **C (ledger integration)**: audit:ledger/fiscal:close read the frozen
  budget for BUDGET columns; methodology stamp bump in the same commit.
- **D (shadow variance row)**: the shadow solve's divergence as a standing
  ledger line with the adapt-threshold verdict.

Phase A is implementable immediately; B-D follow once A's live behavior is
verified over a full month window.

## Phase A as BUILT (2026-08-05)

- `PLAN_BUDGET_INTERVAL` / `isPlanBudgetBoundary` in economy/primitives,
  derived from `CREEP_LIFETIME` so the budget term, the fiscal month and the
  amortization horizon can never drift apart. main.ts's cadence term is the
  boundary; the CPU governor's stretch is now strictly non-binding (1500
  already exceeds even the stretched 150), so degradation can only slow
  planning further, never speed it up.
- The existing durable-transition triggers (spec 36) are unchanged and ARE
  the structural trigger set the design called for.
- **The budget-staleness trigger** (the owner's "large variances as signals
  to adapt") closes the one real hazard of a monthly budget: the ONE VALVE
  rule sizes the upgrader fleet from the published allocation and nothing
  else, so a month-old valve can keep a standing fleet drawing against a
  bank that has since fallen through its reserve. Fires on
  `BUDGET_STALE_FRACTION` (0.5) AND `BUDGET_STALE_ABSOLUTE` (15 e/t)
  together - the ratio alone fires on near-zero valves, the absolute alone
  on ordinary rich-colony drift.

### The flaw caught before it shipped (worth keeping)

The first implementation compared the live law against the PUBLISHED
allocation. That is wrong, and wrong in a way that would have restored the
exact thrash this spec removes: the published allocation legitimately
diverges from the law by PLAN POLICY - wartime relegates it to ~0 while the
law prices the whole surplus, and the physical burn cap bounds it. In the
colony's state on the day this shipped (colony-wide backlog, published ~0,
law ~41) that test would have re-forced a solve every debounce window
forever. The signal is **law-vs-law**: the law as the budget saw it
(`Memory.budgetLawRate`, published by the plan - never re-derived) against
the law now. That asks the only question that matters: has the WORLD moved
out from under the plan, as opposed to the plan having deliberately chosen
a different allocation? Pinned by the wartime test.

### Registered predictions for the phase-A deploy

- Solves drop from ~30/month to 1 plus stamped triggers; `[Planning]
  forced replan: <reason>` lines name every off-cadence solve.
- P1 plan flap goes structurally quiet (a funded-set flip now requires a
  boundary or a stamped trigger); the d017 boundary flap in particular
  cannot recur mid-month.
- CPU: the heaviest recurring block runs 30x less often - watch the CPU
  ledger's planning bucket fall, and the governor's stretch stop mattering.
- Fiscal closes describe ONE budget; F1/F2/F3 stop mixing solve generations.
- RISK to watch (the reason the staleness trigger exists): a mid-month
  world change the trigger set does NOT cover - construction completing,
  paving finishing, a source's buffer draining - now waits for the
  boundary. Expected and intended ("banking excess is fine"), but if a
  fidelity line degrades mid-month in a way that traces to a stale budget,
  that names the next trigger to add.
