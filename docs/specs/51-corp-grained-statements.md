# 51 — The colony budget IS the sum of the corp budgets

**Status: BACKLOG 2026-08-06** (owner: *"Every corp plan is essentially a list of
inputs and outputs. Thats the corp budget. The colony budget is the sum of the
corps. Each corps is assigned a reporting category for aggregate overview and
presentation but the row can be drilled down to the corp level."*)

## 1. This model already exists. It is `Commission`.

The owner's model is not a feature request — it is a description of a type that
has been in the tree since the corp framework landed
(`src/economy/Commission.ts`):

```ts
interface Commission {
  corpId: string;
  kind: string;
  shape: CommissionShape;        // produce | transport | consume | auxiliary
  consumes: CommissionInputs;    // { energyRate, at, spawnPartsPerTick }
  produces: CommissionOutputs;   // { energyRate, at, valuePerTick }
  fleet?: CommissionFleet;       // planned parts/load per role
  assignment: unknown;           // opaque kind payload
}
```

Its own header already says it: *"the planner's output for a single corp: what
the corp consumes (energy-at-a-place, spawn build-time), what it produces
(energy-at-a-place, or colony value)."* That is "a list of inputs and outputs,
that's the corp budget", verbatim. `shape` is "assigned a reporting category".

**So the statement should be a PROJECTION of `Commission[]`, and it is not.**

## 2. What the statement actually does instead — the second book

`scripts/waste-ledger.ts` builds the budget column by RE-DERIVING it from the
flow segment's `sources` / `haulers` / `sinks` arrays with its own formulas:
`minerOverhead(spawnDistance)` for extraction, `spawnParts × CARRY_MOVE_PAIR_COST/2`
for evacuation, and `planSpawnLoad()` — a ~120-line reconstruction — for
reservation, infra, defense and consumers.

That is a **second book**: the planner decided a number, and the reporting layer
independently recomputes what it thinks that number was. Every disagreement
between them shows up as a variance that looks like a colony behaviour and is
actually an accounting artifact. That is the "fanciful and deceiving" — the
statement presents itself as the plan's budget while being a reconstruction of
it.

It is also the direct cause of the three role-mapping defects logged in the
previous draft of this spec (`tanker` bought by two kinds and both landing in
infra; `hauler` spanning evacuation and scavenge; `jack` unclassified): those
only exist because the reporting layer keys on ROLE, which is all
`Memory.spawnLedger` carries. With corp rows, role stops being the key and all
three dissolve rather than being patched.

## 3. The three gaps, precisely

**A. The corp budget is not PUBLISHED.** Segment 4 emits
`{id, kind, type, nodeId, roomName, creepCount, bodyParts, body, fleet, sizing,
produced, createdAt, lastActivityTick}`. `fleet` (the planned parts/load,
spec 39 phase 1) is there; **`shape`, `consumes` and `produces` are not**. The
host cannot sum a book it cannot see, which is why it rebuilds one.

*This is the cheapest fix in the spec and it unblocks the rest: three fields on
the corps segment.*

**B. Auxiliary corps are OFF-BUDGET.** `Commission.fleet`'s own doc: *"auxiliary
commissions are off-budget (the SpawnDirector prices them) and leave it absent
until their kind migrates (spec 39 phase 4)."* Live, that is 7 of 12 kinds —
reservation (8 corps), tender, controllerFeeder, raidGuard, scout, coreBuster,
bootstrap.

So **Σ corps ≠ colony budget today**, and it cannot be until spec 39 phase 4
lands. This is the load-bearing dependency: half the statement's budget comes
from the corps' own book and half is reconstructed, which is exactly the seam
that makes it incoherent. Reservation alone is 19.52 e/t at t72823437 — not a
rounding.

**C. The reporting category is coarser than the statement.** `shape` has four
values; the statement has extraction / evacuation / reservation / link /
infra / defense / consumers / expansion / incursion. The kind should DECLARE its
reporting category (registration-only, per spec 17), so a new kind classifies
itself and `ACCOUNT_CLASS_OF_ROLE` is deleted rather than extended.

## 3b. MEASURED 2026-08-06 — the identity, and exactly where it breaks

Established locally with a pure scenario suite
(`test/unit/economy/corpBudget.test.ts`): stage a `ColonyProblem`, run
`planColony` -> `commissionsFromPlan`, sum `consumes.spawnPartsPerTick`, compare
against the plan's own `partsLedger`. No mockup, no capture, milliseconds.

**The good news first: the model is already REAL for two thirds of the plan.**
Across four staged worlds — home-only, home + two remotes, two spawns, and a
world carrying a standing infra charge — the identity holds EXACTLY:

```
SIGMA(commission.consumes.spawnPartsPerTick) === partsLedger.minerLoad + partsLedger.spent
                                                 delta 0.000000 in all four
```

So "the colony budget is the sum of the corps" is not aspirational. It is how
produce and transport already work, and it is why the remaining two gaps are
worth closing rather than working around.

**GAP 1 — the consume envelope and the fill charge different numbers.
→ CLOSED 2026-08-08.**

`consumerSpawnLoad`'s own docblock claimed it was *"the SAME charge the planner's
parts ledger paid for this sink."* Measured in the construction world:

```
build commission declares   0.074189 p/t
the sink fill actually spent 0.041351 p/t      => 1.79x over-declaration
```

**The whole of it was the SUPPLY VECTOR, and the builder term was identical on
both sides throughout** — which is what makes this a seam bug rather than a
disagreement about economics:

```
              CARRY   parts    load        model
commission     73.8    99.0    0.066892    3C:1M gait, dEff 40, x1.5 margin
fill           25.2    50.4    0.034054    1:1 laden-both-ways, d 20
                                1.964x
```

The envelope had been moved to the gait the runtime really fields (spec 34
vector-gait follow-up B, whose own note says the 1:1 model *"under-priced every
unpaved campaign ~2x and F1 booked the fleet as breach"*) — and the fill was
left on the 1:1 model. The very defect that follow-up existed to remove,
still standing on the other side of the seam, for exactly the reason this spec
is about: nobody was summing one side against the other.

**Closed by ONE derivation, `roadEconomics.consumerUnitSpawnLoad(kind, dist)`** —
the consumer charge per UNIT of energy routed. The fill (`routeToSinks`'s
`workPerUnit`) debits it per unit; the envelope (`consumerSpawnLoad`) is that
same law × the allocation. The identity is now arithmetic, not coincidence.

Being per-UNIT is what makes it one law instead of two: the fill needs a rate to
multiply by each `take`, so anything non-linear in the allocation cannot be
shared. Hence `vectorSupplyPartsGaitRate` — `vectorSupplyPartsGait` with both
ceilings removed. **The ceilings belong to a BODY; a budget is a RATE, and
rounding a rate is what makes two books disagree.** This is
`controllerWorkSpawnLoad`'s own stated precedent (*"a ceil made charge and audit
disagree"*) applied to the vector. Sizing still ceils, on
`tankerCarryNeededFor`; only the price is continuous. Worth 0.6% at rate 30
(98.40 vs 99) — but 22% at rate 1, so removing it also stops the budget
over-stating every marginal unit it prices.

The controller branch still carries NO vector — its mover is the feeder, priced
in `infraSpawnLoad` and declared by controllerFeeder's own corp, so a vector
here would double-count. That asymmetry is real economics, and it now lives in
one place instead of being restated (and mis-stated) at each call site.

**What moved, in the plan.** The fill went UP and the envelope came DOWN, and
they met: on the golden master's build sink, `chargedWork` 0.00254 → 0.00361
against a declared 0.003877 → 0.00361. Construction is genuinely more expensive
now, because a build crew's fuel shuttle is genuinely that expensive: in the
organism scenario the founding site went from a full 16.07 e/t absorb to 12.58,
**parts-bound** (`partsLeft` 0, ledger dry) rather than out-valued — it still
takes the ledger ahead of A's own controller, which keeps only its reserve
floor. The old plan promised 16.07 e/t of build while budgeting half the tanker
fleet the runtime would field; that difference was F1 breach by construction.
`organismScenario`'s assertion was re-pinned from the magnitude to the contract
(priority, and parts-bound-not-value-bound), the way its sibling test had
already been re-pinned in 2026-07-30.

**GAP 2 — auxiliary corps declare a budget of ZERO. → CLOSED for the depot and
remote kinds, 2026-08-06 (spec 39 phase 4).**

`proposeHelpers.perRoomAuxiliaryCommission` hardcoded
`consumes: { spawnPartsPerTick: 0 }` for every auxiliary kind. The colony's
ledger *did* know the cost — it deducts `infraPartsPerTick` before the fill
spends anything — but **no corp owned it**, which is exactly the hole
`waste-ledger.planSpawnLoad` was written to re-derive.

`infraSpawnLoad` is now DECOMPOSED into three per-corp primitives
(`roomReserverSpawnLoad`, `tenderSpawnLoad`, `feederSpawnLoad`) which the
aggregate itself composes, and reservation / tender / controllerFeeder each
declare their own share. The invariant is pinned to **1e-12**:

```
SIGMA(auxiliary corp consumes) === infraSpawnLoad(relay, depots, remotes, linkFed)
```

Exact rather than approximate because `reserverSpawnLoad` is linear in parts, so
N per-room prices sum to the aggregate's `N * parts` term identically.

The aggregate does NOT go away, and that is deliberate: the solve needs the
number before any auxiliary commission exists (`propose()` reads the draft, so it
cannot run first). The circularity is real. What changed is that both sides now
compose the same three primitives, so a drift fails a test instead of surfacing
as a mystery variance.

**A double-book bug fell out of doing it.** The tender and feeder kinds
commission one corp per SPAWN room; `infraSpawnLoad` prices them per DEPOT room
(`depotRoomCount`). Nobody had noticed because neither side was summed against
the other. A pre-storage room therefore commissioned a depot mover the colony's
ledger never charged for. Fixed by a `depotRooms` / `linkFedRooms` host lens on
`ColonyProblem` (spec 17 P3's pattern, alongside `hostileRooms`), so both sides
read the same fact; pinned by the "charges NOTHING for depot movers in a room
with no storage" test.

**And a second one, on the first live capture that could see it (t72828763).**
The reconciliation came up short by exactly `0.003704` p/t — one
`roomReserverSpawnLoad`. Not a pricing drift: the two sides were pricing the same
way from **different remote-room sets**. `infraSpawnLoad` reads
`prevFundedRemoteRooms` — the PREVIOUS solve's answer, because the charge is
deducted before the solve that decides this one's — while the reservation corps
are proposed off THIS solve's draft. The capture shows both: 9 reservation corps,
8 of them priced (the 9th a retained corp for a room that had just dropped out as
sources went 12 → 11), against `infraInputs.remoteRooms: 9`.

A one-solve lag, and survivable as one. It is not survivable as a one-MONTH lag,
which is what the fiscal-month plan term (spec 46 phase A) turned it into: the
plan built at a boundary IS the month's budget, so a remote that leaves is
charged to the colony for the whole month after it stopped being worked. Worse
for this program specifically — remotes leave *exactly when the handicap steps*,
because the first thing a shrinking spawn budget does is stop admitting marginal
remotes. The over-charge would have landed on the same months the sweep is
measuring, in the same direction as the step.

Closed in `solveColony`, where this solve's answer is already in hand: when the
plan funds a different number of remotes than it was priced for, re-price and
solve again with the set it actually funded. Free in steady state (counts match,
no pass runs), bounded to two re-prices when they don't, and it also converges a
COLD start in one solve rather than one replan — with no history the priced set is
every scouted candidate (t72750467: 26 rooms against 8 funded).

**The re-price wraps the fleet-charge iteration rather than following it**, and
that ordering is the whole correctness of it. `infraEnergyPerTick` is a TERM of
the fleet charge, so dropping a reserver lowers the charge the spawn sink should
demand. A correction bolted on after convergence ships a plan whose fleet costs
less than the charge still being demanded for it — the same over-charge, moved out
of the parts ledger and into the energy one. So each re-price re-runs the damped
iteration, seeded from the charge already converged: usually one extra search, and
the stamp's `spawnMaintenance * spawnCount == fleetEnergy` identity survives it
(pinned).

It is not guaranteed to reach a fixed point, because dropping a room frees the
charge that can fund it back. So the stamp publishes
`infraInputs.remoteRoomsFunded` next to `remoteRooms`: one number cannot say
whether the books agree, and a residual that is named is not a mystery variance.

**STILL OPEN:** `scout`, `raidGuard`, `coreBuster` and `claim` declare 0 *and*
are absent from `infraSpawnLoad` — outside BOTH books. `planSpawnLoad` prices
guards anyway (0.98 e/t measured t72823437), so that class remains a second-book
seam: budgeted by nobody, charged by the statement.

**Both gaps are pinned** by the suite. GAP 1's TARGET —
`SIGMA(corp consumes) === minerLoad + spent`, consumers included — is now GREEN,
and the ratio assertion beside it inverted from "between 1.5x and 2.1x" to
"1.0 to 1e-9". GAP 2 keeps an explicit assertion that the ledger's infra is
unowned, with a `skip`ped TARGET beside it for the combat/scout kinds — the fix
flips a red test green rather than being argued.

Two further pins came out of closing GAP 1, both stating the DIAGNOSIS rather
than the total, so a regression names its own cause: that the construction
vector is priced at the fielded gait (~1.95x the retired 1:1 model) and is
linear in the rate, and that the controller charge is WORK only.

### Why scout / raidGuard / coreBuster are NOT just three more of the same

Owner asked the obvious question — why not convert them too, it looks easier.
They split three ways, and only one of the three is mechanical.

**raidGuard and scout SHOULD be priced, and the reason is sharper than "they
are missing".** Defense is already priced — but only in ENERGY, at ADMISSION:
`invaderTax * rate` per remote source (`EXPECTED_RAID_DEFENSE_COST` 750
amortized over `INVADER_RAID_MEAN_ENERGY`), which reduces each candidate's net
and can drop a remote whose profit was fictional. There is **no PARTS-side
counterpart**. Compare reservation, which is priced in BOTH currencies —
`reserverRoomEnergy()` in the admission tax and `reserverSpawnLoad()` in
`infraSpawnLoad`. That is the design: the colony is constrained in energy AND in
spawn build-time, so a standing fleet costs in both books.

So the guard fleet consumes spawn parts the plan never reserves. That is a real
asymmetry, not a rounding — and adding it does NOT double-count the invader tax,
because the tax is the other currency.

**But it is a behaviour change, and a sweep-confounding one.** Measured at
t72823437: the standing guard fleet is 3 creeps / 30 parts = **0.020 p/t against
a plannable 0.600 — 3.3% of the whole budget.** One handicap step is 1% of the
physical 0.667 = 0.0067 p/t, so pricing guards is worth **~3 handicap steps**.
Landing it mid-sweep would move the very quantity spec 50 is varying. Same gate
as everything else here.

**And it needs a plan-side MODEL, which is the part that is not mechanical.**
The three depot/remote kinds were extractable because `infraSpawnLoad` already
contained their terms — the work was decomposition, not invention. There is no
guard term to extract. `waste-ledger.planSpawnLoad` prices guards from the
MEASURED standing bodies, which makes its "budget" an actuals-fed number — the
one thing spec 14's owner directive says not to do yet (*"eventually we will
feed actuals back to inform the budget, but not quite yet. We have some poor
behavior that's causing variants that we don't want to encode as the budget"*).
Copying that into the plan would encode current behaviour as the budget. A
defensible model (guard detail per hostile-exposed remote × standard body /
CREEP_LIFETIME) is design work, and guessing it would manufacture exactly the
undefendable number this spec exists to remove.

**coreBuster and claim are a UNIT mismatch, not a gap.** They are CAPEX —
one-shot purchases funded from the expansion reserve, which the account already
segregates below the operating margin (`CAPITAL (funded from the expansion
reserve, not operating margin)`). A parts-per-TICK standing rate is the wrong
shape for a thing that is bought once and never replaced on a cadence.
`claimKind` says so itself: *"the claimer is CAPEX, priced by the SpawnDirector's
value ranking (held-funded 650), not the flow planner."* They should still carry
a corp row so the CAPITAL section gets a budget where it currently prints "-",
but the number wants a capex shape (total cost + a reserve draw), not a rate.

Ordered conclusion: scout and raidGuard are a genuine next slice needing a
model; coreBuster and claim need a capex-shaped budget line first; none of it
lands mid-sweep.

## Phase 2 — raidGuard onto the budget (2026-08-07, SHIPPED)

Owner override on the timing above: *"What about raid guard"* … *"I want it now.
Don't worry about the sweep that's in parallel."* The gate was the owner's to
lift; the confound is real and stated below rather than argued away.

**The model, and why it is not the actuals feed the section above refused.**
`roomGuardSpawnLoad()` = `GUARD_PARTS_PER_ROOM / CREEP_LIFETIME` = 10/1500, one
per ARMED room. Both terms are declared, not measured: 10 parts is the body
`buildGuardBody` asks for at its own 5-pair cap (the same "price the full-budget
body" convention `RESERVER_PARTS_PER_ROOM = 4` uses), and the cadence is the
lifetime the spawn actually rebuilds on. What the section above rejected was
copying `waste-ledger`'s price — bodies STANDING at capture time — into the plan,
which would have encoded current behaviour as the budget. This runs the
dependency the other way: the plan declares the price and the ledger's
`defense (guards)` line now READS it (methodology #16). Before, both sides of
that variance were the same measured bodies, so it could never disagree; now a
gap is a genuine F1 signal.

**The count comes from a LENS, not a room count — this is the first conditional
member of the identity.** The tender and the feeder exist wherever a depot does;
a guard exists only while a room's raid meter is armed. So `guardTargetsFor`
(moved to `utils/raidMeter`, delegated to by `RaidGuardCorp.guardTargets`) is now
read by three callers — the corp holding its posts, `CommissionHost` publishing
`ColonyProblem.guardedRooms`, and the adapter computing `infraSpawnLoad`. One
predicate, three readers: a second copy would be the two-books failure by
construction, and a CONSTANT would charge a peaceful colony for defense it never
fields. A quiet colony prices exactly zero, and the pre-phase-2 4-argument
`infraSpawnLoad` call is bit-identical.

Armed rooms bind to their NEAREST home (reservationKind's rule, same tiebreak),
so a room two homes can both see is charged once. The runtime would field two
guards there today — a multi-home coverage gap that predates this pricing and is
invisible in a single-colony world.

**The sweep confound, quantified and accepted.** In an ARMED window this takes
~0.020 p/t out of a plannable ~0.600 — 3.3%, about three handicap steps. Quiet
windows are unaffected (numerically identical). Sweep bands straddling this
commit are therefore not comparable on armed windows; the band boundary is the
commit, not a fiscal one.

### Gate for phase 2 (2026-08-07)

unit 2279 passing / 20 pending; `tsc` clean on both projects; build clean;
integration `flow-handoff` PASS, `runt-economy` PASS, `storage-depot` PASS.
Grid `def-t4-raid-guard-holds-the-remote` PASS — guard fielded @1, raid @150,
kill @174 — the one cell where `guardedRooms > 0`.

Two economy cells came back RED and were ACQUITTED by attribution runs at the
parent commit (`a71ff95`) in a clean worktree: `plan-t1-single-source-loop`
(timeout @1200t) and `fid-t4-synthetic-steady-state` (fail @1100t) fail
IDENTICALLY pre-change, same assertion, same satisfied-at ticks. Tick-identical
means deterministic, not host load — these are real pre-existing reds on the
branch against a baseline last ratcheted 07-29, and they are not this change's.

### Gate for phase 4 (2026-08-06)

unit 2251 passing / 20 pending; tsc, lint and build clean; integration
`flow-handoff` PASS, `runt-economy` PASS (240s, "upsize PROVEN"),
`storage-depot` PASS.

`runt-economy` first came back RED at 13 minutes against its usual ~4. It was
re-run clean and passed identically to its previous green — the red was the
documented HOST-LOAD class (the mockup meters real CPU against a real bucket,
so cell behaviour couples to load), self-inflicted by backgrounding the test
and doing spec edits and a poll loop alongside it. Recorded because the
temptation on a 13-minute timeout is to go hunting in the diff: **re-run alone
first**, and only then attribute.

### A note on the scenario harness

`npm run plan:scenario` is DEAD: `scripts/run-plan-scenarios.ts` imports
`test/planning/ScenarioRunner`, which no longer exists, and the 25 world files in
`test/scenarios/*.json` are in a legacy node/resourceNode format that predates
`ColonyProblem`. Nothing reads them. The working scenario harness is the pure
planner one used above (and by `organismScenario.test.ts`): stage a
`ColonyProblem` in TypeScript and run `planColony`. Either revive the runner with
a format translator or delete the orphans — but do not trust `plan:scenario` as
a gate; it cannot even compile.


## 4. What lands

0. **Declare the category** — `economy/accountCategory` (LANDED 2026-08-06):
   kind -> statement line, registration-only, with a test that every kind in the
   tree is classified. Pure; no behaviour, no methodology change.
1. **Publish the corp budget** — corps segment gains `shape`, `consumes`,
   `produces`, plus the declared category. (Segment version bump; no behaviour
   change.) `CorpCensusEntry` already carries `commissionShape`, so this is
   three fields.
2. **Close GAP 1** — one derivation for the consumer charge, shared by the
   commission and the fill. Whichever number is right, both sites must read it.
   **LANDED 2026-08-08** as `roadEconomics.consumerUnitSpawnLoad`; see §3b.
3. **Close GAP 2 / migrate auxiliary kinds onto the budget** — spec 39 phase 4. Until then the
   statement must SHOW the split honestly: which categories are summed from corp
   budgets and which are still reconstructed. A half-projected statement that
   hides which half is worse than today's.
4. **The budget column becomes Σ corps.** `planSpawnLoad` and the per-line budget
   formulas are deleted, not refactored — the whole point is that there is one
   book.
5. **Every row drills to corp.** Free once corp rows are published: the row IS
   the sum of its corps, so the drill-down is the addends. `docs/fiscal/` closes
   gain a per-corp table under each category.

## 4b. A structural consequence: there is no separate `evacuation` row

Worth deciding deliberately, because the corp-summed statement READS differently
from today's.

Today's statement keys on ROLE, so miners and haulers land on separate lines
(extraction / evacuation). But a mining commission is the all-in MINER OPERATION
(spec 34 D5): the harvest node AND its routed evacuation vector in ONE envelope
with ONE price. So under "each corp is assigned a reporting category", a mining
operation is one corp on one line, and the haulers inside it are not a separate
category — they are a level deeper.

Demonstrated on a staged world (`npm run audit:corps -- --drill`):

```
  category        corps   spawn p/t     energy in    energy out    value out
  --------------------------------------------------------------------------
  extraction         4      0.0922          0.00         40.00         0.00
      harvest-src-remote-2               0.0454          0.00         10.00
      harvest-src-remote-1               0.0280          0.00         10.00
      harvest-src-home-a                 0.0102          0.00         10.00
      harvest-src-home-b                 0.0086          0.00         10.00
  consumers          1      0.0989         40.00          0.00      2800.00
      build-site                         0.0989         40.00          0.00      2800.00
```

`evacuation` appears only when a route is commissioned as a STANDALONE `carry`
corp (a scavenge route, or a source whose vector the operation does not own).

So the statement gains a third level rather than losing a line:

```
  category  ->  corps  ->  roles
  extraction -> harvest-src-remote-1 -> { miner: ..., hauler: ... }
```

The role level is already published as `fleet` (spec 39 phase 1), so the split
survives — it just stops being the TOP-level grouping. **This is a presentation
decision for the owner**: keep extraction/evacuation as the headline split (which
means the top level is roles, not corps), or make corps the headline and read the
miner/hauler split one level down. The corp model implies the latter.


## 5. Why this generalizes to resources, spawn and CPU

The owner's other ask — *"all the resources... including minerals or other
resources. As well as spawn body capacities and types and cpu"* — is the SAME
structure with a wider input/output vector, not four separate reports.

`CommissionInputs` is `{energyRate, spawnPartsPerTick}` today: already two
resources (energy and spawn build-time) in one envelope. Widen it to a resource
map plus CPU and every statement the owner listed is the same projection over the
same corp rows:

| statement | the input/output dimension |
|---|---|
| energy (today) | `energyRate` in/out |
| all resources | resource map — minerals (spec 22 prices them, nothing meters them), boosts, market credits |
| spawn capacity | `spawnPartsPerTick` in, split by part TYPE (`fleet[role].parts` already carries the shape) |
| CPU | CPU/tick in — spec 20's ledger exists but **`core.corpCpu` reads `null` in captures**, so no CPU line is closeable today; publishing it is step 0 |

One corp row, several columns. That is the whole design, and it is why B above
matters more than any individual report: get every corp onto the budget once and
all four statements follow.

## 6. Timing — NOT mid-sweep

This changes the chart of accounts, so it bumps `METHODOLOGY`, and spec 41 is
explicit that two reports are comparable only at the same stamp. The spec-50
sweep is running 21 fiscal months whose ONLY axis is the handicap; re-graining at
month 12 makes months 1–11 incomparable to 12–21.

**Land at a sweep CYCLE boundary** (`Memory.spawnSweep.cycle` increments,
handicap wraps to 0). Cycle 0 stays at methodology #14, cycle 1 starts at #15 —
which also makes the re-graining its own free A/B: the same handicaps, measured
both ways.

## 7. Acceptance

- The budget column of every category equals the sum of its corps' `consumes`
  (to 1e-9), and that identity is a test, not a report line.
- Every category row expands to its corp rows; the expansion sums to the row.
- No line's budget is computed anywhere except the corp that owns it —
  `planSpawnLoad` and `ACCOUNT_CLASS_OF_ROLE` are gone.
- Categories still reconstructed (pre-39-phase-4) are LABELLED as such in the
  statement.

## 8. Related

- **Spec 39 (the plan owns the fleet)** — phase 4 is the hard dependency. This
  spec is 39's accounting payoff and cannot complete without it.
- Spec 42 (the energy controller budget) — 42 asks every joule to have a named
  home; 47 says that home is a CORP and the colony total is their sum.
- Spec 17 (ontology layers) — reporting category becomes a kind declaration.
- Spec 41 — the methodology stamp is the gate; see §6.
- Spec 50 — the experiment this must not land in the middle of.
