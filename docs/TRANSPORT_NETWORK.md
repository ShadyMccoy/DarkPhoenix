# Transport network: the game theory of creeps, links, and terminals

Analysis note, 2026-08-06. Not a spec — no acceptance tests. This is the arc-cost
theory a flow planner needs before it can price a transport decision. Where it
contradicts intuition it says so and shows the arithmetic.

Everything here is derived from published Screeps constants. No simulation was
run; treat the numbers as analytic, and the break-evens as ±20% given duty-cycle
and pathing slop.

---

## 1. The result in one paragraph

The three transport modes are not competing for the same job, and the thing that
makes them commensurable is not energy — it is **energy·tiles per tick**, plus a
**fractional delivery tax**. On that scale: a roaded creep costs **0.26% of the
flow per tile** travelled; a link costs **3% flat, at any range, capped at
800 energy·tiles/tick**; a terminal costs **≈3.33% per room step, at any
in-room distance, effectively uncapped**. All three break even against each
other around **12–13 tiles**, which is almost certainly deliberate tuning. The
consequences: links are not an energy optimization (a link pair can never save
more than ~1.6 e/t, ever), terminals are 4x cheaper than creeps for any
cross-room hop and cannot be interdicted, and the terminal's *position inside
its room* is a completely free variable that almost everyone spends wrong.

**The energy scale is also the wrong scale.** CPU binds first, and on CPU the
ordering is far more lopsided: a link pair and a maximum-size hauler move the
same ~18 e/t across a room, and the link costs **1/15th the CPU** (§7). Creep
capacity is CPU-free, so body size buys 16x and then stops dead at 50 parts;
links buy another 15x past that wall. Both levers are the same size and they
multiply.

---

## 2. Correcting the premise

> "What if we put a terminal all the way on the east side of a room and then all
> the way on the western side of a room?"

You can only have **one terminal per room**, at RCL6+. So there is no
east-terminal/west-terminal pair inside a single room.

But the intuition underneath it is right, and the true version is stronger than
the one you were reaching for:

**Terminal send cost is a function of room-grid distance only. The terminals'
positions within their rooms do not enter the formula at all.**

```
cost = ceil(amount × (1 − e^(−d/30)))        d = Game.map.getRoomLinearDistance(a, b, true)
```

`d` counts *rooms*, Chebyshev, on the room grid. So two adjacent rooms whose
terminals both hug the shared border (≈2 tiles apart) and two adjacent rooms
whose terminals hug their far outer edges (≈98 tiles apart) pay **exactly the
same 3.28%**. The last 96 tiles are free.

That is the exploitable asymmetry. It just doesn't point where you thought —
see §8, because the naive reading of it ("maximize send distance") is worth
nothing, and the correct reading is worth more than a link pair.

---

## 3. The common unit

A transport arc has two properties that matter:

- **Bandwidth-distance**: energy·tiles/tick. Moving 10 e/t across 40 tiles and
  moving 40 e/t across 10 tiles are the same work.
- **Tax**: the fraction of the flow consumed by the act of moving it —
  amortized bodies, link loss, terminal cost. This is what a flow planner puts
  on the arc.

Everything below is in those two units.

---

## 4. The cost law of each mode

### 4.1 Creeps

A hauler's tax is its amortized body cost divided by its throughput. Both scale,
so the ratio is clean.

Roaded hauler, 2 CARRY : 1 MOVE (3 parts, 150 energy, 100 capacity, 1 tile/tick):

| term | value |
|---|---|
| throughput over one-way distance `d` | `100 / 2d` = **50/d e/t** |
| body amortization | `150 / 1500` = **0.10 e/t** |
| road wear (`ROAD_WEAROUT` 1 hit/part/step × `REPAIR_COST` 0.01) | 3 parts × 1 step/tick × 0.01 = **0.03 e/t** |
| **tax** | `0.13 / (50/d)` = **0.26% per tile** |

Two things worth noticing. Road wear works out to a flat **0.01 e/t per body
part**, independent of distance — the creep steps once per tick whatever the
route length. And the tax is **scale-invariant**: a 48-part hauler has exactly
the same 0.26%/tile as a 3-part one, so hauler sizing is a latency-and-CPU
decision, never an efficiency one.

Same calculation for the other terrain regimes:

| regime | body | tax per tile |
|---|---|---|
| roaded (any terrain) | 2C:1M | **0.26%** |
| unroaded plain | 1C:1M | **0.27%** |
| unroaded swamp | 1C:5M | **0.80%** |

**Roads are not an energy optimization on plains.** 0.26% vs 0.27% — the
doubled capacity per part is almost exactly cancelled by the wear you inflict
paving it. What roads buy on plain is a **25% reduction in body parts** for the
same throughput, which is CPU and spawn-uptime, not energy. On swamp roads *are*
an energy play: 0.80% → 0.26%, a 3x win, and that is where paving budget should
go first.

### 4.2 Links

- `LINK_CAPACITY` 800, `LINK_LOSS_RATIO` 0.03, cooldown = `range` ticks
  (Chebyshev), intra-room only, `LINK_HITS` 1000, 5,000 energy to build.
- Available RCL5 (2 links), 3 at RCL6, 4 at RCL7, 6 at RCL8.

```
throughput  = 800 / range      e/t
tax         = 3%               flat, range-independent
```

Multiply those and the range cancels: **a link pair is a fixed budget of 800
energy·tiles per tick.** That is the single most useful fact about links. It is
a bandwidth-distance allowance you allocate, not a pipe you plumb.

The corollary usually gets stated backwards. At short range a link looks like it
has enormous throughput — 160 e/t at range 5 — but sustaining that means
*feeding* it 160 e/t, and a room's two sources produce 20 e/t total. The link is
refill-starved, not cooldown-starved, and the "spare bandwidth" is not waste,
it's headroom. Duty cycle hits 100% at:

| range | throughput | matches |
|---|---|---|
| 47 (near max in-room) | 17 e/t | ~1.7 sources |
| 40 | 20 e/t | exactly 2 owned sources |
| 20 | 40 e/t | 4 sources — idles in any real room |

So **one link pair can carry an entire room's raw source output** over any
in-room distance. Link count is essentially never the constraint on source
haulage; it is the constraint on how many *distinct* long hops you can serve.

### 4.3 Terminals

- `TERMINAL_CAPACITY` 300,000, `TERMINAL_COOLDOWN` 10 ticks, `TERMINAL_HITS`
  3,000, 100,000 energy to build, one per room, RCL6+.
- Cost per §2. Cost is always paid **in energy**, regardless of what is shipped.

```
tax = 1 − e^(−d/30)        d in rooms
```

Expanded, because the small-`d` behaviour is what you actually live in:

| rooms | tax | | rooms | tax |
|---|---|---|---|---|
| 1 | 3.28% | | 10 | 28.4% |
| 2 | 6.45% | | 20 | 48.7% |
| 3 | 9.52% | | 30 | 63.2% |
| 5 | 15.4% | | 50 | 81.1% |

The decay scale is **30 rooms**. No real empire has a radius anywhere near that,
so within the regime you occupy the exponential is linear to within a few
percent: **≈3.33% per room step**. Use that as the planner's arc cost and stop
thinking about the exponential.

Throughput is 300,000 per 10 ticks = 30,000 e/t nominal, which is not a real
limit — the real limit is how fast creeps can stuff the terminal. Call it
uncapped and put the constraint on the feeding arc where it belongs.

---

## 5. The dominance map

Setting the taxes equal:

| comparison | break-even |
|---|---|
| link (3%) vs roaded creep (0.26%/tile) | **11.5 tiles** |
| terminal, 1 room (3.28%) vs roaded creep | **12.6 tiles** |
| link vs unroaded swamp creep (0.80%/tile) | **3.8 tiles** |

