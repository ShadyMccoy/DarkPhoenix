# 26 — Links as hub ports (deposit-side haulPos)

**Status:** SHIPPED THEN REVERTED — FAILED (2026-07-23). CONTROLLER-LINK ports
were deployed at ~t72512031, **slow-collapsed the live colony** (fleet 30→13
over ~1400t), and were reverted to pre-spec-26 on `master` (colony recovered).
`detectLinkDepositPorts` now returns `[]` so the feature is INERT; the planner
pricing, the shared mapper, `pickStorageDeposit`, and their unit tests are kept
for a correct redesign. The earlier "verified live" claim was WRONG — it read
plan-side telemetry (segment 6 showed the port) and a grid cell whose "link
fills" assertion was a FALSE POSITIVE (the core→ctrl relay fills the link
regardless of haulers). See docs/specs/14 for the incident writeup.

**Why it failed — two faults:**
1. **Delivery never landed.** In prod the core→controller relay keeps the
   controller link topped, so a hauler finds ~no free room and falls back to
   storage. Reproduced: a staged loaded hauler on a ported route wrote NO
   `deposit-port` receipt in 240t. So the plan under-sized the ported haulers
   for a delivery that always fell back to the hub — a plan-vs-actual lie. A
   working controller-link port REQUIRES the relay to RESERVE drop room
   (symmetric to `CORE_LINK_INCOME_RESERVE`) plus the feeder credit — the
   deferred work is a hard PREREQUISITE, not optional.
2. **Latent recovery deadlock (its own incident).** The fleet collapse drained
   the spawn network and killed the tender; with the warchest at 2× target, a
   "campaign" upgrader (`mustFund`, `gate: wall`) then held the spawn ahead of
   the income fleet — a death spiral. Pre-existing scheduler fault (spend
   outranks income when the fleet is depleted); spec-26 only triggered it.

**Blind spot that let it ship:** the integration trio and the grid link cells
never staged a storage hub + controller link together, so none exercised the
port DELIVERY path. Any redesign MUST assert a real hauler delivery RECEIPT
(not link fill) AND run a steady-state cell WITH the feeder relay present.

**Original design refinement (kept for the redesign):** source-link ports were
already dropped from v1 — a remote drop into a source link forwards to the core,
but core→storage is staffed only for the home source's own rate, so the injected
flow is unstaffed. Both port classes therefore need core/relay sizing work
(source-link: a commissioned core→storage drain; controller-link: the relay
drop-reserve + feeder credit) BEFORE any port pricing is honest.

**UPDATE — STAGE 4 SHIPPED (source-link ports, 2026-07-24).** The source-link
class is now LIVE and stable. The unstaffed-leg fault above was fixed by
attributing the deposited flow to the port's OWNING link-served source, whose
hauler already picks up at the core (`sourcePickupSpot` redirect) — so the
core→storage drain is staffed with no new execution path (`DepositPort.drainFrom`
/`drainSourceId`, `routeToSinks` drain loop). `detectLinkDepositPorts` re-armed
for source-links ONLY (`DEPOSIT_PORT_HEADROOM=30`, conservative), controller-link
ports still OUT (they need the relay drop-reserve — the v1 fault). Verified live
against the failure signatures: 3 eastern remotes deposit at source-link 4a83,
LINK `toHubRate` doubled (8.5→18.6 e/t) with `directShare 0` (no core
congestion), `controllerStock` ROSE (relay untouched — the stage-2 starvation
ruled out), plan CARRY 115.6→103.8. Captures shard1-t72530027 (pre) /
-t72530163 (live proof). The controller-link class remains the deferred v2.

## The idea (owner 2026-07-21)

"Some of our remote mines' roads walk right past the link and then continue
to the hub. In theory they could just drop their energy off at the link —
links as sort of extensions of the hub."

## The model

Precedent in-tree: the SOURCE side already does this — a link-served source's
`haulPos` is redirected to the core link at problem assembly (`flowAdapter`
`detectLinkHaulPositions`, wired ~line 404), so the plan prices the short leg
and the hauler fields the small body. The pinning test asserts miner.distance
= 200 while hauler.distance = 2 (`CorpPlanner.test.ts` `link-served sources`).

This spec is the symmetric DEPOSIT-side counterpart: the hub = storage PLUS its
link constellation ("deposit ports"). A mined route prices its delivery to the
nearest eligible port, emergently — the planner's per-(source,sink) distance at
`CorpPlanner.ts:543` (`dist(s.haulPos ?? s.pos, sink.pos)`) takes the cheaper of
{storage, nearest port}, exactly as `haulPos` already shortens the pickup leg.
No flag: the cheaper-distance port wins on economics. `carryPartsFor(rate, d)`
does the rest — shorter `d` ⇒ smaller CARRY:MOVE body.

