# Spec 45 — Arrivals-first link sequencing (remove the sink wait, don't price it)

**Status: MEASURED DIAGNOSIS 2026-08-05 (owner-directed). The SIZING leg
(feeder volley-service floor, fix #2c) SHIPPED + DEPLOYED same day —
`volleyServiceCarry()` in primitives, floored in the corp AND the
infraSpawnLoad/-Energy twins, 6 red-first pins, trio 3-0; the 16C body
arrives at the incumbent's natural EOL (staffing is by-count, no linchpin
churn — registered prediction #3). The SEQUENCING legs (fix #1 direct-first,
#2a/#2b feeder gates, #3 deposit-body cap) are the next session's first
work item; the five-gauge acceptance bar belongs to them.** Owner framing:
*"Behind pricing sink wait let's see what we can do to remove or reduce it.
What's actually causing that?"* — attack the cause; pricing the wait into the
plan (the alternative this spec supersedes for now) only becomes relevant for
whatever residue survives the fix.

## The income-statement stake

The sink wait is the live mechanism behind the account's two biggest
unfavorable lines (measured across FY4852-M04/M05 windows):

- **Ground pile decay 8.4–10.3 e/t vs a 0 budget** (the L1 top line): mouths
  stand a container-cap + ~1–1.9k ground stock because hauler removal ≈
  inflow with the drain margin eaten by sink-side idle. 5 of 12 miner ops
  held (cd8d 100%, cedc 91% CHRONIC).
- **Forgone mining 3.5–10.7 e/t**: the pile gate de-prices held mouths.
- Per-corp `idleSinkFrac` 12–27% (cedc 0.266, cd94 0.20, cd8d 0.17, cee2
  0.124), with the `idleSinkAtSinkFrac`/`idleSinkStorageRoomFrac` split
  showing haulers standing AT the deposit while storage has room — blocked
  at the port, not the bank.

Fixing it also raises effective port ceilings, which is what makes the DEP
program (link-depositing more remote routes; the gauge shows ~870 tile·e/t
of haul savings across 7 routes) viable later.

## The measured causal chain (capture t72787778 + live topology reads)

Topology (W43N23, RCL 7 — 4 links, the cap; nothing new can be built):

| link | pos | role | cooldown to hub | ideal ceiling |
|---|---|---|---|---|
| HUB (core) | (35,25), beside storage (36,26) | feeder's bidirectional buffer | — | — |
| CTRL | (41,30), range 6 from hub | withdraw-only upgrader feed | — | 800/6 ≈ 133 e/t relay |
| PORT A | (46,11) | deposit port, 4 routes ≈ 31 e/t | 14 | 800/14 ≈ 57 e/t |
| PORT B | (43,38) | deposit port, 3 routes ≈ 30 e/t | 13 | 800/13 ≈ 61.5 e/t |

Port B is also range 8 to CTRL — CLOSER than its range 13 to the hub.

LinkMeter, 130t window: `toHubRate 40.75`, `toControllerRate 64.2`,
`directShare 0.277`, `hubVolleyAvg 378` (of 800), **`hubClampShare 0.50`**,
`coreFillAvg 227`, **`coreEmptyShare 0.26`**, `coreCongestedShare 0.038`.
Live spot reads: PORT B **800/800 FULL at cooldown 1** (haulers queued
behind it); CTRL 639/800; hub 115.

The chain, each step measured:

1. **CTRL near-full gates the core.** The core→CTRL relay fires whenever
   CTRL has ≥ threshold free (LinkRunner), keeping CTRL topped (639/800);
   its only drain is upgrader work speed (~55–60 e/t). With CTRL free below
   threshold, the core cannot fire and holds energy.
2. **Core non-empty clamps the ports.** Empty only 26% of the time, fill
   avg 227 → port volleys land clamped (avg 378/800, half of all volleys).
   A clamped volley charges the FULL cooldown — effective port throughput
   collapses to ~half the ideal ceiling.
3. **The feeder races the ports for the same landing room.**
   `coreLinkTargetLevel = min(cap − CORE_LINK_INCOME_RESERVE, ctrlFree)`:
   when CTRL drains, the target jumps and the feeder LOADS the core from
   STORAGE — staging bank energy in the exact buffer the ports' waiting
   volleys need. Staged energy beats arriving energy. (This is the
   feeder-vs-relay race spec 26's P7 finding mapped by seam name; this spec
   supersedes that residue with the measured program.)
4. **Hauler cargo exceeds the landing quantum.** Deposit-route bodies carry
   978–1,851e into an 800-cap link (cee2 31C = 1,553e, d01f 37C = 1,851e):
   2–3 volley cycles standing at the port per trip even when nothing else
   is wrong.
5. Ports full → arriving haulers wait (`idleSinkAtSink`, storage-room-free)
   → per-trip removal barely exceeds mouth inflow → staged stocks stand →
   decay + pile-gate holds.

**Hypothesis verdicts** (owner's three): (a) links don't drain fast enough —
TRUE downstream (CTRL drains at upgrade speed; everything queues behind it);
(b) ports oversubscribed — **FALSE at ideal ceilings** (57/61.5 vs 31/30
assigned, ~2× paper headroom; total link inflow ≈ 58 e/t vs controller
demand ~60 — a SEQUENCING problem, not capacity); (c) core not empty when
ports are ready — **TRUE and dominant** (26% empty, 50% clamp).

## The sizing principle (owner 2026-08-05, verbatim doctrine)

> "It's important for the feeder to be big enough. They need to drain the
> core link pretty much on demand. Anytime an incoming link is imminent. It
> can't be a bottleneck. Between its programming and its size it has to do
> job well. Idle haulers are a form of waste. They're sized for full time
> moving."

Two creep classes, two sizing laws — do not blur them:

- **Haulers are sized for full-time moving.** Duty ~1.0 is their contract;
  every idle hauler tick is waste (H1's whole point). The network owes them
  a sink that is never blocked.
- **The feeder is a SERVICE creep.** Its metric is drain LATENCY, not
  throughput utilization: it must clear a full volley from the core before
  the next one lands, and its idleness between volleys is the price of
  hauler duty — cheap and correct. Sizing it to average relay flow is the
  bug class.

**Measured gap (t72787778): the live feeder is 4 CARRY / 4 MOVE = 200e.**
`parkedRelayCarry(effectiveBodyRate)` sizes it to sustain the average relay
flow on the parked 1-tile leg (~4 CARRY carries 60-80 e/t there — true and
irrelevant). Draining one 800 volley takes FOUR withdraw→transfer cycles
(~8 ticks even perfectly stationed) while two ports at 13/14t cooldowns
land volleys every ~7t on average. The feeder is quantitatively the
bottleneck the arrivals-first program would otherwise expose harder.

**The floor: with inbound senders on the core link, feeder CARRY ≥ one
full volley** (`LINK_CAPACITY / CARRY_CAPACITY` = 16 — both constants in
primitives; no new numbers). A 16C body stationed on the pivot tile
(adjacent to BOTH core (35,25) and storage (36,26) — e.g. (35,26)/(36,25))
clears a volley in ONE withdraw+transfer pair = 2 ticks without moving.
Seam: the feeder body sizing in `ControllerFeederCorp` (the
`parkedRelayCarry`/`carryPartsFor` branch, ~line 421) gains the volley
floor when `coreLink` has inbound senders (deposit ports or source links);
the plan prices the bigger body through the same commission envelope
(P4/F1 stay honest by construction).

## The fix, in order (no new constants)

**Principle: inbound energy outranks staged energy at every buffer.**

1. **LinkRunner — ports outrank the core relay for CTRL's free space.**
   Hold the core→CTRL relay fire while any other link stands loaded
   (≥ LINK_FIRE_THRESHOLD) and off cooldown: those links fire DIRECT to
   CTRL when it has room (fewer hops, one 3% tax instead of two, and PORT B
   is literally closer to CTRL than to the hub). The core relay becomes the
   fallback, not the competitor. Seam: `runLinks` order + a pending-sender
   check before the core→CTRL block; `routeSourceVolley` (pure, in
   `execution/linkRouting.ts`) already carries the capacity/range machinery.
2. **Feeder — load the core from storage ONLY when no inbound volley is
   pending, PRE-DRAIN when one is imminent, and size for the volley.**
   Three legs of one requirement (the sizing-principle section above):
   (a) the LOAD gate gains the arrivals-first condition; (b) the DRAIN
   direction fires proactively whenever any inbound link stands loaded or
   near-fire — target level effectively 0 ahead of arrivals, not reactive
   after the clamp; (c) the body floors at one full volley (16 CARRY) with
   inbound senders, stationed on the pivot tile. The drain/load
   target-level symmetry (`coreLinkLoadRoom`/`coreLinkDrainAmount`,
   spec 02/38 — do NOT disturb the phase-D valve or re-create the
   t72595372 walking-drain thrash; the feeder stays the sole operator) is
   kept. Seams: `ControllerFeederCorp.runLinkRouter` direction choice,
   `coreLinkLoadRoom`/`coreLinkTargetLevel` inputs, and the body sizing at
   the `parkedRelayCarry` branch (~line 421).
3. **Cap deposit-route hauler bodies at the landing quantum: 16 CARRY
   (800e).** One arrival = one unload intent (given port room) — the
   worthABody doctrine's cousin: match the actuator to the quantum it
   serves. Seam: route body sizing where `depositPos` is set (planner
   `maxCarryPerHauler` clamp for deposit routes; LINK_CAPACITY/CARRY_CAPACITY,
   both already in primitives).
4. **Re-measure, then stop.** If `coreEmptyShare` rises and clamping stops,
   the ideal ceilings are real and the ports carry ~2× headroom — no
   subscription margin needed. Only if clamping persists: debit
   `portRemaining` at a conservative effective throughput in the planner's
   port model (that is the LAST resort, and it is pricing again).

## Acceptance shape (write these first)

Unit pins (red-first):
1. `routeSourceVolley`/`runLinks` sequencing: a loaded off-cooldown port +
   CTRL with room ⇒ the port fires direct and the core relay HOLDS that
   tick; core relay fires only with no pending inbound sender.
2. Feeder load gate: `coreLinkLoadRoom` (or its call site) returns 0 while
   an inbound link stands loaded ≥ threshold — staged-vs-arrivals pinned.
   Drain-direction valve law unchanged (spec 38 conformance stays green).
2b. Feeder volley-service floor: with inbound senders on the core link the
   planned feeder body carries ≥ LINK_CAPACITY/CARRY_CAPACITY (16); without
   them the `parkedRelayCarry` law stands unchanged (bit-identical pin).
   Pre-drain: an imminent inbound volley (loaded link, cooldown ≤ its
   range-to-core) drives the drain target to 0 that tick.
3. Deposit-route body cap: a route with `depositPos` never plans a body
   over 16 CARRY; walking routes unchanged (X6 judges against the corp's
   own stamp — keep them consistent).

Live acceptance (the five gauges, before/after across ≥2 fiscal windows,
multi-draw rule applies):
- `coreEmptyShare` 0.26 → materially up (directional; register the exact
  prediction pre-deploy);
- `hubClampShare` 0.50 → near 0; `hubVolleyAvg` 378 → toward full volleys;
- `directShare` 0.277 → up (direct becomes the primary CTRL feed);
- per-corp `idleSinkAtSinkFrac` down at the seven deposit routes;
- E6 held-mouth count/heldFrac down; L1 mouth share of pile decay down
  (the ceil-floor share ~3.9–4.3 stays — that is spec 44's half).

Regression gate: full trio + unit; watch the spec-26 upgradeMeter
reset-roll residue when reading post-deploy windows (a meter spanning the
deploy poisons X1/workUtil).

## Trap notes for the implementing session

- RCL 7 = 4 links, all standing. Capacity expansion is not available until
  RCL 8 (6 links) — do not design around new structures.
- The engine clamps `transferEnergy` to the target's free capacity but
  charges `LINK_COOLDOWN × range` in FULL — partial volleys are the waste
  mechanism, not a harmless retry (already encoded in `routeSourceVolley`'s
  throughput rule; the sequencing fix must not regress it).
- CTRL is withdraw-only BY RULE (two-link ping-pong burns 3%/hop) — keep.
- `preferControllerDirect` is gated on the warchest (banked ≥ reserve via
  `resolveReserveTarget`) — production-first below the reserve is spec 26
  stage-2 law; arrivals-first sequencing must respect that gate, not
  replace it.
- Deposit-port assignment and `portRemaining` throughput debits live in the
  planner's storage-sink fill (CorpPlanner ~line 760+); the body cap is a
  SIZING clamp, not a flow clamp — flows are already port-bounded.


## The sequencing legs AS BUILT (2026-08-05, owner-directed)

Re-measured before implementing (t72805426, 249t window): the defect had
WORSENED against the diagnosis baseline — **hubClampShare 0.50 → 0.625**,
hubVolleyAvg 378 → 500 of 800, coreEmptyShare 0.26 → 0.276. Senders blocked
62% of the time while the receiver sat idle 28% of the time; a buffer cannot
be both saturated and idle, which is what makes this sequencing rather than
capacity.

**Leg 1 — `holdCoreRelay` (execution/linkRouting). BUILT WRONG, THEN
CORRECTED the same day — the wrong version is the more useful record.**

*v1 (wrong):* hold the relay whenever any port stood loaded and CTRL had
threshold room, justified on hop count and the 3% tax, per this spec's own
"ports outrank the core relay for CTRL's free space" framing.

*The owner's correction (2026-08-06):* "Leg 1 HoldCoreRelay is only good if
it increases throughput. Ie if the controller link is closer and empty
enough. It might be rare. Energy tax is less important." Chasing that down
found the rule was wrong in a way that FOUGHT ITS OWN SIBLING LEG:

- The core→CTRL relay is one of the core link's two DRAIN paths. Holding it
  keeps the core FULLER — exactly when leg 2 is emptying the core to give
  inbound volleys somewhere to land. The measured defect is hubClampShare
  0.625, ports clamped by a FULL core, so a rule that slows core drainage
  attacks the wrong side of it.
- The tax was never the argument, and the two paths do not even compete for
  the same cooldown: the port spends its own, the relay spends the core's.

*v2 (built):* what they DO contend for is CTRL's free space WITHIN ONE TICK,
and the engine makes that expensive in exactly one way — a transfer is
CLAMPED to the target's free capacity while `cooldown += LINK_COOLDOWN *
range` is charged IN FULL. So when a direct volley lands in CTRL this tick
and the relay fires into the remainder, the core pays its whole cooldown to
move a sliver and cannot drain again for LINK_COOLDOWN × range ticks — which
is precisely the landing room the arrivals needed. The rule is therefore the
SAME one `routeSourceVolley` step 4 applies to ports: never pay a full
cooldown for less than a worthwhile volley.

`runLinks` accumulates `incomingDirect` (energy direct fires land in CTRL
this tick) through the port loop and passes it to the hold. With no direct
fire inbound the rule reduces to the pre-existing behavior BIT FOR BIT — so
the warchest carve-out v1 needed is gone: policy never enters a purely
physical rule. And per the owner it should be RARE, firing only when a direct
volley genuinely crowds the relay out.

**Leg 2 — arrivals-first at the core buffer (corps/nodeEnergy).** Rather than
patching the load gate and the drain direction separately, the fix rides the
EXISTING symmetry: both directions read one target level, so
`coreLinkTargetLevel(..., inboundPending)` returning 0 delivers both legs at
once — `coreLinkLoadRoom` → 0 (stop staging into the landing zone) and
`coreLinkDrainAmount` → the whole store (PRE-drain, clearing it ahead of the
arrival). The loadRoom>0 XOR drainAmount>0 invariant is preserved by
construction and pinned; the phase-D valve law is untouched (this decides
WHEN the core holds staged energy, never how much the controller is
allocated). `coreInboundPending` is the detector: any non-core, non-CTRL link
loaded ≥ threshold and within `nearFireTicks` (1) of firing. It fails CLOSED
on partial mocks / unresolvable rooms — no evidence of an arrival is not an
arrival.

**Leg 3 — `depositRouteCarryCap` (economy/primitives).** A deposit route
unloads into a link port, so one arrival is one unload intent: CARRY beyond
LINK_CAPACITY/CARRY_CAPACITY buys standing time at the port, not throughput
(measured: 978–1,851e bodies into an 800-cap port, 2–3 volley cycles per
trip). Reuses `volleyServiceCarry()` rather than minting a second constant —
the unloading quantum and the feeder's draining quantum are the same physical
fact. Walking routes untouched. A SIZING clamp only; flows stay port-bounded
by the planner's `portRemaining` debit.

Safe against the deadlock class: CarryCorp's swarm cap has been denominated
in CARRY rather than count since 2026-08-02 for exactly this reason, so
smaller-than-planned bodies cannot satisfy a count gate at a permanent carry
deficit. X6 judges bodies ABOVE the route need, so a downward clamp cannot
trip it.

### Registered predictions (from t72805426)

- `hubClampShare` 0.625 → toward 0; `hubVolleyAvg` 500 → toward full 800.
- `coreEmptyShare` 0.276 → materially UP (an empty core is the goal now: it
  is landing room, not idleness — read it WITH the clamp share, never alone).
- `directShare` 0.25 → up (leg 3's smaller deposit bodies clear ports faster,
  so ports stand loaded less often); `taxRate` 3.37 → down as a SIDE EFFECT,
  never as the goal (owner: "energy tax is less important").
- Deposit-route hauler bodies ≤ 16 CARRY; per-corp `idleSinkAtSinkFrac` down
  at the seven deposit routes; H1 `atSink` (0.05) down.
- E6 held-mouth count/heldFrac down; L1 mouth share of pile decay down (the
  ~4.2 ceil-floor share stays — that is spec 44's half).
- NOT predicted to move: H1's `enRoute` 0.21. That is spec 47's un-localized
  approach-lane signal and it is a DIFFERENT failure; if it falls anyway,
  the two were coupled and that is itself a finding.