All three modes cross around 12 tiles on plains. Below that, creeps win outright
and a link there is 3% of pure loss. Above it, structures win — and since *any*
cross-room route is ~50 tiles minimum, the terminal beats creep haulage by
**roughly 4x on every inter-room hop that exists** (3.28% vs ~13%).

The clean division of labour that falls out:

- **< 12 tiles, intra-room** → creeps. This is where extension refill,
  storage↔terminal, and link-hub drain live. All irreducibly creep work
  (nothing else can fill an extension), and all in the regime where creeps are
  the cheapest mode anyway. The design is self-consistent.
- **> 12 tiles, intra-room, high volume** → link. Canonically source→storage and
  storage→controller.
- **Any inter-room** → terminal, always, if both ends are owned.
- **Last mile is always creeps.** Neither structure can touch a controller, a
  spawn, or an extension.

---

## 6. Links are not an energy play

This one is worth its own section because it inverts the usual reasoning.

The energy a link pair saves per tick is `flow × (0.0026d − 0.03)`, and flow is
capped at `800/d`. Substituting the cap:

```
max saving = (800/d)(0.0026d − 0.03) = 2.08 − 24/d
```

which asymptotes to **2.08 e/t** and reaches **1.57 e/t** at maximum in-room
range. And that is the saturated case. A link pair actually fed by one source —
the common case — carries 10 e/t and saves:

```
10 × (0.0026 × 47 − 0.03) = 0.92 e/t
```

Against a 10,000-energy build cost, that is an **~11,000-tick payback on
energy alone.** A link pair cannot save you more than about one and a half
energy per tick under any circumstances. Next to a 20 e/t room it is a rounding
error.

What the same link pair actually displaces, at 10 e/t over 47 tiles:

| | |
|---|---|
| body parts | **~28** (0.355 e/t per part at that range) |
| capital in bodies | ~1,400 energy, recycled every 1500 ticks |
| CPU | **~0.12 CPU/tick** — and 15x that at full duty; see §7 |
| spawn uptime | **~5.6%** of a single spawn |

**Price links on CPU and spawn throughput, not on energy.** In Screeps at scale
CPU is the binding constraint and energy is not, which means the correct shadow
price makes links look far better than the 0.92 e/t suggests — but for the right
reason. §7 does that accounting properly and the ratio is **15x on CPU**, against
1.7x on energy. A planner that evaluates a link on its energy tax alone will
systematically under-build them, and one that credits it with "eliminating
haulers" will over-build them (see §9: links concentrate haulers, they don't
eliminate them).

---

## 7. The CPU accounting: energy per intent

Energy tax is the wrong currency for this comparison at scale, because CPU binds
long before energy does. The CPU law is simple, and it explains everything else:

> An intent costs 0.2 CPU. **Moving costs one intent per tile regardless of what
> the creep is carrying.** So CPU efficiency is exactly *energy delivered per
> intent*, and the enemy is movement, not cargo.

Which means creep **capacity is CPU-free**. That is the observation worth
building on.

### 7.1 One maximum-size hauler crossing a room

50 parts on roads is 33 CARRY : 17 MOVE — 1,650 capacity, 2,500 energy, and it
still moves 1 tile/tick loaded (33 fatigue against 34 reduction). Over a 45-tile
crossing:

| | |
|---|---|
| move intents | 90 (45 out loaded, 45 back empty) |
| withdraw + transfer | 2 |
| **total** | **92 intents = 18.4 CPU** |
| delivered | 1,650 |
| **CPU per 1,000 energy** | **11.2** |
| throughput | 17.9 e/t |
| **CPU per tick** | **0.20** |

That last line is the general result: **a moving creep costs ~0.2 CPU/tick no
matter how big it is**, because it fires one move intent per tick either way.

### 7.2 The same work by link

A link pair at range 45 delivers 776 per 45-tick cooldown — **17.8 e/t, within
1% of the max hauler above.** Apples to apples:

| | intents per 776 delivered |
|---|---|
| sender `transferEnergy` | 1 |
| hub drain: withdraw + transfer | 2 |
| **total** | **3 = 0.6 CPU** |
| **CPU per 1,000 energy** | **0.77** |
| **CPU per tick** | **0.013** |

**One max hauler and one link pair move the same 17.8 e/t across a room. The link
costs 1/15th the CPU.**

Directly: a hauler round trip is 92 intents, a fully loaded link transmission
with its drain is 3. **≈31 link transmissions per hauler crossing** — and those
31 deliver **24,000 energy against the hauler's 1,650. 14.6x the energy for
identical CPU.**

### 7.3 Why you cannot actually spend that

Those 31 transmissions take 31 × 45 = **1,395 ticks** on one pair, against the
hauler's 92. The link is 15x cheaper per energy and 15x slower per unit; the
product is conserved. Each is simply one unit of ~18 e/t, and only the CPU
differs.

**To spend the CPU saving you need concurrency — ~15 link pairs to match one
max hauler's tempo.** RCL8 gives you 6 links.

### 7.4 So: multiple links sending across the room

Cooldown is charged to the **sender** only, and a receiver absorbs from any
number of senders in the same tick. So the throughput-maximizing RCL8 topology
is a **5 → 1 star**, not three independent pairs:

| topology @ range 45 | throughput | CPU/tick |
|---|---|---|
| 3 independent pairs | 53 e/t | 0.046 |
| **5 → 1 star** | **89 e/t** | **0.067** |
| equivalent max haulers (5×) | 89 e/t | **1.00** |

Still 15x. The constraint that bites is the **receiver's 800 cap**: a second
sender firing into a partly-full hub moves only what fits and the remainder is
not sent, so a star needs its drain to keep pace and its senders sequenced. A
stationary creep adjacent to both hub link and storage does one withdraw and one
transfer per tick — 800 e/t of drain if those share a tick, 400 e/t if they must
alternate. Either is far above the 89 e/t a star produces, and it is 2 intents
per 800 under both readings, so the CPU figures hold either way.

The number that matters: **89 e/t of in-room link bandwidth against a room's own
source output of 20 e/t.** At RCL8, link bandwidth is not scarce — it is ~4x
oversupplied. What is scarce is link *count* (how many distinct routes you can
serve), and the fact that none of them leave the room.

### 7.5 The two levers are the same size, and they multiply

| mode, 45-tile crossing | CPU per 1,000 energy |
|---|---|
| 3-part hauler (100 capacity) | 184 |
| 12-part hauler (400 capacity) | 46 |
| **50-part hauler (1,650 capacity)** | **11.2** |
| **link pair** | **0.77** |

Body size buys **16x** and then stops dead at `MAX_CREEP_SIZE`. Links buy
**15x** past that wall. Together, ~240x.

Two things to act on. **Body size is the cheaper lever and should always be
pulled first** — it costs only spawn energy and spawn time, against a link's
5,000 energy and one of six slots. And **the wall is real**: once haulers are at
50 parts there is no creep-side CPU optimization left at all, and every further
unit of throughput costs a flat 0.2 CPU/tick. That is the point where links stop
being optional.

The binding limit on hauler size is the route, not the cap — a 1,650-capacity
creep needs `flow × 2d ≥ 1650` to stay busy. Two sources at 45 tiles put 1,800
energy in flight, so long routes naturally land at or above max size, and short
routes should not pretend to.

### 7.6 The residual: what creeps must still do

Nothing but a creep can fill an extension, and RCL8 has 60 of them holding
12,000 energy. But extension refill is **transfer-dominated rather than
movement-dominated** — 200 energy per intent, moves amortized across many
transfers — so it is much better than its reputation:

| filler pattern | CPU per 1,000 energy |
|---|---|
| roaming filler (~100 moves per 12k refill) | 2.8 |
| **stationary filler, link-fed, zero moves** | **1.1** |

A parked filler is **link-competitive**. That is the entire argument for the
fast-filler nest layout: it deletes movement intents, and movement intents are
the whole cost.

