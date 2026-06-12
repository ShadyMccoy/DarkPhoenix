# Energy-Store Thermostat — Balancing Income vs. Build/Upgrade

Status: **proposal / design-only** (no code yet). Companion to
[`ECONOMIC_FRAMEWORK.md`](./ECONOMIC_FRAMEWORK.md).

> This revision replaces an earlier draft whose premise ("the consumer corps
> ignore their flow allocation") turned out to be **wrong on inspection** — the
> corps already size themselves from their allocation. The real faults are
> upstream, in the flow solver and spawn scheduler, and are documented below with
> file:line evidence. We control on the **stored-energy level** (not its noisy
> derivative), because the level is the integral of net flow — smooth, and matched
> to the slow spawn actuator.

## 1. The problem, in one screenshot

Room W43N23, established, 24h:

| metric | value |
| --- | --- |
| energy harvested | 257K |
| energy on creeps | **212K** (~82%) |
| energy on construction | **0** |
| control points | flat / ~0 |

The colony harvests plenty and pours ~82% of it into *making more creeps*
(haulers, remote-mining crews). Construction and upgrading — the activities that
advance the empire — get almost nothing.

## 2. Root cause (verified against the code)

Three concrete facts, established by reading the pipeline end to end:

1. **Consumers already size from their allocation — this is NOT the bug.**
   `ConstructionCorp.builderPlan` sizes builder WORK from `getTotalAllocatedEnergy()`
   (`ConstructionCorp.ts:254-285`); `UpgradingCorp.getSpawnDemand` sizes upgrader
   count from `sinkAllocation.allocated` (`UpgradingCorp.ts:408-419`). A unit test
   already asserts this (`getSpawnDemand.test.ts:71-89`). The RCL heuristic in
   `UpgradingCorp.plan()` is vestigial — it doesn't drive spawning.

2. **Income monopolises spawn time (the decisive fault).**
   `spawnPriority` puts every income demand at **`+1,000,000`**
   (`SpawnScheduler.ts:158-173`), and `scheduleSpawn` **returns on the first
   affordable demand in priority order** (`SpawnScheduler.ts:223-236`). So while
   any income demand is present and affordable — always, with a full
   spawn+extensions — income spawns and the flow-budgeted consumers below it are
   never reached. Income is count-capped *per source*, but CorpPlanner adds every
   profitable source including **unbounded remote/transient sources**
   (`flowAdapter.ts:71-80`, producer selection `CorpPlanner.ts:182-236`), so its
   demand never empties. The advertised anti-starvation aging (`since`) that would
   let a waiting consumer eventually win is **declared but never implemented** — no
   corp sets it and `spawnPriority` never reads it.

3. **Construction can't absorb the surplus even when valued higher.**
   The routing weights already prefer building: `DEFAULT_SINK_VALUE` is
   `spawn 100 > construction 70 > controller 50 > storage 1`
   (`CorpPlanner.ts:92-96`). But the construction sink's **capacity is pinned at
   `CONSTRUCTION_ABSORB_RATE = 5` e/tick** (`flowAdapter.ts:39,115`), while the
   controller sink's capacity is the whole supply (`flowAdapter.ts:120`,
   "mops up the remainder"). So surplus routes *past* construction (capped at 5)
   into the controller. Construction is preferred but throttled.

**Net:** the spawn is monopolised by uncapped income, so even the controller's
remainder allocation can't be consumed (no upgrader ever gets a spawn tick → flat
control points), and construction is throttled at 5 e/tick regardless. The 212K
on creeps is the income monopoly; the 0 on construction is the absorb cap plus the
monopoly.

## 3. The idea: stored-energy *level* is the thermostat

We are spawn-bound and energy-rich, so the quantity to regulate is **stored
energy**; the gauge is **container + storage levels**.

**Control on the level, not the rate.** A "surplus/tick" signal (`Δstores`) is
noisy, and spawning is a slow actuator — driving a laggy actuator from a noisy
derivative oscillates. The **level** is the integral of net flow: already
low-pass-filtered and moving on the same slow timescale as spawning. Read the
gauge and compare to a setpoint band:

```
fill = storedEnergy(room) / storableCapacity(room)   # 0..1, smooth
```

- **`fill` high** → we collect more than we use → let consumers grow and **stop
  adding income**.
- **`fill` low** → consumers outrunning income → throttle consumers / unblock
  income.
