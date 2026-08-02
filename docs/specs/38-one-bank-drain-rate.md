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

## P-F. THE PLAN IS ADVISORY, NOT BINDING — the premise under everything above

Owner, pressing on the assumption the whole fidelity argument rests on:
*"IF we follow the plan in fact."* Checked in code, not inferred:

1. **Commissions DO declare a price.** `Commission.consumes.spawnPartsPerTick`
   exists and is populated — `commissionPlan.ts:138` prices a miner commission
   as `minerSpawnLoad(distance) + Σ routes.spawnParts`.
2. **Nothing enforces it.** `grep partsLedger|plannableSpawnParts` across
   `src/` returns hits ONLY in the planner, the flow adapter and telemetry.
   **No spawn-side code reads the budget.** `SpawnScheduler` fills demands by
   priority; it never sums declared prices, never compares them to the ledger,
   and cannot decline a demand for exceeding it.
3. **Exactly ONE corp reads a plan allocation at all** — `UpgradingCorp`
   (`setSinkAllocation`). Every other corp sizes from its own lens (route
   rate, stock/inflow, site absorb, spawn appetite). And the one that reads it
   overrides it: measured `planAllocated 50.02` vs `allocated 90.13`.

So the parts budget shapes **which commissions the solver makes**; it never
bounds **what gets spawned**. There is no feedback loop from the ledger back
to the spawn queue.

**Consequence for the 10% headroom's transmission path** (the open question
the steady-state read was meant to answer — now partly answerable from code):
a smaller budget can only drop MARGINAL COMMISSIONS. It cannot shrink the
bodies of the corps that survive, because no corp asks the plan how big to be.
So a 10% budget cut yields *some* shrinkage (the cheapest routes fall out) but
categorically not a 10% smaller colony — and the surviving corps' bodies,
which are most of the spend, are untouched.

**This is the root the other problems grow from.** P-A's three drain rates,
spec 37's fuel lens, and P4's under-counts are all instances of the same
thing: the plan describes a colony, the runtime builds a different one, and
no mechanism reconciles them. F1 measures the total divergence; this section
names why it is structurally nonzero.

**NOT a call to make the plan binding.** A hard parts cap at the spawn door is
a GATE, and the trap list is explicit that scarcity acts through PRICE, not
gates ("the planner prices — it doesn't gate"); a cap would also re-open the
t72455355 class in a new place. The open question is what a *pricing*-shaped
reconciliation looks like — most likely making corps' own lenses derive from
the same primitives the plan prices with, so agreement is structural rather
than enforced.

## OWNER DECISION 2026-07-31 — invert the doctrine: actuals go INTO the plan

> "Consumers sized from actual. Let's invert that though. Let's incorporate
> the actual into the plan. So a bank with 30k surplus over 1500 ticks is a
> 20 e/t source. Same thing right? But a single consistent framework."

This RESOLVES Q1 and Q2. The single framework is: **actuals → plan →
consumers**, one direction, no side-channel lenses. Notably the injection
half already exists — the owner's example is `bankSurplusRate` to the digit
(`spendableBankSurplus / SURPLUS_DRAIN_TICKS` = 30k/1500 = 20 e/t), and
`bankToTransientSource` already feeds the solver at exactly that rate. What
the decision changes is the OTHER half:

1. **`feederRelayRate`'s `+ STORAGE_UPGRADE_TARGET` dies.** The 15 e/t save-
   regime sip becomes a standing controller-sink floor INSIDE the plan (it is
   an allocation, not an out-of-plan bonus), so P-B's structural overshoot is
   gone by construction.
2. **The consumer override (P-C) dies.** Feeder and upgrader read the plan's
   routed controller allocation, full stop. "Consumers size from actuals"
   stops being a bypass doctrine and becomes literally true THROUGH the plan,
   because the actuals (bank stock, controller stock, piles) are plan inputs.
3. **t72455355 therefore moves INSIDE the solver as an invariant**: the
   parts-ledger fill must never starve a sink that the plan's own bank source
   is routing to below the sip floor while that source stands. That is a fill-
   order guarantee (production-first already exists; this extends the floor to
   the bank-fed controller sip) plus the pinned regression test the spec
   already demands. The `partsLedger.dry` discriminator becomes unnecessary —
   there is no override left to arm.
4. **The oscillation churn (t72684708) gets its structural fix here too**: if
   the pending/placeable construction claim enters the SAME solve as a sink,
   the upgrader sizing sees the residual surplus (surplus minus the build
   claim about to stand up) and never buys 1500-tick bodies against a surplus
   with 300 ticks of remaining life. The buy-then-recycle regression
   (~9,000e/period) is priced away rather than hysteresis-patched.

**Spawn-parts pricing rider (owner, same message):** *"spawn costs per the
plan should be ratioed via effective ttl — a spawn 750 ticks away for delivery
effectively costs double the body parts."* `effectiveLife(distance) =
CREEP_LIFETIME − distance` already exists and most producer classes amortize
with it; the decision makes it UNIVERSAL: every commission's
`spawnPartsPerTick` — consumers included — is `parts / effectiveLife(delivery
walk)`, claim bodies over `CLAIM_LIFETIME`, and the F1/P4 comparison uses the
same basis so plan and measurement cannot diverge on amortization convention.

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
   **CHECKED 2026-08-02 (phase-0 hedge of the income-statement program):**
   neither committed capture is dry — t72725767 (SURPLUS regime, bank 130,795,
   controller allocated 77.6) reads partsLeft 0.133, and t72734018 (FILLING
   regime, bank 67,206, allocation at the 15 floor) reads partsLeft 0.216. So
   `dry` never fires in either live regime today and the t72455355 state
   (bank full + ledger dry + allocation ~2) does not occur organically — the
   acceptance-1 conformance test MUST STAGE it (grid cell, owned-schema
   storage) rather than wait for a live capture. The outcome-level pin
   already landed green in test/unit/economy/bank.test.ts ("t72455355 pin: a
   full bank NEVER starves the relay").
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
