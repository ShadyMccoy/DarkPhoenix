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

## The LINK BUFFER (owner 2026-08-06) — economics, sizing, and why it waits

*"Maybe we just need a biiit of a buffer at the links. Energy arrives in
waves. Either the link is idle sometimes or the hauling is waiting. If it has
a smaller Carry creep with the 1 move scale. Maybe a carry per source routing
to the link. It could be worth the cost by smoothing out both the link and
haulers. But not sure about the numbers."*

This is the mothership concept aimed at the LINK instead of the storage, and
the "1 move scale" is exactly right for a reason worth stating: EMPTY CARRY
parts generate no fatigue in Screeps (`isFatigueFreeWhenEmpty`, movement.ts),
so a creep that only ever travels empty needs one MOVE, not one per CARRY.
That is what makes it cheap. Numbers from `npm run haul:vs:link`'s sibling,
**`npm run link:buffer`** (`scripts/link-buffer.ts`, every formula imported
from `economy/primitives`).

### The cost side clears easily

```
  CARRY   buffer e   holds e   e/t cost   parts/t   as a 1:1 body   saving
     8        450       400      0.300    0.0060        0.533        0.233
    16        850       800      0.567    0.0113        1.067        0.500
    24       1250      1200      0.833    0.0167        1.600        0.767
```

A 16-CARRY buffer costs **0.567 e/t** — HALF what the same capacity costs as
a conventional 1:1 CARRY+MOVE body. Break-even against recovered hauler idle:

```
  fleet-wide idle share a 16-CARRY buffer must recover to pay for itself
    n=5 haulers   0.88%      n=10   0.44%      n=15   0.29%
```

**0.29% of a 15-hauler fleet's time.** This is the cheapest intervention on
the board — cheaper per unit of smoothing than anything spec 47 previously
considered.

### The sizing is WRONG as proposed, and the correction matters

"A carry per source" undersizes it, because the arrival quantum is 800e —
a full volley and a full deposit-route hauler load are the SAME number
(`LINK_CAPACITY` = 16 CARRY = the spec 45 leg 3 landing quantum):

```
  sources x 1 CARRY   holds   of one arrival   absorbs?
       7                350        44%         PARTIAL only
      11                550        69%         PARTIAL only
      16                800       100%         whole load
```

That distinction is not cosmetic. **A link sender is all-or-nothing under
full-volley discipline, so a partial buffer does not unblock it at all.** A
hauler can transfer any amount, so a partial buffer shortens its wait without
ending it. The honest unit is **16 CARRY per SIMULTANEOUS arrival you intend
to absorb**, not one per source feeding the link. At the measured deposit-port
flow (65 e/t over 7 remote routes) a bare link gives 12.3t of headroom before
it refuses; +16 CARRY gives 24.6t — it doubles the wave that can be ridden
out.

And the standing caveat: **a buffer fixes BURSTINESS, never a rate deficit.**
If inflow exceeds drain on average it fills once and stays full, having bought
one arrival of delay and nothing more.

### WHY IT IS NOT BUILT YET: 74% of the target is a different bug

The aggregate that motivates it — H1 `idleSink` 0.07 → **0.18** — does not
survive localization. Per-corp at t72808131:

```
  ALL   11 corps:  idleSink 0.181   atSink 0.019
  REST   9 corps:  idleSink 0.055   atSink 0.021
  mining-W43N24-harvest-cd8d  idleSink 1.00  atSink 0.00  duty 0  loaded 1
  mining-W43N24-harvest-cd8e  idleSink 1.00  atSink 0.00  duty 0  loaded 1
```

Those two corps contribute **74% of all sink-idle**, and they are precisely
the two sources P1 reports flipping funded→defunded this window. They are gone
from the flow graph (12 sources → 11) while their creeps still stand: the
miner keeps producing (`produced` still climbing), the hauler sits **LOADED**
and idle for the whole 111t window, and the corp's outer sizing stamp has
vanished entirely — it is no longer being evaluated.

That is the trap-list class verbatim: *"a rule whose distress response is
REVOCATION — retire commissions, strand the standing fleet — is the wrong
class regardless of its trigger."* And note `atSink 0.00`: **they never reach
a sink at all**, so a buffer at the sink cannot help them by construction.

