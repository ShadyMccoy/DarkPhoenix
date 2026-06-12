# God-Points Chain — Design

Status: **proposal / design-only** (no code yet). Companion to
[`ECONOMIC_FRAMEWORK.md`](./ECONOMIC_FRAMEWORK.md).

## 1. The problem, in one screenshot

Room W43N23, established, 24h:

| metric | value |
| --- | --- |
| energy harvested | 257K |
| energy on creeps | **212K** (~82%) |
| energy on construction | **0** |
| control points | flat / ~0 |

The colony harvests plenty and pours nearly all of it back into *making more
creeps*. The two activities that actually advance the empire — **upgrading** and
**construction** — get essentially nothing. A source-container site sat unbuilt
for a very long time because no builder ever spawned.

## 2. Root cause: two value systems that disagree

We price the economy in **two unrelated places**:

1. **Flow solver** (`flow/`, `ECONOMIC_FRAMEWORK.md`). Thinks correctly: it has
   sinks with priorities (`construction: 70`, `controller: 60`) and routes
   *energy* to them.
2. **Spawn scheduler** (`spawn/SpawnScheduler.ts` + each corp's
   `getSpawnDemand`). Decides which *creep* to build, using a **separate,
   hardcoded** value scale where income is in an untouchable tier:
   - miner `100`, hauler `90+` → `+1,000,000` "income tier"
   - builder `95`, upgrader `90` → consumption tier, **no** income bonus

Because the scheduler picks **one creep per spawn per tick**, and any income
demand outranks every consumer by ~1e6, the builder/upgrader are structurally
last in line *forever*. The flow can allocate energy to the construction sink,
but the scheduler never spawns a builder to spend it. Worse: nothing tells the
scheduler that the *Nth hauler* or *Mth remote mine* produces **zero** terminal
value, so "build more income" always looks worth it → the over-spawn you see.

**The two systems must become one, and that one must be priced in the only thing
that actually matters.**

## 3. The principle: god points are the only terminal value

> The planner maximizes **god points**. Corps are simple; the planner sticks
> them together and judges the whole chain by the god points it yields.

- **God points** = progress on the only scoreboard the game keeps: **controller
  upgrade progress (→ RCL/GCL)**, plus **construction** (structures that unlock
  capacity, i.e. *future* god points). Everything else — mining, hauling,
  reserving, spawning — has **no terminal value of its own**. It is worth
  *exactly* the god points it enables downstream, and nothing more.
- **Only two corps emit god points**: `UpgradingCorp` (controller progress) and
  `ConstructionCorp` (build progress, valued as the discounted future capacity
  it unlocks). Every other corp's value is *derived*, not declared.
