# Spec 40 — The operator contract, and measuring its variance (not its average)

**Status: BACKLOG (owner 2026-07-31, backlog grooming).** Two owner thoughts
that are really one instrument idea at two levels.

## The owner's ask (verbatim)

> "Continuing to tighten the plan ontology vs object abstractions and audit
> the inputs and outputs with variances against the plan. As an abstract
> contract between the two right?"

> "The other is in addition to avg could look at 90th percentile on stats.
> Would show sitting idle every other tick."

These unify: a **contract** says what an operator consumes and produces; a
**variance** is how far actual strays from it; and an average is the wrong
statistic for that variance, because it hides exactly the failure mode the
second sentence names.

## Why now: the border-bounce proved the gap empirically

The exit-tile incident (spec 14, 2026-07-31) is the motivating case, and the
important detail is **the ledger said "ok" the whole time**:

```
t72684708   P8 build delivery   [ok] 1.15 e/t built
            (a builder working ~1 tick in 3, teleport-bouncing across a
             room border, shedding its cargo at the door on every bounce)
t72687812   P8 build delivery   [ok] 10.51 e/t built   (after the fix)
```

A 37× defect sat inside an "ok" verdict for hours. No line caught it; the
**owner watching a replay** did. Two distinct reasons, one per owner thought:

1. **No contract to be in breach of.** P8 asks "did site progress advance?",
   not "did this operator deliver what it declared it would." 1.15 e/t against
   a 20 e/t allocation is a 94% shortfall — but no line computes that ratio
   per operator, so nothing was red.
2. **The statistic was a mean.** Build output was *bimodal*: ~2 ticks at zero,
   1 tick at full. Mean 1.15 reads as "slow"; a p50 of 0 with a p90 at full
   reads as "stalling and recovering", which is a different diagnosis pointing
   at a different cause. Averages cannot distinguish "uniformly slow" from
   "fine but idle two-thirds of the time" — and those want opposite fixes.

## Part A — the contract (the ontology/object boundary made auditable)

This continues spec 34's thesis (*"simple economic interface up
positions/rates/ALL-IN price, sophistication inside, faithfulness measured"*)
and depends on spec 39 making the fleet side real. What is missing is that
"faithfulness measured" has exactly ONE live number today (F1, colony-wide
spawn parts). The contract generalizes it.

Every operator (commission ⇄ corp) declares, in ONE place:

| contract term | example | already exists? |
|---|---|---|
| INPUTS consumed (e/t, by source) | miner: 10 e/t from src A | partially — flow plan routes |
| OUTPUTS produced (e/t, to sink) | hauler: 10 e/t to storage | yes — `flowRate` per route |
| PRICE (spawn parts/tick) | `consumes.spawnPartsPerTick` | **yes** — spec 39 makes it universal + effective-ttl |
| the POST (where it stands) | delivery location | partially — spec 19 |
| CAPITAL formed (energy → structures) | builder: 3,000 into an extension | **no** — see Part C |
| UPKEEP (energy → holding capital) | detail/tower: road decay replaced | **no** — see Part C |

The last two terms were added 2026-07-31 after a retrospective found them
missing — an operator that converts energy into a *durable asset* is producing,
not consuming, and one that spends energy *holding* an asset is doing neither.
Four terms could not tell those apart from waste.

The audit then computes, per operator, `actual ÷ declared` for each term.
F1 becomes the aggregate of a table rather than a single opaque number, and
the leak arrives with a name attached (spec 39's "accounting win", generalized
from parts to all four terms).

**The key property**: a contract is falsifiable per-operator. Today a colony
number tells you something is wrong somewhere; a contract table tells you
WHICH operator is in breach and on WHICH term — input starvation, output
under-delivery, or price overrun are three different diagnoses that F1
currently sums into one.

## Part B — percentiles (the statistic that would have caught the bounce)

**Implementation reality, checked in code**: percentiles need *in-tick*
sampling; the ledger only sees two snapshots, so a snapshot-delta line like P8
can never gain them without the bot sampling. Three corps already accumulate
per-tick duty meters in Memory and are the natural first adopters:

- `CarryCorp` — `dutyActive/dutyIdleSource/dutyIdleSink` (+ the at-sink
  refinement), already surfaced as H1
- `ExtensionTenderCorp` — transfer-duty meter
- `UpgradingCorp` — `workUtil`/`dryShare`/`meterTicks`, already in the stamp

Those are means over a window today. The change is to keep a small **bucket
histogram** instead of a running mean (a handful of counters — cheap in CPU
and Memory), and export p10/p50/p90 alongside the mean.

**The discriminator this buys**, stated as the acceptance test:

| pattern | mean | p50 | p90 | diagnosis |
|---|---|---|---|---|
| uniformly slow | 0.33 | 0.33 | 0.4 | under-provisioned — size it up |
| **stall/recover** | 0.33 | **0.0** | **1.0** | blocked intermittently — find the blocker |

Same mean, opposite fixes. The border bounce was row 2 and was read as row 1
(the working theory for months was "builders are under-fed", which was ALSO
true — spec 37 — and that coincidence is precisely why the bimodality never
got questioned).

**Candidate first line: X1** (dry WORK ticks) — it already samples per tick and
reported `workUtil 1.00` in windows where creeps were demonstrably not working
every tick. A p50/p90 split on the same counters would have made that
contradiction visible without any new sampling.

