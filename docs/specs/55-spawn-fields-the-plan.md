# Spec 55 — THE SPAWN FIELDS THE PLANNED BODIES

**Status: STANDING REQUIREMENT, repeatedly asked for and still not met.**
Owner, 2026-08-08: *"I've been asking for the spawn to field the planned bodies
FOREVER."*

That frustration is the correct reading of the evidence, and this spec exists so
no future session has to re-derive it. This is **not** a bug report about one
gate. It is a report about a PATTERN: the planner prices a fleet, and something
between the plan and the spawn quietly declines part of it. Every instance has
been found the same way — by a fidelity row (F1/F2) or a pile — and every instance
has been fixed locally, and then another one appears.

**The requirement, stated once:**

> If the plan prices a body, the spawn buys it. If it does not, the refusal is
> RECORDED at the decision site with its own reason, and that reason is auditable
> from a capture. Silent partial fielding is a defect regardless of how good the
> local reason sounds.

## 1. Why this keeps happening (the structural read)

Every violation so far has the same shape: a **local heuristic with a good
justification and a threshold in the wrong units**, sitting between the plan's ask
and the purchase. Each was individually defensible. None was visible in the
plan. The plan says "N parts"; the fleet stands at less than N; nothing in
between says why.

The framework already has the right instinct in two places — `F1` (plan-priced
vs measured spawn load) and `F2` (per-commission declared vs fielded parts) —
but they are REPORTS, not gates. They tell you the gap exists after the fact.
Nothing refuses to run with a gap, and nothing attributes the gap to the
heuristic that caused it.

## 2. The catalogue (measured, each with its own incident)

Four distinct mechanisms found in ONE session (2026-08-08). This is the argument
for treating it as a class.

| # | Mechanism | Measured cost | Status |
|---|---|---|---|
| 1 | **Cost-less demand** — `LinkCorp.portDemands` built a `SpawnDemand` through an `as SpawnDemand` cast with no `minCost`/`desiredCost`. Every funding comparison is a numeric `>=`, and `x >= undefined` is false, so the walk recorded gate `"impossible"` (the RCL-can-never-build verdict) at the HEAD of both spawn queues for 1804+ ticks | The port tender NEVER spawned. Zero of 92 spawn rows. The plan meanwhile routed 40 e/t through each of two ports and priced the body via `portTenderSpawnLoad` | **FIXED + class closed** at the collection seam (`hasFundableCosts`) |
| 2 | **The mature dead-band** — `CarryCorp` declines the marginal hauler while `deficit < bodyShare/2`. Written for *"+-1 CARRY solve to solve"* jitter; the actual threshold at capacity 5600 is **9-12 CARRY**, ~10x the jitter | **7 of 7 piled sources declined**, every solve, forever. Fleet at 89% of the ask (241 of 271.5 CARRY), shortfall perfectly rank-correlated with the piles. Cost: **19.48 e/t** of ground-pile decay, 17% of funded capacity | **OPEN — this spec's first target** |
| 3 | **Swarm cap in the wrong currency** — capped the physical COUNT at 2x target while the ask gate stops on CARRY, so a count-heavy carry-short fleet stopped asking at a permanent deficit | Fielded carry 53-74% of plan with the spawn 54-82% IDLE, controller shortfall tracking the carry shortfall across all three fidelity cells | FIXED 2026-08-02 **in CarryCorp only** — the 2026-08-09 code sweep found `ExtensionTenderCorp` still count-capped behind a stale "mirrors CarryCorp's" comment (the t72851251 tender incident's mechanism, 34/48 parts standing, spawn idle `empty`), and `UpgradingCorp` carries a third sibling at its own patch level. **Tender twin FIXED 2026-08-09** (staffed exit already stops on COUNT+CARRY; the count-2x line became the absolute `TENDER_CREW_CEILING` backstop, red-first pinned in `extensionTender.test.ts`). The upgrader sibling rides catalogue #4 |
| 4 | **Upgrader sliver** — the same predicate family on the consumer side; the corp stamps `demand: "sliver"` and declines | F2 worst line: `upgrading-W43N23` 50p fielded vs 85p declared (**-35**) | OPEN, likely the same fix as #2 |

Historical instances of the same class, already in spec 14: the reserver
`holdToFund` case (an indivisible CLAIM pair every cheaper demand out-ate), the
scaling upgrader's `min == desired == energyCapacity` (fleet froze at 2/6 while
191k idled at 6.9x warchest), and the runt ladder (`3->6->9->12->15->30` parts,
five stepping-stone bodies for one full body).

