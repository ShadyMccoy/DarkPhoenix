# REBOOT — the v2 rewrite (2026-08-18)

**Owner decision 2026-08-18: "I'm ready to blow it up and start over."** The
codebase — not the colony. The live bot keeps running the last v1 build from
`master` untouched; this branch line rebuilds the bot from an empty `src/`.
Everything below is the why, the boundary, and the ladder.

Revised later the same day in planning conversation with the owner — the
dated rulings quoted through this document are that conversation's record,
and the working agreement at the bottom governs how milestones proceed:
**acceptance criteria are agreed with the owner before code is written
toward them.**

## Where the old world lives

Nothing is lost. The full v1 tree (131 src files / ~45k lines, 288 test
files / ~64k lines) remains:

- on `master` — the deployed, live bot; still the thing running on shard1
- in git history of this branch (the demolition commit's parent)
- readable any time: `git show master:src/economy/primitives.ts` etc.

`docs/` survives **in place** as the learning archive: ONTOLOGY, the 60+
specs, the fiscal closes, and spec 14's session records describe v1 and are
the reference library for v2 decisions. They are records now, not law — v2
law starts in this file.

## The disease (named from v1's own records, not vibes)

v1 was not failing at Screeps. It reached RCL8 and GCL 32, founded rooms
autonomously, and closed fiscal months at 100% coverage. What it was failing
at was **cost of change**. The owner's naming of it (2026-08-18): *"We kept
thrashing with corporations that didn't have the right size bodies. That
should've been a fundamentally solved issue. How come we have 64k lines of
tests, but none of them seem to catch this?"*

**Body sizing is the emblematic case.** The record shows the same defect
landing repeatedly at new sites — haulers sized to spawn capacity instead
of route (#148), the runt-miner equilibrium (spec 01), tanker
over-provisioning (2026-07-27), a 24-CARRY hauler bought for a 1.7-CARRY
route (X6, 2026-08-14, *after* the #148 fix) — while the test estate
stayed green throughout. Why it missed, structurally:

- **Tests pinned intentions, not economics.** A sizing test asserted the
  code computed what the formula said. When the formula was the bug, the
  test certified the bug — every wrong sizing rule shipped with a green
  test enshrining it.
- **Sizing derived in many places, so no test could own it.** Each corp
  kind sized its own bodies from its own inputs; route, income, duty and
  spawn capacity were never one function's job, so nothing could be
  exhaustively pinned.
- **Wrong bodies don't fail — they waste.** A 14.5×-oversized hauler
  crashes nothing and still reaches the milestone in a staged world, so
  both the unit suite and the "colony survives" integration tests pass
  over it. Only the live waste ledger ever caught these — every sizing bug
  in the archive has a live t-stamp and none has a test name. The estate
  had no **economic oracle**.

The general form, of which sizing is one instance — the evidence is v1's
own paperwork:

1. **Two-lens drift.** Nearly every incident class reduces to two modules
   deriving "the same" fact differently: demand-vs-work census (`staffsPost`
   symmetry), the upgrader valve vs the plan allocation (the sign-flipped
   throttle of 2026-08-02), the guard demand lens blind to its own purchases
   in the spawn pipe (t72811290, three guards bought for one room). The
   architecture *permitted* parallel derivations, so they multiplied, and a
   conformance suite had to be built just to police the seams.
2. **Compensating mechanisms.** Rules added at the symptom instead of the
   mechanism: the remote gate took two patches across two incidents before
   the mechanism itself was questioned (238 parts stranded); the
   stock-grounded valve was built to fix an under-stating plan and later
   throttled a correct one. The trap list is the graveyard of these — and
   the fact that CLAUDE.md needed a trap list at all is the finding.
3. **Instrument sprawl.** Legibility was bolted on because it wasn't built
   in: 64k lines of tests over 45k of src, seven telemetry segments, a
   13k-line session log (spec 14), a waste ledger with 20 methodology
   revisions. The measurement apparatus grew until *reading it* was the
   session's main cost — and it still let 47% of mining capacity go forgone
   while every gauge was green enough.
4. **Session-ergonomics collapse.** The doctrine payload required to touch
   v1 safely (CLAUDE.md + ONTOLOGY + the trap list + the relevant specs)
   outgrew what a session can hold. "Each of these has burned a session" is
   written in v1's own agent playbook. When the safe-change checklist is
   longer than the change, the codebase is the bug.
5. **Scale fragility.** The analysis/graph machinery heap-killed the global
   at two-room scale (t72933848) and had to be emergency-gated behind
   `Memory.analysisGo`. 480 nodes of world model for a 3-room colony.

## What was never the problem (doctrine that carries over)

The economics and the strategy were right. v2 keeps, verbatim:

- **One pure planner; operators at the edge.** The ONTOLOGY shape — a pure
  economic plan, dumb executors. v1 drifted from it; v2 enforces it
  structurally (below).
- **Fidelity is the objective** (owner 2026-07-30): the plan is only worth
  what the runtime faithfully implements. A plan-vs-actual gap is a P0 bug
  at the seam, never something to valve around.
- **Macro doctrine:** production over consumption; fund producers, bank to
  the warchest, consumers burn the residual.
- **The tender is a heartbeat** (owner 2026-08-06): spawn refill is an
  axiom, not a variable. If it looks broken, fix *it*, never compensate
  elsewhere.
- **The sink ladder** — spawn > new-spawn-site > claim-pump > controller >
  construction > controller floor > storage — one ordered list, moved only
  as a list.
- **Measured, not vibes:** multi-draw for tempo claims (±20-30% single-draw
  variance is measured fact), plan-vs-actual reported side by side, the
  grid ratchet as the success metric.
- **Value-per-intent** (GRAND_STRATEGY) as the north star, unchanged.

## The bet (what v2 does differently)

v2's thesis: **every v1 disease above is a structural permission, and v2
revokes the permission instead of policing the symptom.** The objective
the structure serves, in the owner's words (2026-08-18): **"we are chasing
efficiency"** — energy not wasted on wrong bodies now, value-per-intent at
the limit; the long-term is what we are optimizing for.

1. **One snapshot, one reader of the game.** A single `World` value is
   built from `Game.*` once per tick by one module. The planner and every
   executor read *only* `World`. No other module may touch `Game`, `Memory`
   raw, or live objects for *reading*. Two-lens drift becomes impossible to
   write, not just forbidden — there is one lens.
2. **The plan is the only state.** The plan is literal: jobs (mine this
   source with N bodies of shape B, upgrade this controller, build this
   site) and spawn orders derived as `target − (live + in-spawn)` — one
   subtraction, in one place, counting the spawn pipe by construction (the
   exact class of v1's last live bug). No corp objects, no per-module
   lifecycle state, no derived caches in Memory. Memory holds: the plan,
   creep→job assignments, intel. A global reset must be a non-event by
   construction: everything else rebuilds from `World` each tick.
   **The corp and the plan are the same thing** (owner ruling 2026-08-18:
   "we don't want duplicate code or objects that represent the same thing
   — the plan and the corporation should kind of be the same thing"). One
   representation per thing, the general form of law #1: a corp IS an instance
   in the plan — target, body, source, route, expected e/t — and the plan
   is nothing but the corps ledger (`Plan = { corps: Corp[] }`). A creep's
   memory names the corp that employs it; the census counts those
   pointers; the spawner buys toward the instance's target. v1 kept three
   representations in sync (commission, corp object, census view) and the
   sync gaps were the bugs. The name stays "corp" — the archive speaks it
   and the business metaphor earned its keep — but the moment a corp grows
   a method or a lifecycle, that is the disease returning.
3. **Executors are order-takers; DESKS act** (owner 2026-08-18: "almost
   all the game methods are gated behind some type of accessor —
   controlled from a single point, like how spawns are controlled").
   Per-kind runners (~30 lines each) decide *actions*; a small set of desk
   modules — one per game-method family (spawn desk, creep-act desk; site
   / tower / link desks arrive with their milestones) — are the ONLY
   callers of game methods, lint-enforced alongside the read gate. The
   write-side twin of law #1: reads have one gate (`world.ts`), writes
   have one desk each. Desks also COUNT INTENTS at the chokepoint — the
   value-per-intent accounting (spec 29's keystone, never built in v1)
   exists structurally from day one. If a runner needs to "decide"
   something economic, that decision belongs in the planner — the runner
   asks nothing.
4. **Fidelity instrumented from tick one.** The plan states its expected
   e/t; a ~30-line ledger measures actuals and prints plan-vs-actual every
   window. That one line is the whole telemetry system until it earns more.
   Instruments are added when a question needs one, and deleted with the
   question.
5. **Sizing is solved once** (owner ruling 2026-08-18: "that should've
   been a fundamentally solved issue"). A body is derived by exactly ONE
   pure module — (job's work requirement, route distance, energy budget)
   → body — and every job kind calls it; a second sizing site anywhere in
   src is the thrash coming back. The economics live inside it
   (route-based CARRY, saturation-based WORK, the worth-a-body floor),
   and it carries the exhaustive unit suite, pinned forever.
6. **A size budget with teeth.** v2 src stays under ~3k lines until the
   grid says the bot has out-earned v1's early tiers. Growth happens in the
   planner's *vocabulary* (new corp kinds, new sinks), not in new
   mechanisms. A change that needs a trap-list entry to be safe is the
   wrong change.
7. **Tests assert outcomes — WITH an economic oracle.** Survival alone is
   the v1 oracle failure: wrong bodies don't fail, they waste, and every
   staged world limps to its milestone anyway. So every milestone test
   asserts efficiency too: (a) structural sanity — no spawned body whose
   capability exceeds what the sizing module derives for its job,
   recomputed independently in the test (the assertion that would have
   caught the 24-CARRY hauler, by name); (b) a fidelity band —
   plan-vs-actual e/t within a range pinned from a multi-draw baseline
   (±20-30% single-draw variance is measured fact; no vibes numbers).
   Unit tests exist only for pure math (primitives, sizing, planner).
   Nothing pins internal shapes, so a refactor breaks a test only when it
   breaks the bot.

## The planning concept (shaped with the owner, 2026-08-18)

The conversation that produced these is the working agreement doing its
job: concept before code. Three pieces, one picture.

**1. The plan is a priced flow ledger.** A corp instance is a STAGE of a
flow — mining produces at a source, hauling moves, upgrading consumes at
a sink (the ladder's steps: spawn refill, controller, construction,
storage) — with bodies the sizing module derives from route and rate.
The source→sink FLOW is a CHAIN the engine composes from independent
stages (amended 2026-08-18, owner: "mining doesn't have to own the
hauling — that might have been a convenient hack"); chain composition
is piece 6's job, and the funded plan RECORDS each chain's flow edges
(mine A → haul B → controller), so fidelity audits end-to-end and
per-stage without ownership. Ownership would have fragmented the hauler
fleet per mine — the CARRY-sliver class v1 measured and killed (#150);
a pooled haul instance serving several sources is natural under
composition and impossible under ownership. Every instance carries its own P&L — gross e/t, cost e/t (amortized
bodies; CPU joins later), net — so efficiency is a COLUMN, not a hope.
Funding: *between* sinks the ladder stays a strict ordered list (the
axiom, no magic weights); *within* funding, spawn capacity goes to flows
in net-descending order, and a negative-net flow is never funded (the
worth-a-body discipline, structural — a 24-CARRY hauler on a 1.7-CARRY
route prints its own negative net before it spawns). The fidelity line
audits per ROW: claimed net vs measured, so a wrong model shows up in the
instance that is wrong. No persistent DERIVED graph — routes, candidates and
ROI derive at replan; what persists is observed INTEL (piece 4, which
also holds why the 480-node apparatus is not coming back). The concept
ships complete (every instance always prices); new sinks arrive with their
milestones.

**2. Corp kinds are a typed union; the instance is the corp's memory.**
`Corp = MineCorp | HaulCorp | UpgradeCorp | ...` — kind-specific fields
live on the union member, the instance lives in the plan, the plan lives in
Memory: kind-specific persistence with zero new mechanism. Inheritance is
rejected on the record: v1's seven subclasses each implemented every
contract their own way, spec 60's conformance suite existed to police
them into agreement, and #173 — the last PR before the reboot — was two
subclasses disagreeing with five others about the spawn pipe. The union
inverts it: M dispatch functions (sizeFor / priceFor / runnerFor) with N
compiler-checked branches; shared behavior is a shared function, never a
base class. Three ownership rules keep instance-memory honest:
- **Derivable facts are derived** at plan time, never cached (stale-cache
  drift is the analysis-restart incident class). Stated exception:
  STABILITY — the planner may read the previous instance to keep a multi-valued
  choice steady across replans.
- **Measured history lives in the ledger, keyed by corp id** — never in
  the corp (v1's corp-owned counters produced the counter-reset phantom:
  a recommissioned corp booked a full window of false forgone mining).
- **Only the planner writes instances.** Executors read; the ledger measures;
  a creep's memory is its corp id and one hysteresis bit. Workflow/stage
  state passes a high bar: derive the phase from the world wherever
  possible; a stored phase is planner-written and earns its place.

The formal shape (settled 2026-08-18, second round): **the corp class
exists — as an interface.** `price / run / requirement`, implemented
statelessly by each kind's vertical, held in a registry the compiler
checks for completeness. It implements, never extends; it is never
constructed at runtime — **the CORP INSTANCE is a plain data record in
the plan** (owner naming, third round: "corp instance"; "row" retired as
vague). The class is behavior, the instance is data, the plan is the set
of living instances. And **variants are fields, never subclasses**: a
transport instance's realization (`via: bodies | link`, `roaded`) is
instance data priced by one formula whose terms zero out, so the SAME
instance — same id, same ledger history — re-prices when its
infrastructure matures (the field moved from the mine to transport with
the 2026-08-18 link retraction, piece 5 — the mine just produces).
Subclassed variants would churn the corp's identity at every upgrade:
the counter-reset phantom as architecture.

**3. Every game verb has ONE owner — and where a verb has one corporate
user, the corp IS its desk** (owner 2026-08-18: "the corp is the desk —
harvest corp harvests, spawn corp spawns"). Code organizes as one
vertical per corp kind: `corps/mine.ts` holds the kind's pricing branch,
its runner, and — being its only user — the codebase's only
`creep.harvest` call; `corps/spawning.ts` operates the spawns (the only
`spawnCreep`, executing the planner's funded order; the tender heartbeat
lives here when it arrives) and eventually carries its own instance —
parts/tick produced vs energy consumed, spawn utilization priced like
everything else. Everything about a business sits in one small file.
Two guardrails survive from the owner's earlier rulings:
- **Universal verbs have no single corporate user** — move, transfer,
  withdraw, pickup are every kind's; they live in the one shared desk
  (movement policy stays in one place), or the spec-60 disease returns
  as N per-kind copies of the same contract.
- **The ROW never gains a method.** The vertical is the kind's CODE; the
  corp's data stays a plain instance. A kind = an instance shape + a file.
Every chokepoint — vertical or shared — stamps through one counting
substrate (`issue(creep, verb, rc)`) so intent accounting and same-tick
clobber detection stay whole; the lint rule bans game methods outside
registered chokepoints, wherever they sit. WHICH body to buy next stays
the planner's funding order — the spawning corp executes it (the one v1
seam that already worked, given its corporate name).

**4. Nodes become intel + plan-time pricing; expansion is emergent**
(owner 2026-08-18: "one of the most important goals [is] for energy and
corps to emergently 'flow' to new rooms"). v1's Node fused two things:
observed facts and derived structure. The facts cannot be recomputed
(vision is only where creeps are) so they persist; the structure can be
recomputed, and v1 persisted it anyway — hence 480 nodes for 3 rooms,
analysis passes to rebuild them, and the t72933848 heap-kill. v2 splits
the fusion:
- **Intel is what the one lens remembers seeing**: a flat record per SEEN
  room — sources, controller state, hostiles, timestamp — written at the
  read gate as a side effect of looking (`world.ts` is intel's one
  writer). Facts only, never interpretations; everything derived happens
  at plan time, windowed to reach. No analysis pass exists, so the class
  that heap-killed v1 has nothing to kill. "Node" as a word retires with
  the fusion.
- **Emergence is the funding order, not a mechanism.** A remote source is
  a mine instance with a longer route and lower net; when home sources
  saturate, the best unfunded instance is in the next room, and corps flow
  outward because the profitable frontier moved. Reservation is a
  supporting instance that doubles a remote's gross for a claimer's cost; a
  claim is an investment flow toward the `new-spawn-site` sink the ladder
  already holds. v1 needed spec 06 and hand-staged campaigns; v2's
  version is a sort order.
- **Scouting is the second stated exception** (stability is the first):
  information cannot be priced by the nets it has not yet revealed, so
  exploration is funded as COVERAGE — intel within reach kept fresher
  than a horizon — axiom-priced like the tender heartbeat, and declared
  as such rather than dressed up as emergent.
- **Commute is a cost column, not a mechanism.** Bodies may spawn far
  and walk (v1's bankfeed / walked fill, which founded W43N24 and
  W43N21, become plain instances): a body that commutes C ticks amortizes
  over 1500−C. The sketch's spawn-in-own-room assumption dies by M5.
- **Risk joins the P&L when measured.** Intel records hostiles; a route
  with measured attrition carries it as a cost term (the R1 lesson:
  real raid losses ran ~10× the priced guess). Slot named now, built
  when there is data.

**5. Corps own their capital — and that is what builds it.** (First cut
2026-08-18 had the link harvester owning its link; the owner retracted
it the same day: "I back off the link mining corp idea. A good concept
for the links is just to DISPLACE EXISTING HAULING. That generalizes to
a lot of cases, including the source link.") The law stands; the link
found its true owner:
- **A link is a competing REALIZATION of a transport edge.** Any hop in
  any chain can be realized by a body fleet (per-tile creep cost,
  road-modified) or by capital (link: capex + 3% tax + cooldown
  throughput). The cheaper realization wins the edge. One calculus
  covers the source link, the controller link, and the border links v1
  hand-built in spec 26 to meet remote flow at the door — displacement,
  which v1 built as a mechanism and v2 prices.
- **The link is TRANSPORT capital**, owned by the transport instance
  whose edge it spans. Construction is funded by the DISPLACEMENT DELTA
  on that edge's own books — body cost currently paid, minus tax and
  capex amortization — through the same ladder-and-net ordering as
  everything else. The haul business automates itself exactly where its
  own P&L says bodies are the expensive way to move energy. When the
  link stands, the edge's `via` flips in place: same instance, same
  books, no identity churn. No RCL-triggered build scripts.
- The general law is unchanged: an exclusive asset sits on its corp's
  books, capex + opex as terms in the instance's net. This closes a
  named v1 class: assets nobody owned — the container demolished
  correctly-by-its-own-lights while another lens counted it (spec 54),
  the ownerless port buffer (spec 56), the balance sheet's `fixed` line
  that read "not measured" forever (spec 47). A SHARED asset belongs to
  the corp that operates the shared function (the hub-side receiver,
  shared by many edges, to the core's operator; roads enter the routes
  that use them as a cost term), and a verb with two corporate users
  (link send) lives in the shared desk per piece 3, each caller's sends
  stamped to its own corp.

**6. The planner is a budgeted search engine over the ledger — and
bootstrap is its first test, with no special mode** (owner 2026-08-18:
corp instances have inputs and outputs, so "we want a GOAP or A*-style
graph search of possible corp combinations to find the best one"; and
on bootstrap: "a special mode would defeat the point and blur out the
signal").
- **Distributed pricing, tiny shared vocabulary.** Verticals price; the
  engine only combines. Every corp instance declares `requires` and
  `provides` from a deliberately frozen vocabulary — `spawnTime(p/t)`,
  `energyAt(place, e/t)`, `asset(id)` to start; risk joins when measured
  (piece 4). Growing this vocabulary is a constitutional event. The
  engine holds no domain knowledge, so it cannot accumulate case logic —
  it is too small to hide anything in.
- **It searches the LEDGER space, never the map**: stocks, flows,
  capacities, standing assets. Positions stay inside `price()`; the
  moment tiles enter the search state, the 480-node apparatus is being
  rebuilt inside the planner.
- **Anytime and budgeted** (the t72933848 rule): a CPU/node budget in,
  best-found-so-far out. The physical caps in primitives are admissible
  optimistic bounds; dominance between portfolios prunes. **Depth is a
  dial, and depth-zero IS the greedy clearing loop** — the early game
  runs shallow; depth turns up where decisions branch (variants, capex
  timing, claims). Lookahead must EARN its CPU: depths race in the grid
  on staged scenarios, value found per CPU spent — planner quality is
  measured, not argued. Greedy's known myopia (it refuses negative-now
  capex natively) is exactly what deeper search exists to fix; no ROI
  side-logic gets bolted onto depth-zero to fake it.
  **Performance scope** (owner 2026-08-18: "optimizing performance we
  can figure out later — as long as we have a structurally sound
  concept"): only two performance properties are STRUCTURE — the
  anytime budget interface and the ledger-space state bound — because
  retrofitting either is a rewrite. Everything else (pruning strategy,
  beam widths, depth policy, memoization) is tuning, deferred until the
  racing harness has data. Do not gold-plate the search.
- **The plan's form never changes with depth**: funded instances with
  their P&L, plus the blocked frontier with REASONS (the porttender
  wedge — AFFORDABLE+IDLE against a 12,900 bank for 1,804 ticks,
  diagnosed forensically — becomes one printed line on the tick it
  happens). The search is an implementation behind the plan, never a
  black box instead of it; the fidelity line audits every depth the
  same way.
- **Incumbency is an engine semantic, not a courtesy**: a funded
  instance keeps its funding unless a challenger clears it by a margin
  (pinned from measurement). Same world + same ledger = same plan:
  stable ordering everywhere, so plan diffs mean something.
- **Chains are assembled backward from sinks** (GOAP's own move —
  search from the goal): progress needs `energyAt(controller)`, a haul
  stage provides it and requires `energyAt(source)`, a mine stage
  provides that. The engine composes chains from independent instances
  and prices them END-TO-END — gross at the sink minus every stage's
  cost. Chains are 2–3 hops, so composition is cheap; an edge realized
  by link instead of bodies drops the fleet from that hop's cost
  (piece 5's displacement, restated).
- **Deferred together by the owner**: the objective ("more on what
  'best' means later") and the horizon it is evaluated over — one
  conversation, to be had with the racing harness in hand. One property
  is pinned already (owner 2026-08-18: "mining without hauling doesn't
  qualify as 'best' because it doesn't result in any upgrading"):
  **value is realized at sinks only — production has no standalone
  worth**; energy standing at a source is decay-exposed inventory, not
  wealth. Corollary self-test: v1's "production over consumption"
  doctrine must EMERGE from the objective (sinks cannot realize value
  unsupplied), never be hand-coded; if it fails to emerge, the
  objective is wrong.
- **Bootstrap: the ordinary engine on an empty ledger.** One affordable
  root instance (a floor-priced workman whose `requires` a bare spawn
  meets), then the cascade — the same engine, unchanged, runs the RCL1
  first tick and the GCL-32 empire. No cold-start flag exists in src for
  a branch to read; cold and warm worlds enter the same entry point, and
  the milestone cell asserts it. The survival sizing law is NOT a mode —
  it is a pricing rule inside `price()` that parameterizes the root
  candidate; the engine never knows the colony is newborn. Kills v1's
  BootstrapCorp class and the special-path interaction bug family (the
  emergency hold that silently blocked zero-node worlds).

## The demolition boundary

Deleted on this branch (recoverable from `master` forever):

- `src/` — all of it. v2 rebuilds from `main.ts` up.
- `test/unit/`, the old integration assertions, `test/grid/cells/` and the
  v1 `baseline.json` ratchet — they specified v1's internals.
- `scripts/` probes and audits that import v1 src (diag-*, waste-ledger,
  base-lab, sim-real-rooms, …).

Kept, because it is implementation-agnostic or it is data:

- the mockup harness: `test/integration/helper.ts`, world staging
  (`loadLayout`, `startAtRcl`, scenario/mods), the grid engine
  (`test/grid/*.ts` minus cells), `scripts/grid.ts`, `probe-mockup.js`,
  `setup-test-env.sh` (the isolated-vm trap it guards is real and
  environmental)
- `test/fixtures/` — captured real rooms, telemetry snapshots, incidents
- the toolchain: webpack build → `dist/main.js`, rollup deploy, tsconfigs
- `telemetry-app/` — reads live public segments; v1 emits them today
- `docs/` — the archive, plus this file

Formulas are ported, not imported: when v2 needs an economic formula that
v1 hardened (amortized body cost, decay laws, the corrected
`CONTROLLER_LEVELS` run), port it from
`git show master:src/economy/primitives.ts` *with its docblock*, into v2's
own `primitives.ts`, and pin it with a unit test. Never re-derive from
memory what v1 already paid to verify.

## The ladder

Each milestone is mockup-verified; the grid ratchet re-arms at M6
with a fresh v2 baseline.

- **M0 — toolchain proven.** `setup:test-env` + `probe:mockup` green in
  this environment (guards the invisible runtime-bundle failure).
  **LANDED 2026-08-18.**
- **M1 — cold start to RCL2.** Empty room, one spawn: workmen mine, feed
  the spawn, upgrade. No starvation, RCL2 by a pinned tick.
  **LANDED 2026-08-18 as a survival gate** (`v2-cold-start.test.ts`: RCL2
  inside 600 ticks on the bare two-source room; first red taught the first
  v2 economics lesson — duty-corrected saturation ordered a 12-body ramp
  that starved the residual, now capped in the planner with the incident
  in `RAMP_CAP`'s docblock). **DRAFT under the same day's rulings:** a
  survival-only gate is the v1 oracle failure, so before M2 opens, this
  cell gains the economic oracle — the structural sizing assertion and a
  fidelity band pinned from a multi-draw baseline (bet #7). Criteria to be
  owner-approved per the working agreement.
- **M2 — division of labor.** Static miner + hauler split, extensions
  filled (the tender heartbeat), RCL3 on the two-source room.
- **M3 — the fidelity line.** Plan-vs-actual e/t printed and within a
  pinned band across a full draw; variance harness revived for tempo
  claims.
- **M4 — the economy proper.** Storage, the sink ladder in the planner,
  construction funded from surplus, warchest banking.
- **M5 — beyond one room.** Remote mining and the reserver, priced by the
  same planner, no special-case gates.
- **M6 — the grid re-armed.** v2 baseline ratcheted; BOT LEVEL becomes the
  success metric again.
- **M7 — the respawn.** Settled in advance (owner 2026-08-18: "we can
  respawn the live colony if necessary — we're looking for the long-term"):
  when M6 is green, v2 goes live by RESPAWN, fresh ground, cold start on
  its own proven rails. Adoption-in-place machinery — inheriting v1's
  creeps, memory and structures mid-flight — is never built; a whole class
  of complexity deleted by ruling. The owner still calls the moment.

## The working agreement (owner + sessions, 2026-08-18)

Born from the reboot's own first misstep: the demolition and the M1 sketch
were built at sprint pace on a confirmation the owner never actually gave
(a lost question dialog). The owner's correction is the process now:
*"don't you want to talk with me and plan it out first? Otherwise we might
just rush into the same situation again."*

1. **Plan before code.** Each milestone's acceptance criteria are agreed
   with the owner BEFORE code is written toward it. The M1 sketch predates
   this agreement and stands as draft until its upgraded criteria are
   approved.
2. **Rulings are recorded** — in this document, dated, in the owner's
   words. A session acts on recorded rulings, not on inferred ones.
3. **Bands are measured, then pinned.** Any efficiency band starts from a
   multi-draw baseline run, never a chosen-looking number; it ratchets
   only on new measurement.

## The live rule

`master` is the deployed bot and stays deployable. Nothing from the v2
line deploys to the live account until M6 is green and the owner calls M7.
Deploy scripts remain pointed at whatever branch is checked out — so the
guard is procedural: **do not run `push-main` from the v2 line.**
