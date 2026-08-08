# Spec 53 — Concentration of force: the RCL8 sprint, priced

**Status: BACKLOG 2026-08-06 (owner direction).** The *strategy* is not new —
[GRAND_STRATEGY §4](../GRAND_STRATEGY.md) already names the concentration engine
and picks the RCL8 sprint as its highest-value payload. What was missing is the
arithmetic: what it costs, what actually binds, and whether it pencils out. This
spec supplies that, corrects two numbers the strategy doc had wrong, and gates
the mechanism behind measurement in the usual way.

**Priority:** P2 — the analysis is the deliverable now; the mechanism waits on
the measurement legs and the owner's go.

**Companion analysis:** [docs/TRANSPORT_NETWORK.md](../TRANSPORT_NETWORK.md) —
the full derivation of every coefficient used here (transport arc costs, the CPU
accounting, terminal geometry, the market's limits).

## The owner's direction (2026-08-06)

> "What I really want is for all the rooms in the colony to coordinate to quickly
> build one room up to RCL8. So I don't care about power, I care about focusing
> all my rooms on global objectives that overwhelms other locally focused bots."

And, on the market as the transport mechanism:

> "The market is nice but for a 'war time' economy focusing energy in one area it
> might not scale to quite that level."

Both readings are correct and §4 / §6 below show why.

---

## 1. Two corrections this analysis forced

**`CONTROLLER_LEVELS[7]` is 10,935,000, not 7,290,000.** GRAND_STRATEGY's climb
table had the final step at ×2 over level 6 rather than ×3, breaking the
geometric run that holds from level 2 up. Our own captures settle it — every
telemetry fixture with an RCL7 room reads `rclProgressTotal: 10935000`
(`test/fixtures/telemetry/shard1-t72777517.json`, `rcl: 7`). RCL1→8 is therefore
**16,380,200**, of which 7→8 is **67%**, and every sprint estimate in
GRAND_STRATEGY §4 is ~50% longer than it said. Fixed in that doc 2026-08-06.

**The upgrade-boost claim needs re-verification, and it is the single largest
lever in this spec.** GRAND_STRATEGY §2 states that `upgradeController` deducts
energy on the *unboosted* WORK count but credits progress on the *boosted*
amount, making `XGH2O` two progress per one energy — free progress. If true it
**halves the entire climb**, from 16.4M of energy to 8.2M, which dwarfs every
other lever here (transport tax is 3.9% of gross; this is 50%). If false, boosts
buy throughput and creep-count only. The claim is specific and cites engine
internals, but it sits in the same document as the level-7 error above, so its
"verified" status no longer carries on its own. **Verification leg V1 below
resolves it, and nothing else in this spec should be sequenced ahead of it.**

## 2. Why concentration, stated so it can be checked

The argument does *not* rest on scheduling cleverness, and it does not rest on
combat. Both of those are real but secondary.

**The primary argument is that spawn energy capacity is the one thing that does
not pool.** Energy ships at 3.33%/room; bodies walk; CPU and GCL are global. But
a creep is built from one room's spawns and extensions:

| RCL | extensions × capacity | + spawns | max single creep |
|---|---|---|---|
| 6 | 40 × 50 | 1 × 300 | **2,300** |
| 7 | 50 × 100 | 2 × 300 | **5,600** |
| 8 | 60 × 200 | 3 × 300 | **12,900** |

A 50-part creep costs 2,500 (all MOVE) to 12,500 (all HEAL), so an RCL6 room
cannot field a 50-part creep at all. Concentration exists to overcome the one
non-poolable resource, and no amount of terminal traffic substitutes.

**The secondary argument is scheduling.** For `N` equal projects on a shared
pool: parallel finishes everything at `NW/R`; serial finishes the first at `W/R`
and the last at the same `NW/R`, halving mean completion. Compounding (a finished
room raises `R`) breaks the tie outright.

**The argument that does *not* apply here is the military one.** An earlier draft
justified concentration by the convexity of combat capability. GRAND_STRATEGY §5
and §6 — verified, and independently persuasive — say offense dead-ends on
deliberate engine rules and peace is the CPU-optimal policy. **Concentration's
value is that it out-*grows* rivals, not that it out-fights them**, which is also
the plainer reading of the owner's "overwhelms." Recording the correction so the
spec is not later mistaken for a war plan.

## 3. The GCL curve makes this close to mandatory

The strongest form of the argument, and the one that changes the decision.

**Controller spending is a joint product, not an expense.** Every energy into any
controller buys RCL progress in that room *and* GCL progress empire-wide, 1:1,
RCL-independent. GCL gates room **count**, not room **level**.

GCL *n* requires `(n−1)^2.4 × 10⁶` control points:

| | GCL requirement | marginal cost of the next room |
|---|---|---|
| GCL 5 (5 rooms) | 27.9M | — |
| GCL 6 (6 rooms) | 47.6M | **19.7M** |
| GCL 7 | 73.7M | 26.1M |

So a 6th room costs 19.7M of controller spend, while taking an existing room
RCL4→8 costs 16.2M. **At five rooms the sprint is cheaper than expansion** —
narrowly, and the margin closes as the corrected level-7 figure bites.

And the surplus is forced. Holding 5 rooms *requires* 27.9M of controller spend,
but bringing 5 rooms to RCL6 costs only 9M. **The remaining 18.9M has to go
somewhere.** The real choice at GCL 5 is not whether to spend it but what shape
to give it:

| the same 27.9M | max single creep | towers |
|---|---|---|
| spread evenly — 5 × RCL7 | 5,600 everywhere | 3 each |
| concentrated — 1 × RCL8 + 4 × RCL6 | **12,900** in one, 2,300 in four | 6 / 2 |

Identical cost, identical GCL, total income within ~10%. The economics are a
wash; the shape is the whole decision.

## 4. The income statement

Five-room posture: one target rushed RCL4→8, four RCL6 donors. Energy per tick.
Coefficients from TRANSPORT_NETWORK §4 and §7 — analytic, ±20%, **not measured**,
which is what leg M1 fixes.

```
REVENUE      local 10 × 10, remote 14 × 10                    240.0
COGS         miner bodies (10.4) hauling (22.1) reservation (10.6)
             GROSS PROFIT                                      196.9   82.0%
OPEX         decay (7.5) defense (10.0) anti-downgrade (4.0)
             OPERATING SURPLUS                                 175.4   73.1%
TRANSPORT    terminal tax, 145.2 shipped @ 6.45%                (9.4)
             available at the target                           166.0
OBJECTIVE    upgrader bodies (12.0)  link tax @ 3% (4.6)
             NET CONTROLLER PROGRESS                           149.4   62.3%
```

At 149.4 e/t, RCL4→8 (**16,200,000**) takes **~108,000 ticks**.

Where the missing 37.7% goes, ranked: hauling 22.1, upgrader bodies 12.0,
reservation 10.6, miner bodies 10.4, defense 10.0, terminal tax 9.4, decay 7.5,
link tax 4.6, anti-downgrade 4.0.

Three readings that should change what we work on:

- **Transport is not the problem.** Terminal plus link tax is 14.0 e/t — 5.8% of
  gross. Eliminating it entirely recovers less than 6%. The cost of concentration
  is cheap, which is the quantitative answer to "is this worth doing at all."
- **Hauling is the largest single cost in the empire**, at 9.2% of gross, and it
  is the one line that responds to engineering rather than strategy. Consistent
  with specs 43/45 already living there.
- **Reservation (10.6) costs more than the terminal tax (9.4).** A CLAIM part is
  600 energy for 600 ticks of life — exactly **1 e/t, permanently, per part**.
  Most underestimated line on the statement; worth its own gauge regardless of
  this spec.

## 5. What actually binds

Not energy delivery — a terminal moves 300k per 10 ticks and five donors are
~600x over-provisioned against the absorption ceiling. Three things bind:

**Absorption at the controller.** Uncapped below RCL8, so the ceiling is WORK
parked in range 3 and fed. Sustaining `N` 50-part upgraders costs `N/30` parts
per tick against one spawn's ⅓ → **~6 upgraders ≈ 240 e/t for a one-spawn
target**, ~500 at RCL7 with imports. GRAND_STRATEGY's ≤48-tile geometry bound
sits above this; spawn capacity binds first. *If V1 confirms the free boost, this
ceiling doubles for free* — another reason V1 sequences first.

**Feeding the nest.** 240 e/t into a tight cluster is exactly spec 45's star
topology: three sender links beside storage into one receiver at the controller,
15 tiles away, is `3 × 800/15` = **160 e/t for ~0.1 CPU/tick**. The target room's
links should serve the controller, not its sources — inverting normal doctrine,
and directly dependent on spec 45's sequencing work landing first.

**Importing bodies.** The target has one spawn until RCL7, so donors must spawn
upgraders and walk them in. A 40 WORK / 10 MOVE body moves at 2 ticks/tile on
roads: a 50-tile walk costs 6.7% of its life, a 150-tile walk costs 45%. **Import
bodies from adjacent rooms only; ship energy from anywhere further.** Note this is
the *only* mechanism in the analysis that creates geographic-compactness pressure
— the terminal tax does not (TRANSPORT_NETWORK §8.1).

## 6. Why not the market

Answering the owner's own objection, which the arithmetic confirms. The sprint
needs ~240 e/t for ~108,000 ticks: **~26M energy**. Energy is a thin book where a
large order is tens of thousands of units, so at that volume you are not trading
on the energy market, you are it. Four independent failures — price impact (you
set the price against yourself), credits (~800k, earnable only by selling into
the same book), determinism (war needs a known rate; fills are stochastic), and
secrecy (orders are public, so a standing buy program names the target room in
its own metadata, defeating the point of concentrating).

**Move energy on our own terminals. Trade only for minerals** — a room yields one
mineral type, a T3 boost line needs four, and a four-creep boosted squad is ~6,000
units against 20M energy. Three-plus orders of magnitude apart, and comfortably
inside market depth.

## 7. Where the surplus goes when the target is full

Donors will out-produce the 240 e/t ceiling. Ranked:

1. **Ramparts on the donor itself.** Repair is 0.01 e/t per hit, so 1 energy buys
   100 hits with no rate cap; ~30 ramparts at RCL6's 20M ceiling is ~6M energy of
   sink per donor. This is the *right* answer because it buys down exactly the
   exposure concentration creates — the donors sit at RCL6 with 2 towers instead
   of RCL7 with 3, and a rational opponent attacks the weakest room.
2. **Sell for credits, buy minerals** — the only route to what we cannot mine.
3. **Bank it** — 1.3M per room, ~81,000 ticks of buffer at 80 e/t. A delay, not a
   sink.
4. **A rotating GCL sink controller** (GRAND_STRATEGY §3) — strictly better than
   power processing, and the standing answer to TRANSPORT_NETWORK §11's
   "fully-RCL8 empire has no sink" problem.

## 8. Acceptance

Measurement legs first, mechanism gated on them — the house pattern (specs 32,
44).

**V1 — the boost verification (blocks everything).** A unit test pinning whether
`upgradeController` charges energy on boosted or unboosted WORK, against
`@screeps/engine` master, plus a live capture reading energy-drawn against
controller-progress for a boosted upgrader. DONE = the ratio is pinned in a test
and GRAND_STRATEGY §2 either stands or is corrected. Everything below is sized
differently depending on the answer.

**M1 — the income statement becomes a measured ledger line, not a spreadsheet.**
The §4 table is analytic; spec 15's ledger already carries most of its rows. Add
the consolidated ratio — **net controller progress ÷ gross harvest** — as a
standing gauge, with the loss lines rolled up beneath it. DONE = `npm run
audit:ledger` prints the ratio and the nine loss lines sum to gross minus net
within the residual tolerance spec 42 stage B established. This is the honest
version of the whole spec: our estimate says 62.3%, and we do not know the real
number.

**M2 — the reservation gauge.** CLAIM parts at 1 e/t permanently is a bigger line
than the terminal tax and is currently unnamed. DONE = a ledger row for standing
CLAIM cost per reserved room, comparable against that room's delivered energy.

**U1 — transport arc costs in `economy/primitives.ts`.** Per CLAUDE.md every
economic formula lives there and nothing reimplements it. `terminalSendCost`,
`linkThroughput`, `haulTaxPerTile`, `rclClimbCost`. DONE = kind-conformance-style
unit tests to 1e-9, including a regression pin that `rclClimbCost(7,8)` is
10,935,000 against the telemetry fixture — the level-7 error must not recur.

**U2 — the absorption ceiling primitive.** `controllerAbsorptionCeiling(spawns,
tiles, boosted)` implementing the `N/30`-parts-per-tick arithmetic. DONE = unit
test, and the planner reads it rather than any hand-tuned upgrader count.

**G1 — a grid cell.** Donor rooms with terminals feeding one target; assert the
target's controller progress rate clears a ratcheted floor and that donors ship
by terminal rather than by creep across the boundary. Note the CLAUDE.md sim
blind spot: sims stage no `roadRoutes` receipts and never churn spawn ids, so
stage the receipts explicitly if any behaviour here gates on them.

**Regression gate:** `npm run test-unit` plus `flow-handoff`, `runt-economy`,
`storage-depot`, one file at a time, after `npm run build`.

## 9. Open questions

- **Does the free upgrade boost hold?** V1. Everything is sized off the answer.
- **What is the real net-to-controller ratio?** M1. 62.3% is analytic; the
  measured number is the deliverable.
- **Which room is the target?** Selection is defensibility and controller
  geometry, never income — income ships in, defensibility does not. No scorer
  exists; spec 24's controller-geometry work is the nearest prior art.
- **Does the RCL6-everywhere-first sequencing hold under the GCL curve?** §3 says
  the surplus is forced, but the *order* of spending it is unmodelled.
- **Interaction with spec 39** (the plan owns the fleet): a sprint is a
  cross-room fleet commitment, which is exactly the authorship inversion 39
  describes. This spec should not hand-wire what 39 will own.

## 10. Non-goals

- Any implementation before V1 and M1 land.
- The military payload of the concentration engine (GRAND_STRATEGY §4's second
  option). §2 above explains why it is not the justification here; spec 21 owns
  conquest and its abort rules.
- Power processing. The owner ruled it out explicitly, and §7.4 gives a better
  terminal sink anyway.
- Terminal *placement* optimization (TRANSPORT_NETWORK §8.4–8.5). Real, worth
  ~1 e/t, one-shot with ~100k of regret — but it is a separate and much smaller
  decision than this spec, and it should not ride along.