The energy still BELONGS to the storage hub in the plan (a mined deposit); the
port is a physical DELIVERY shortcut the hub reclaims, not a re-route to a
different sink. That distinction is the whole ballgame — see the incident below.

## The banking question (owner reframe 2026-07-23) — retires the surplus gate

An earlier draft split ports into "source links (bank-neutral)" and "controller
link (bypasses the warchest → surplus-only gate)". The owner reframed this and
the gate is WRONG:

A hauler that drops mined energy at the controller link does NOT bypass the
bank. The upgraders pull from that link at whatever rate the economy currently
supports; because the link is now fuller, **the core fires less into it, and
because the core needs less, the feeder pulls less from storage.** The drop
DISPLACED a bank drawdown of the same size. Net storage change is
`income − consumption` either way — identical to banking-then-drawing. No
ping-pong; energy never flows controller→storage, we just don't SEND what we no
longer need to.

It is **partial banking for free**: whatever the upgraders can't absorb backs
up in the 800-cap link, the hauler carries the remainder on to storage, and
that part banks normally. The consumed/banked split falls out of the upgrader
pull rate — not a rule.

And the metering is the point: the **bank level IS the governor**. It sets
`sustainableConsumptionRate`, which sizes the upgraders, which sets how much
gets burned-on-arrival vs. banked. Drain the bank → consumers shrink; empty it
→ starvation sheds corps (the existing consumption-starve backstop). The loop
self-corrects in EVERY regime, so there is nothing to gate. Both port classes
become plain efficient delivery paths that leave the bank BALANCE untouched;
the "controller is the risky 21%" framing is void.

## Backpressure trace (2026-07-23) — the runtime foundation already holds

The model is only honest if the backpressure propagates the whole chain:
controller link fills → core fires less → feeder loads less → storage spared.
Traced the live path:

- **core→controller** (`LinkRunner.ts:65-72`): the core fires into the
  controller link ONLY when `ctrl.store.getFreeCapacity() >= LINK_FIRE_THRESHOLD`.
  So a controller link filled by drops stops receiving from the core. ✓ ("send
  less from the core, since the link is still full anyway" — already wired.)
- **feeder→core** (`nodeEnergy.coreLinkLoadRoom = capacity − CORE_LINK_INCOME_RESERVE
  − store`): the feeder loads the core only up to its free room, so a core that
  stays full (not firing to a full controller) drives the load to ~0 → the
  feeder withdraws less from storage. ✓ Storage outflow drops; the bank is
  spared without any new code.

So the runtime backpressure is PRESENT. The gaps are all in the PLAN:

1. The planner does not price ports yet, so haulers don't drop — they haul to
   storage (the whole point of this spec).
2. The feeder SIZING (`ControllerFeederCorp.sizeFeederRelay`) is set to the
   plan's relay rate and does not know drops will offload it, so the feeder
   stays OVER-sized — the "feeder-work deletion" saving is unrealized until the
   plan credits port-fed controller flow against the relay.
3. The plan's accounting must keep mined a storage-hub DEPOSIT while pricing the
   DELIVERY to the port — the port shortens the leg, it does not change the sink.

## Incident reconciliation (t72434228 — "spending our savings")

`CorpPlanner.ts:519-521` records the hybrid that "hauled mined straight to the
controller, so storage saw ~0 income and bled feeding the spawn." That was the
PLAN routing mined to the controller SINK (bypassing storage as a destination),
so storage had no mined income yet still funded the spawn → it bled. It is NOT
a counterexample to this spec: here the plan keeps mined → storage hub, and the
port is a delivery shortcut the backpressure makes bank-neutral. Fix the
mechanism (backpressure), don't gate the symptom (trap-list doctrine).

## Measured impact on OUR colony (2026-07-23, geometry @ t72509559)

Live home-room links (from `game/room-objects`): core (35,26-adjacent @ 35,25),
source link @ (46,11), controller link @ (41,30); storage @ (36,26). Distances
by multi-room Dijkstra over captured terrain (road-agnostic, matching the bot's
`pathDistance`; validated within ~2 tiles of the telemetered source→storage on
5/6 routes). Bodies 2:1 paved, `carryPartsFor`:

| source | dir | drop | dist | CARRY:MOVE | Δparts |
|---|---|---|---|---|---|
| cd8e | N (W43N24) | source link | 37→24 | 16c:8m → 10c:5m | −9 |
| cd8d | N (W43N24) | source link | 55→42 | 23c:12m → 18c:9m | −8 |
| cedc | E (W42N23) | source link | 52→42 | 22c:11m → 18c:9m | −6 |
| cee0 | SE (W42N22) | controller link | 53→49 | 22c:11m → 20c:10m | −3 |
| cd92 | home | controller link | 12→8 | 6c:3m → 4c:2m | −3 |
| cbd5 | W (W44N23) | — (storage) | 53→53 | 22c:11m → 22c:11m | 0 |

**~29 CARRY+MOVE parts (~17% of the mined fleet)** off a saturated single spawn
— real headroom toward another upgrader. Geometry-contingent: the source link
sits high/east, so the N and E routes pass it ~10-13 tiles before storage; the
W route (cbd5) gets nothing — no forwarding link on its side. The source/
controller split (~79/21 here) is an ACCIDENT of this layout and could invert
in another; both port classes are first-class in the pricing.

This is the IDEAL. Real saving derates for throughput: the source link forwards
~57 e/t (800 / cooldown 14) shared with its own home miner (~10), and a big
hauler's burst load can exceed 800 in one drop → **port-full fallback** (drop
what fits, carry the rest). The plan must price that expected distance honestly
(no plan-vs-actual drift), so realized < 29 parts.