### 7.7 Caveat — this accounting is a floor for links

Everything above counts engine intents at 0.2 CPU. Your own code sits on top and
is wildly asymmetric: a hauler carries pathfinding, a state machine, and traffic
resolution, typically another 0.1–0.3 CPU/tick, while a link's logic is "check
cooldown, check full, fire." **15x is a lower bound; real implementations should
see 20–30x.**

---

## 8. Terminal geometry — and where your free 98 tiles actually pays

### 8.1 There is no routing problem

Because `e^(-a/30) × e^(-b/30) = e^(-(a+b)/30)`, an `a`-room hop followed by a
`b`-room hop costs **exactly** what the direct `(a+b)`-room send costs. The
exponential was chosen precisely to make relaying arbitrage-free. Hopping only
loses: each hop burns 10 ticks of cooldown, occupies terminal capacity, requires
you to own the waypoint, and eats a `Math.ceil` round-up.

Terminal sends also ignore everything between the endpoints — no vision, no
ownership, no hostiles, no terrain. So:

**The terminal network is a complete graph over your owned rooms with edge cost
a pure function of room-grid Chebyshev distance. Always send direct. There is no
shortest-path problem to solve.**

All the interesting structure moved somewhere else: into *where you claim rooms*.
And even there the pressure is weak — a 49-room blob of radius 3 averages ~7%
internal tax; radius 6 (169 rooms) averages ~13%. **Terminal tax does not
meaningfully constrain empire shape at any realistic scale.** Do not let it drive
expansion decisions.

### 8.2 The fan-in / fan-out asymmetry

Cooldown is charged to the **sender**. A terminal can receive from any number of
terminals in the same tick, but can only send once per 10 ticks.

**Collection is free; distribution serializes at 10 ticks per destination.** A
hub serving 10 satellites reaches each one every 100 ticks. Bandwidth is never
the issue (300k per send); **latency** is. Fine for economy, potentially fatal
for reinforcement under attack — build the network hub-inbound, and accept that
outbound broadcast is slow.

### 8.3 Where to actually put the terminal

The free in-room position is real. The naive use of it — "maximize send
distance" — is worth exactly zero, because nothing in the game rewards send
distance. The correct use is:

> **Spend the free tiles on shortening the most expensive creep leg that touches
> the terminal.**

Which leg that is depends on the room's role, and this is where the standard
"terminal adjacent to storage" bunker reflex is sometimes wrong:

- **Room consuming its own remote income.** Remote haulers should deliver to
  *storage*, not the terminal. Terminal position is irrelevant to them; keep it
  adjacent to storage so terminal traffic pays ~0%.
- **Room that is a net *exporter* of remote-mined energy** — a mining colony
  feeding a war front or a distant RCL8 sink. Here the dominant flow is
  remote → terminal → elsewhere, and storage is a sideshow. Offset the terminal
  toward the inbound remote routes. Moving it 20 tiles down a 60-tile remote
  route cuts that route to 40 tiles: **~33% off the hauler fleet for that
  remote — 24 body parts, ~1,200 energy of capital, ~0.1 CPU/tick.** Comparable
  to a whole link pair, at zero capital cost, since the terminal was going to be
  built regardless. §8.4 scores it properly; §8.5 says when not to.

Formally it's a flow-weighted 1-median (Weber point) over the creep routes
incident on the terminal, with the terminal→terminal leg contributing **zero
weight**. The network side of the problem is free; only the last miles have
gradient.

Two costs on the offset, both real: a terminal at x≈1 sits next to an exit tile
with 3,000 hits, so it wants a rampart and is easier to snipe; and every
terminal↔storage movement now pays the offset, so the decision hinges on the
ratio of remote-inbound flow to local-consumption flow.

### 8.4 Scoring a placement

This is a well-posed optimization with a cheap exact solution, and the objective
collapses to a single scalar.

**The flows.** Only flows that touch the terminal — and only their *in-room*
legs — depend on the terminal's position `p`. Everything else is constant and
drops out of the argmin.

- `f_i` — remote route `i`, entering the room at exit tile `e_i`
- `s` — storage, fixed
- `X` — export rate through the terminal, e/t
- `x_i ∈ {0,1}` — does route `i` deliver to the terminal or to storage

**The objective**, in energy·tiles per tick:

```
E(p, x) = Σ f_i · [ x_i·d(e_i, p) + (1 − x_i)·d(e_i, s) ]     inbound legs
        + | Σ x_i f_i  −  X | · d(s, p)                        reconciliation
```

The second term is the one that is easy to forget, and it is what makes the
problem non-trivial: whatever the terminal receives beyond what it exports must
be pushed to storage, and whatever it exports beyond what it receives must be
pulled from storage. Either way the imbalance crosses `d(s,p)` — exactly the
distance the offset just created.

**Both currencies are linear in `E`, so there is only one objective.** One
max hauler is 825 energy·tiles/tick at 0.2 CPU/tick (§7.1), which fixes all
three conversions:

| per unit of `E` (energy·tiles/tick) | |
|---|---|
| energy | `2.6 × 10⁻³` e/t |
| CPU | `2.42 × 10⁻⁴` CPU/tick |
| body parts | `1/16.5` = 0.061 |

That is worth stating on its own: **the placement decision needs no CPU shadow
price.** Energy and CPU are proportional here, so minimizing `E` minimizes both
at once. A shadow price is only needed for build-or-don't decisions, where a
capital cost sits on the other side of the scale.

**The score** is the improvement over the reflex placement:

```
V  =  E(p adjacent to storage)  −  min_p E(p)          [energy·tiles/tick]
```

Report it in all three units, and normalize by the *full* route burden —
in-room plus out-of-room legs — or a saving that removes 70% of the in-room leg
will read as far larger than it is.

**Solving it** is cheap, and belongs at planning time rather than per tick:

1. Flood-fill a path-distance field over the room from `s` and from each `e_i`.
   Terrain-weighted, or uniform if you assume the route gets paved — the latter
   is defensible and keeps both currencies linear.
2. For each buildable candidate `p`, the routing `x*` is greedy: sort routes by
   `d(e_i,p) − d(e_i,s)` ascending and assign to the terminal until `X` is
   covered. That is the entire inner problem.
3. Take the argmin. `O(tiles × routes)` after `routes + 1` flood fills over
   ~2,500 tiles — negligible, and cacheable essentially forever.

Distances must be **path** distances, never Chebyshev. A tile 20 closer in a
straight line but behind a wall is worse, and swamp asymmetry moves the optimum
visibly.

### 8.5 The gate: when the offset is worth anything at all

Collapse to the single-cluster case — aggregate remote flow `f_R` entering at one
point, terminal shifted `t` tiles from storage toward it — and the score has a
closed form:

```
V  =  min( X, f_R, 2f_R − X ) · t
```

Three regimes, and only the middle one is good:

| | |
|---|---|
| `X = 0` — room consumes everything it mines | `V = 0`, **never offset** |
| `X = f_R` | `V = f_R · t`, **the maximum** |
| `X ≥ 2 f_R` | `V ≤ 0` — pulling from storage costs more than the inbound leg saves |

So the offset pays only for `0 < X < 2f_R`, and it is best when **export flow
matches the remote inflow it captures.** You want the terminal to be a
pass-through: starve it and you pay to pull from storage, flood it and you pay
to push back.

Worked, for a room with two reserved remotes entering the west side, storage 25
tiles in, exporting all of it, terminal shifted 18 tiles:

| | |
|---|---|
| `f_R` = 20 e/t, `X` = 20 e/t, `t` = 18 | `V` = **360 e·tiles/tick** |
| energy | **0.94 e/t** |
| CPU | **0.087 CPU/tick** |
| body parts | **~22** |
| share of the full 60-tile route burden | **30%** |

About one link pair's worth of benefit at zero capital cost. That is the honest
size of it — real, but not transformative.

**Three things that should stop you:**

