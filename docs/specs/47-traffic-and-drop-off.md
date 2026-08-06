# Spec 47 — Traffic, the drop-off zone, and the core conduit

**Owner directive (2026-08-05):** *"We need something to deal with traffic
congestion."* Four candidate mechanisms were offered: a **mothership** slave
carrier that widens the storage drop-off POINT into a ZONE; a **tractor-beam
roundabout** where creeps join a predefined conduit past the storage instead
of pathfinding; a **base layout rebuild** toward the newest (highway) logic;
and finally **the link drop-off** — *"If there's still a throughput issue with
the core link being unavailable, I'd love to take a look at that which I think
we built instrumentation for. Otherwise, we need to think about supplementing
the link routes with a hauler to make up gaps and the throughput."*

We do have that instrumentation. It answers the fourth question outright and
it re-ranks the other three.

## What the measurement says (t72805426, 249t link window)

### The LINK half is a confirmed defect — and it got worse

```
hubClampShare      0.625     62.5% of hub volleys CLAMPED   (spec 45 baseline: 0.50)
hubVolleyAvg       500 / 800
coreEmptyShare     0.276     the core link sits EMPTY 27.6% of the time
coreCongestedShare 0.116
coreFillAvg        252 / 800
toHubRate  48.2   toControllerRate  64.2   directShare 0.25   tax 3.37
```

Read those two bold numbers together: **senders are blocked 62% of the time
while the receiver is empty 28% of the time.** A resource cannot be both
saturated and idle — so this is not capacity, it is SEQUENCING, exactly as
spec 45 diagnosed, and the clamp share has risen from 0.50 to 0.625 since.
Spec 45 is already **P0** with a designed fix order and its sizing leg
shipped (the feeder's 16-CARRY volley-service floor is live and measured:
the feeder stamps `volleyFloor 16, neededCarry 16, gate "staffed"`).

The owner's fallback ("supplement the link routes with a hauler") is
therefore premature: the link network is not short of throughput, it is
mis-sequenced. Adding a hauler to a link that is empty a quarter of the time
buys bodies to work around a scheduling bug.

### The TRAFFIC half is real but NOT where the mothership would help

```
H1 duty 0.74
  idleSource   0.00
  idleSink     0.26
    atSink     0.05    <- waiting AT the drop-off
    enRoute    0.21    <- idle while TRAVELLING to it
```

`enRoute = idleSink - idleSinkAtSink` (scripts/waste-ledger.ts), so this is
hauler time lost in the approach, not at the destination. That is a 4:1 split
against the drop-off point — and it is the ranking fact for the owner's
first idea:

- **The mothership widens the drop-off POINT.** Its whole value lands on
  `atSink`, which is **0.05**. Even a perfect drop-off zone recovers ~5% of
  hauler duty, not 21%. It is the right idea aimed at the smaller half.
- **The conduit/roundabout and the layout rebuild** both act on the approach,
  which is where the 21% is.

## The honest gap: we have not LOCALIZED the 21%

`enRoute` idle says a hauler stood still on its delivery leg. It does not say
WHY, and the candidates are materially different fixes:

- genuine mutual blocking in a narrow approach lane (→ conduit / layout),
- `stepOffRoad` and standing-worker etiquette pushing creeps into each other,
- room-border crossing stalls,
- repathing churn (pathMeter shows mining dominates CPU, but per-corp stall
  location is not recorded),
- waiting on storage room / a full container at the end of the leg.

Spec 14's method is explicit for this case: *"If the cause is invisible: the
fix is FIRST a stamp — decision-site record, exported verbatim — deploy,
recapture. Never guess twice."* Building a tractor-beam conduit or, worse,
demolishing and rebuilding the base layout on an unlocalized 21% would be
precisely the guess-twice failure. The layout rebuild is also the only
IRREVERSIBLE option on the list, which puts it last on evidence grounds
alone, not on merit.