## The base-layout leg (why this is the load-bearing primitive)

Once a link is priced as a port, "add a link at P" becomes a NUMBER: drop a
candidate link at P, re-run the econ plan, read the total spawn-parts delta
across every route it shortens, minus its tolls, upkeep, and the throughput it
steals from its own source. Best P wins. Link PLACEMENT becomes search +
evaluate-by-replanning:

- **Greedy-by-marginal-value** fits the RCL link budget (3 @ RCL6 → 6 @ RCL8):
  place the highest-value link, replan, place the next, stop at the cap or when
  marginal saving < the link's cost.
- **The evaluator IS the runtime pricer** — same port math scores the candidate
  and shrinks the hauler, so the placement number can't drift from behavior
  (same discipline as the P4 ledger echoing the planner).
- **It generalizes**: anything whose value is "reshapes route economics"
  (storage pos, extension cluster, next spawn) is placed by perturb-replan-read.
  Links are the cleanest first case — their value is ~100% logistical, fully
  captured by the plan. (Road-scoring does this by traffic proxy; this is the
  exact econ value.)

So spec 26 is not a one-off hauler tweak — it is the evaluation function the
base-layout track runs on. Build it as a clean, replannable primitive.

## Proposed effort (build plan — NOT started)

Two altitudes; build MINIMAL first, it unblocks the base-layout evaluator.

1. **Minimal (this spec).** A sink-side `depositPos` mirror of `haulPos`:
   - `flowAdapter.detectLinkDepositPorts(graph)` — forwarding ports (source
     links; the controller link) with positions + throughput headroom, ONE lens
     shared by pricing and CarryCorp delivery (staffsPost-symmetry class).
   - `routeToSinks` prices each mined deposit to `min(storage, nearest port)`
     with the 3% toll in net-energy and honest port-full fallback distance.
   - Commission carries the chosen `depositPos`; `CarryCorp` delivers there with
     storage fallback; feeder relay sizing credits port-fed controller flow.
   - Telemetry: export `depositPos`/port per hauler (segment 6, echo pattern).
   - Red-first: `CorpPlanner.test.ts` (symmetric to the `haulPos` describe),
     a CarryCorp delivery test, and a GRID CELL staging our real links on a
     remote route (receipts-gated behavior — mockup blind spot, trap-list).
   - Gate: unit + flow-handoff/runt-economy/storage-depot trio + grid; deploy;
     verify the throughput-derated per-route CARRY:MOVE against the plan.
2. **Full.** Links as flow-graph EDGES (teleport edges w/ capacity + toll);
   subsumes the source-link special cases and LinkRunner rules; the spec 18/25
   planner-evolution version, and the substrate for the link-placement search.

Constraints (must be PRICED, not discovered at runtime): port-full fallback
with honest expected distance; the 3% toll in net-energy; throughput shared
with the source's own mining flow; one eligibility lens for pricing + delivery.

## Open questions (carried)

1. Minimal ports first (this plan) vs. jump to the full graph-edges model that
   the base-layout evaluator ultimately wants?
2. Feeder resizing: credit expected port-fed controller flow against the relay
   in the SAME pass, or a follow-up once drops are observed live?