1. **It is a one-shot decision carrying 100,000 energy of regret.** Terminals
   cannot be moved, only destroyed and rebuilt at full price, and against
   `V ≈ 1 e/t` a relocation pays back in ~100,000 ticks — which is to say never.
   The position is chosen once, at RCL6, on a *forecast* of the room's role. Take
   the offset only where that role is structurally certain (a dedicated mining
   colony, a designated forward base), never on observed traffic that might be a
   phase.
2. **`f_i` must come from the plan, not from creep positions.** Flows keyed to
   observed hauling flap with every lost remote and go blind exactly when a route
   is contested. Read commissions and the `RoomDiscovery` lenses — the same
   durable-signal rule the stranded-reserver incident established.
3. **Exposure is not in the objective.** A terminal near an exit tile has 3,000
   hits, wants a rampart, and needs builder trips to maintain it — another creep
   route the model does not price. Treat "inside the defended perimeter" as a
   hard constraint, not a penalty term.

**And the alternative that usually dominates: claim the remote.** Same 20 e/t,
same room, but routed through a terminal in an *owned* neighbour instead of a
60-tile creep haul:

| | energy | CPU/tick |
|---|---|---|
| baseline — 60-tile creep haul | 3.12 e/t | 0.29 |
| terminal offset (§8.3) | 2.18 e/t | 0.20 |
| **claim the remote, terminal hop** | **1.44 e/t** | **0.09** |

Claiming beats offsetting by ~1.5x on energy and ~2x on CPU, and beats the
baseline by 2.2x and 3.1x, because it replaces the whole long haul with a 3.28%
teleport. **The offset is what you do when GCL or defensibility says you cannot
claim.** It is a second-best and should be labelled as one, so it never gets
mistaken for the strategy.

---

## 9. Second-order mechanics that change the shape

**The link hub is a concentrator, not an eliminator.** A hub link receiving from
three source links at range 20 takes 3×800 per 20 ticks = 120 e/t of arrivals,
but holds only 800. It must be drained continuously or senders stall on a full
target. The good news: a creep parked between the hub link and storage does one
withdraw and one transfer per tick with zero movement, so **a stationary
16-CARRY creep drains 800 e/t.** Links move the hauling burden from a long
expensive route to a short cheap one — which is the whole point, but a fleet
model that credits links with removing haulers outright will under-staff the hub
and stall the network.

**Structure fragility inverts structure cost.** Links are the squishiest
logistics structure (1,000 hits) and the cheapest to replace (5,000). Terminals
have 3,000 hits and cost 100,000 — losing one is ~5,000 ticks of a room's net
income and isolates the room from the network. **Rampart the terminal; don't
bother with links.**

**Construction is irreversible — there is no liquidation.** `dismantle()` returns
`0.005 × hits` to the creep and repair costs `0.01 × hits`, so you recover a flat
50% of energy spent *repairing*. But a structure's hit pool has nothing to do
with its build cost, and salvage on buildings is therefore ~zero:

| structure | hits | salvage | build cost | recovery |
|---|---|---|---|---|
| **terminal** | 3,000 | **15** | 100,000 | **0.015%** |
| storage | 10,000 | 50 | 30,000 | 0.17% |
| spawn | 5,000 | 25 | 15,000 | 0.17% |
| link | 1,000 | 5 | 5,000 | 0.10% |
| road, plain | 5,000 | 25 | 300 | **8.3%** |
| rampart | as repaired | `0.005/hit` | `0.01/hit` repaired | **50%** |

The terminal is the worst-salvaging structure in the game — the most expensive
thing you can build, and among the squishiest. Dismantling one recovers **15
energy**, and the 10-WORK creep that does it costs 1,000. So §8.5's "100,000
energy of regret" is not rhetorical: relocating a terminal destroys the entire
build cost.

Two corollaries that do matter. **Roads and ramparts are the only structures
worth dismantling**, being hit-dense relative to cost. And a turtled defender's
ramparts are **a 50%-liquid battery for whoever can stand next to them** —
repairing to 30M hits sinks 300,000 energy and hands 150,000 back to the
attacker who dismantles it. Over-investing in rampart hits is storing energy in
a form the enemy can withdraw. Slowly (50 hits per WORK per tick puts 30M hits
at ~24,000 creep-ticks unboosted), but the energy is real and belongs in raid
economics.

**Creep logistics is the attack surface; terminal logistics is not.** Convoys can
be ambushed, blocked, and starved. Terminal sends have no interception mechanic
at all. Under contest the creep arc's true cost is 0.26%/tile *plus* expected
interdiction loss *plus* escort — while the terminal arc stays at 3.28%. War
should push the network hard toward terminals, and it means supply-line
strangulation is essentially not a viable strategy in Screeps: you cannot cut a
terminal link without destroying the room.

**The terminal is a strategic-reserve instrument, not a throughput one.** 300,000
energy arriving in a single tick from 5 rooms away, at 15% tax, is a
mobilization no creep network can approximate. Every other mode in the game moves
energy at tactical speed. This is the only one that moves it at strategic speed —
fast enough to out-repair a breach in progress. That argues for holding terminal
buffers deliberately full rather than treating the terminal as a pass-through.

---

## 10. The value-density corollary

Terminal cost is a **flat energy charge per unit shipped, regardless of what the
unit is worth.**

Shipping 3,000 energy one room costs 98 energy — 3.28% of the cargo's value.
Shipping 3,000 units of a T3 boost one room also costs 98 energy — a fraction of
a percent of the cargo's value.

**Shipping energy is the single worst use of a terminal.** The tax is regressive
in value density, so:

> Don't ship energy. Ship the thing energy was turned into.

Site energy-intensive production where the energy is mined, and export the
compact high-value output. This is Weber's least-cost location theory for
weight-losing industry, reproduced exactly by the Screeps cost formula, and it
argues for a genuinely different empire structure than "mine everywhere, ship to
one hub, process centrally."

### 10.1 The market is a transport network with no distance term

`deal()` charges the **caller** `calcTransactionCost` out of their own terminal.
`createOrder` charges the **poster** a 5% credit fee (`MARKET_FEE`) and no
transport at all. That asymmetry is the entire mechanism:

> **Makers pay credits. Takers pay energy.**

Which gives two ways to move energy across the map without paying the
exponential:

**Taker / taker.** Sell into a buy order near A, buy from a sell order near B.
You pay two *short* transport legs plus the spread twice — energy cost
`≈ (d₁ + d₂)/30`, where `d₁` and `d₂` are distances to your counterparties and
have nothing to do with the distance from A to B.

**Maker / maker.** Post a sell order in A and a buy order in B. Counterparties
come to you and pay their own transport. **Your energy transport cost is zero.**
You pay 5% per order in credits, plus the spread, plus fill risk.

Either way, the distance from A to B **appears nowhere in the cost**. A
terminal's cost is a function of `d`; the market's is a function of order-book
depth near your endpoints. Those are unrelated quantities.

### 10.2 Where the break-even actually sits

The two currencies are commensurable because **energy's shadow price is its
market price** — selling is always available, so that is its opportunity cost.
On that basis maker/maker beats a direct send when:

```
0.10 (two 5% fees)  +  s (effective spread)   <   1 − e^(−d/30)
```

| effective spread `s` | direct send becomes the worse option beyond |
|---|---|
| 0% | **3.2 rooms** |
| 10% | **6.7 rooms** |
| 20% | **10.7 rooms** |
| 30% | **15.3 rooms** |

Taker/taker with counterparties two rooms out and a 10% spread breaks even near
**7.8 rooms**, and fills immediately rather than eventually.

Every row depends on **energy order-book depth near both endpoints**, which is
live and volatile rather than constant. Energy is one of the thinner books on the
market and a 30% effective spread is not unusual, so measure before trusting the
table.