### Recommended order

1. **Fix the defund-stranding first.** It is 74% of the number, a buffer
   cannot touch it, and it is already a named wrong-class mechanism. It also
   plausibly feeds the L1 pile-decay BREACH (6.80 e/t vs a 0.00 budget) —
   two miners producing into piles no hauler is clearing.
2. **Then re-read `idleSink`.** On the healthy residual (`idleSink` 0.055,
   `atSink` 0.021, storage HAD room ⇒ spatial contention at the deposit) the
   16-CARRY buffer still clears its 0.29% break-even by roughly **7x**. The
   economics do not need the stranded corps to work.
3. **Then build it at 16 CARRY per simultaneous arrival**, deposit ports
   first (that is where a hauler waits on a link rather than on storage).

Building the buffer first would improve the aggregate while leaving the
stranding in place — the exact failure this spec already recorded once:
*"had spec 47 been built first, we would own a tractor-beam conduit for a
link scheduling bug."*

### Refinement: FREE ULLAGE before bought capacity (owner 2026-08-06)

*"Sometimes the link has a miner next to it with 1 carry. If utilizing ullage
there would let a hauler depart then probably with it. Kinda cheeky, marginal
but hey every little bit counts."*

**The fact checks out.** `buildMinerBody(work, cap, linkFed)` gives a
link-served miner a CARRY part so it can transfer into the link instead of
dropping, and the live bodies confirm it: `cd90` and `cd92` are both
**5 WORK + 1 CARRY + 3 MOVE**, parked at their source link for their whole
life. That is 50e of buffer nobody has to buy.

**The trade is better than "marginal" suggests, and for a reason worth
naming: it is not about the 50e, it is about WHOSE TICK IS SCARCE.**

```
  route d   hauler e/t   ullage e/t   trade ratio
     20        19.0          1.0          19x
     30        12.9          1.0          13x
     50         7.8          1.0           8x
     75         5.3          1.0           5x
```

Borrowing the miner's CARRY costs it its own deposit slot for the duration —
its harvest drops and decays at Screeps' `ceil(amount/1000)` = 1 e/t for a
small pile, until the miner recovers it. A hauler's tick is worth 6-19. So
the exchange is favourable by **5-19x every time it fires**. That generalises
into a ladder, and the ladder is the durable part of this idea:

```
  1. the link's own free capacity            0.000 e/t
  2. ullage on creeps already standing       ~1 e/t WHILE borrowed, and only
                                             when it actually frees a hauler
  3. a bought buffer creep (16 CARRY)        0.567 e/t standing
```

**Where "marginal" is right:** 50e against the 800e arrival quantum is 6.25%
of one load, so it converts "wait" into "depart" only when the hauler's
residual is already ≤50e — about a 6% slice of arrivals. Real, free, and
small.

### THE CATCH THAT OUTRANKS BOTH REFINEMENTS: deposit ports are not built

Neither the buffer creep nor the ullage loan has anywhere to fire today,
because **no hauler currently deposits at a link.** DEP is a READ-ONLY
instrument, and `economy/depositSavings` says so at the top: *"This module
MEASURES the opportunity before any routing changes ... Read-only knowledge;
the depositPos plumbing re-activation is a later, data-driven step."* The
ledger row agrees — *"informational: it sizes the potential lever before the
depositPos routing is re-activated."*

So today every remote hauler walks past those links to STORAGE, and the
`atSink` idle it experiences is spatial queueing at the storage tile with
storage having room — not link capacity at all.

**And the un-built thing is worth more than either refinement.** DEP prices
7 remote sources that could deposit at a home link: **65 e/t of deposit flow,
hauls shortened by 8-16 tiles each, ~795 tile·e/t saved.** Compare a 16-CARRY
buffer's 0.567 e/t of cost or the ullage loan's ~6% slice. The prerequisite is
the prize.

### Revised order

1. **Fix the defund-stranding** — 74% of the measured sink-idle, and a buffer
   cannot touch it (`atSink 0.00`: those haulers never arrive).