3. Warchest target as a function of spend RATE (owner: "what we have in the bank
   corresponds to our spending rate") — related buffer-sizing idea, separable.

## Stage 5 (BACKLOG) — link placement as an optimization (owner 2026-07-24)

Once ports work (stage 4 shipped), the open question is WHERE the links go. The
common Screeps convention — one link next to each home source — is a **naive
default**: it privileges a placement that only maximizes value by luck. A link
is a scarce slot (RCL-capped: 3 at RCL6, 4 at 7, 6 at 8); each should be placed
to maximize its logistics contribution, and a home source-link is just ONE
candidate competing with confluence / edge-interception spots.

**The metric.** A deposit link at position `P` serving source set `S` has three
coupled quantities:

- **Throughput ceiling** `T(P) = LINK_CAPACITY / range(P, core) = 800 / range`
  e/t (cooldown = Chebyshev range, `LINK_COOLDOWN=1`). Hard cap; exceed it and
  the link backs up — the failure the range-40 case (`T=20`, 2 sources) warns of.
- **Assigned flow** `F(S) = Σ flow(s)`, constrained `F(S) ≤ T(P)`.
- **Logistics value** (maximize this) `L(P,S) = Σ flow(s)·(haulDist(s) −
  linkDist(s,P))` in **tile·e/t** ≈ CARRY parts freed.

**The reach rule** falls out of `F ≤ 800/range`:

> **A link's reach is inversely proportional to the flow it carries:
> `range* ≤ 800 / F`.** High-flow clusters must be caught CLOSE to the core;
> a single far source is exactly what a FAR link can serve. "Closer vs further"
> is the wrong axis — push the link as far toward the flow as its `800/F` ring
> allows, then it is optimal. Utilization `U = F/T`; a low-U link (few sources)
> is only worth its slot if `L` still wins.

**Measured examples (live W43N23, 2026-07-24):**

| link | sources | F e/t | range→core | T | U | L (tile·e/t) |
|---|---|---|---|---|---|---|
| 4a83 (E, live) | cd90 + 3 remotes | 40 | 14 | 57 | 70% | ~530 |
| (2,20) (W, proposed) | cbd5 only | 10 | 33 | 24 | 42% | ~320 |

`(2,20)` serves cbd5 — a FAR single remote (hauler carry 21.2 @ dist 52) that
4a83 physically cannot reach — cutting it to ~dist 20 (~13 CARRY freed). Under-
utilized (1 source) but complementary, not competing: it captures flow, not
redistributes it. Failure modes the metric rules out: high-flow cluster on a far
link (backup); single far source on a close link (wasted ceiling + distance left
on the table).

**Objective.** Given ≤N link slots, partition sources into ≤N (position, cluster)
assignments maximizing `Σ L` subject to per-link `F ≤ T` and geography (a link
can't catch opposite room edges). A facility-location problem; greedy-by-`L`
is the first cut.

**Dependencies / sequencing:**
- **Instrument first** (measure, no behavior change): extend
  `computeDepositSavings` to cluster candidate sources, find each cluster's
  `L`-maximizing `P` under the `800/range` ceiling, and rank — the DEP ledger
  line reports `next link: <region>, L=…, U=…%` instead of raw per-source saving.
- **Source-less interception links** (like `(2,20)`, no adjacent home source)
  need drain attribution — the stage-4 owning-source trick doesn't apply, so
  the drain attaches to a home source (cd90/cd92) or a dedicated core-drain.
- **Link budget** is the gate: the storage↔controller merge (below) frees the
  slot a second port needs. The two are one plan.

**Related: storage↔controller merge (owner 2026-07-24).** Storage `(36,26)` and
controller `(40,32)` sit 6 apart, forcing TWO links (core + controller). Placing
storage adjacent to the controller lets ONE link do both jobs, which (1) frees a
link slot for a deposit port, (2) halves the tax on controller-bound energy
(1 hop, not source→core→controller = 2 hops = 6%), and (3) DELETES the
core→controller relay entirely — the mechanism behind both the stage-2 collapse
and the sub-threshold tax-dribble. Cost: relocating a built storage (~30k +
migration), so a "when expanding / placing fresh" decision, not urgent.

**Acceptance (when built):**
- Unit (pure): `L`, throughput ceiling, and utilization primitives in
  `economy/primitives.ts`; a placement ranker that respects `F ≤ 800/range`.
- Instrument: the DEP ledger line reports ranked candidate placements (L, U,
  ceiling) — measure-first, no behavior change, same discipline as stage 1.
- Later (behavior): the planner consumes the ranking to propose link
  construction sites; source-less port drains staffed and priced.
