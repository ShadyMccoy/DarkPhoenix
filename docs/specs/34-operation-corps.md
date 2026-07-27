# 34 — Operation corps: the corp as economic interface

**Status:** ACTIVE (owner direction 2026-07-27). Extends the ONTOLOGY §4/§5
corp contract; supersedes nothing — it TIGHTENS the existing Commission
envelope until every corp fits it honestly.

## Landed / open (the backlog, pick-up-cold order)

**LANDED 2026-07-27** (commits 71a6b59 + the unladen-relocation follow-up,
deployed): the primitives family (`bufferCarryParts`/`refuelIntervalTicks`/
`vectorSupplyParts`/`directFetchParts`/`supplyMethod`/`operationSpawnLoad`),
the parked buffered builder (D1–D3b: body honors demand, buffer from fuel
geometry, tanker adjacency gate, shed-before-cross-room-leg), and the all-in
construction commission price (D4, both charge sites, golden master regen).
ONTOLOGY §3 records the family.

**LANDED 2026-07-27 (second tranche — the fidelity session):**

- **D6 — cohort release at operation end.** `releaseCohortAtOperationEnd`:
  the pool drained past `OPERATION_END_CONFIRM_TICKS` (2× the placement
  cadence, so a between-rungs gap never fires it) releases every squad the
  same tick — builders → the adoption marker (`claimsOrphan` → next corp,
  else grace → recycle), tankers → `RELEASED_TANKER_CORP_ID` → grace →
  recycle refund. The tender-rescue of construction tankers is RETIRED
  (extensionTenderKind.claimsOrphan is gated on `isTenderCreep`). Two
  boundary rules, both pinned in `cohortRelease.test.ts`: DEFUND (allocation
  → 0, sites standing) never releases, and — the refinement D6 forced — a
  mid-operation WANT DIP never releases either: the home pool corp's want is
  a re-solve PRICE, and releasing on its dip stranded a standing 2W builder
  as a frozen orphan holding 80 energy (measured in the cell, want 2→1 at a
  site completion). Home corps release ONLY through the operation-end
  cohort; remote stint corps keep the immediate local hand-off (their want
  is a stable local signal — the original hand-off incident).