**Scope, and it is a narrow one.** Every row above assumes you are a *price taker
at the quoted spread* — true for marginal quantities, false the moment your flow
becomes the market's dominant flow. At the volumes a concentration push needs
(§12), price impact, credit balance, and fill latency all bind long before the
transport tax does, and the table stops applying entirely. See §12.7.

Two costs it hides. **Credits are not free** — if credits are your binding
constraint, which they usually are before labs and boosts are running, then
paying credits to save energy means paying in the currency you actually lack.
And you need energy already in the terminal to pay transport *even when the thing
you are buying is energy*, which is a real bootstrap constraint for a room
starting from empty.

### 10.3 The reframe that matters more than the arbitrage

The arbitrage is real but second-order. The first-order point is what it does to
the shape of the problem.

An RCL8 room with surplus and no sink (§11) is going to sell energy locally
anyway. A developing room is going to buy energy locally anyway. **When both
happen, energy has moved across the map and nobody routed it** — there was never
a transport decision, only two independent local pricing decisions.

> The market turns a routing problem into two local pricing problems.

That is structurally the same move as §8.1, where the terminal's complete graph
dissolves routing rather than solving it. Worth naming as a theme: **almost none
of the interesting decisions in this domain are routing decisions.** Terminals
are a complete graph. The market has no distance term. Links are point-to-point
within one room. The only genuine routing left is creep pathing on the last mile.

### 10.4 The market is public; terminal sends are not

Pure game theory, and it cuts against everything above. `getAllOrders()` exposes
every order's room, resource, amount and price to every player:

- A large standing **buy** order in room B advertises that B is energy-hungry —
  which reads as developing, under-defended, and worth visiting.
- A large standing **sell** order in room A advertises surplus, which reads as a
  full storage worth taking.
- A predictable large order is **front-runnable**: a competitor prices just
  inside yours and takes the flow, or simply prices against a buyer they know has
  to fill.

Terminal transfers carry no such exposure — `incomingTransactions` shows only
your own. **Choosing the market over your own terminals converts a private
logistics operation into a public broadcast of your economic state.** For a room
whose role you would rather not advertise, that is worth more than 3.33%.

And the reflexive one: this arbitrage exists only because energy is illiquid and
spatially segmented. Every player who exploits it narrows the spread that made it
work.

---

## 11. The RCL8 inversion: the room stops being a sink

At RCL8 the controller hard-caps at **15 e/t**
(`CONTROLLER_MAX_UPGRADE_PER_TICK`). Below RCL8 a controller is an unbounded
sink — throw 100 e/t at it with enough upgrader WORK and it all converts to RCL
progress. At RCL8 that ends, and the room's economics invert.

A mature RCL8 room with remotes:

| | e/t |
|---|---|
| local sources (2) | 20 |
| remotes (3–6) | 30–60 |
| **income** | **50–80** |
| controller, capped | 15 |
| creep replacement, towers, decay repair | 10–20 |
| **local burn** | **25–35** |
| **surplus with nowhere local to go** | **20–50** |

Storage (1M) plus terminal (300k) banks 1.3M, which at 40 e/t of surplus fills in
**~32,000 ticks**. After that the room must export, sell, or convert. Hoarding is
a nine-hour option, not a strategy.

So the observation is structural rather than incidental: **every RCL8 room with
remotes becomes a net exporter, and energy export becomes its dominant terminal
activity.** Four consequences worth planning around.

### 11.1 Export is nearly free; acquisition is where all the CPU goes

A terminal send is one intent — 0.2 CPU per 10-tick cooldown, **0.02 CPU/tick** —
and with storage adjacent the fill is a stationary creep at 2 intents per 800.
**An RCL8 room can export its entire surplus for ~0.03 CPU/tick.**

Against the 0.3–1.0 CPU/tick its remote hauling costs (§7), distribution is a
rounding error. **All CPU optimization belongs on the acquisition side** — bigger
haulers, links where geometry allows, and above all converting creep hauls into
terminal hops by claiming remotes (§8.5).

### 11.2 The terminal is idle, which is what makes §9's reserve role free

40 e/t of export split three ways is ~400 energy per send, against 300,000 of
capacity and a 30,000 e/t nominal ceiling. **Energy export uses well under 1% of
a terminal's throughput and never comes near the cooldown.**

That spare capacity is not waste — it is exactly what makes the
strategic-reserve posture from §9 free. Holding a terminal near full costs the
export role nothing.

### 11.3 It resolves the one-shot placement problem

§8.5 worried that terminal placement is a forecast made at RCL6, when `X ≈ 0`,
about a payoff that only arrives at RCL8. The RCL8 arithmetic closes that gap.
Substituting `X = 20 + f_R − 30 = f_R − 10` into the gate:

```
V = min( X, f_R, 2f_R − X ) · t  =  X · t          for any f_R > 10
```

**For a mature RCL8 room the offset value is simply export rate × shift
distance** — the awkward `X > 2f_R` regime never applies. And `X` grows
monotonically with remote count, which is a *geographic* fact known at claim
time rather than a speculation. So:

> Site every terminal for the room's RCL8 steady state, never its RCL6 present.

At `f_R` = 40, `X` = 30, `t` = 18: **`V` = 540 e·tiles/tick — 1.4 e/t,
0.13 CPU/tick, ~33 body parts.** Half again the §8.5 example, and the gap widens
as the room matures.

The forecast that still matters is "how many remotes will this room hold," and
that is answerable from the map before you claim.

### 11.4 The endgame: exporting energy is the worst option and the default

§10 said shipping energy is the worst possible use of a terminal — a flat energy
charge per unit, paid in the same commodity, on the lowest-value-density cargo in
the game. The RCL8 room does exactly that, continuously, by default.

Ranked by what a surplus energy unit is actually worth:

| sink | tax | capacity | notes |
|---|---|---|---|
| **power processing** | **0%** | 50 e/t | 50 energy + 1 power → GPL, entirely local |
| feed a sub-RCL8 controller | 3.33%/room | uncapped below RCL8 | converts to RCL, which creates new sinks |
| sell locally for credits | the spread | market depth | §10's arbitrage |
| export energy to another RCL8 room | 3.33%/room | — | **moves the problem, does not solve it** |
| nukes | — | 5M each | a sink, not an investment |

`PowerSpawn.processPower()` burns 50 energy per power
(`POWER_SPAWN_ENERGY_RATIO`), i.e. **50 e/t of sink at zero transport tax** —
precisely the scale of an RCL8 room's surplus, and evidently designed as its
terminating sink. It needs a power supply chain from highway banks, but where one
exists it strictly dominates exporting energy.

**This ranking assumes no growth target.** If the empire is funding a room's
ascent (§12), row two moves to the top: a sub-RCL8 controller is uncapped, and it
is the objective function rather than a sink of convenience. Power processing is
what you do with surplus when there is nothing left to build.

Watch the fourth row. In a fully-RCL8 empire **every room is a source and none is
a sink**, so energy shipped between mature rooms merely circulates, paying 3.33%
every time it moves. That is the real endgame constraint, and it is why power
processing and the market exist at all.

---

## 12. Concentration of force: rushing one room to RCL8

The transport network is not the objective. It is the mechanism that lets `N`
rooms fund one room's ascent. This section is why that is worth doing, what it
actually costs, and the one number that decides it.

### 12.1 The one resource that cannot be pooled

Almost everything in Screeps is poolable across rooms. Energy ships at 3.33% a
room (§4.3). Bodies walk. CPU is a global budget. GCL is empire-wide.

**Spawn energy capacity is not.** A creep is built from one room's spawns and
extensions, and no amount of terminal traffic changes that:

| RCL | extensions × capacity | + spawns | **max single creep** |
|---|---|---|---|
| 6 | 40 × 50 | 1 × 300 | **2,300** |
| 7 | 50 × 100 | 2 × 300 | **5,600** |
| 8 | 60 × 200 | 3 × 300 | **12,900** |

