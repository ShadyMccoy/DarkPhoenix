# Energy-Store Thermostat — Balancing Income vs. Build/Upgrade

Status: **proposal / design-only** (no code yet). Companion to
[`ECONOMIC_FRAMEWORK.md`](./ECONOMIC_FRAMEWORK.md).

> Earlier drafts chased a "god-points" terminal-value model. We dropped it: it
> modeled a value we'd have to invent and tune. This design keys off **measured
> state** instead. And we control on the **stored-energy level**, not its rate of
> change — the level is the integral of net flow, so it's naturally smooth and
> matched to the slow spawn actuator. The desired behavior falls out of one
> feedback loop.

## 1. The problem, in one screenshot

Room W43N23, established, 24h:

| metric | value |
| --- | --- |
| energy harvested | 257K |
| energy on creeps | **212K** (~82%) |
| energy on construction | **0** |
| control points | flat / ~0 |

The colony harvests plenty and pours almost all of it into *making more creeps*
(haulers, remote-mining crews). The two activities that actually advance the
empire — **upgrading** and **construction** — get nothing. A source-container site
sat unbuilt for a very long time because no builder ever spawned.

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

## 3. The idea: stored-energy *level* is the thermostat

We are spawn-bound and energy-rich, so the quantity to regulate is **stored
energy**, and the gauge is **container + storage levels**.

**Control on the level, not the rate.** A naive "surplus/tick" signal
(`Δstores`) is noisy tick-to-tick, and spawning a creep is a slow actuator
(hundreds of ticks to field a fleet). Driving a laggy actuator from a noisy
derivative oscillates. The **level** is the integral of net flow — it already
low-pass-filters the noise and moves on the same slow timescale as spawning. So
we read the gauge and compare to a setpoint band:

```
fill = storedEnergy(room) / storableCapacity(room)        # 0..1, smooth
```

- **`fill` high** (stores near full): we collect more than we use → grow the
  consumers (build/upgrade) to spend it, and stop adding income.
- **`fill` low** (stores near empty): consumers are outrunning income → throttle
  consumers (and/or add income, if spawn budget allows).
- **`fill` in-band**: balanced — the "optimum that evenly consumes the surplus"
  is the equilibrium the loop settles into, not a number we compute.

No modeled value, no god points, no differentiation of a noisy signal. Just a
thermostat reading a slow, real gauge.

## 4. Three small changes (the whole design)

### 4.1 Read the level

A single cheap function, run each planning cycle:

```
storeFill(room) -> 0..1     # stored energy / storable capacity
```

From container + storage contents over their capacity. Smooth by construction —
no trend/derivative needed. (We may keep the trend around later as a secondary
tiebreak, but the **level is the primary control signal.**)

### 4.2 Consumer demand scales with fill

In the flow graph, set the **construction + controller sink demand as a function
of `fill`** instead of a fixed/priority constant — e.g. demand rises as `fill`
climbs above a low setpoint and saturates near full. The solver already routes
energy to sinks; now it routes *more* of it to consumers exactly when the
reservoir is backing up. This is the only change to the solver inputs.

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

### 4.4 Let fill regulate income too

The same level caps income: when `fill` is high, the colony already collects more
than it uses, so **stop opening new haulers / remote mines**. Gate income growth
(the marginal hauler, the next remote source) on `fill` being above the high
setpoint. One signal grows consumers *and* caps income — precisely what kills the
212K-into-creeps over-spawn.

## 5. Why the behavior falls out

A plain negative-feedback loop on a slow variable:

```
stores fill → fill high → consumer allocation grows → more build/upgrade WORK
            → energy drains → fill returns to band → settles
```

Because we're spawn-bound, the consumer WORK we can field is capped by spawn
time, so the loop settles wherever the spawn budget balances income against
consumption. The "right" amount of build/upgrade is an **equilibrium of the
thermostat**, not a formula we maintain. Tuning is the setpoint band and the
build/upgrade weights (§6) — a couple of constants, not a model.

## 6. The build/upgrade split: a weight, not a switch

Ideally construction is just **weighted higher** so energy naturally prefers it,
yet upgrading still draws flow where that makes more sense (e.g. construction
queue is short but the controller is starving / near downgrade). This is the
god-points routing idea applied narrowly to the split:

```
construction sink weight  >  controller sink weight
```

The solver allocates the fill-driven consumer budget across both by weight, so
both can receive energy simultaneously — construction just wins ties. Start with
a weight high enough that it behaves like "construction-first" while sites exist,
but keep it a tunable weight (not a hard gate) so upgrading is never fully
starved. This is the one real policy knob.

## 7. What maps onto existing code

| concern | today | after |
| --- | --- | --- |
| consumer crew size | RCL heuristic / dedicated-source floor | `WORK = allocation / rate` (pure) |
| consumer ↔ flow | allocation field, mostly ignored | allocation is the *only* input |
| consumer sink demand | fixed / priority constant | function of `storeFill` |
| build vs upgrade | n/a (upgrade-only got energy by luck) | sink **weights** (construction > controller) |
| income growth | unbounded (income tier) | gated on `fill` above high setpoint |
| stored energy | unmonitored | the regulated variable (`storeFill`) |