## 3. What it costs right now

From capture t72869702 (2131 reset-free ticks before it):

- **F2: 18 commissions declare 604 parts standing; 517 fielded.** A 14% standing
  fleet deficit, colony-wide, every window.
- **19.48 e/t** of ground-pile decay = **17% of the 115 e/t funded capacity**, and
  **5.6% of everything ever mined** (1,735,680e of 30.9M all-time).
- The piles are *perennial* for exactly this reason — the owner's own diagnosis,
  2026-08-08: *"The reason we have source piles is simply because our hauling is
  not efficient enough. Otherwise miner spawn idling, and decay would always get
  rid of the piles."* Confirmed: the plan asks for the drain (`bufferDrainCarry`
  predicts cd8d's 5.11 CARRY against 5.10 measured in the plan), and the
  dead-band declines it.

## 4. The owner's proposed mechanism for the drain

Owner, 2026-08-08: *"we could always factor in something like half the ground
pile over 1500 ticks into the source rate."*

This is a better shape than the current one and should be the design basis. Today
the drain is a **carry-side** addition (`h.carryParts += drainCarry`) bolted onto a
route sized from the source rate. Folding it into the **SOURCE RATE** instead —
`rate += staged/2 / CREEP_LIFETIME` — means:

- every downstream term reprices itself automatically (route carry, miner
  gating, the source's admission net, the parts ledger), because they are all
  already functions of the rate;
- the `/2` is the same temporal-midpoint argument `scavengeRate` already uses (a
  pile decaying at ~1/1000 sits at ~0.47x its initial size halfway through a
  1500-tick drain, so half the standing pile is the honest average);
- there is **one** number to audit instead of a base rate plus a correction, which
  is the same "one derivation" principle spec 51 GAP 1 applied to the consumer
  charge;
- it self-retires: as the pile clears, the rate returns to the source's true
  yield with no gate to switch off.

Note the interaction to check: the source rate also drives the *admission* verdict
(`candidates[].net`), so a piled source would look temporarily more attractive. That
is arguably correct — the pile is real energy — but it must not let a pile flip a
source to funded that would otherwise be rejected, or the plan flaps (P1).

## 5. Why one-sided fixes keep failing — read this before patching

The dead-band's threshold cannot simply be lowered. It exists because of the
t72773737 treadmill: *"the even-share treadmill that bought d01f eight bodies in
~1200t (5.17 e/t vs a 1.27 e/t plan)"* — and **d01f is one of the six piled
sources** the dead-band is currently starving. The ask gate and the recycle
**pounce** read the SAME predicate (`worthABody`; flagged in-code at
`CarryCorp:461` as *"the same predicate the ask gate reads"*). Loosening the ask
alone makes the pounce cull incumbents more eagerly, and buy-then-cull churn IS
the treadmill.

**So the fix is two-sided by necessity:** the ask may buy the drain body without
the pounce culling an incumbent over the same margin. Any patch that touches one
side only will re-open a measured incident, and CLAUDE.md's trap list already
names this situation exactly — *"if you are writing the SECOND patch on the same
mechanism, the mechanism is the bug."* Two patches have now been written on
`worthABody`'s threshold family. It is the mechanism.

## 6. Acceptance tests (the contract)

A task under this spec is DONE when these pass, not when a number looks better.

1. **`F2 == 0` invariant cell.** A grid cell in a steady-state world asserting
   declared standing parts == fielded parts within one body share, sustained over
   >= 1500 ticks. This is the spec's headline and it does not exist today.
2. **Drain-to-empty unit test.** A source with a standing pile and a
   count-complete fleet fields the drain body; the pile reaches ~0 and the fleet
   then returns to sustained size (no permanent over-fielding).
3. **Anti-treadmill pin (the two-sided half).** The same world, over >= 1200
   ticks: X5 rebuild churn stays <= its current 0.06-0.09 of spawn spend and the
   pile still clears. This is the assertion that would have caught t72773737, and
   it must fail on a one-sided loosening.
4. **Every refusal is attributable.** For any declined planned body, a capture
   carries the decision-site reason (`lastExit` already does this for CarryCorp:
   `staffed` / `deadband` / `swarm-cap` / `asking`). Extend to the consumer side
   (#4 in the catalogue) and assert in the conformance suite that no kind can
   decline a priced body without stamping a reason.
5. **The seam holds.** `hasFundableCosts` (already landed) keeps refusing
   malformed demands, and the black-box `err` row stays empty.

## 7. Related

- **Spec 39** (the plan owns the fleet) — this is 39's thesis with the failures
  enumerated. The auxiliary-spawn seam noted there (the SpawnDirector does not
  read `commission.fleet`) is plausibly the structural fix for the whole class:
  if the director bought what the commission declares, none of these four
  heuristics would sit in the path.
- **Spec 15** (waste ledger) — F1/F2/X5/E5/S4 are the instruments; this spec is
  about them becoming gates rather than reports.
- **Spec 44** (standing scavenger) — explicitly NOT this. Owner 2026-08-08:
  *"forget about the scavenger. That's for things close to the core not perennial
  source piles."* 44 keeps the near-core stocks; source-mouth piles are a hauling
  question and belong here.
- **Spec 14** — the incident log; every catalogue entry above has its full
  write-up there under its cycle heading.

## Live confirmation t72871684 (audit cycle) — and the aggregate that hides it

Mechanism (2), the mature dead-band, is **stamped live on 8 of the 10 piled
sources** this capture: `exit: "deadband"` on cedc (pile 3665, carryNeeded 22,
1 creep), cd94 (2413/21/1), cd8d (2506/20/1), cee2 (2644/34/2), d01f
(2069/38/2), cbd5 (1274/24/1), cbd8 (332/33/2). Pile decay **17.32 e/t against a
budget of 0.00** — L1's worst row at 69.28× — plus **4.59 e/t forgone** where the
pile-gate throttled the miner (cd94 held **100%** of the window).

**The aggregate no longer shows it, and that is the trap to carry forward.**
Source-route haulage is fielded at **230 CARRY against a 236.7 ask — 97%**, where
this spec's original measurement was 89% (241 of 271.5). The shortfall did not
close; it MOVED. The over-fielded sources (cd8d 161% of declared, cd98 353%) net
out the starved ones (cedc 74%, cd94 78%), and the correlation runs backwards —
the most-piled source has the least carry. A future check of this spec must be
**per-route**, because the colony-wide number now reads healthy while the defect
is unchanged.

(Colony-wide CARRY is 381, but 101 of that is on BUILDING corps and 45 on the
feeder/tender — comparing 381 against the plan's 252.8 makes the fleet look 51%
OVER-fielded and would falsify this spec for the wrong reason. P11 warns about
exactly this; it still caught a session.)

Still not patched, for the reason in §5: the ask gate and the recycle POUNCE
share `worthABody`, so a one-sided loosening re-opens the t72773737 treadmill on
d01f — one of the seven sources above. Acceptance remains the F2==0 cell plus
the anti-treadmill X5 pin. Full write-up: spec 14, cycle t72871684.

## Live confirmation t72874433 — the dead-band is a RANK ORDERING, not a correlation

Read off `corps[].innerSizing` (the miner operation's internal CarryCorp stamps
— spec 34 D5 moved the haulers inside the harvest kind, and their `exit` /
`carryNeeded` / `staged` stamps ride there, not on the standalone `hauling-*`
corps):

```
  source  staged   carryNeeded  idleSink   exit
  cedc      3719        21        0.120     deadband
  cd94      3504        23        0.082     deadband
  cd98      3319        50        0.065     deadband
  d01f      2795        38        0.084     deadband
  cd8d      2590        22        0.182     deadband
  ------------------------------------------------  <- the line
  cbd5      2569        22        0.048     staffed
  cee2      1474        29        0.067     staffed
  cd8e      1650        12        0.126     staffed
  cbd8      1394        32        0.037     staffed
  cee0        30        26        0.085     staffed
```

**The five sources that stamp `deadband` are exactly the five most-piled
sources, in order.** Previous confirmations of this mechanism were stated as a
count ("8 of 10", "7 of 7") which invites the reading that piles and the
dead-band merely co-occur. They do not co-occur: the ranking is monotone and the
cut falls between 2,590 and 2,569.

Their haulers are NOT idle — duty 0.81–0.93, idleSink 0.05–0.18 — so this is
not a delivery-side stall wearing a dead-band mask. The fleet is working; there
is simply less of it than the ask, and the ask gate declines to close the gap.

Unchanged: §5's fence still holds (the ask gate and the recycle POUNCE share
`worthABody`), so this remains un-patched pending the two-sided fix, and
acceptance is still the F2==0 cell plus the anti-treadmill X5 pin. Recorded
because the ordering is the sharpest evidence this spec has, and it cost one
capture read.