- **Corps stay dumb.** A corp knows only how to (a) `project()` its own per-tick
  cost/throughput and (b) `work()`. It does **not** assert a priority number.
  The **planner** owns all valuation and composition. (This deletes the
  hardcoded `90/94/95/100` values — those are the smell we're removing.)

## 4. The model

### 4.1 A chain

A chain is the path energy takes to become god points:

```
source ──(miner)──> pile ──(hauler)──> sink ──(consumer corp)──> god points
                                         └─ controller  → UpgradingCorp
                                         └─ construction → ConstructionCorp
                                         └─ spawn/ext    → (enables the creeps
                                                            the rest of the chain
                                                            needs — recursive)
```

We already have the seed of this: `ChainEvaluator` stands up the real corps for a
candidate spawn and sums **net energy delivered to the controller**, by calling
each corp's `project()`. The change is to:

1. Extend the chain's terminal from "energy at controller" to **god-points/tick**
   at the consuming endpoints (controller **and** construction), and
2. Use that same chain valuation to drive **ongoing spawn decisions**, not just
   spawn *placement*.

### 4.2 Marginal valuation (this is the whole fix)

Every spawn candidate is scored by the **marginal god points per spawn-cost** it
adds to the chain:

```
value(candidate) = Δ(god points/tick of the chain, with candidate) / spawn cost
```

- The **first miner** on a fresh source has enormous marginal value: it unlocks
  the entire downstream chain (its energy can become god points). → spawns first.
- The **first hauler** is similarly high: without it the energy strands. → next.
- The **Nth hauler** beyond what the sink can actually consume adds **~0**
  god points (the sink is saturated) → its marginal value collapses → it stops
  being spawned. **This is the automatic cap on over-spawn.**
- A **remote mine** is valued by the god points its *extra* energy unlocks
  *after* paying its full freight (reserver + long haul + spawn build-time). Once
  home consumption is saturated, that downstream value is ~0 and the remote stops
  looking worth it. **This is the automatic cap on too many remote mines.**
- A **builder/upgrader** is valued at the god points it *directly* emits. When
  income is saturated and consumers are starved (today's W43N23), the consumer's
  marginal value is the **highest** thing on the board → it finally spawns.

The income tier (`1e6`) and the hardcoded consumer values both **disappear**.
Ranking falls out of one number: marginal god points / cost.

### 4.3 Where the numbers come from

Nothing new for corps to learn — we already have `Corp.project() →
{ costPerTick, throughput, spawnPartsPerTick }`. We add the terminal piece:

- `UpgradingCorp.project()` reports god-points/tick = energy converted to
  controller progress (1:1 today; controller-level multipliers later).
- `ConstructionCorp.project()` reports god-points/tick = build progress, with
  the built structure's future-capacity value discounted into a god-point-
  equivalent (a tunable conversion, documented in one place).
- Income corps report `throughput` (energy) as today; the **planner** turns that
  energy into god points by following the chain to its consumer and reading the
  consumer's conversion. Income corps never see "god points."

## 5. How it maps onto the code we have

| concern | today | after |
| --- | --- | --- |
| per-corp economics | `Corp.project()` | unchanged shape; upgrade+construction also report god-points/tick |
| chain composition | `ChainEvaluator` / `hubNet` (placement only) | same composition, terminal extended to god points, reused for **spawn ranking** |
| energy routing | flow solver sinks + priorities | unchanged; sink priority *derived from* the same god-point conversion so routing and spawning agree |
| spawn ranking | `SpawnScheduler` hardcoded value + 1e6 income tier | **replaced** by marginal-god-point ranking emitted by the planner |
| corp priorities | `value: 90/94/95/100` literals | **deleted** — corps stop asserting value |

The spawn scheduler becomes a thin executor: the planner hands it a ranked list
(or just the single best candidate) computed from chain marginal value; the
scheduler only decides body size vs. available energy and whether to wait.

## 6. Cold-start (the part that has bitten us)

Marginal valuation handles cold-start *without a special case*, because when
god-point throughput is **0**, the first miner/hauler have the highest marginal
value on the board (they unlock the only path to any god points at all). The
existing **bootstrap corp stays** for RCL 1 (300-energy rooms, where spending on
the flow economy starves the single jack — see `FLOW_MIN_RCL`). Above that, the
marginal model takes over. We must verify we don't regress the "must
over-invest in income before any god points exist" early phase — see test plan.

## 7. Migration plan (incremental, each step shippable + tested)

1. **Instrument, don't change behavior.** Add god-points/tick to
   `UpgradingCorp.project()` and `ConstructionCorp.project()`; add a sim probe
   that reports chain **god-points/tick** and per-role spawn share. Establish the
   W43N23 baseline (construction = 0) in the sim. *No economic change yet.*
2. **One chain, end-to-end value.** Extend `ChainEvaluator` to score a chain in
   god points (controller + construction endpoints). Keep it placement-only for
   now; assert via unit tests that a saturated sink yields ~0 marginal value for
   an extra hauler.
3. **Bridge the scheduler.** Replace the consumer corps' hardcoded values with a
   value derived from their chain marginal god points (income tier still intact).
   This alone should let builders/upgraders break the starvation — smallest
   user-visible win. Gate behind tests + the probe (construction > 0).
4. **Unify ranking.** Move income corps onto the same marginal-god-point scale and
   delete the `1e6` income tier. The planner emits the ranked spawn plan; the
   scheduler becomes the thin executor. Heaviest step; do last, with the
   cold-start regression suite green.
5. **Align flow sink priorities** with the same conversion so routing and
   spawning never disagree again.

## 8. Test plan

- **Probe (sim):** chain god-points/tick, energy split by role, construction
  energy > 0, control-points/tick rising — the W43N23 symptom must invert.
- **Unit:** marginal value of an extra hauler on a saturated sink ≈ 0; marginal
  value of the first miner on a fresh source ≫ any consumer; remote-mine value
  goes negative once home consumption is saturated.
- **Cold-start regression:** RCL1→3 climb time does not regress vs. current
  bootstrap behavior.
- **No-regression:** existing `twoSourceRcl3` harvest/haul probes stay green.

## 9. Risks & open questions

- **Construction → god-point conversion** is a judgment call (how much is a future
  extension "worth" now?). Keep it a single tunable constant with a documented
  rationale; don't scatter it.
- **Saturation signal.** "The sink can't consume more" must be a clean, cheap
  read (consumer `project()` throughput cap), or the marginal calc gets fuzzy.
- **CPU.** Re-scoring chains every spawn tick may be too costly; likely cache the
  chain valuation and only re-score on structural change (new source/sink/RCL).
- **Step 4 is the historically tricky one.** Steps 1–3 deliver the visible win
  (construction un-starves) with the income tier still in place as a safety net;
  only collapse the tier once the marginal model is proven in-sim.

## 10. One-line summary

Stop pricing the colony in energy and creep-counts. Price it in **god points**,
let the **planner** value every creep by the marginal god points its chain
yields, and the over-spawning, the starved builder, and the flat control-points
curve all fix themselves — while the corps stay dumb.