A 50-part creep costs between 2,500 (all MOVE) and 12,500 (all HEAL). So an RCL6
room **cannot field a 50-part creep at all**, an RCL7 room can field a cheap one,
and only an RCL8 room can build the maximum creep the game permits.

That is the whole argument. **Concentration exists to overcome the one
non-poolable resource**, and each RCL step is a ~2.3x jump in maximum single-creep
strength. Combat outcomes are decided by your *best* creep, not your average one,
so capability is convex in RCL — and by Jensen, for a fixed energy budget a
concentrated RCL distribution beats a spread one on peak capability. That is the
formal version of "overwhelms locally-focused bots," and it is correct.

### 12.2 Serial dominates parallel, and it is not close

Standard result, and it applies exactly. `N` identical projects of size `W`, one
shared resource pool of rate `R`:

| | first completion | last completion | mean |
|---|---|---|---|
| parallel (each room funds itself) | `NW/R` | `NW/R` | `NW/R` |
| **serial (pool onto one)** | **`W/R`** | `NW/R` | **`(N+1)W/2R`** |

The first project finishes `N` times sooner and the last finishes **no later**.
Serial halves mean completion time and costs nothing in this idealization.

Screeps then adds compounding, which breaks the tie: a finished RCL8 room raises
`R` for everyone after it. Worked, for five rooms at 16.2M each (RCL4→8), pool
starting at 135 e/t and each completion adding ~35 e/t:

| | first RCL8 | all five RCL8 |
|---|---|---|
| parallel | ~450,000 ticks | ~450,000 ticks |
| **serial** | **120,000 ticks** | **~421,000 ticks** |

**First RCL8 at 27% of the time, and everything finishes sooner too.** The costs
against that are the transport tax — ~10% at a typical 3-room average, which is
noise at this scale — and risk concentration (§12.5).

### 12.3 The honest part: this is a terrible economic investment

Reaching RCL8 costs **16.38M energy** cumulative, and 10.9M of that is the 7→8
step alone — 67% of the whole journey. Against what it returns:

| | cumulative energy | steady income | payback on the last step |
|---|---|---|---|
| RCL4 | 180,200 | ~25 e/t | — |
| RCL6 | 1,800,200 | ~45 e/t | ~81,000 ticks |
| RCL8 | 16,380,200 | ~70 e/t | **~583,000 ticks** |

Claiming a *new* room and taking it to RCL4 costs ~180k for +25 e/t — a 7,200-tick
payback, **roughly 50x better ROI than the 7→8 step.** Purely economically,
expansion strictly dominates RCL progression, and it is not remotely close.

Once you are *at* RCL8, the 15 e/t cap (§11) also makes the room a poor GCL farm;
sub-RCL8 rooms are unlimited ones. The journey there is fine — control points
accrue 1:1 regardless of RCL — but the destination is a slow place to keep
farming from.

> **Superseded by §13.4.** The comparison above prices a new room at its ~180k
> development cost while ignoring the ~19.7M of GCL required to claim it. Once
> that is included, the rush is *cheaper* than expansion at five rooms, and the
> GCL curve forces the surplus upgrading to go somewhere regardless. The honest
> verdict is not "economically irrational" but **"economically neutral, and
> decided on capability"** — see §13.4 for the corrected arithmetic.

**If the goal is purely military, price RCL7 first.** It costs 5.4M against
16.4M — a third — and delivers 6 labs, 2 spawns, and 5,600 spawn capacity. The
premium buys 6 towers, a third spawn, 10 labs, the nuker, and the jump to 12,900.
Whether that last item is worth 11M energy is the actual question, and it depends
entirely on whether your opponents field creeps you cannot answer below 12,900.

### 12.4 What actually binds

Not energy delivery — the terminal is effectively uncapped (§4.3). Three other
things bind, in this order:

**Absorption at the controller.** Upgrading is uncapped below RCL8, so the ceiling
is WORK parts parked in range 3 and fed. Sustaining `N` 50-part upgraders costs
`N/30` parts per tick against one spawn's 1/3, so **~6 upgraders ≈ 240 e/t is the
practical ceiling for a one-spawn target**, ~500 e/t at RCL7 with two spawns and
imported bodies. Beyond that, open a second target rather than waste surplus.

**Feeding the nest.** 240 e/t into a tight cluster is real hauling — and it is
exactly what §7.4's star topology is for. Three sender links beside storage
feeding one receiver at the controller, 15 tiles away, deliver `3 × 800/15` =
**160 e/t for ~0.1 CPU/tick.** Dedicate the target room's links to the controller,
not to its sources; that inverts the usual doctrine and is correct here.

**Importing bodies.** The target has one spawn until RCL7, so donors must spawn
upgraders and walk them in. WORK-heavy bodies are slow: 40 WORK + 10 MOVE moves
at 2 ticks/tile on roads, so a 50-tile walk costs 6.7% of the creep's life and a
150-tile walk costs 45%. **Import bodies from adjacent rooms only; from further
out, ship energy instead.** That constrains the donor set to a compact cluster
around the target — which is the same geographic-compactness pressure §8.1 said
the terminal tax *doesn't* create. Body import does create it.

### 12.5 Selecting the target, and the risk

**Choose for defensibility and controller geometry, not income.** Income ships in
by terminal from anywhere; defensibility cannot be shipped. Want few exits, walkable
tiles in range 3 of the controller, a short storage→controller run for the link
star, and distance from hostile players.

Two risks, and the second is the one that actually decides it:

**Single point of failure.** 16M energy in one room. Lose it and the donors are
stunted and the investment is gone — there is no salvage (§9: dismantling
recovers 0.015%).

**Your donors are soft, and a rational opponent attacks the weakest room, not the
strongest.** Concentration maximizes your peak and exposes your minimum. The
fortress you built is irrelevant if the enemy never goes near it. This gives the
sequencing:

> **RCL6 everywhere first, then concentrate on one room to RCL8.**

RCL6 is 1.8M per room — 11% of the RCL8 cost — and it is the threshold that makes
a room both self-sufficient and useful: terminal (so it can donate at all), 2
towers, 3 labs. Below RCL6 a room cannot even participate in the strategy, because
it has no terminal.

### 12.6 What this changes upstream

- **§11.4's sink ranking inverts.** Power processing is the best sink for a mature
  empire with no growth target. With a rush target, feeding a sub-RCL8 controller
  is strictly better — it is the objective function, and it is uncapped.
- **§8.3's terminal placement flips for the target room.** Its dominant flow is
  terminal → controller, not remote → terminal. Site its terminal toward the
  controller. Since placement is one-shot (§9), and the room becomes an exporter
  only after the rush completes — at which point exporting energy is the worst
  thing it can do anyway (§11.4) — the rush should win that argument.
- **§10.2's market route does *not* earn its keep here** — the one place the
  earlier analysis needs outright retracting for this posture, not just
  reordering. §12.7.

### 12.7 Why the market is not part of this

§10 established the market as a cheaper transport substitute beyond ~3–7 rooms.
That result is right **at the margin and wrong at this scale**, and it is worth
being precise about why, because the arithmetic is not close.

**Volume.** The rush needs ~240 e/t sustained for ~120,000 ticks — call it **29M
energy**. Energy is one of the thinner books on the market, where a large order
is tens of thousands of units. You would not be trading on the energy market, you
would **be** the energy market, several times over.

**Price impact.** A buyer that size walks the book. Your effective spread is not
the quoted 10–30% but the depth-weighted cost of everything you have to lift, and
it rises as you lift it. §10.4 noted that exploiting the arbitrage narrows it; at
wartime volume that stops being second-order and becomes the whole story —
**you set the price, and you set it against yourself.**

**Credits.** 29M energy is on the order of a million credits, one to two orders of
magnitude above a typical balance, and the only way to earn it is selling into the
same thin book you are buying from.