Note a second gap it exposes: captures carry **no structure inventory**
(the balance sheet's `fixed` line reads "not measured"), so the question
*"does our base even have the newest highway layout?"* cannot currently be
answered from telemetry at all. That is its own small instrumentation item
and a prerequisite for judging the rebuild.

## Recommended order

1. **Spec 45's sequencing legs (P0, proven, no new mechanism).** The defect
   is measured, the fix is designed, and it is the largest confirmed number
   on the table. Re-measure the five named gauges after.
2. **Localize the en-route idle (small, doctrine-mandated).** Stamp WHERE a
   hauler's delivery leg stalls — room + whether it was adjacent to the core,
   at a border, or mid-route — and recapture once. One window decides between
   conduit, etiquette, and layout.
3. **Then build the traffic mechanism the data names.** If stalls cluster in
   the last few tiles before the core, the conduit/roundabout is the answer
   and the mothership becomes a cheap complement to it (it also directly
   attacks `atSink`, so the two compose rather than compete). If stalls are
   diffuse across the map, it is a lane/layout problem and the rebuild earns
   its cost.
4. **Structure inventory in the capture** so the layout question is decidable
   before anything is demolished.

## Design notes for the mechanisms (kept, not yet built)

**Mothership (drop-off zone).** A storage-adjacent carrier that walks out to
meet inbound haulers and accepts transfers, turning one tile into a small
zone. Attacks `atSink`. Cheap and reversible; sizing it is the open question
(it earns its body only when `atSink` idle × hauler count exceeds its own
upkeep — the same `worthABody` discipline as everywhere else). Worth building
AFTER the approach is fixed, because a wider mouth behind a blocked lane
moves the queue rather than draining it.

**Tractor-beam conduit.** Creeps join a predefined path at a defined entry
angle, ride it past the storage, and exit toward their highway — no
per-creep pathfinding on the last leg. Attacks `enRoute` and would also cut
the pathfinder CPU the meter attributes to mining. The hard parts are entry
arbitration (who joins when) and making the conduit's tiles genuinely
one-way, which the engine does not enforce for us. One conduit per highway
direction, as the owner suggested.

**Layout rebuild.** Demolish and re-place extensions to the current
(highway-aware) placement logic. Highest cost, irreversible, and blocked on
both the localization above and the structure inventory. If the approach
stalls turn out to be structural rather than behavioural, this is the real
fix and the others are palliative.


## MEASURED 2026-08-06: the traffic premise is mostly DISSOLVED

Spec 45's sequencing legs deployed, and the gauge this spec was built around
moved with them — **without any traffic mechanism being built.**

```
                    t72805426        t72807566
  H1 duty              0.74     ->     0.86
    idleSink           0.26     ->     0.07
      atSink           0.05     ->     0.03
      enRoute          0.21     ->     0.04     <- the whole traffic premise
```

`enRoute` was the 21% this spec called "approach-lane congestion (traffic /
standing blocker at the core)" and proposed the conduit, the mothership and
the layout rebuild to attack. It was explicitly registered as a
**NON-prediction** of the spec 45 deploy — *"NOT predicted to move: H1's
enRoute 0.21. That is spec 47's un-localized approach-lane signal and it is a
DIFFERENT failure; if it falls anyway, the two were coupled and that is
itself a finding."* It fell by 81%.

So they were coupled, and the honest reading is the one the un-localized
signal could not give us: haulers standing "idle en route" were largely
**waiting on a link network that was clamped**, not blocked by each other in
a lane. A deposit-route hauler whose port is full has nowhere to put its load;
that reads as delivery-leg idle time and looks exactly like traffic from the
duty meter alone.

**Consequences for this spec:**

- The **layout rebuild** loses its evidence entirely. It was already last on
  irreversibility grounds; it is now unmotivated as well. Do not demolish
  anything on the strength of a signal that has since fallen 81% for an
  unrelated reason.
- The **tractor-beam conduit** loses most of its case. 4% residual en-route
  idle does not pay for entry arbitration and one-way tile enforcement.
- The **mothership** is unchanged in principle and still the smallest of the
  three, but its target (`atSink`) is now **0.03**. It is not worth a body at
  that level — the `worthABody` discipline applies to this mechanism as much
  as to any other.
- The **localization stamp** (step 2 of the old order) is no longer urgent.
  Keep it filed: if en-route idle returns without a link explanation, that is
  when it earns implementation.
- The **structure inventory** item survives on its own merits — "does our base
  have the newest layout" is still unanswerable from telemetry, and that is a
  gap worth closing regardless of whether a rebuild is ever ordered.

**This spec is therefore PARKED, not cancelled.** The mechanisms are sound
designs for a problem the colony does not currently have. The lesson worth
carrying is the one the method already encodes: the signal was never
localized, and acting on it would have built a traffic system for a link
scheduling bug.