The spawn scheduler does **not** need its income tier ripped out for this to
work: once consumer demand is real and bounded *and* income growth is gated on
fill, the scheduler's free spawn ticks naturally flow to the consumers. We can
revisit the tier later if needed, but it is not on the critical path here.

## 8. Migration plan (incremental, each step shippable + tested)

1. **Add `storeFill(room)` + a probe.** Report stored energy, capacity, fill, and
   per-role spawn share; establish the W43N23 baseline (construction 0, fill
   climbing toward full). No behavior change.
2. **Size consumers from their allocation.** Replace `UpgradingCorp`'s RCL
   heuristic and `ConstructionCorp`'s floor with allocation-driven sizing. With
   current allocations this alone should let build/upgrade grow. Gate behind
   tests + probe (construction energy > 0).
3. **Drive consumer sink demand from fill, split by weight.** Feed `storeFill`
   into construction + controller sink demand; weight construction above
   controller. Probe: fill holds its band; control-points/tick rises.
4. **Gate income growth on fill.** Stop opening marginal haulers / remote mines
   while `fill` is above the high setpoint. Probe: energy-on-creeps share drops;
   no income starvation at cold start.

## 9. Test plan — a graduated ladder

Build the test ladder bottom-up: **prove each corp in isolation doing one job
well**, then combine corps and complicate the scenario one rung at a time. **Do
not advance a rung until the one below is efficient and flexible** (handles
asymmetric/swamp/variant layouts, not just the happy path). Each rung has a
hard efficiency bar, not just "it runs."

The existing scenario library (`test/integration/scenario/library.ts`:
`singleSource`, `asymmetricTwoSource`, `swampSource`, `twoSourceRcl3Containers`,
`remoteSource`, …) and `RoomBuilder` are the building blocks — most rungs reuse
or lightly extend them.

**Rung 0 — unit (pure functions, no sim).**
`storeFill` from container/storage contents (graceful when no storage exists);
consumer spawn demand is a pure function of allocation (no hidden heuristic);
income gate fires only above the high setpoint; weighted split routes more to
construction but never zero to upgrade.

**Rung 1 — each corp alone, one job.** One corp, a scenario that isolates its
function, an efficiency bar:
- *UpgradingCorp* on a controller with a stocked container → controller progress
  per energy at/near the WORK-rate ceiling; fleet size tracks its allocation.
- *ConstructionCorp* with a stocked source/container and one site → site
  completes; builder WORK tracks allocation; no idle builders.
- *Income (miner+hauler)* on `singleSource` → source drained, no pile-up; across
  `asymmetricTwoSource`/`swampSource` to prove flexibility.

**Rung 2 — two corps, the handoff.** Income + one consumer, so the flow→corp
allocation actually drives the consumer: `singleSourceRcl3` with a site (income →
construction) and with a starving controller (income → upgrade). Bar: consumer
energy > 0, `fill` doesn't run away, no income starvation.

**Rung 3 — the split under one roof.** Income + construction + upgrade together
(`twoSourceRcl3Containers`): the fill-driven budget splits by weight — both
consumers fed, construction favored, `fill` held in band. This is the W43N23
reproduction; the symptom must invert (construction energy > 0, control-points/
tick rising).

**Rung 4 — scale & regression.** Remote mining (`remoteSource`) and the cold-start
climb (RCL 1→3 time must not regress — `fill` starts low so consumers stay small
and income is unblocked). Existing `twoSourceRcl3` harvest/haul probes stay green.

Promotion rule: a rung is "done" only when its efficiency bar holds across the
*variant* layouts at that rung, so the behavior is robust before it carries more
weight above it.

## 10. Risks & open questions

- **Hysteresis / actuator lag.** Spawning is slow, so even on the level we want a
  setpoint *band* (separate grow/throttle thresholds) so the fleet doesn't thrash
  around a single point. Size the band wider than one spawn cycle's worth of
  swing.
- **No storage yet (low RCL).** Before storage exists, "stored energy" = source
  containers (and ground piles). `storeFill` must degrade gracefully and the band
  scale with whatever capacity exists.
- **Spawn-budget accounting.** "Spawn-bound" assumes we can read remaining spawn
  capacity; sizing consumers beyond what spawn time allows must be a graceful cap,
  not thrash.
- **Build/upgrade weight** (§6) is the policy knob; keep it a single documented
  constant/function.

## 11. One-line summary

Treat the **stored-energy level as a thermostat**: the planner scales
build/upgrade allocations with how full the reservoir is (and caps income when
it's full), splitting between build and upgrade by weight; corps stay dumb and
size themselves to their allocation; and one slow feedback loop balances
mine-vs-build-vs-upgrade without any modeled "value."
