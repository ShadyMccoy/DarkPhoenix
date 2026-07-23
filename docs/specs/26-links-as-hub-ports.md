# 26 — Links as hub ports (deposit-side haulPos)

**Status:** SCOPED — ready to build (owner design session 2026-07-23). The
2026-07-21 deferral (below) is lifted: spec 25 (emergent dedication) has
landed, and the owner's backpressure reframe (§"The banking question") retires
the surplus-gate that made the controller-link half risky. Build is NOT started
(owner: "document the proposed effort ... don't build").

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
