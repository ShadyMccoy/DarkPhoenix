# 36 — Post-refactor unlocks: the behavioral backlog spec 35 paid for

**Status:** PROPOSED 2026-07-27 (session follow-up to spec 35). Spec 35's
phases A–D + G–H were structure-only by design — this spec is the ranked
list of BEHAVIORAL changes the new seams make cheap, so the paydown turns
into bot-level movement instead of just a cleaner tree. Each item names
the seam it rides and the acceptance that proves it. Items are
independent; land them in any order, though tier 1 is ranked by expected
grid movement per unit of work.

Conventions per [README](README.md): acceptance criteria live in tests
only; the regression gate (unit + `flow-handoff`, `runt-economy`,
`storage-depot`) applies to every item here since all touch live
behavior; grid cells named per item, baseline updated in the same commit
that earns it.

---

## Tier 1 — grid-moving, directly unlocked

### 1. Event-triggered replanning (the ONE planning entry)

**Seam:** `main.ts` `runPlanningPhase(force)` (spec 35 G unified the
loop's cadence path and `global.plan()` into one full-sequence entry —
survey, sink admission, solve, publish).

**The change:** call `runPlanningPhase(true)` on durable world
transitions instead of waiting out the 50/150-tick governor cadence.
Trigger set, each already a durable signal (trap list: never creep
positions or vision):

- a room flips in `RoomDiscovery.hostileRooms` (embargo on/off),
- `Memory.expansion` campaign state transitions (claim placed / founding
  spawn done),
- RCL-up in an owned room (`lastRclUpTick` era ended — use the event, not
  the deleted Memory field),
- a spawn is added/lost from the census.

Debounce: at most one forced solve per N ticks (name the constant in the
governor; the governor's bucket still gates — a forced plan is a REQUEST,
the CPU governor may still stretch it). The stale-plan tax this removes
is the incident class where the planner priced a world up to 50 ticks
gone (retired-remote and stranded-reserver both had this flavor).

**Acceptance:** unit — a staged transition fires exactly one forced
solve through the governor gate (pin the debounce); grid — a cell where
a remote flips hostile mid-run and the NEXT tick's agenda already
reflects the embargo (today it lags up to a full cadence); trio green.

**Priority: P0** — smallest work, broadest effect.

### 2. Depot bridge economy fix in its new home (the `haul-t4` red)

**Seam:** `corps/haulPolicy.ts` (spec 35 H extracted the hauler
routing/banking policy head — `shouldRefillFromDepot`,
`shouldDrainDedicatedSource`, `pickDeliverySink` et al. — pure and
unit-testable).

**The change:** the fix already queued in spec 27's notes ("depot bridge
economy, bus-regime red") is a policy change; write it against
`haulPolicy` with unit tests FIRST, then wire. The red cell
`haul-t4-tender-bus-regime` is the acceptance, already in the grid.

**Acceptance:** `haul-t4-tender-bus-regime` green + baseline ratchet in
the same commit; no other haul cell regresses (multi-draw the tempo
cells per the ±20-30% rule).

**Priority: P0** — it is THE named red blocking the bot level.

### 3. The backoff instrument as a telemetry segment

**Seam:** `telemetry/` per-segment writers (spec 35 H; a new instrument
is a ~100-line sibling module, not surgery), `Memory.spawnMeter` idiom
for windowed accumulators.

**The change:** the surplus-vs-under-delivery separator that master's
spec 32 (graceful mining backoff) names as its HARD prerequisite: per
mined source, window the ground-pile stock against the planned haul rate
and classify standing energy as SURPLUS (pile high, haul keeping pace —
backoff would be correct) vs UNDER-DELIVERY (pile high because haulage
lags plan — backoff would sweep a bug). Passive and pullable (ONTOLOGY
§1): no bot decision reads it until spec 32 lands.

Side value: this instrument is exactly the diagnostic for the upstream
`haul-t3-dedicated-resume-groundpile` regression (#143, timeouts on pure
master — see spec 35 status).

**Acceptance:** unit — staged windows classify a lagging-haul world as
under-delivery and a saturated world as surplus (pin thresholds); the
segment's bytes are shape-pinned like the others; trio green (passive —
no behavior change).