- **`fill` in band** → balanced; the equilibrium falls out, it isn't computed.

## 4. The changes (small, and upstream)

### 4.1 Read the level — `storeFill(room) -> 0..1`

Stored energy / storable capacity, from containers + storage. Smooth by
construction; no derivative. The shared signal for the two levers below.

### 4.2 Lever 1 — bound income growth by `fill` (the decisive fix)

In CorpPlanner producer selection / transient-source detection
(`CorpPlanner.ts:182-236`, `flowAdapter.ts:71-80`), **stop adding marginal sources
(especially remote/transient) and stop growing hauler counts beyond delivery need
while `fill` is above the high setpoint.** Income demand then *empties*, and the
scheduler — walking its ranked list — finally reaches the consumers the flow has
already budgeted. This is what breaks the 212K-into-creeps monopoly, and it needs
no change to the `+1e6` tier itself.

### 4.3 Lever 2 — let construction absorb the surplus

Replace the fixed `CONSTRUCTION_ABSORB_RATE = 5` with a capacity that **scales
with `fill`** (and/or active-site count × remaining work), so the existing value-70
preference can actually pull surplus into building instead of spilling it to the
controller. Keep the weights as-is — construction already outranks the controller;
it just needs the headroom to act on that.

### 4.4 Lever 3 — consumers size from allocation (mostly done) + aging backstop

The corps already size from allocation (§2.1). Remaining cleanup: drop the
vestigial RCL `targetUpgraders` path so allocation is the single input. Optionally
**wire up the dormant `since` aging** as a backstop so a long-starved consumer can
eventually win even if income bounding is imperfect — small, and it makes the
system robust rather than relying on income emptying perfectly.

## 5. Why the behavior falls out

A slow negative-feedback loop:

```
stores fill → fill high → income growth gated off (Lever 1) → income demand empties
           → scheduler reaches flow-budgeted consumers → builders/upgraders spawn
           → construction absorb scaled up (Lever 2) → energy drains into progress
           → fill returns to band → income unblocks → settles
```

Spawn-bound means the consumer WORK we can field is capped by spawn time, so the
loop settles where the spawn budget balances income against consumption — the
"optimum that evenly consumes the surplus" as an equilibrium, not a formula.

## 6. The build/upgrade split — already a weight, not a switch

`DEFAULT_SINK_VALUE` already encodes exactly the weighting we wanted: construction
(70) is preferred over the controller (50), but the controller still draws the
remainder, so upgrading is never fully starved. **No new split logic is needed** —
Lever 2 just removes the absorb cap that currently prevents the existing
preference from taking effect. The one tunable knob is the construction absorb
scaling (and, if we ever want it, nudging the 70/50 weights).

## 7. What maps onto existing code

| concern | today | change |
| --- | --- | --- |
| consumer crew size | already `allocation / rate` | drop vestigial RCL path (cosmetic) |
| income growth | uncapped (remote/transient unbounded) | **gate on `storeFill` ≥ high setpoint** |
| construction absorb | fixed `=5` e/tick | **scale with `storeFill`** (and site work) |
| build vs upgrade weight | `DEFAULT_SINK_VALUE` 70 > 50 | keep |
| anti-starvation aging | declared, never wired | optionally implement `since` |
| stored energy | unmonitored | `storeFill(room)` — the regulated variable |

The scheduler's `+1e6` income tier does **not** need ripping out: once income
growth is bounded by fill, its demand empties and the free spawn ticks flow to
consumers on their own.

## 8. Migration plan (incremental, each step shippable + tested)

Implemented constants (all in one fill band so the levers move together):
`INCOME_THROTTLE_LOW = 0.5`, `INCOME_THROTTLE_HIGH = 0.9`, `INCOME_BUDGET_FLOOR =
0.5` (income spawn-budget multiplier 1.0 → 0.5 across the band);
`CONSTRUCTION_ABSORB_RATE = 5` → `CONSTRUCTION_ABSORB_MAX = 20` across the same
band.

1. **DONE — `storeFill(room)`** (`src/economy/storeFill.ts`). The level gauge
   (storage + containers; 0 when no reservoir, so cold start is unaffected).
   Rung-0 unit tests. No behavior change.
