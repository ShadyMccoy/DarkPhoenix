# Surplus Thermostat — Balancing Income vs. Build/Upgrade

Status: **proposal / design-only** (no code yet). Companion to
[`ECONOMIC_FRAMEWORK.md`](./ECONOMIC_FRAMEWORK.md).

> Earlier drafts of this doc chased a "god-points" terminal-value model. We
> dropped it: it modeled a value we'd have to invent and tune. This design keys
> off **measured state** (stored energy) instead — simpler, and the desired
> behavior falls out of one feedback loop.

## 1. The problem, in one screenshot

Room W43N23, established, 24h:

| metric | value |
| --- | --- |
| energy harvested | 257K |
| energy on creeps | **212K** (~82%) |
| energy on construction | **0** |
| control points | flat / ~0 |

The colony harvests plenty and pours almost all of it back into *making more
creeps* (haulers, remote-mining crews). The two activities that actually advance
the empire — **upgrading** and **construction** — get nothing. A source-container
site sat unbuilt for a very long time because no builder ever spawned.

## 2. Root cause: the flow→corp gap, and an unregulated economy

Two concrete faults:

1. **Consumers ignore their allocation.** The flow solver computes a controller
   and construction allocation, then the corps **throw it away** and use ad-hoc
   heuristics:
   - `UpgradingCorp.plan()` sets upgrader count from an RCL rule
     (`rcl<=2 ? 1 : 2`, capped at 3). It holds a flow-allocation field but does
     not size from it.
   - `ConstructionCorp` floors the builder to a dedicated-source guess, and then
     the spawn scheduler's income tier buries it anyway.

   So the flow and the corps speak different languages, and the consumer side
   never grows to use available energy.

2. **Nothing regulates income.** The spawn scheduler ranks income (miner/hauler)
   in a `+1,000,000` tier above every consumer, and nothing tells it the *Nth*
   hauler or *Mth* remote mine produces no benefit. We are **spawn-bound, not
   energy-bound** — there is surplus energy — yet the colony keeps spending its
   scarce spawn time on more income instead of consuming what it already has.

## 3. The idea: stored energy is the thermostat

We are spawn-bound and energy-rich, so the quantity to regulate is **stored
energy**. You already named the sensor: **container + storage levels**. One
measured number drives the whole economy:

```
surplus/tick  =  rate stored energy is piling up
              =  Δ(source containers + storage) over the planning window
```

- **Surplus > 0** (stores filling): we collect more than we use → grow the
  consumers (build/upgrade) to spend it, and stop adding income.
- **Surplus < 0** (stores draining): consumers are outrunning income → shrink
  consumers (or add income, if spawn budget allows).
- **Surplus ≈ 0**: balanced. This is the "optimum that evenly consumes the
  surplus" — it falls out, it isn't computed.

No modeled value, no god points. Just a thermostat reading a real gauge.

## 4. Three small changes (the whole design)

### 4.1 Measure surplus

A single cheap function, run each planning cycle:

```
roomSurplus(room) -> energy/tick
```

From the stored-energy level and its short-window trend (source containers +
storage; spawn/extension fill tells us income is "enough"). Real state, no
estimation chain.

### 4.2 Feed surplus into the consumer sinks

In the flow graph, set the **construction + controller sink demand = surplus**
(split by a simple policy — see §6), instead of the current fixed/priority guess.
The solver already routes energy to sinks; now it routes the *surplus* to the
things that turn it into progress. This is the only change to the solver inputs.

### 4.3 Tighten the handoff — consumers size from their allocation

Make each consumer corp size its crew **purely from its sink allocation**:

```
desired WORK  ≈  allocatedEnergy/tick  /  per-WORK consumption rate
```

- **Delete** `UpgradingCorp`'s RCL heuristic; the upgrader fleet is whatever its
  controller allocation funds (keep a small safety cap against a stale
  allocation, and a floor while downgrade is imminent).
- **Delete** `ConstructionCorp`'s dedicated-source over-floor; the builder fleet
  is whatever its construction allocation funds.

Now `getSpawnDemand` is a **pure function of the allocation** — the flow and the
corps finally speak one language. Corps stay dumb: they don't decide *how much*,
they only execute their funded size.

### 4.4 Let surplus regulate income too

