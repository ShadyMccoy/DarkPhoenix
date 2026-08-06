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

The same logic makes the market a transport substitute. `Game.market.deal`
charges the *caller* the same distance tax, so buying remotely doesn't dodge it —
but selling to a buyer near you and buying from a seller near your destination
pays two short-distance taxes plus the bid-ask spread twice, instead of one
long-distance tax. Break-even is `2 × spread < 1 − e^(−d/30)`; at a 10% energy
spread that's around **3 rooms**. Beyond that, **the market is cheaper than your
own terminal network**, and your internal logistics is competing with it whether
you model that or not.

---

## 11. What this implies for the planner

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
9. **Prefer exporting product over exporting energy**, and check the market
   before shipping energy more than ~3 rooms.

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