2. **DONE — Lever 1, income throttle** (`incomeBudgetScaleForFill`, threaded via
   `ColonyProblem.incomeBudgetScale` into `selectProducers`). Scales the mining
   spawn-part budget down as `fill` rises, shedding marginal/remote sources first
   (the spawn's best source is always kept). Rung-0 unit tests + an end-to-end
   planner proof (far source shed at full fill). Integration regression guard
   green (two-source RCL3, `fill≈0`, behavior unchanged).
3. **DONE — Lever 2, construction absorb** (`constructionAbsorbForFill` at
   `buildColonyProblem`). Lifts the absorb cap with `fill`. Rung-0 unit tests + an
   end-to-end proof (surplus shifts controller→construction at full fill).
4. **TODO — Lever 3, cleanup + optional `since` aging.** Drop the vestigial RCL
   `targetUpgraders` path; optionally wire `since` as a starvation backstop.
5. **TODO — full-loop demonstration.** An RCL4+storage scenario run to ~1500
   ticks showing the *combined* loop: stored energy holds a band, construction +
   upgrade energy > 0 and rising, income expansion stands down — the W43N23
   symptom inverting in the live sim (not just the planner).

## 9. Test plan — a graduated ladder

Build the ladder bottom-up: **prove each corp in isolation doing one job well**,
then combine corps and complicate the scenario one rung at a time. **Do not advance
a rung until the one below is efficient and flexible** (handles asymmetric/swamp/
variant layouts, not just the happy path). Each rung has a hard efficiency bar.

Substrate confirmed to exist: mock-based corp unit tests (`test/unit/corps/`, e.g.
`getSpawnDemand.test.ts`, `pickSinkByAllocation.test.ts`) for single-corp isolation,
and the integration scenario library (`test/integration/scenario/library.ts`:
`singleSource`, `asymmetricTwoSource`, `swampSource`, `twoSourceRcl3Containers`,
`remoteSource`, …) + `RoomBuilder` for combined rungs.

**Rung 0 — unit (pure functions, no sim).** `storeFill` from container/storage
contents (graceful when no storage exists); consumer spawn demand is a pure
function of allocation (extend `getSpawnDemand.test.ts`); income-growth gate fires
only above the high setpoint; construction absorb scales with `fill`.

**Rung 1 — each corp alone, one job** (mock-based unit tests, efficiency bar each):
- *UpgradingCorp* with a stocked controller container → controller progress per
  energy near the WORK ceiling; fleet tracks allocation.
- *ConstructionCorp* with a stocked source + one site → site completes; builder
  WORK tracks allocation; no idle builders.
- *Income (miner+hauler)* on `singleSource` → source drained, no pile-up; repeat on
  `asymmetricTwoSource`/`swampSource` to prove flexibility.

**Rung 2 — two corps, the handoff** (`singleSourceRcl3` + a site / + a starving
controller): income → consumer. Bar: consumer energy > 0, `fill` doesn't run away,
no income starvation.

**Rung 3 — the split under one roof** (`twoSourceRcl3Containers`): construction +
upgrade both fed, construction favored (it already is, by value 70>50), `fill` held
in band. This is the W43N23 reproduction; the symptom must invert (construction
energy > 0, control-points/tick rising).

**Rung 4 — scale & regression** (`remoteSource` + cold-start RCL 1→3 climb time must
not regress; existing `twoSourceRcl3` probes stay green).

Promotion rule: a rung is "done" only when its efficiency bar holds across the
*variant* layouts at that rung.

## 10. Risks & open questions

- **Hysteresis / actuator lag.** Even on the level, use a setpoint *band* (separate
  grow/throttle thresholds, wider than one spawn cycle) so the fleet doesn't thrash.
- **No storage yet (low RCL).** Before storage exists, "stored energy" = source
  containers (and ground piles). `storeFill` must degrade gracefully; the band
  scales with whatever capacity exists.
- **Income bounding vs. legitimate expansion.** Gating income on `fill` must not
  permanently refuse a genuinely profitable remote when stores are merely
  momentarily full — the band + the slow level signal should cover this, but it's
  the thing to watch in Rung 4.
- **Construction absorb scaling shape.** Linear in `fill`? Proportional to remaining
  site work? Start simple (a `fill`-scaled multiple of the current 5) and tune.

## 11. One-line summary

Treat the **stored-energy level as a thermostat**: gate income growth when the
reservoir is full so the spawn frees ticks for the consumers the flow already
budgets, and lift the construction absorb cap so building (already weighted above
upgrading) can soak the surplus — one slow feedback loop, no modeled "value."