The same surplus number caps income: when stored energy is high, the colony
already collects more than it uses, so **stop opening new haulers / remote
mines**. Concretely, gate income growth (the marginal hauler, the next remote
source) on `surplus <= 0`. One signal grows consumers *and* caps income — which
is precisely what kills the 212K-into-creeps over-spawn.

## 5. Why the behavior falls out

A plain negative-feedback loop:

```
stores fill → surplus>0 → consumer allocation grows → more build/upgrade WORK
            → energy drains → surplus→0 → settles
```

Because we're spawn-bound, the consumer WORK we can field is capped by spawn
time, so the loop settles wherever the spawn budget balances income against
consumption. The "right" amount of build/upgrade is an **equilibrium of the
thermostat**, not a formula we maintain. Tuning is one or two constants (target
store band, build/upgrade split), not a model.

## 6. The one policy choice: splitting surplus

How to divide the surplus between construction and upgrading. Start simple:

- **Construction-first:** while construction sites exist, surplus goes to build;
  otherwise to upgrade. (Matches "finish infrastructure, then pour into RCL.")
- Alternative: a fixed ratio, or shift toward upgrade as RCL nears a target.

Pick construction-first to start; it's the least surprising and easy to change.

## 7. What maps onto existing code

| concern | today | after |
| --- | --- | --- |
| consumer crew size | RCL heuristic / dedicated-source floor | `WORK = allocation / rate` (pure) |
| consumer ↔ flow | allocation field, mostly ignored | allocation is the *only* input |
| consumer sink demand | fixed / priority constant | `= surplus` (measured) |
| income growth | unbounded (income tier) | gated on `surplus <= 0` |
| stored energy | unmonitored | the regulated variable (`roomSurplus`) |

The spawn scheduler does **not** need its income tier ripped out for this to
work: once consumer demand is real and bounded *and* income growth is gated on
surplus, the scheduler's free spawn ticks naturally flow to the consumers. We can
revisit the tier later if needed, but it is not on the critical path here.

## 8. Migration plan (incremental, each step shippable + tested)

1. **Add `roomSurplus(room)` + a probe.** Measure stored-energy trend and per-role
   spawn share; establish the W43N23 baseline (construction 0, stores climbing).
   No behavior change.
2. **Size consumers from their allocation.** Replace `UpgradingCorp`'s RCL
   heuristic and `ConstructionCorp`'s floor with allocation-driven sizing. With
   current allocations this alone should let build/upgrade grow. Gate behind
   tests + probe (construction energy > 0).
3. **Drive consumer sink demand from surplus.** Feed `roomSurplus` into the
   construction + controller sink demand, with the construction-first split.
   Probe: stored energy holds a band; control-points/tick rises.
4. **Gate income growth on surplus.** Stop opening marginal haulers / remote
   mines while `surplus > 0`. Probe: energy-on-creeps share drops; no income
   starvation at cold start.

## 9. Test plan

- **Sim probe:** stored energy stays in a band (no overflow, no empty);
  build + upgrade energy > 0; control-points/tick rising — the W43N23 symptom
  inverts.
- **Unit:** `roomSurplus` sign/magnitude from container deltas; consumer spawn
  demand is a pure function of allocation (no hidden heuristic); income growth
  gate fires only when `surplus > 0`.
- **Cold-start regression:** RCL 1→3 climb time does not regress (surplus starts
  ≤ 0, so consumers stay small and income is unblocked; bootstrap unchanged).
- **No-regression:** existing `twoSourceRcl3` harvest/haul probes stay green.

## 10. Risks & open questions

- **Surplus window.** Container/storage deltas are noisy tick-to-tick; average
  over a planning window (or smooth) so the thermostat doesn't oscillate.
- **No storage yet (low RCL).** Before storage exists, "stored energy" = source
  containers (and ground piles). Define the gauge to degrade gracefully there.
- **Spawn-budget accounting.** "Spawn-bound" assumes we can read remaining spawn
  capacity; sizing consumers beyond what spawn time allows just won't field — make
  sure that's a graceful cap, not thrash.
- **Build/upgrade split** (§6) is the one real policy knob; keep it a single
  documented constant/function.

## 11. One-line summary

Treat **stored energy as a thermostat**: the planner sets build/upgrade
allocations from the measured surplus and caps income when stores are full; corps
stay dumb and size themselves to their allocation; and one feedback loop balances
mine-vs-build-vs-upgrade without any modeled "value."