**Determinism.** A war push needs a *known* rate. Terminal sends are exact and
land next tick. Market fills are stochastic — 50k this tick, nothing for the next
ten thousand. **A wartime economy needs deterministic throughput and the market
supplies a stochastic queue.** This objection is more fundamental than depth, and
unlike depth it does not improve with a better book.

**And it broadcasts the Schwerpunkt.** Orders are public (§10.4), and a standing
multi-million-unit energy buy program names your target room in its own metadata.
Concentration of force depends on the enemy not knowing where you are
concentrating; buying the war chest on a public exchange defeats the strategy's
central premise. It also hands a rational opponent a holdup — your demand is
inelastic because the investment is sunk, so they price against you, or simply
attack the room you have advertised.

**The decisive point is that none of it is needed.** Five donor terminals push
300,000 per 10 ticks each: ~150,000 e/t of theoretical transport capacity against
an absorption ceiling near 240 (§12.4). **You are absorption-limited by a factor
of roughly 600, not transport-limited.** The market solves a cost problem, and
cost is not binding when the 3.33%-per-room tax applies to a flow you already
cannot fully absorb.

> Move energy on your own terminals. At this scale they are unbounded,
> deterministic, and private — and the market is none of the three.

### 12.8 What the market is for in wartime

Two things, both of which the terminal network cannot do.

**Minerals and boosts — the thing you cannot mine.** A room yields exactly one
mineral type. A single T3 military boost line needs four (`Z`, `H`, `O`, `X` for
XZH2O) and a full set needs most of the seven. **No empire mines what it needs to
boost**, so trading is not an optimization here, it is the only path.

The volumes are what make the difference. Boosting a 50-part creep costs 1,500
mineral units (`LAB_BOOST_MINERAL` = 30 per part), so a four-creep squad is
~6,000 units — **three-plus orders of magnitude below the 29M energy figure**, and
comfortably inside market depth. §10's regressive value-density tax works in your
favour for once: shipping boosts costs a rounding error.

**Converting unabsorbable surplus.** Where donors out-produce what the target can
take, selling the excess for credits to buy boosts is the option that compounds
into the military objective instead of sitting idle.

### 12.9 The best sink for the excess is your donors' ramparts

Which closes §12.5's risk. Repair costs 0.01 energy per hit, so **one energy buys
100 rampart hits**, at no rate cap:

| | |
|---|---|
| 80 e/t of excess | 8,000 hits/tick |
| `RAMPART_HITS_MAX` at RCL6 | 20M per rampart |
| ~30 ramparts covering a donor base | 600M hits ≈ **6M energy of sink** |
| maintenance (`RAMPART_DECAY` 300 per 100t) | 0.03 e/t each — trivial |

Each donor therefore absorbs on the order of 6M energy into its own defences —
about a third of the entire RCL8 rush cost — and what it buys is exactly the
vulnerability concentration creates. **The surplus the target cannot take should
harden the donors, because a rational opponent attacks the weakest room and the
donors are it.** Self-correcting in the right direction, and strictly better than
any market route.

Ranked, for a donor with surplus beyond the target's absorption:

1. **Ramparts on the donor itself** — unbounded rate, no transport tax, and it
   fixes the strategy's own exposure.
2. **Sell for credits, buy boosts** — the only route to minerals you cannot mine.
3. **Bank it** — 1.3M per room across storage and terminal, ~81,000 ticks of
   buffer at 80 e/t. Real, but a delay rather than a sink.
4. **Open a second rush target** — once (1) saturates and absorption is genuinely
   the binding constraint.

---

## 13. The income statement

Consolidating everything above into one P&L, for the five-room concentration
posture of §12: one target room being rushed RCL4→8, four RCL6 donors. All
figures **energy per tick**. Derived from the cost laws in §4 and §7, not
measured — treat the structure as sound and the coefficients as ±20%.

### 13.1 Consolidated

```
REVENUE
  Local sources          10 × 10 e/t                        100.0
  Remote sources         14 × 10 e/t                        140.0
                                                          ───────
  Gross energy income                                       240.0

COST OF GOODS SOLD
  Miner bodies           24 × 650e / 1500t                  (10.4)
  Hauling                8,500 e·tiles/t × 0.0026           (22.1)
  Remote reservation     9 rooms × 1.18                     (10.6)
                                                          ───────
  GROSS PROFIT                                              196.9    82.0%

OPERATING EXPENSES
  Structure decay & repair                                   (7.5)
  Defense response                                          (10.0)
  Anti-downgrade upgrading, donors                           (4.0)
                                                          ───────
  OPERATING SURPLUS                                         175.4    73.1%

TRANSPORT — the cost of concentration
  Terminal tax           145.2 shipped @ 6.45%               (9.4)
                                                          ───────
  Available at the target                                   166.0

COST OF THE OBJECTIVE
  Upgrader bodies        160 WORK sustained                 (12.0)
  Link tax               154.0 fuel @ 3%                     (4.6)
                                                          ───────
  NET CONTROLLER PROGRESS                                   149.4    62.3%
```

At 149.4 e/t, RCL4→8 (**16,200,000** exactly) takes **108,400 ticks**.

### 13.2 Segment view

| | donor ×4 (RCL6) | target (RCL4→8) |
|---|---|---|
| local sources | 20.0 | 20.0 |
| remote sources | 30.0 | 20.0 |
| **revenue** | **50.0** | **40.0** |
| miner bodies | (2.2) | (1.7) |
| hauling | (4.7) | (3.4) |
| reservation | (2.4) | (1.2) |
| decay & repair | (1.5) | (1.5) |
| defense | (2.0) | (2.0) |
| anti-downgrade | (1.0) | — |
| **operating surplus** | **36.2** | **30.2** |
| terminal tax | (2.3) | — |
| **contributed to objective** | **33.9** | **30.2** |

Four donors contribute 135.6, the target 30.2. Against that pool: upgrader
bodies (12.0) and link tax (4.6), leaving **149.2** of controller progress.

### 13.3 Where the 37.7% goes

90.6 e/t never reaches the controller. Ranked:

| line | e/t | share of loss | share of gross |
|---|---|---|---|
| **hauling** | 22.1 | 24.4% | 9.2% |
| **upgrader bodies** | 12.0 | 13.2% | 5.0% |
| remote reservation | 10.6 | 11.7% | 4.4% |
| miner bodies | 10.4 | 11.5% | 4.3% |
| defense | 10.0 | 11.0% | 4.2% |
| terminal tax | 9.4 | 10.4% | 3.9% |
| decay & repair | 7.5 | 8.3% | 3.1% |
| link tax | 4.6 | 5.1% | 1.9% |
| anti-downgrade | 4.0 | 4.4% | 1.7% |

Four readings worth having:

**Hauling is the largest single cost in the empire**, at 9.2% of gross — which
retroactively justifies every line of §7. It is also the one that responds to
engineering rather than to strategy.

**Transport is not the problem.** Terminal plus link tax is 14.0 e/t — 15% of all
losses, 5.8% of gross. §12.7's claim that the cost of concentration is cheap
holds up: you could eliminate transport entirely and recover less than 6%.

**Reservation costs more than the terminal tax.** A CLAIM part is 600 energy for
600 ticks of life — **exactly 1 e/t, permanently, per part** — and it is the most
underestimated line on this statement.

**Upgrader bodies exceed the entire transport bill.** Which points at boosts:
XGH2O doubles upgrade per WORK, halving the fleet from 12.0 to 6.0 e/t. But that
needs ~2,400 units per 1,500 ticks — ~173,000 units across the whole rush, an
industrial program well beyond what §12.8's market can supply. **Don't boost
upgraders for the energy.** Boost them because halving the creep count doubles the
absorption ceiling against the target's one-spawn constraint (§12.4) — 240 e/t
becomes ~480. That is a spawn-capacity argument, not an efficiency one.

