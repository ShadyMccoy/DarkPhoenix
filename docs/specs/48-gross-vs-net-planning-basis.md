# Spec 48 — the plan is a GROSS book, the account is a NET book

**Owner 2026-08-06:** *"Also there's a silly problem with some of this
tangential. Why is this using the entire gross energy budget? It should use the
net energy budget more like. Idk something there is quite wrong it seems."*

Something is. This is the measurement, the mechanism, and the open question —
no fix is proposed here, because the answer changes the shape of the solve and
that is the owner's call.

## The measurement (t72811290, 962t window)

The solver's own sink table against the same window's ENERGY ACCOUNT:

```
  SOLVER                                    ACCOUNT (same window)
    spawn          26.00                      gross mining      95.87
    spawn          18.45                      - fleet (spawn)  -38.05
    construction    7.43                      - measured loss  -15.86
    construction   10.06                      ================================
    storage       104.03                      = appropriable    41.96
    controller      0.00
    ------------------                      the plan appropriates
    ALLOCATED     165.97                      construction + storage + controller
                                              = 121.52  =  2.9x the real net
```

Allocation of 165.97 against 120 e/t of mined capacity is not itself an error —
the difference is bank draw-down, which is a legitimate source. **The error is
one level up, in what the sinks are competing FOR.**

## The mechanism: the fleet is a SINK, and losses are nothing at all

Two things the account treats as coming off the top, the plan does not:

1. **The fleet is modelled as a CONSUMER.** `spawn` sinks claim 44.45 e/t at
   sink value **100** — the top of the ladder — so they win first and the rest
   compete for what is left. Arithmetically that lands in the right place, but
   it means every downstream sink's *demand* is quoted against a supply that
   still contains its own cost of production. The same fleet then appears in
   the account as a **−38.05 e/t operating cost**. One fleet, two books, two
   numbers (and the ledger already prints the gap as *"the plan ROUTES 44.45
   e/t to the spawn sinks — OVER-routing its own fleet by 10.48 e/t of disposal
   flow the spawn cannot convert"*).

2. **Losses are not in the plan at all.** Ground decay, tombstones and repair
   measured **15.86 e/t** this window. The plan's budget for them is
   **0.00** — which is exactly why L1 has been the ledger's TOP LINE for four
   consecutive cycles at "42x budget": the budget is zero, so any loss is an
   infinite ratio. L1 is not reporting a leak so much as reporting that the
   plan does not model loss.

Net of both, ~42 e/t is genuinely appropriable and the plan appropriates 121.5.
The books only reconcile because **storage silently absorbs the difference** —
104.03 e/t routed to a sink whose value is **1**.

## Why this shows up everywhere else

Several standing anomalies are the same defect wearing different hats:

- **P4 / P12 "over-routing"** — the plan routes more to spawn sinks than the
  spawn can physically convert. That is a gross-basis artefact.
- **The bank as permanent residual claimant** (spec 38 phase D) — with the
  fleet priced as a sink and losses unpriced, storage is where the gross-vs-net
  gap has to go.
- **E4 idle capital** — the surplus the bank keeps re-accumulating is partly
  this gap, not real wealth.
- **L1's 0.00 budget** — see above.

## The open question (owner's call — NOT built)

Should appropriation sinks compete for **net** supply — gross mining, less the
standing fleet's cost, less a modelled loss allowance — with the fleet ceasing
to be a sink at all?

Arguments it is right: one book instead of two; the spawn stops being a
value-100 "consumer" that outranks the things it exists to serve; L1 gets a
budget that is not zero, so it can report a real ratio; and the plan's
appropriations become achievable by construction, which is the fidelity
objective (CLAUDE.md: *"a plan the runtime does not follow costs more than the
energy it misprices — it costs the DIAGNOSIS"*).

Arguments to be careful: the fleet's cost is endogenous — sizing it needs the
plan that its cost constrains — which is why the two-pass solve exists
(`spawnMaintenance` is already a pass-2 input). A net-basis solve may just be
pass 2 done honestly, or it may reintroduce the fixed-point that missed its
predictions by 4x on 2026-08-01. **That failure is the reason this is filed and
not built.**

The cheap first step, if the owner wants one: give losses a **non-zero budget**
from the measured loss meters and see whether L1 stops being the top line by
becoming reportable rather than infinite. That is one number, reversible, and
it tests the "plan does not model loss" half without touching the solve.