## Part C — capital and upkeep are unmeasured outputs (found 2026-07-31)

A month-scale retrospective tried to close the colony's energy ledger and
could not, because two flows have no instrument. The accounting identity a
retrospective needs is:

```
production = controller delivery + Δbank + capital formed + upkeep spent
```

**What was measurable** over 18–31 July (287,251 ticks):

| flow | energy | per tick | source |
|---|---|---|---|
| delivered to controller | 6,141,708 | 21.38 | GCL progress delta (level held at 32) |
| bank change | −440,396 | −1.53 | `rooms[].storageEnergy` delta |
| capital formed | **+166,200 (floor)** | +0.58 | derived, see below |
| upkeep spent | **unmeasured** | ? | — |

**Capital had to be DERIVED, not read** — there is no structure inventory in
telemetry. What worked: `energyCapacity` arithmetic (5,600 = 2 spawns × 300 +
50 extensions × 100 at RCL7; 1,800 = 1 × 300 + 30 × 50 at RCL5) gives
20 new extensions × 3,000 + 1 spawn × 15,000; `roadReceipts[].built` is a
ratchet, so its delta × ROAD_BUILD_COST gives 304 tiles × 300 = 91,200.

**Everything else is invisible**, and the gaps are not small:
- containers, links and the towers RCL6/7 unlocked — 5,000 energy each,
  plausibly 5–6 of them, so the true capital figure is likely 190–200k not 166k;
- roads built before 2026-07-21 (the first capture carrying receipts already
  read 119 tiles built);
- the swamp/tunnel premium — receipts count TILES, not terrain, and swamp road
  costs 5× (tunnel 15×), so 91,200 is a hard floor on road capital;
- **upkeep entirely**. 423 standing road tiles carry a permanent decay bill,
  and the tower + repair detail spend real energy against it every tick. The
  colony can report what it BUILT and not what it KEEPS.

**Why this matters beyond retrospectives.** Upkeep is the term that decides
whether a road pays for itself — `roadEconomics` prices the investment against
a payback horizon, but nothing measures the realised maintenance cost to check
that pricing. A route whose upkeep exceeds its savings is a permanent negative
position that no current line can surface. Same shape as the fidelity problem:
a price with no measurement beside it.

**Instrument sketch** (cheap; both are already partly sampled):
- CAPITAL: the construction corp already knows energy-into-sites (the poolWork
  delta the build line credits). Attribute it per commission and accumulate.
- UPKEEP: `creep.repair()` and `tower.repair()` are the only two spend sites,
  both already routed through known seams (`doMaintenance`, `TowerRunner`).
  Counting the energy at those two call sites yields a colony upkeep rate
  directly — no estimation.

Note both are ADDITIVE to production, not subtractions from it: capital and
upkeep are what the colony bought with energy that never reached a controller,
which is exactly the distinction "idle capital" cannot draw today (it sees
only the bank, so energy that left storage looks spent regardless of whether
it became a road, held a road, or rotted on the ground).

## Sequencing (Part B first — it is far cheaper and self-contained)

| phase | change | gate |
|---|---|---|
| B1 | histogram buckets + p10/p50/p90 on the three existing duty meters; export in the stamps | unit + build (telemetry-only) |
| B2 | ledger lines read percentiles; add a "bimodal" verdict where p50≈0 with p90 high | unit only (ledger script) |
| A1 | operators declare full I/O contract (inputs/outputs/price/post) | unit + trio |
| A2 | per-operator variance table; F1 decomposes into it | unit only (ledger) |
| C1 | count energy at the two repair call sites → colony upkeep rate | unit + build (telemetry-only) |
| C2 | attribute capital per commission; close the production identity | unit only (ledger) |

B1+B2 are independently valuable and do not wait on specs 38/39. A1 wants
spec 39's commission-owns-the-fleet shape first, since that is what makes the
price term trustworthy.

## Acceptance (measurements)

1. A synthetic stall (worker blocked every other tick) reads p50 0 / p90 full
   while its mean is mid-range — and the ledger flags it as bimodal, not slow.
2. Replaying the border-bounce fixture window through the new lines produces a
   NON-ok verdict (the regression test for "the ledger said ok for hours").
3. Per-operator contract variance exists for every commissioned operator; no
   operator is exempt (the P4 "unbudgeted" class cannot recur).
4. The production identity closes: `delivery + Δbank + capital + upkeep` is
   within a few percent of independently-estimated income (funded sources ×
   rate), over a window of at least one creep generation. Today it cannot be
   computed at all.
5. Every standing road route reports realised upkeep beside the payback
   horizon `roadEconomics` priced it against — a route underwater on that
   comparison is visible.
6. CPU: the histogram costs < 0.05 CPU/tick colony-wide (bucket increments
   only; measure before and after — spec 20's per-corp CPU meter is the
   instrument).

## Risks / notes

- **Percentiles over a short window are noisy.** Keep the same window the duty
  meters already use (one creep generation) and report `meterTicks` beside the
  percentiles so a thin sample is visible rather than authoritative.
- **Don't add a third statistic nobody reads.** B2 (a verdict that USES the
  percentiles) must land with B1, or the buckets are decoration.
- **Contract inflation**: four terms per operator is a schema the segment must
  carry. Version it and keep the export flat; the F1 precedent is that one
  number nobody can decompose is worse than a table.
