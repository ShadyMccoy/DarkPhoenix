# 47 — The colony budget IS the sum of the corp budgets

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

## 4. What lands

1. **Publish the corp budget** — corps segment gains `shape`, `consumes`,
   `produces`, plus a declared `reportingCategory` from the kind. (Segment
   version bump; no behaviour change.)
2. **Migrate auxiliary kinds onto the budget** — spec 39 phase 4. Until then the
   statement must SHOW the split honestly: which categories are summed from corp
   budgets and which are still reconstructed. A half-projected statement that
   hides which half is worse than today's.
3. **The budget column becomes Σ corps.** `planSpawnLoad` and the per-line budget
   formulas are deleted, not refactored — the whole point is that there is one
   book.
4. **Every row drills to corp.** Free once corp rows are published: the row IS
   the sum of its corps, so the drill-down is the addends. `docs/fiscal/` closes
   gain a per-corp table under each category.

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
explicit that two reports are comparable only at the same stamp. The spec-45
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
- Spec 45 — the experiment this must not land in the middle of.