**Priority: P1** — gates spec 32, illuminates a live red.

## Tier 2 — capabilities the completed contract affords

### 4. New corp kinds off the cheap contract

**Seam:** spec 35 D — `proposeHelpers`, `startedUnitDemandGroup`,
optional `run()`, registration-only + conformance. A kind is now one
file + one KINDS entry.

Candidates already in the backlog, in value order:

- **KeeperGuardCorp** (spec 28's guarded-producer model — the garrison
  tax primitive prices it; `startedUnitDemandGroup` is its funding
  shape),
- **minerCorp producer mirror** (spec 34 D5 second half),
- **link-logistics corp kind** (spec 02's open redesign — LinkRunner
  becomes a kind with a declared demand instead of a free function).

**Acceptance:** per kind — enroll in `describeCorpKindConformance`,
registration-only proof stays green (adding the kind touches ONE file
beyond itself), plus the kind's own cells (spec 28 names them).

**Priority: P2** (P1 for KeeperGuardCorp if SK rooms are the next
economic frontier).

### 5. What-if solves (counterfactual pricing)

**Seam:** `economy/planningAssembly.assembleEconomyForSolve` (spec 35 G)
— the solve input is now assembled at one seam, so a HYPOTHETICAL
problem (candidate remote, candidate claim, candidate spawn site) can be
staged and priced by the real planner without touching live state.

**The change:** a pure `priceCandidate(problem, candidate)` that clones
the problem, injects the candidate, solves, and returns the plan delta
(valueDelivered, partsLedger headroom). Consumers: spec 21's
probe→assess ladder and spec 18's structure search — both currently
have no evaluator for "what would this claim be worth."

**Acceptance:** unit — staged candidate raises/lowers the plan delta as
constructed; purity — the what-if path writes NOTHING (no Memory, no
commissions); planEquivalence untouched (the live path shares no state
with the what-if path).

**Priority: P2** — substrate for two proposed owner specs.

### 6. Placement experiments against the pure ladder

**Seam:** `corps/constructionPlacement.ts` (spec 35 H — limits, rung
table, tile scorers, trunk gate; Game-free, ratchet-pinned).

**The change:** spec 27 (extension relocation scorer + per-cluster
table) and spec 31 (serpentine target shape) develop against the pure
module with table-driven tests; the corp only executes verdicts. This is
sequencing leverage, not new function: the owner-review gate spec 27
requires becomes a reviewable TABLE diff.

**Acceptance:** spec 27/31's own acceptance; this spec only asserts the
work happens in the pure module (ratchet keeps it Game-free).

**Priority: rides spec 27's P0** when that work starts.

## Tier 3 — remaining spec 35 phases (structure that unlocks behavior)

### 7. Structural regimes (spec 35 phase E)

`corps/regimes.ts` now owns the lens; upgrade `tenderOwnsExtensions` /
feeder-coverage to derive from STRUCTURES (links built, container
present, storage live) instead of creep liveness — kills the
regime-thrash-on-tender-death flap class. Grid: a cell staging a tender
death must NOT flip the regime for the gap.

**Priority: P1.**

### 8. D-scout (spec 35 phase D-scout)

Scout through the scheduler: `getSpawnDemand` on ScoutCorp, delete
`setSpawningCorpResolver` + the host wiring — the last special-case
outside the demand pipeline. Scout cadence becomes a ladder rung
(`demandLadder.SCOUT…`), tunable and agenda-visible.

**Acceptance:** spec 35's own acceptance line ("`setSpawningCorpResolver`
gone"), scoutKind conformance, the multiroom cells' scout-cadence pins
deliberately re-baselined in the same commit.

**Priority: P1.**

---

## Explicitly out of scope here

- The envelope-v2 bundle (phantom `"build"` kind, `role: "bank"`,
  `staffedBy`) stays deferred exactly as spec 35 defers it — one
  deliberate golden-master regeneration, not an unlock to sneak in.
- The upstream #143 regressions (`haul-t3-dedicated-resume-groundpile`,
  `plan-t4-link-haul-pricing`) belong on master — spec 35's status has
  the bisection evidence; item 3's instrument helps diagnose but does
  not fix.