- **`builder-buffer-feed` grid cell** — green at 98–100% workUtil across
  four draws (floor 0.9), zero fuel trips, delivery detected ~t21. Building
  it surfaced and fixed THREE fidelity gaps, in order of discovery:
  1. **Parked burn** (fed-idle was 73% of all idle): the full-refill toggle
     made a vector-fed builder wait for a FULL store while the tanker
     dribbled its buffer. Now: while the corp fields live tankers, the
     builder builds on ANY held energy and holds its post when dry
     (`parkedBuilderBurn.test.ts`); fetch worlds keep the toggle verbatim.
  2. **1:1 vector carriers**: the CARRY-heavy 3C:1M tanker walked its laden
     leg at 3 t/tile — real RT ≈ 2× the `roundTripTicks` the sizing priced,
     so the fleet under-delivered its own vector (starvation valleys,
     starved 500 → 30 after). Construction tankers now field
     `buildRatioHaulerBody 1:1`, the gait `vectorSupplyParts` prices ("the
     vector IS carryPartsFor"); the tender keeps CARRY-heavy where the duty
     cycle really is parked. bodyEquivalence pins the supersession.
  3. **The operation-end release gate** (the D6 refinement above): fed-idle
     1480 → 0.

**OPEN, in order:**

1. **minerCorp — the producer-side mirror (D5 second half).** "Spawn a
   minerCorp": harvest + its evacuation vector as ONE commission with ONE
   all-in price (`operationSpawnLoad(minerOverhead, [vector])`), the carry
   squad an internal detail of the harvest kind. Registration-only (spec 17);
   the consumer half landed first, this is the same move on produce.
2. **P4 ledger consistency**: the waste ledger's plan-implied parts should
   read the construction charge THROUGH the all-in price (it now exists in
   the plan) so "unbudgeted" construction bodies disappear from the detail
   line for the right reason.
3. **Further kinds into the interface** (as encountered, not speculatively):
   the feeder IS a 1-tile vector; tender/scout/reserver declare
   `spawnPartsPerTick: 0` today — same honesty pass as D4 when their pricing
   matters to a real decision.
4. **Fidelity measurement integrity (EconWatch)**: the fid-* accumulators
   read the bot's exported memory PER TICK (workType lens, plan sums); the
   builder-buffer-feed calibration measured ~13% of samples with
   unparsable/partial memory, which silently drops the plan-side sums those
   ticks and INFLATES the gross ratio. Fix = the sticky-identity idiom the
   cell now uses (a name that ever read a workType keeps it) plus caching
   the last parsed plan across glitch ticks. Ratios will move (honestly,
   mostly down) — recalibrate the fid floors from fresh multi-draw runs in
   the same commit; do not mix into an unrelated landing.

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
| C3 | **Fatigue: empty CARRY generates none.** Laden CARRY = 2 fatigue/tile like any part; each MOVE clears 2/tick; roads halve, swamps 5× | "Travel unladen" is FREE buffer transport (owner's rule). A mobile consumer relocating empty needs MOVE for WORK only — and the owner's relocation rule follows: **empty the carry before a longer leg** (`shedLoad`: hand-off to an adjacent store, else drop; drop+move share a tick, so it's free). The laden-walk cost is also half of why self-fetch loses (D1). |
| C4 | `MAX_CREEP_SIZE = 50` parts | Bounds WORK+buffer+MOVE in one body. A crew that needs more splits (`splitIntoMembers`) — the multi-member squad is the pressure valve, unchanged. |
| C5 | `CREEP_LIFE_TIME = 1500`; spawn = 3 ticks/part (`0.333` parts/t ceiling per spawn) | Spawn build-time is THE scarce currency (ONTOLOGY §2). Every design choice is priced in parts/tick amortized over `effectiveLife(distance)` — the ONLY honest comparator between methods. |
| C6 | Build/upgrade range 3; transfer/withdraw range 1 | Refueling requires ADJACENCY: a hauler must physically reach the consumer (or its pile/buffer structure). Range-3 build means several bodies ring one site without blocking. |
| C7 | Container: 5,000 energy to build, decays (needs repair upkeep) | An infrastructure buffer costs ~a whole extension's energy and rots. For a TRANSIENT consumer (a build site consuming 3–30k total) a container can cost more than the project — this is WHY mobile consumers buffer on the body (owner's insight, now derived, not asserted). |
| C8 | Storage at RCL4; links at RCL5 (800 cap, 3% tax, cooldown) | The static consumer (controller) graduates buffers: pile → container → link. The mobile consumer never graduates — CARRY is its terminal buffer form. |

## Derived design decisions

**D1 — The builder is a PARKED consumer (owner doctrine), and the math
proves the doctrine.** "Builders don't MOVE the energy. They stay in one
place building" (owner, 2026-07-27). The builder never makes fuel trips —
"a hauler brings them energy, unless it's already adjacent to an energy
source like a container or a link." So there are exactly two supply modes:

- **Vector-fed (default)**: a dedicated haul vector `(fuel, site, rate)` at
  `2·carryPartsFor(rate, d)` standing parts delivers TO the parked builder;
  its onboard buffer bridges the delivery interval.
- **Direct draw (route of length 0)**: parked within withdraw range (C6) of
  an energy structure — container, link, storage — the builder withdraws in
  place. No vector, near-zero buffer.

Self-fetch is NOT a mode — `directFetchParts` exists only as the priced
counterfactual proving why: the fetcher's WORK idles for the round trip
(needs `1/u` the fleet at 100e/part — the game's costliest idle) and its
CARRY returns laden (C3). At the fetch-optimal cycle (`T* = √(50·RT/w)`):
rate 10 at d=8 → ≈22 parts vs the vector's ≈12; even d=2 loses. The same
math that made static-miner+hauler the game's meta. The `supplyMethod`
verdict therefore lands exactly on the owner's rule — vector everywhere
beyond withdraw-adjacency — but as a COMPUTED verdict the corp reads, not
a category baked in.

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

**D3b — Unladen relocation (owner rule).** "When they move to the next site
they empty their carry if necessary for longer routes": before a cross-room
leg the builder SHEDS its load (`shedLoad` — adjacent store hand-off, else
drop; drop+move are different action groups, zero-tick cost), then walks at
WORK-only speed (~0.8 tiles/t vs ~0.3 laden for the buffered body). Short
in-room hops keep their load (dumping there wastes more than it saves).
Landed in both cross-room branches (runBuilder + doBuild's founding walk),
pinned by `builderUnladenRelocation.test.ts`.

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
