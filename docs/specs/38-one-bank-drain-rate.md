# Spec 38 — One bank-drain rate

**Status: BACKLOG (owner 2026-07-30).** Raised by the owner during the audit
loop: *"Can't the plan take into account the draining 300 K bank?"* The answer
is **yes, and it already does** — but three different drain rates exist and
the plan's *spawn-parts* budget is computed against the smallest while the
*consumption chain* draws the largest. Problem inventory first (same shape as
spec 37); the direction section is short and non-binding.

## The plan is NOT blind to the bank (measured, t72681617)

The premise that "consumers ignore the plan" — which I stated loosely in the
t72681617 audit — is **too strong and is corrected here**:

```
flow segment assembly:  {"graphSources":38,"mined":38,"transient":4,"bank":1}
total sink allocation:  286.2 e/t   vs ~100 e/t mined income
controller sink:        allocated 50.0 e/t  (demand 312)
upgrader sizing stamp:  planAllocated 50.02   <- it READS the plan
feeder sizing stamp:    planFlow 50.02, surplusRate 94.694, relayRate 89.694
```

`bankToTransientSource` injects the storage as a real planner source at
`bankSurplusRate`, and the solver routes it like any transient stock. The
plan's energy side models the bank correctly.

## P-A. THREE drain rates, and the chain uses the largest

| # | rate | value @ banked 189,541 / reserve 70,000 | consumed by |
|---|---|---|---|
| 1 | solver's routed controller allocation | **50.0 e/t** | the parts ledger (budgets the fleet) |
| 2 | `bankSurplusRate` = `min(MAX_SURPLUS_DRAW, surplus/SURPLUS_DRAIN_TICKS)` | **79.7 e/t** | the plan's bank SOURCE rate; the regime lens |
| 3 | `feederRelayRate` = `STORAGE_UPGRADE_TARGET + bankSurplusRate` | **94.7 e/t** | the feeder relay → upgrader inflow → fleet size |

Measured consequence at t72681617: feeder `relayRate 89.694` (94.694 − 5
constructionAbsorb) → upgrader `inflow 89.694` → upgrader `allocated 90.13`
against `planAllocated 50.02`. The upgrader corp fields **91 parts** where
P4's ledger budgets **69** for it.

## P-B. The overshoot is STRUCTURAL, not a tuning drift

```ts
export function feederRelayRate(banked, reserveTarget) {
  return STORAGE_UPGRADE_TARGET + bankSurplusRate(banked, reserveTarget);  // 15 + rate
}
```

`feederRelayRate` is `bankSurplusRate` **plus a constant 15**. So the
consumption chain out-draws the plan's own bank-source rate by
STORAGE_UPGRADE_TARGET **always, by construction** — even if the solver routed
100% of the bank source to the controller, the feeder would still pull 15 e/t
more than the plan injected. This is not a threshold that can be tuned into
agreement; the two formulas cannot converge while one is defined as the other
plus a constant.

## P-C. It is a documented, incident-backed OVERRIDE — do not "just clamp it"

`feederRelayTarget`'s surplus branch says so in its own comment:

> "SURPLUS (bankSurplusRate > 0): the raw surplus formula, **IGNORING the
> plan's controller allocation** — consumers size from actuals, never the goal
> plan (macro doctrine)."

The incident behind it (prod **t72455355**): the plan's parts ledger exhausted
*before* the controller sink (allocated **2**) while **340k** stood banked;
clamping the feeder to that plan number sized it to relay **7** while the
upgraders' own sizing assumed **115** — controller stock drained **1520 → 60**.
So the override exists precisely because the solver's controller allocation
can be starved by the parts ledger while the bank is full. **Any fix that
simply makes the feeder obey the solver's number re-opens t72455355.**

This is the spec's central tension: the plan number is *sometimes* an
artifact of parts starvation (must be ignored), and *sometimes* the correct
budget (must be obeyed), and today's code cannot tell those apart.

## P-D. Violates the single-home rule for economic formulas

CLAUDE.md: *"ALL economic formulas live in `economy/primitives.ts`. No module
reimplements them."* "How fast does bank energy reach the controller" has
three live answers. `feederRelayRate`'s own docstring claims the opposite —
*"all three consumers ... read this one function, so they cannot disagree"* —
which is true of the feeder/upgrader pair but **not** of the solver, the
fourth reader nobody counted.

## P-E. The measured cost: an unbudgeted spawn-parts gap

The gap this explains (t72681617, and flat across every capture that session):

```
measured spawn partsPerTick   0.642   (util 0.978 / 0.949, queueDepth 8 / 8)
plan-implied (P4)             0.422   (0.63x physical)
unbudgeted                    0.220 parts/t  = 33% of the physical ceiling
```

The 90% planning headroom (spec: SPAWN_PLAN_FRACTION, shipped 2026-07-30)
reserved 10% for exactly this class and was **falsified** as a lever: the
overspend is ~3.3× the margin, and `partsPerTick` did not move at all across
the deploy (0.652 → 0.642) while the plan obediently fell 0.95× → 0.63×. Part
of the residual is genuine transition cost (fleet grew 676 → 798 parts on the
wartime exit; the parts ledger prices an *equilibrium*, spec 11's GOAL plan,
never the ramp) — but the drain-rate disagreement is the part that is
structural and permanent.

## Open questions (the real work, not yet answered)

1. **Which number is right?** If the chain's 94.7 is correct behaviour (it is
   converting idle capital into control points at 67.6 e/t — the best score
   rate of the session), then the *ledger* is wrong to budget 50 and P4 has
   been under-reporting the fleet all along. If 50 is right, the colony is
   over-fleeting its consumers by ~1.8×. **Not yet determined** — do not
   assume the smaller one is "correct" just because it is the plan's.
2. **Can the solver's controller allocation be made trustworthy** — i.e. can
   the parts-starvation artifact of t72455355 be distinguished from a genuine
   budget, so the override's precondition disappears? The `partsLedger.dry`
   flag (shipped v9) may already be that discriminator: t72455355 would have
   read `dry: true`, and t72681617 reads `dry: false` with 0.070 p/t unspent.
   Unverified hypothesis — check `dry` against the two captures before
   building on it.
3. **Does the parts ledger need a transition term at all** (spec 11 GOAL vs
   NOW), or is the ramp cost small enough to leave in the headroom?

## Acceptance shape (measurements, not code)

1. ONE function answers "how fast does bank energy reach the controller",
   in `primitives`/`bank`, with the solver among its readers; a conformance
   test asserts solver-allocation and feeder-relay agree in the surplus regime.
2. t72455355 is pinned as a regression test **first** — bank full, parts
   ledger dry, controller sink allocated ~2 — and the new rule must NOT starve
   the relay in it.
3. P4's plan-implied parts/tick tracks measured `partsPerTick` within the
   multi-draw band in steady state (today: 0.422 vs 0.642).
4. No loss on the score: rclProgress rate must not fall below the band around
   its pre-change value (67.6 pts/t at t72681617).

## Direction (non-binding)

Most likely the plan should inject the bank source at the rate the chain will
actually draw (`feederRelayRate`, not `bankSurplusRate`) so the parts ledger
budgets the fleet reality will build — with the solver's controller allocation
kept as the *floor* it already is rather than a ceiling, and the override's
precondition narrowed to the parts-dry case it was born for. That is one
candidate, not a decision; question 1 above must be answered with data first,
because it determines whether this is a ledger-honesty fix or a real
over-fleeting bug.