2. **Activate deposit-port routing (DEP, 65 e/t).** This is what creates a
   "hauler waits on a link" situation in the first place. Both refinements
   below are undefined until it exists.
3. **Then the ullage loan — it is free, so it comes before anything bought.**
   Gate it exactly as the owner framed it: borrow only when doing so lets the
   hauler DEPART, never as general spillover.
4. **Then the buffer creep at 16 CARRY per simultaneous arrival**, if the
   re-read `idleSink` still justifies it.

### Better still: a CONTAINER by the link, with a lil tender (owner 2026-08-06)

*"Because we could also maybe build containers instead as well by the links…
might be better. With a lil tender."*

**It is better, and the margin is large.** Priced from the container economics
already homed in primitives (`CONTAINER_CAP`, `containerDecayEnergy`,
`parkedRelayCarry`):

```
   option        holds e    e/t standing    spawn p/t    build e
  creep16            800         0.567         0.0113          0
  cont+tend         2000         0.233         0.0027       5000
  cont only         2000         0.100         0.0000       5000
```

The tender really is little: `parkedRelayCarry(65 e/t)` = 2.6 → **3 CARRY**,
so 3 CARRY + 1 MOVE = 200e = 0.133 e/t, on top of 0.10 e/t of container
repair. Together **0.233 e/t for 2000e**, against **0.567 e/t for 800e** —
**6.1x cheaper per unit of capacity**, with the 5000e build paying back in
~15,000t (10 creep lifetimes).

**But capacity is not the real reason it wins.** A container costs **zero
spawn throughput**, and the spawn is the binding constraint — S5 has us
building 0.555 of 0.667 p/t physical, a 17% surge margin. The deeper point:

> A buffer creep conflates CAPACITY and THROUGHPUT in one body and charges
> spawn parts for both. Container + tender SEPARATES them —
> **capacity → the container** (burst absorption, 0 spawn parts),
> **throughput → the lil tender** (sustained rate, a few CARRY).
> Buy each at its own cheapest price.

That separation is the durable idea here, and it retires the buffer-creep
proposal above except where no container can be placed.

**Two caveats, both real:**

- **Placement.** A remote container costs **0.50 e/t — 5x** an owned one,
  purely because the engine decays it five times as fast
  (`CONTAINER_DECAY_INTERVAL_REMOTE`). This is cheap in the HOME room and
  much less so anywhere we do not own.
- **The build competes.** 5000e is a real construction project — 4x the
  current backlog (1210e remaining at W43N24) — and construction is the
  owner's declared priority consumer. It is not free just because it is not
  spawn parts.

### And at a SOURCE link the tender already exists — for nothing

Inverting `parkedRelayCarry`, a 1-CARRY link-served miner is a parked relay
worth **25 e/t**, against a source's **10 e/t**. `25 >= 10`, so **it can drain
its own container unaided**: a container at a source link needs no tender at
all, just the 0.10 e/t repair. That converts a full link from *"miner drops
and the pile decays"* into *"miner parks it next door"* — and pile decay is
the standing **L1 BREACH** (6.80 e/t against a 0.00 budget).

This is the same ullage insight one tier up: the creep that is already
standing there is the mover, so only the CAPACITY has to be bought.

### THE FULL LADDER (use cheapest-first)

```
  1. the link's own free capacity                  0.000 e/t
  2. ullage on creeps already standing             ~1 e/t while borrowed
  3. a CONTAINER + whatever can already move it    0.100 e/t  (+5000e build)
  4. a container + a lil tender (3 CARRY)          0.233 e/t  (+5000e build)
  5. a bought buffer creep (16 CARRY)              0.567 e/t
```

Tier 5 is now dominated by tiers 3-4 wherever a container can be placed.

