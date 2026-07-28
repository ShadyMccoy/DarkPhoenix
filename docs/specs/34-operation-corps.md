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
  else grace → recycle), tankers → CORP-DRIVEN recycle (`memory.recycling`;
  the squad walks them out, banks cargo, refunds the body). Tankers skip
  the orphan path deliberately: no rescue exists for them by design, and
  the first cut (a release sentinel through OrphanRescue) FROZE them for
  the 25t grace wherever they stood — measured as fid-t4-synthetic's
  refill-SLA breach at t1091, deterministic across draws, a released tanker
  parked dead on the tender's refill-approach tile. The tender-rescue of
  construction tankers is RETIRED (extensionTenderKind.claimsOrphan is
  gated on `isTenderCreep`, returning corp.id — never the commission store
  key, the frozen-stale-tender incident). Two boundary rules, all pinned in
  `cohortRelease.test.ts`: DEFUND (allocation → 0, sites standing) never
  releases, and — the refinement D6 forced — a mid-operation WANT DIP never
  releases either: the home pool corp's want is a re-solve PRICE, and
  releasing on its dip stranded a standing 2W builder as a frozen orphan
  holding 80 energy (measured in the cell, want 2→1 at a site completion).
  Home corps release ONLY through the operation-end cohort; remote stint
  corps keep the immediate local hand-off (their want is a stable local
  signal — the original hand-off incident).
- **`builder-buffer-feed` grid cell** — green at 91–92% workUtil across
  four draws (floor 0.9), zero fuel trips, fed-idle 0. Building it surfaced
  THREE fidelity gaps; two are fixed, the third is measured and queued:
  1. **Parked burn** (fed-idle was 73% of all idle): the full-refill toggle
     made a vector-fed builder wait for a FULL store while the tanker
     dribbled its buffer. Now: while the corp fields live tankers, the
     builder builds on ANY held energy and holds its post when dry
     (`parkedBuilderBurn.test.ts`); fetch worlds keep the toggle verbatim.
  2. **The operation-end release gate** (the D6 refinement above): fed-idle
     1480 → 0.
  3. **The vector-gait tension — measured, OPEN** (see the open item
     below): the residual ~8% is starvation from the 3C:1M carrier's laden
     gait (3 t/tile → real RT ≈ 2× the priced `roundTripTicks`).

**LANDED 2026-07-28 (third tranche — the producer mirror, owner go):**

- **D5 second half — the MINER OPERATION.** A mined source is ONE harvest
  commission carrying `{miner, routes}` with `spawnPartsPerTick =
  minerSpawnLoad(d) + Σ routed spawnParts` (the planner's own per-route
  parts, paved discounts and deposit legs included) — the two-envelope
  double-declaration (nominal estimate on harvest + routed truth on carry)
  is gone. The harvest kind fields the whole operation: hauler role moved
  in (`deliversEnergy` intact), bodies via the same ratio-hauler formula,
  and HarvestCorp runs the vector through an internal CarryCorp engine
  sharing the operation's id (workType separates the squads — the
  construction builder/tanker pattern; every haul behavior/gate/policy
  verbatim). Boundary rulings (owner): link-served = haul-of-zero (routes
  [], price = node alone); minerless scavenge stocks keep the standalone
  carry path; bank routes stay uncommissioned. `Corp.innerCorps()` is the
  metering hook that keeps the engine's plan-vs-actual row in
  Memory.corpVariance (flow-handoff's hand-off probe enforces it).
  Gate: unit 1591 green (golden master deliberately regenerated),
  integration trio green, full grid 125/130 — the fifteen first-run reds
  were stale cell DETECTORS (cells watched for the retired "hauling-"
  stamp; operation haulers stamp "mining-…"), modernized and re-verified
  per class; remaining reds are the pre-existing set (the two #143 master
  regressions, exp-t5's known timeout, and the batch-marginal refill-SLA
  class below).

**LANDED 2026-07-28 (P4 ledger consistency):** construction is charged
THROUGH the plan's all-in price, end to end, by ECHO (the v8
hauler-spawnParts pattern - one derivation, zero re-computation):
`consumerSpawnLoad` in commissionPlan is the ONE formula (envelope and
adapter share it; golden master byte-identical), the adapter stamps
`spawnLoad`/`spawnDist` on construction sink allocations, the flow segment
echoes them (v11), and the waste ledger's P4 table gains the
"construction (all-in)" line - legacy captures without the echo emit no
line (no fabricated figures). The wrapper honesty landed with it:
`constructionKind.propose` sums its room's build-commission prices instead
of declaring 0 (own-room only - a pooled spawnless room's price rides its
own wrapper, exactly as its energyRate does). Passive per the spec-36
instrument precedent: unit 1594 green + trio green.

