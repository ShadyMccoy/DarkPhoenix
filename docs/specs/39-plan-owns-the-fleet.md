# Spec 39 — The plan owns the fleet (corps receive creeps, they don't request them)

**Status: PHASES 0-2 SHIPPED 2026-08-03; phases 3-5 BACKLOG (owner 2026-07-30).**
Phase 0 (the cop) landed first, per the migration table:
`test/unit/framework/spawnAuthority.test.ts` pins `.spawnCreep(` to the
executor + bootstrap allowlist and ratchets the `getSpawnDemand` CODE surface
(comment-stripped) at **11 files** - the ten demand-side corp classes plus
SpawnDirector; the spec's earlier "16 files" figure counted docstring-only
mentions. Both lists are shrink-only from here. Unlike spec 37
(problems-first), the owner asked for design thinking here: *"Think about how
this would work."*

**Phase 2 (2026-08-03): the adapter carries the fielded fleet into the plan.**
`CommissionHost.assembleFieldedFleets` joins live creeps to commission corpIds
through the store (the runtime-id -> commission-id mapping only the store
has), inverts each kind's `roles` table (workType -> role; undeclared
workTypes bucket under themselves - measured, never dropped), and returns
per-role `FieldedRole { count, parts, ttls }` (TTLs ascending; spawning
creeps count full life; unclaimed creeps are X3's orphans, not fleet). Inner
squads need no special casing - they stamp the OPERATION's id
(HarvestCorp.setHaulRoutes). main threads it as an ARGUMENT
(`economy.update(tick, assembleFieldedFleets())`) - a live snapshot owned by
the execution layer, not Memory-persisted history - through `solveColony`
into `ColonyProblem.fielded`. Unread until phase 3's replacement scheduling;
pinned by `test/unit/execution/fieldedFleets.test.ts`.

**Phase 1 (2026-08-03): solver-backed commissions declare their FLEET.**
`Commission.fleet` (`FleetRole { parts, load, workingParts?, count? }`) on
harvest/carry/upgrade/build envelopes - the same price decomposed by role,
built INSIDE the one derivation (`haulerFleetRole` from the planner's own
routed spawnParts; `consumerSpawnLoad` now returns its decomposition), so the
declaration cannot drift from the price: per commission,
`Sigma(fleet[role].load) == consumes.spawnPartsPerTick` pinned to 1e-9 by
`test/unit/economy/commissionFleet.test.ts`. Role keys are the kind's declared
`roles` keys - the join key per-commission plan-vs-actual will use. Auxiliary
commissions stay fleet-absent by design (off-budget; they join per-kind in
phase 4).

## The owner's ask (verbatim)

> "I'd actually like it if corps get their creeps from the plan. It makes the
> connection between spawn and corp and owns it and owns the creep ownership
> transfer on arrival. So corps don't really know anything about spawning.
> They just know which creeps they have assigned to work with. ... It's good
> for accounting too. There should be a code cop to guard anyone spawning
> directly besides spawns as commissioned by the plan mostly."

## Why: this is the structural answer to spec 38 P-F

P-F established (in code, not inference) that **the plan is advisory**: the
parts budget shapes which commissions the solver makes but never bounds what
gets spawned; `SpawnScheduler` fills corp-authored demands by priority and no
spawn-side code reads `partsLedger`. Every fidelity failure catalogued this
session — three bank-drain rates (38), the fuel lens (37), P4's 7× reserver
under-count, F1 at 1.24× — is a symptom of the same shape.

**Crucially this proposal is NOT a gate.** The trap list forbids gating
scarcity (`"the planner prices — it doesn't gate"`), and a hard parts cap at
the spawn door would re-open the t72455355 starvation class. This inverts
*authorship* instead: there is no demand for a gate to reject, because corps
never author demands. The plan decides the fleet; the executor builds it;
corps receive it. Agreement becomes structural rather than enforced.

## Current state (measured 2026-07-30)

| | today |
|---|---|
| corps implementing `getSpawnDemand` | **16 files** (11 corps + `Corp` base + lenses) |
| `spawn.spawnCreep` call sites | **3** — `SpawningCorp.ts:142`, `BootstrapCorp.ts:274`, `:359` |
| ownership assignment | ALREADY at spawn: `memory: { corpId: buyerCorpId, workType, spawnedBy }` |
| body authorship | `CorpKind.roles: { [role]: RoleSpec }` — kinds ALREADY declare bodies |
| commission price | `Commission.consumes.spawnPartsPerTick` — ALREADY declared |
| enforcement precedent | `test/unit/economy/purity.test.ts` — source-scan ratchet with an explicit `KNOWN_IMPURE` debt list |

**Three of the four pieces already exist.** The executor already stamps
ownership; kinds already own bodies; commissions already declare a price. What
is missing is that the *quantity and timing* decision lives in 16 corp-local
lenses instead of in the plan.

## Target shape

```
GOAL plan (solver)      "this colony needs: 2 miners @ src A, 1 hauler 8C, …"
        ↓ commissions, each declaring its fleet AND its price
NOW plan (spawnAgenda)  "to reach/hold that: build X now, Y at t+40 (EOL of Z)"
        ↓ ordered build list
SpawningCorp            executes; stamps corpId on the newborn (already does)
        ↓ ownership transfer on arrival
Corp                    members() — that is the WHOLE spawn surface it sees
```

`Corp.getSpawnDemand()` is deleted from the base class. A corp cannot express
a wish for a creep; it can only work the creeps it has.

## OWNER DECISIONS 2026-07-31 (settle hard parts 1 and half of 2)

1. *"Incorporate the actual into the plan. A bank with 30k surplus over 1500
   ticks is a 20 e/t source. Same thing — but a single consistent framework."*
   → Hard part 1 is DECIDED, not open: per-post actuals (bank stock, piles,
   controller stock, TTLs) enter `ColonyProblem` through the adapter, the plan
   allocates, corps obey the plan. The macro doctrine's "consumers size from
   actuals" is PRESERVED by construction — the actuals are simply upstream of
   the sizing instead of beside it. Spec 38 records the same decision from the
   drain-rate side (the +15 out-of-plan sip and the consumer override both
   die; t72455355 becomes an in-solver fill-order invariant).
2. *"Spawn costs per the plan should be ratioed via effective ttl — a spawn
   750 ticks away for delivery effectively costs double the body parts."*
   → Commission pricing is UNIVERSALLY amortized over
   `effectiveLife(delivery walk)` (already true for producers; extended to
   every class, claim bodies over CLAIM_LIFETIME). This also prices the
   replacement-overlap question in hard part 2: a commission's cost per tick
   of USEFUL life is what the NOW plan schedules against, so the
   deliveryLeadTime overlap stops being invisible spend.

## The hard parts (honest, not hand-waved)

**1. Consumers must still size from ACTUALS — so the actuals must reach the
plan.** Macro doctrine: consumers size from measured stock/inflow at their work
site, never the goal plan. That doctrine is *correct* and this proposal must
not break it. But the planner is **pure** (enforced by `purity.test.ts` — it
may not touch `Game`). So per-post actuals (controller stock, source buffers,
site absorb) must enter through `ColonyProblem` via the sanctioned adapter
(`flowAdapter`), which already reads `Game` behind guards.
*This is the main cost of the change: the problem object grows.* It is also
the main prize — one place reads the actuals, one place decides, so
"three drain rates" becomes impossible by construction rather than by
vigilance.

**2. Replacement timing needs creep TTLs in the NOW plan.** Today each corp
watches its own creeps and orders a successor `deliveryLeadTime` early
(deliberate double-staffing so a post is never dark). Under the inversion the
NOW plan owns that schedule and needs TTLs — again adapter-supplied. Note this
also makes the EOL-overlap cost *visible in the plan* for the first time, which
is part of the unexplained F1 gap.

**3. Reactivity.** Corps re-decide every tick; the planner runs on
`PLANNING_INTERVAL` (100t). A creep dying at t+1 must not wait 99 ticks for a
successor. Prerequisite: **spec 36 item 1, event-triggered replanning
(`runPlanningPhase(force)`)** — a death/loss event forces a NOW-plan refresh.
Without it this change trades fidelity for latency, which is a bad trade.

**4. Legitimate direct-spawn exceptions.** `BootstrapCorp` spawns directly
because at cold start there is no plan and no economy to plan with. That is a
real exception, not debt to erase — the cop must allowlist it explicitly (the
`KNOWN_IMPURE` pattern), so the exception is *named* rather than silent.

**5. Orphan re-adoption** (`claimsOrphan`) becomes a plan concern: an
unassigned creep is a fleet the plan did not order, so the plan reassigns or
recycles it. Simpler than today, but it must not regress the orphan-rescue
behaviour the kind conformance suite pins.

## The accounting win (the owner's "good for accounting too")

If every creep traces to a commission, then:

- **per-commission plan-vs-actual becomes free**: planned parts vs the parts
  actually spawned against that commission id. F1 decomposes from one colony
  number into a per-commission table — the leak lands with a name attached.
- **P4's under-count class becomes unrepresentable**: today P4 re-derives each
  class's parts from stamps and got reservers 7× wrong by sampling one of
  seven per-room corps. If the ledger sums the commissions that actually
  spawned, there is nothing to re-derive and nothing to sample.
- **X5 churn gets an owner**: an early death is a commission whose fleet was
  rebuilt, chargeable to that commission.
- **"unbudgeted" disappears as a category.** P4 currently prints
  `transient-route haulers (unbudgeted)` — a class the plan admits it does not
  price. Under the inversion an unpriced spawn cannot happen.

## The code cop (concrete — follow `purity.test.ts`)

A source-scan ratchet, same shape as the existing purity test:

1. `spawn.spawnCreep(` may appear ONLY in an allowlist:
   `corps/SpawningCorp.ts` (the sanctioned executor) and
   `corps/BootstrapCorp.ts` (named cold-start exception).
2. `getSpawnDemand` may appear only in files on a **shrinking** debt list —
   the test fails if the list GROWS, and fails if a paid-off entry is still
   listed (exactly how `KNOWN_IMPURE` ratchets today). This lets the migration
   land corp-by-corp with the direction enforced at every step.
3. Once migration completes, both lists collapse to the executor + bootstrap
   and the ratchet becomes a permanent invariant.

The cop is cheap and can land **first**, before any behavioural change — it
pins the current surface (3 spawn sites, 16 demand files) so the number can
only go down.

## Migration path (each phase independently shippable)

| phase | change | gate |
|---|---|---|
| 0 | the cop, pinning today's surface as debt | unit only |
| 1 | commissions declare their FLEET (count + body per role), not just a price | unit + trio |
| 2 | adapter carries per-post actuals into `ColonyProblem` | unit + trio |
| 3 | NOW plan owns replacement scheduling (needs spec 36 item 1) | full gate + grid |
| 4 | migrate corps off `getSpawnDemand`, one kind at a time, cop shrinking | full gate per kind |
| 5 | delete `Corp.getSpawnDemand`; cop becomes an invariant | full gate |

## Acceptance (measurements, per house style)

1. **F1 ≈ 1.0** in steady state — the point of the whole exercise. Today 1.24×.
2. Every fielded creep resolves to a live commission id; `X3 untracked` → 0
   (today 2, chronic).
3. P4 needs no per-class re-derivation: its table is a sum over commissions,
   and the reserver-class 7× bug is not expressible.
4. The cop's two lists are strictly non-growing across the migration.
5. No regression in the delivery contract: posts do not go dark at EOL (the
   `churn-t3-gapless-replacement` grid cell stays green) — this is the risk
   phase 3 carries.
6. Score does not fall outside the multi-draw band across the migration.

## Risks

- **Latency for fidelity** is the central trade. Mitigated by spec 36 item 1;
  if event-triggered replanning does not land first, phase 3 must not ship.
- **The pure-planner boundary could erode** as actuals are threaded in. The
  purity ratchet must be extended, not relaxed — actuals enter via the adapter
  seam only.
- **A big-bang migration would be unreviewable.** Hence the per-kind phase 4
  with the cop ratcheting; no phase should require a flag day.

## The auxiliary-spawn seam has a measured price now: it is the colony's largest leak (t72872936)

This spec's open seam is usually stated architecturally — *the SpawnDirector
does not read `commission.fleet`, so a commission can declare a fleet nobody
buys*. Two audit cycles put a number on it.

`mining-W42N22-harvest-cee0`, measured t72872936:

```
  commission declares      35 parts          (F2 row)
  fielded                  11 parts
  corp's own demand lens   carryNeeded 1     exit "staffed"
  standing at its mouth    8,151 e           miner pile-gated 98% of the window
```

The commission is right. The corp's demand lens is right *under its own rule* —
`haulCarryNeeded` filters `construction-` routes with *"the tankers own this
energy, pile or no pile"*, and cee0's flow is routed to a construction sink. The
tankers that are supposed to own it are sized for a 10-tile haul
(`tankerDist: 10`) against a d=36 supply route, so they never come.

Nothing reconciles the two, because **nothing reads the commission when
buying**. That is this spec's seam, and its cost is no longer hypothetical:

- cee0 + cd98 (the two construction-routed sources) grew **5,431 → 13,766e in
  1,252 ticks — 82% of the colony's entire pile growth**;
- colony pile decay **19.26 e/t against a budget of 0.00**, the ledger's TOP
  LINE and 16% of gross mining;
- and the spawn was **idle 13% of that window, 63% of it for "no demand"** — so
  this is not a funding shortfall. The capacity to fix it was sitting unused
  because the ask never arrived.

**If the director bought what the commission declares, cee0 would be staffed.**
That is the one-line argument for closing this seam, and it now has a price tag
rather than an appeal to tidiness. It also retires the five debt entries already
on file here, and closes spec 49's Leg B blocker (*"the plan would price a route
nobody drives"*) as a side effect — same defect, different route class.

Not attempted in the audit cycle that found it: this is a framework change, and
patching `haulCarryNeeded` to grab construction routes instead would put the
mining haulers and the construction tankers on the same sinks with nothing
arbitrating — the double-order class the trap list names. The seam is the fix.
