# Spec 45 — Arrivals-first link sequencing (remove the sink wait, don't price it)

**Status: MEASURED DIAGNOSIS 2026-08-05 (owner-directed); red-first design
ready, implementation is the next session's first work item.** Owner framing:
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
   pending.** The drain direction and target-level symmetry
   (`coreLinkLoadRoom`/`coreLinkDrainAmount`, spec 02/38 — do NOT disturb
   the phase-D valve or re-create the t72595372 walking-drain thrash; the
   feeder stays the sole operator) is kept; only the LOAD gate gains the
   arrivals-first condition. Seam: `ControllerFeederCorp.runLinkRouter`
   direction choice + `coreLinkLoadRoom` inputs.
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
   Drain direction unchanged (spec 38 conformance stays green).
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
