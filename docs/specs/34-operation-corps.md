# 34 — Operation corps: the corp as economic interface

**Status:** ACTIVE (owner direction 2026-07-27). Extends the ONTOLOGY §4/§5
corp contract; supersedes nothing — it TIGHTENS the existing Commission
envelope until every corp fits it honestly.

## The thesis (owner, 2026-07-27)

> "Corps are useful abstractions that have simple interfaces and faithfully,
> with the necessary sophistication and nuance, work to achieve that in the
> actual Screeps world. This allows the planning engine to reason over the
> corp abstractions and accomplish its goals."

Three clauses, three obligations:

1. **Simple interface**: a corp presents itself to the planner in the
   planner's language — positions, rates, ALL-IN spawn cost. `Commission`
   already IS this shape (`consumes {energyRate, at, spawnPartsPerTick}`,
   `produces {energyRate, at, valuePerTick}`). Nothing new to invent; the
   work is making every corp fill it truthfully.
2. **Faithful**: measured actual ≈ declared interface. Plan-vs-actual
   (fid-* cells, ledger P-lines) is the enforcement: it stops being "how is
   the economy doing" and becomes "is each abstraction telling the truth."
3. **Sophistication inside**: refuel trips, buffers, replacement lead,
   cohort recycling — invisible above the interface. "Spawn a miner" means
   spawn a minerCorp: the whole operation, internals included.

Corollaries the owner pinned in discussion:

- **A haul corp is a vector**: `(from pos, to pos, rate e/t)`. Everything
  else derives. There is NO shared haul fleet — every hauler serves a
  specific vector. A vector exists ONCE; endpoints reference it, never copy
  it (double-instantiation = the double-count bug class).
- **A builder is a consumer exactly like an upgrader** — the difference is
  MOBILITY, and mobility decides where the buffer lives: static consumer →
  infrastructure buffer (container/link); mobile consumer → onboard CARRY.
- **Route of length 0**: a consumer adjacent to its fuel needs no vector at
  all — it withdraws directly. The degenerate case, not a special one.
- **Cohort lifecycle** (side effect, not goal): an operation's creeps
  release/recycle TOGETHER when the operation ends — no half-useful strays.
  NOTE the trap-list boundary: cohort death happens at operation END (work
  complete), never as a scarcity response (defunding acts at the SPAWN; a
  rule that strands standing fleets is the revocation class).

## The game constraints (what physically drives the design)

| # | Constraint (engine constant) | Design force |
|---|---|---|
| C1 | `BUILD_POWER = 5` e/t per WORK; `UPGRADE_CONTROLLER_POWER = 1`; `HARVEST_POWER = 2` | Builders are **burn-dense**: one builder WORK drains 5× an upgrader WORK. A builder's buffer empties 5× faster → refuel logistics dominate the build economy in a way they never do for upgrading. |
| C2 | `CARRY_CAPACITY = 50`; part costs WORK 100 / CARRY 50 / MOVE 50 | One CARRY part buffers 10 tick-WORKs of building (50/5) but 50 of upgrading. Buffer sizing must be rate-derived, never a fixed ratio. |
| C3 | **Fatigue: empty CARRY generates none.** Laden CARRY = 2 fatigue/tile like any part; each MOVE clears 2/tick; roads halve, swamps 5× | "Travel unladen" is FREE buffer transport (owner's rule). A mobile consumer relocating empty needs MOVE for WORK only. But SELF-FETCHED fuel comes back LADEN — self-fetch pays MOVE for its CARRY; route-fed delivery does not (the builder's buffer is refilled in place). |
| C4 | `MAX_CREEP_SIZE = 50` parts | Bounds WORK+buffer+MOVE in one body. A crew that needs more splits (`splitIntoMembers`) — the multi-member squad is the pressure valve, unchanged. |
| C5 | `CREEP_LIFE_TIME = 1500`; spawn = 3 ticks/part (`0.333` parts/t ceiling per spawn) | Spawn build-time is THE scarce currency (ONTOLOGY §2). Every design choice is priced in parts/tick amortized over `effectiveLife(distance)` — the ONLY honest comparator between methods. |
| C6 | Build/upgrade range 3; transfer/withdraw range 1 | Refueling requires ADJACENCY: a hauler must physically reach the consumer (or its pile/buffer structure). Range-3 build means several bodies ring one site without blocking. |
| C7 | Container: 5,000 energy to build, decays (needs repair upkeep) | An infrastructure buffer costs ~a whole extension's energy and rots. For a TRANSIENT consumer (a build site consuming 3–30k total) a container can cost more than the project — this is WHY mobile consumers buffer on the body (owner's insight, now derived, not asserted). |
| C8 | Storage at RCL4; links at RCL5 (800 cap, 3% tax, cooldown) | The static consumer (controller) graduates buffers: pile → container → link. The mobile consumer never graduates — CARRY is its terminal buffer form. |

## Derived design decisions

**D1 — Supply method is a COMPUTED crossover, not a category.** Compare, in
spawn-parts/tick per delivered e/t (C5), the two ways to keep a consumer fed
at distance `d` from fuel:

- **Vector-fed**: a dedicated haul vector `(fuel, site, rate)` costs
  `2·carryPartsFor(rate, d)` standing parts (CARRY+MOVE at 1:1), and the
  consumer carries only a small buffer bridging the delivery interval.
- **Self-fetch**: the consumer's own round trips. Its WORK idles during the
  trip (utilization `u = T_build/(T_build + roundTrip)`), so delivering the
  same effective rate needs `1/u` times the WORK — at 100e/part, WORK idle
  is the most expensive waste in the game — plus laden-return MOVE for its
  CARRY (C3).

Worked at the optimum (`T_build* = √(10·RT)`, minimizing total parts): for
rate 10 e/t at d=8, self-fetch ≈ 22 parts vs vector ≈ 12; even at d=2 the
vector wins (~13 vs ~7). **The crossover sits at adjacency**: only `d ≈ 0–1`
(withdraw range, C6) favors direct draw — the owner's "route of length 0."
This mirrors the game's own meta (static miner + hauler beat mobile
harvesters, same math). So: consumers ALWAYS buffer onboard sized to their
refuel interval; the supply is a real vector whenever fuel is beyond
withdraw-adjacency, and nothing at all when adjacent.

**D2 — The onboard buffer formula (one primitive, all consumers).**
`bufferCarryParts(burnRate, intervalTicks) = burnRate · interval / 50`.
The interval is the refuel cadence: `roundTripTicks(d) / nHaulers` for a
vector-fed consumer, `PARKED_RELAY_CYCLE_TICKS (2)` for a parked one —
making the feeder's existing `parkedRelayCarry` the degenerate case of the
same law (`parkedRelayCarry(rate) ≡ bufferCarryParts(rate, 2)`). This is the
owner's builder formula verbatim: WORK parts (burn), distance (round trip),
haulers on the route (divisor).

**D3 — Builder body = WORK + buffer CARRY + MOVE-for-unladen.** MOVE sized
to the WORK core (empty CARRY free, C3); laden movement is only site hops
(short, rare) and the vector delivers in place. Retires the fixed
`buildUpgraderBody(cap, 2)` shape for builders.

**D4 — The commission price is ALL-IN.** A corp's declared
`spawnPartsPerTick` covers its node bodies AND its operated vectors —
`constructionKind.propose` currently declares `spawnPartsPerTick: 0` while
fielding builders+tankers (the ledger prints them as "unbudgeted"; P4
measured the class). The honest price derives from primitives only:
`constructionWorkSpawnLoad(rate, d) + vectorSpawnLoad(rate, d_fuel)`.
Faithfulness (thesis §2) starts with not lying about cost.

**D5 — The vector exists once, owned by the operation it serves.** The
consumer corp OPERATES its inbound supply vector (spawns/runs its carriers
as internal squads — the subcontract); the planner sees only the all-in
price (D4). The producer corp operates its outbound evacuation the same way
(minerCorp end state: harvest + carry as ONE commission — a follow-up
registration, this spec lands the consumer half). No vector appears twice.

**D6 — Cohort release at operation end.** When the operation's work is DONE
(pool drained, not defunded), every squad releases the same tick: builders →
`claimsOrphan` adoption (exists); vector carriers → release → grace →
recycle refund. No creep outlives its operation "by accident" (owner). The
existing per-generation replacement (`staffsPost`) is untouched — an
ongoing operation rolls generations normally.

## Acceptance tests (the contract — write first)

Unit (primitives — pure, `test/unit/economy/`):
- `bufferCarryParts`: rate 25 @ interval 10 → 5 CARRY; degenerate
  `bufferCarryParts(r, 2) ≡ parkedRelayCarry(r)` to 1e-9 (D2).
- `refuelIntervalTicks(d, n)`: RT/n, n=0 → self-cadence (the consumer's own
  round trip), monotone in both.
- `supplyMethod(rate, d)`: adjacency (d≤1) → "direct"; d≥2 → "vector"
  with vector parts < self-fetch parts at the measured example points
  (rate 10: d=8 ≈ 12 vs 22; d=2 ≈ 7 vs 13) (D1).
- `operationSpawnLoad`: all-in = node load + Σ vector loads; construction's
  equals `constructionWorkSpawnLoad + vector` exactly (no third formula).

Unit (corps):
- Builder body: WORK from absorb, CARRY = `bufferCarryParts(work·5,
  interval)`, MOVE = ceil(WORK/2)+1 unladen-sized; never exceeds 50 parts
  (C4 → split proof via `splitIntoMembers` unchanged).
- `constructionKind.propose` commission carries the all-in
  `spawnPartsPerTick > 0` whenever it fields anything (D4), derived from
  primitives (conformance envelope).
- Cohort release: pool drained → every member released same tick; defund
  (allocation → 0 with work standing) does NOT release (trap-list class).

Grid:
- `builder-buffer-feed`: staged site + storage at d≈8 with a live vector;
  assert workUtil ≥ 0.9 (buffer bridges deliveries) and NO builder trip to
  the fuel (unladen-travel rule only between sites).
- Existing `wartime-build-eats-surplus` (spec 33) inherits the new sizing.

Regression: unit + trio; P4 ledger line stops printing construction bodies
as unbudgeted once D4 lands.
