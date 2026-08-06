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
see §7, because the naive reading of it ("maximize send distance") is worth
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
| CPU | **~0.3 CPU/tick** |
| spawn uptime | **~5.6%** of a single spawn |

**Price links on CPU and spawn throughput, not on energy.** In Screeps at scale
CPU is the binding constraint and energy is not, which means the correct shadow
price makes links look far better than the 0.92 e/t suggests — but for the right
reason. A planner that evaluates a link on its energy tax alone will
systematically under-build them, and one that credits it with "eliminating
haulers" will over-build them (see §8: links concentrate haulers, they don't
eliminate them).

---

## 7. Terminal geometry — and where your free 98 tiles actually pays

### 7.1 There is no routing problem

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

### 7.2 The fan-in / fan-out asymmetry

Cooldown is charged to the **sender**. A terminal can receive from any number of
terminals in the same tick, but can only send once per 10 ticks.

**Collection is free; distribution serializes at 10 ticks per destination.** A
hub serving 10 satellites reaches each one every 100 ticks. Bandwidth is never
the issue (300k per send); **latency** is. Fine for economy, potentially fatal
for reinforcement under attack — build the network hub-inbound, and accept that
outbound broadcast is slow.

### 7.3 Where to actually put the terminal

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
  remote — 24 body parts, ~1,200 energy of capital, ~0.25 CPU/tick.** That is
  larger than the entire lifetime energy saving of a link pair.

Formally it's a flow-weighted 1-median (Weber point) over the creep routes
incident on the terminal, with the terminal→terminal leg contributing **zero
weight**. The network side of the problem is free; only the last miles have
gradient.

Two costs on the offset, both real: a terminal at x≈1 sits next to an exit tile
with 3,000 hits, so it wants a rampart and is easier to snipe; and every
terminal↔storage movement now pays the offset, so the decision hinges on the
ratio of remote-inbound flow to local-consumption flow.

---

## 8. Second-order mechanics that change the shape

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

## 9. The value-density corollary

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

## 10. What this implies for the planner

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
2. **A link pair's justification is ~28 body parts, ~0.3 CPU/tick, and ~6% of a
   spawn — not its ≤1.6 e/t.** Any evaluator scoring links on energy will
   under-build them.
3. **Terminal placement is a free 2,500-tile choice.** Solve the flow-weighted
   1-median over its incident creep routes; for export rooms that is *not*
   beside storage.
4. **Don't route terminal traffic.** The graph is complete and relaying is
   provably neutral. Any multi-hop terminal logic is dead code.
5. **Terminal tax should never drive expansion geometry.** At radius 6 it is 13%.
   It is not the constraint anyone thinks it is.
6. **Prefer exporting product over exporting energy**, and check the market
   before shipping energy more than ~3 rooms.

### Open questions worth measuring

- The CPU shadow price that makes link builds pay (spec 29 territory) — §6
  gives the physical displacement, not the price.
- Whether the hub-drain creep is actually staffed to 800 e/t in practice, or
  whether hub stalling is silently capping link duty cycle (§8).
- Whether any live room is a net terminal exporter by enough margin to justify
  the §7.3 offset, or whether that is theory without a subject.