**ATTEMPTED AND REVERTED 2026-07-28 (the earned reservation — owner: "a
fallback we don't need. What we want it's just to make sure that the
builder does its job and is sized correctly"):** the resume valve
(`shouldDrainDedicatedSource` + the drain gates in `yieldsToBuild`) was
deleted and the reservation gated on an earned-consumption gauge
(`dedicationJustified`, two cuts: pool absorb alone, then min(standing
burn, absorb)). The grid then demonstrated, one measurement at a time,
that always-dedicate + valve is a FOUR-legged coupled regime, and each
cut broke a different leg's dependents:
1. absorb-only gauge → runt-economy froze the cold ramp (container sites
   ~15k work justified reserving the near source for a 1-WORK crew; the
   source hoarded, extensions never filled, the 2-WORK miner never
   upsized in 1200t). Doctrine names it: consumers sized from ACTUAL
   capability, never the goal plan.
2. min(burn, absorb) gauge + valve deleted → the refill-SLA class
   breached DETERMINISTICALLY (haul-t4-refill-sla @211: the "dedicated"
   source's container was staged at 75%, so under the old code the valve
   had kept its haulers running the whole time — the cell's tuned income
   stream) and fid-t5-real-maze collapsed 50→16% gross. The valve is the
   consumption-lag lens: standing WORK is capability, not throughput.
3. valve restored, gauge kept → fid-t4-preramped STILL breached @239:
   with reservations refused, the tankers' least-loaded fallback spread
   across BOTH sources (the old always-dedicate had confined the siphon
   to one) and UpgradingCorp.effectiveAllocated's (n-1)/n damping never
   engaged — the tender crawled at spawn self-regen after a volley.
Per the trap-list rule (second patch on the same mechanism = interrogate
the mechanism; this was heading for a fifth), the gauge was REVERTED to
always-dedicate + valve — the measured-good regime — same day. KEPT from
the attempt, independently verified: (a) NEED-FIRST tanker dispatch
(closest-only starved a parked builder at ZERO for its whole life while
micro-dripping a container-adjacent self-refueler; builder-buffer-feed
91-92% → 95-99% workUtil with 3C:1M unchanged), (b) the SITE-NEAREST
tanker-source fallback for un-reserved builds (the least-loaded spread's
siphon-everything pathology, measured in fid-t4-preramped), (c) the
groundpile cell staging fix (the #143 red's root cause), (d) this
investigation — the redesign fork now lives in open item 5 with all the
measurements.

**OPEN, in order:**

1. **Further kinds into the interface** (as encountered, not speculatively):
   the feeder IS a 1-tile vector; tender/scout/reserver declare
   `spawnPartsPerTick: 0` today — same honesty pass as D4 when their pricing
   matters to a real decision.
2. ~~Operation-end release traffic vs the refill SLA~~ **RESOLVED
   2026-07-28 (owner ruling: cut the contract's over-reach, don't fix the
   bot)** — the breaches were the SLA rider punishing behavior that is
   correct: (a) a 1-tick 44-short dip at t1091 while the released build
   cohort recycled through the spawn cluster - deliberate fleet
   restructuring, not a refill failure; (b) a 2-energy crumb deficit at a
   deadline (violation anatomy: deficit=2, nearFuel=2120, five tank-role
   creeps standing) - a spawn-remainder residue the +1/t regen erases,
   which a 400-carry tender SHOULD ignore. The rider gained two precision
   clauses, both measured: a RELEASE-WINDOW carve-out (exempt while a
   construction-family creep is recycling, sticky through the shortfall
   episode) and a DE-MINIMIS floor (deficit must reach one extension-load,
   50, to violate - a smaller sum means every drained extension got its
   delivery). The owner design questions the old item queued (recycling
   carriers shedding into extensions; between-RCL pause as operation end)
   are no longer forced by anything and stand withdrawn unless the
   phenomena resurface. haul-t4-refill-sla-under-churn 3/3 green after
   both clauses; the class's historical flakiness is explained by the
   crumb anatomy. RESIDUAL: `plan-t5-remote-pipeline` went 0/3 red under
   the honest tanker sizing (deficits 70/160/200 - MULTIPLE whole
   extensions outstanding, a loaded tender idling 10+ tiles out) - not a
   contract problem: the correctly-sized construction volleys expose that
   world's tender apparatus as genuinely thin (the old green rode on an
   under-provisioned fleet leaving more bank margin). Owner 2026-07-28:
   ACCEPTED as a tracked red pending a tender-latency/capacity look -
   "let's get it closed out and move forwards". (The rider's
   construction-cargo fuel exclusion also carried the stale
   "construction-" id prefix - the trap-list drift - fixed to cover
   "building-".)
3. ~~The vector gait (carrier body vs priced RT)~~ **RESOLVED 2026-07-28
   (owner ruling: "the sizing formula should be made to be correct
   regardless of the carry:move ratio. Also, it should be road-aware")** —
   `tankerCarryNeededFor` now sizes the fleet through the SAME gait lens
   the road economics use (`effectiveOneWayTiles`: empty leg full speed,
   loaded leg per-tile for the body's ACTUAL ratio over the route's paved
   fraction), with the ratio constant exported from buildTankerBody so
   formula and body cannot drift, and paving read by sampling BUILT road
   structures on the site-fuel line (deliberately NOT roadRoutes receipts,
   per the trap list - staged roads in a cell exercise it). The builder's
   buffer interval reads the same effective distance; supplyMethod keeps
   raw tiles (its direct-draw verdict is geometric adjacency). Unit-pinned
   (6 hand-derived cases; a 3:1 unpaved fleet sizes ~2x the old formula).
   Battery: buffer-feed 98-99%, maze 43% (the demand-shape canary did NOT
   collapse), preramped 101%, fid-t4-synthetic 62% x2, SLA-churn 3/3 with
   the item-2 rider precision. History for the record: the 91-92%
   "gait starvation" was mostly the closest-only DISPATCH bug (need-first
   fix); the 1:1 body switch remains falsified (maze collapse via
   demand-shape, scheduler facts recorded in git history of this item) -
   BUT owner 2026-07-28: "The maze experiment had issues due to the
   energy constraints. Might be poorly designed" - treat the maze's
   falsifications as PROVISIONAL (an energy-constrained world can
   manufacture demand-shape cliffs that say more about the cell than the
   bot); a maze-world redesign is a candidate if the 1:1 question
   reopens. RATIO-CHOICE optimization stays explicitly OUT OF SCOPE per
   the same ruling. Follow-ups: a staged-roads organic-fleet acceptance cell
   (road-aware sizing's grid pin - the sampler currently rides fixture
   worlds' roads only), and the plan-side vector PRICE
   (consumerSpawnLoad's vectorSupplyParts) still prices 1:1-laden-both-
   ways - aligning it to the gait lens is a golden-master regeneration,
   deliberate not incidental.
4. ~~Fidelity measurement integrity (EconWatch)~~ **LANDED 2026-07-28**:
   plan cached across glitch ticks + sticky haul lens (a parsed-but-empty
   plan still counts as the real re-solve gap). Recalibration, three draws
   each, IDENTICAL per world (the glitch noise is gone): fid-t4-preramped
   98/98/98% gross (19.6 vs 20.0 e/t - the July 65-72% calibration's ~30%
   transport/decay gap has shrunk to ~2% under this session's parked-burn +
   release fixes; floor ratcheted 0.55 → 0.85 per the cell's charter),
   controller 22%, carry 64%; fid-t5-real-maze steady at 51/50/56-57%
   (floors untouched - organic-ramp floors stay loose by design).
5. **Planner-owned dedication (the spec-25 completion, pre-hub)** — the
   dedication regime remains runtime room memory; the PLAN still doesn't
   know. The 2026-07-28 attempted retirement (see the ATTEMPTED AND
   REVERTED entry above) established by measurement that the regime is a
   FOUR-legged coupling switching on `dedicatedBuildSourceId` together:
   the stand-down, the drain valve (the actual-consumption lens), the
   tanker source pinning, and the upgrader (n-1)/n damping. Any
   replacement must re-provide all four functions — a corp-side gauge
   swap alone broke a different leg's dependents on each cut
   (runt-economy cold freeze; refill-SLA class; preramped tender crawl).
   Measured consequences that remain today: the solver routes the
   dedicated source's output to ordinary sinks (a plan-vs-actual phantom
   while any reservation holds), and the site supply leg is represented
   twice (a haul route on the source's operation AND the consume
   commission's tanker vector, different distance bases, one physical
   job — the tankers execute, the routed haulers are gated). The clean
   home mirrors hub-era emergent dedication: the construction sink's
   fill IS the reservation (sized by the plan to what the crew actually
   sustains — the wartime-relegation lens supplies the upgrader damping
   plan-side), the source's home routes carry only the residual (the
   valve dissolves into routing), and tanker sourcing follows the fill's
   nearest-first choice. FORK FOR THE OWNER before starting: pre-hub the value
   ladder runs controller 80 > construction 70, so a construction
   pre-pass that claims the nearest source ahead of the controller fill
   changes ladder semantics — the exact class the 90-vs-85 founding
   incident warns about. Needs an owner ruling on where construction's
   claim slots pre-hub; do not nudge a value in isolation.

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