### 13.4 The capital account — and a correction to §12.3

§12.3 called the rush "economically irrational," priced against claiming a new
room at ~180k. **That comparison was wrong**, because it ignored the GCL a new
room requires. Correcting it materially strengthens the case for concentration.

**Controller spending is not an expense — it buys two assets at once.** Every
energy into any controller yields RCL progress in that room *and* GCL progress
empire-wide, 1:1 and RCL-independent. GCL gates room **count**, not room
**level**.

GCL n requires `(n−1)^2.4 × 10⁶` control points, so the marginal room costs:

| | GCL requirement | marginal cost of the next room |
|---|---|---|
| GCL 5 (5 rooms) | 27.9M | — |
| GCL 6 (6 rooms) | 47.6M | **19.7M** |
| GCL 7 (7 rooms) | 73.7M | 26.1M |
| GCL 8 (8 rooms) | 106.7M | 33.0M |

**A 6th room costs 19.7M. Taking a room RCL4→8 costs 16.2M.** At five rooms the
rush is *cheaper than expansion*, not 50x worse — the opposite of what §12.3
said.

And the GCL curve does something stronger than permit the strategy; it very
nearly forces it. Holding 5 rooms requires 27.9M of controller spend, but
bringing 5 rooms to RCL6 costs only 9M. **The remaining 18.9M has to go
somewhere**, and 16.2M of it takes one room to RCL8 with change left over. So the
real choice at GCL 5 is not whether to spend it, but how to shape it:

| the same 27.9M, distributed two ways | max single creep |
|---|---|
| spread evenly — **5 × RCL7** | 5,600 everywhere |
| **concentrated — 1 × RCL8 + 4 × RCL6** | **12,900** in one, 2,300 in four |

Both cost identically, both yield identical GCL, and total income differs by
under 10% (one room at +45 e/t against four at +10 each). **Economics is a wash;
the decision is made entirely by the convexity argument of §12.1** — and 12,900
beats 5,600 decisively, because combat is settled by your best creep.

The cost is now sharper too, and it is exactly §12.5's risk: your donors sit at
RCL6 with 2,300 spawn capacity and 2 towers, rather than RCL7 with 5,600 and 3.
Which is precisely why §12.9's rampart sink is not optional bookkeeping — it is
how you pay for the shape you chose.

---

## 14. What this implies for the planner

Stated as arc costs, ready to price:

| arc | tax | capacity | notes |
|---|---|---|---|
| creep, roaded | `0.0026 × d` | `16.7/d` e/t per body part | scale-invariant; +0.01 e/t/part road wear already included |
| creep, unroaded plain | `0.0027 × d` | `12.5/d` e/t per part | pave for parts/CPU, not energy |
| creep, unroaded swamp | `0.0080 × d` | `4.2/d` e/t per part | pave this first — 3x energy win |
| link pair | `0.03` | `800/d` e/t, hard | intra-room only; **price on CPU + spawn, not energy** |
| terminal pair | `0.0333 × d_rooms` | uncapped; 10t cooldown, sender-charged | inter-room only; complete graph, always direct |

And the judgements that don't reduce to a table:

1. **Never creep-haul across a room boundary when both ends have terminals.**
   4x on tax, and terrain- and hostility-blind.
2. **Price links on CPU: 0.77 vs 11.2 CPU per 1,000 energy against a max hauler,
   a 15x edge — not the 1.7x their energy tax implies.** Any evaluator scoring
   links on energy alone will systematically under-build them.
3. **Pull body size before building links.** 3 parts → 50 parts is 16x on CPU
   and costs only spawn energy, against a link's 5,000 energy and one of six
   slots. But size is capped: at 50 parts creep-side CPU optimization is
   exhausted and every further unit of throughput costs a flat 0.2 CPU/tick.
   Size haulers by `flow × 2d` so they actually fill.
4. **Prefer stationary creeps wherever a creep is unavoidable.** CPU cost is
   movement intents; a link-fed filler that never moves runs 1.1 CPU/1,000e
   against a roaming filler's 2.8, which is link-competitive.
5. **Build in-room links as a 5 → 1 star, not as independent pairs.** Cooldown is
   sender-charged, so a star is 89 e/t against three pairs' 53 e/t for the same
   6 links — but it needs sender sequencing, because a receiver at 800 silently
   drops the overflow.
6. **Terminal placement is a free 2,500-tile choice** — but a one-shot one.
   Score it with §8.4's `E(p,x)`, gate it on `0 < X < 2f_R` (§8.5), and take the
   offset only where the room's export role is structurally certain. Where GCL
   allows claiming the remote instead, claim it: that dominates any offset.
7. **Don't route terminal traffic.** The graph is complete and relaying is
   provably neutral. Any multi-hop terminal logic is dead code.
8. **Terminal tax should never drive expansion geometry.** At radius 6 it is 13%.
   It is not the constraint anyone thinks it is.
9. **Prefer exporting product over exporting energy**, and price the market
   route before any long send. Posting orders costs credits and no transport;
   dealing costs transport and no fee — so a maker/maker pair moves energy with
   **zero** distance term (§10.1). Break-even against a direct send is ~3 rooms
   at zero spread, ~7 at 10% (§10.2). Net it against the intelligence leak:
   orders are public, terminal sends are not (§10.4). **This holds only at
   marginal volume** — at concentration scale the market fails on depth,
   credits, determinism and secrecy at once, and your own terminals are 600x
   over-provisioned for the job anyway (§12.7). Trade minerals, not energy.
10. **Treat RCL8 as a role change, not a milestone** (§11). The controller caps
    at 15 e/t, the room turns net exporter, and its surplus needs a real sink —
    power processing first, sub-RCL8 controllers second. Energy shipped to
    another RCL8 room just circulates at 3.33% a hop.
11. **Never model construction as recoverable.** Salvage is `0.005 × hits`,
    which is 0.015% of a terminal's build cost. Only roads and ramparts are
    worth dismantling.
12. **If the empire is funding one room's ascent (§12), say so explicitly and
    let it reorder everything.** Serial beats parallel by ~4x on
    time-to-first-RCL8, the transport tax to enable it is ~6% of gross, and the
    target's links, terminal placement, and sink ranking all invert.
13. **Price controller spending as a joint product, never as an expense**
    (§13.4). It buys RCL progress *and* GCL 1:1, and GCL gates room count rather
    than room level. At five rooms a 6th room costs 19.7M of GCL against 16.2M
    to take a room RCL4→8 — so concentration is economically neutral, not
    irrational, and the choice is settled on capability convexity alone.
14. **Budget against the 62% figure, not the 100%** (§13.1). Only 62.3% of
    harvested energy reaches the controller; hauling alone takes 9.2% and
    reservation takes more than the terminal tax does. A plan priced off gross
    harvest over-states delivery by 60%.

### Open questions worth measuring

- The CPU shadow price itself (spec 29 territory). §7 gives the physical ratio —
  15x — but not what a CPU-tick is worth in energy, which is what actually
  decides whether a 10,000-energy link build clears the bar.
- Whether the hub-drain creep is actually staffed to keep pace, or whether hub
  stalling is silently capping link duty cycle (§7.4, §9). A stalled hub would
  make every throughput figure here an overstatement and would not show up in
  any energy metric.
- Whether any live room is a net terminal exporter by enough margin to justify
  the §8.3 offset, or whether that is theory without a subject.
- Measured CPU per creep-tick for our haulers against the 0.2 intent floor —
  §7.7 assumes 0.1–0.3 of code overhead on top, and that ratio decides how much
  the link numbers understate.
- What our RCL8 rooms actually do with surplus, measured against §11's table. If
  the answer is "bank it until storage caps, then export energy to another RCL8
  room," the room is paying 3.33% a hop to circulate energy that has no sink
  anywhere in the empire — which is a planner bug wearing the costume of a
  healthy export flow, and no energy metric would flag it.