**One blocker this exposes:** we cannot tell from telemetry whether containers
already stand beside these links — captures carry **no structure inventory**
(this spec's own open item, previously "survives on its own merits"). That
promotes it from nice-to-have to **prerequisite**: the decision to build is
not decidable without it. Cheap to close, and it now gates real spend.

### The sizing law: which links need one (owner 2026-08-06)

*"Safe to say only links of a certain size (throughput correlates with waves)
would normally require it?"*

**Yes — with one correction that changes the threshold.** Throughput does not
make waves bigger; it makes them **collide more often**.

> **CORRECTED 2026-08-06** (owner: *"why is one arrival always 800? Are our
> haulers in fact sized that way"*). This section originally asserted that one
> arrival is always 800e. **That was wrong** — see the correction at the end of
> this spec. `rho` and the three bands survive unchanged (arrival size cancels
> out of the utilisation); the BUFFER SIZE table below does not. So the criterion is a utilisation, and **RANGE is
in it** — a far link pays a longer cooldown per volley and therefore needs a
buffer at half the throughput of a near one:

```
      rho = R * range / LINK_CAPACITY
      (arrival rate / one-volley-per-cooldown service rate)

    R e/t     range 5     range 10     range 20     range 30
       20     0.13 --      0.25 --     0.50 BUF     0.75 BUF
       25     0.16 --      0.31 --     0.63 BUF     0.94 BUF
       40     0.25 --     0.50 BUF     1.00 SAT     1.50 SAT
       65     0.41 --     0.81 BUF     1.63 SAT     2.44 SAT
      100     0.63 BUF    1.25 SAT     2.50 SAT     3.75 SAT
```

**Three bands — and both live extremes already sit in the outer two, which is
what makes this more than a model:**

- **rho < 0.5 — IDLE.** Nothing to smooth; the link is empty most ticks.
  *Measured:* the link-served sources cd90/cd92 hold **21e and 0e** against a
  2000 cap.
- **0.5 ≤ rho < 1.0 — BUFFER.** Collisions are frequent but the drain still
  keeps up on average. **This is the only band a container earns its 0.233 e/t
  in.**
- **rho ≥ 1.0 — SATURATED.** A rate deficit. A buffer fills once and stays
  full. *Measured:* five remote source containers standing **4,232e ABOVE
  cap**, decaying — which is exactly H1's `ground-piled 4232e`.

**How much buffer** (M/D/1 mean queue, deterministic one-volley service):

```
    rho   queue loads   queue e   wait t @r10   container?
   0.50          0.25       200           5.0   covers it
   0.70          0.82       653          11.7   covers it
   0.80          1.60      1280          20.0   covers it
   0.90          4.05      3240          45.0   UNDERSIZED
```

One 2000e container covers the mean queue up to **rho ≈ 0.8**. Past that the
queue grows faster than any buffer worth buying — the same statement as *"a
buffer fixes burstiness, never a rate deficit"*, now with the crossover named.

**Where this leaves the two live candidate ports:** 8f08 carries 40 e/t and
4a83 carries 25 e/t. At range 10 that is rho 0.50 and 0.31 (one marginal, one
idle); at range 20 it is 1.00 and 0.63 (one saturated, one squarely in the
band). **The verdict flips entirely on range, and range is exactly what
telemetry cannot tell us** — the structure-inventory gap again. That is now a
THIRD reason it is the prerequisite: it gates whether to build, where to
build, and now which band each candidate is even in.

### CORRECTION: the arrival is NOT 800e — size the buffer to the ROUTE

*"Why is one arrival always 800? Are our haulers in fact sized that way?"*
(owner 2026-08-06). **They are not.** Measured per-body hauler CARRY at
t72809560:

```
  route   CARRY   arrival e   fits an 800 link?   buffer needed for ONE
   cee2    14.8        740          yes                     0
   cbd8    15.4        770          yes                     0
   d01f    18.9        945          NO                    145
   cee0    19.7        985          NO                    185
   cd94    20.4       1020          NO                    220
   cbd5    23.0       1150          NO                    350
   cd98    24.2       1210          NO                    410
   c9f9    35.0       1750          NO                    950
```

**Eight of ten routes exceed 800e; the median arrival is ~1,020e.** The
16-CARRY figure comes from `depositRouteCarryCap` (spec 45 leg 3), which fires
only when `isDepositRoute` is true — and that is **never today**, because DEP
routing is read-only. The quantum was a POLICY THAT IS NOT SWITCHED ON, stated
here as a fact. `LINK_CAPACITY` remains a hard cap on a link VOLLEY (the engine
clamps a fire), so that half of the claim stands.

**What survives — `rho`, and provably.** Arrival size cancels out of the
utilisation: arrivals of size `S` come at `R/S` per tick, and each needs
`S/800` volleys to clear, so their service rate is `(800/range)/S`. Then
`rho = (R/S) / (800/(S*range)) = R*range/800`. The three bands hold whatever
the haulers weigh.

**What does not survive — the buffer SIZE.** The buffer must cover
`(arrival − 800)` before ANY queueing, then the queue on top. Against the worst
live route (c9f9 at 1,750e):

```
    rho   queue e   + 1 arrival   total need   2000 container?
   0.50       437           949         1386     covers it
   0.60       787           949         1736     covers it
   0.70      1428           949         2377     UNDERSIZED
   0.80      2798           949         3747     UNDERSIZED
```

One container covers to **rho ≈ 0.5–0.6**, not the 0.8 previously claimed.
**Size the buffer to the route's arrival, never to `LINK_CAPACITY`.**

### The tension this exposes — decide it BEFORE switching DEP on

Leg 3's cap exists to make the quantum 800e so a deposit hauler always fits its
link. But the routes DEP would serve are the **long** ones — cd98 (d=99),
d01f (d=95), cee2 (d=87) — which are exactly the ones whose efficient body is
biggest. Capping those at 16 CARRY splits each into 2-3 creeps: the same total
CARRY, but more spawn EVENTS against a spawn already at **0.92x its ceiling**
with 8% surge margin (S5).

So there are two ways to make a big hauler fit a link — **cap the hauler**
(leg 3, costs spawn events) or **buffer the link** (a container, costs 0.10 e/t
and a 5000e build) — and which is cheaper is an OPEN question that this spec
does not yet answer. It must be decided before deposit-port routing is
activated, because leg 3's cap silently picks one of them.

### Siting the port container (owner 2026-08-06)

*"It's important to build the container where it's best accessible to incoming
hauling routes as well as adjacent to the link of course."*

**Those two requirements look like they conflict, and the TENDER is what
reconciles them.** The link's tile is fixed wherever it was built, which may be
nowhere near where haulers arrive. Without a mover, the container must touch
the link — something has to cross the gap — so the link's position dictates the
container's. A parked tender relaxes *"adjacent to the link"* into **"within 2
of it, sharing a parking tile"**, and that slack is the entire budget for
hauler accessibility.

So the tender's second job is **decoupling the container's position from the
link's**. Throughput was only its first.

**The constraint comes straight from `parkedRelayCarry`'s own premise** — a
creep "standing adjacent to both its bank and its sink", withdraw tick +
transfer tick, zero travel. There must be a walkable tile `P` with
`range(P, container) <= 1` AND `range(P, link) <= 1`, which forces
`range(container, link) <= 2` and nothing tighter.

**Why the tile is worth optimising rather than taking the first legal one:**
the candidate ring spans ~4 tiles of one-way distance, so ~8 round-trip tiles.
Against a d≈50 route that is **~16% more CARRY — the same order as the entire
saving the deposit port exists to produce** (DEP: 31.8 CARRY, 16%). A badly
sited container can eat the whole point of the port.

**The rule** (`bestPortContainerTile`, `corps/constructionPlacement.ts` — pure,
Game-free, 9 unit assertions):

```
  minimise   sum over routes of  flowRate * chebyshev(from, tile)
  subject to  range(tile, link) <= 2
              a walkable tile adjacent to BOTH tile and link exists
              tile is in bounds, unblocked, unoccupied
  tie-break   toward the link (keeps the tender's parking choice open
              as the room fills in around it)
```

Flow-weighted, so the fattest route wins a two-sided pull — the same weighting
`depositSavings` already uses to rank ports. Cross-room approaches measure to
the tile anyway: that leg is common to every candidate, so only the in-room
difference moves the ranking.

**Still gated on the port meter.** The scorer is pure and pinned now, so the
placement policy is settled whichever way the measurement goes; whether a
container gets built at all waits on `portWaitFrac` from the next capture.
