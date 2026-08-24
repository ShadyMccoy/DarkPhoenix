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

## The mental model (one picture)

**Corps are NODES; matched inputs and outputs are EDGES; the plan is
the funded match set; the bank is energy's counterparty; the engine
chooses which matches to fund.** (Owner refinement 2026-08-18: the
graph is not geographic — "the edges represent the relationships
between corps, matched inputs and outputs.")

- **Every corp exposes PORTS** — each port is (commodity, rate, place).
  An in-place converter has co-located ports (mine: spawnTime-in +
  energy-out, both at its mouth) — no movement, no self-loop weirdness.
  The spawning corp bridges COMMODITY space (energy in → spawnTime
  out); its output matches every corp's body-input port, delivery being
  the creep's walk, embodiment priced into the match. Multiple corps at
  one game position are simply multiple nodes — the tile was never the
  identity.
- **Geography is an attribute of the match, not the graph's skeleton.**
  Co-located ports match free; distant ENERGY ports match only through
  transport — and since every energy match routes through the bank
  (piece 9), transport corps WORK FOR THE BANK: their ports are bank
  branches, and hauling/linking is the bank moving stock between its
  own branches. Energy's graph stays radial (hub-and-spoke), never
  pairwise.
- **Three views, one model:** the abstract match graph (what the engine
  walks — GOAP's backward chaining is "goal port ← matching outputs ←
  those corps' inputs ← …", and the funded plan IS the match set piece
  1 records); the position matrix (ports netted by place × commodity —
  where clearing and the conservation identity live, per column); and
  the energy projection (the geographic picture: mouths → bank →
  controller — the dense column rendered spatially, right for
  intuition, a view rather than the model).

- **The commodities span all corp inputs and outputs** (owner
  2026-08-18: "not just energy"): energy; spawnTime; safety per room;
  intel coverage; standing assets — and CONTROL POINTS, the one
  terminal commodity. **Every corp is a converter**: mine turns
  spawnTime into energy@mouth; spawning turns energy into spawnTime;
  haul and link move energy at different prices; upgrade turns energy
  into control points; guard makes safe@room; scout makes coverage. One
  multi-commodity economy refining everything toward control points
  within the horizon — energy is just the most-traded intermediate
  good. Minerals, labs and boosts slot in later as commodities and
  converters with zero new machinery. Commodities differ in
  transportability and the ports say so: energy hauls; spawnTime
  travels only EMBODIED in the creeps it built; safety and coverage are
  place-bound services.
- **The position matrix is the aggregation view**: net all ports by
  (place × commodity) and each place holds a VECTOR of positions — a
  sparse matrix whose dense column is energy, which is why the pictures
  get drawn in energy (owner: "a matrix or vector rather than a scalar
  — conceptually easier to envision for energy"). Clearing nets per
  commodity column; the conservation identity holds per column too —
  energy balances through the bank, spawnTime balances into births, and
  control points is the absorbing column that only accumulates: the
  objective, stated as linear algebra.
- **The graph is transient** — assembled at each replan from candidates
  the corp classes price, discarded after clearing. Persistent state is
  three things only: World (this tick's snapshot), Intel (places seen),
  Plan (the funded ledger).
- **Two loops.** Every tick: execution of standing orders — snapshot →
  runners → desks → ledger; no thinking. Every replan (~20–50t): the
  budget meeting — classes submit priced candidates, the engine pays
  obligations, funds chains backward from the sinks as packages against
  the hurdle, leaves the residual to the controller, and prints the
  blocked frontier with reasons.
- **Search depth = how many not-yet-existing prerequisites a plan may
  chain through.** Depth-0 funds only what can run today (bootstrap
  lives entirely here); depth-1 plans through one build (the link); a
  claim is depth-2+. Deeper search is permission to plan through
  construction.
- The human handle: a holding company's budget meeting. Treasury (the
  bank), divisions (corp classes) submitting mini-P&Ls, a CFO with one
  fixed rule (the engine), dividends to the controller, an auditor (the
  fidelity line), and books that must balance to the energy (the
  conservation identity).

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
5. **Rebuild fragility.** The analysis machinery that re-derived the
   node graph heap-killed the global at two-room scale (t72933848) and
   had to be emergency-gated behind `Memory.analysisGo`. The moral is
   NOT the node count — 480 records is nothing (owner 2026-08-18: "I
   wouldn't worry so much about the 480 nodes") — it is that the graph
   was DERIVED state with its own rebuild loop that could disagree with
   the world and die trying to catch up. Persist observations freely;
   never persist what a pure function of them can answer.

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
composition and impossible under ownership.

**Corps trade in POSITIONS; transport clears the position book** (owner
2026-08-18: "corps require hauling implicitly to cover energy + and −
position gaps — but that could be provided in various concrete
implementations and optimizations without affecting other corps
directly"). A + position is energy provided at a place, a − position
energy required there; transport demand is DERIVED from the netted gaps
per place, never declared by name — no corp ever asks for a hauler.
Whatever can move energy offers to cover gaps at its own price and
constraints: haul corps, link corps, later the terminal (3.33%/room,
v1-hardened) and the walked-bankfeed pattern — each a new kind plus a
registry entry, touching no other corp. The boundary buys three things:
extension without contact (what inheritance was reached for, delivered
by the market); transport-internal optimization invisible to the rest
of the economy (pooling, consolidation, backhaul — the spec-49 class,
cleared inside the service); and an implementation-blind transport
audit (the fidelity line measures gap coverage per place, identical
whether bodies, links, or terminals moved it — swaps are safe because
the instrument doesn't move). Every instance carries its own P&L — gross e/t, cost e/t (amortized
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
haul instance's route grade (`roaded: boolean`) is instance data priced
by one formula whose terms zero out, so the SAME instance — same id,
same ledger history — re-prices as its route is paved. Subclassed
variants would churn the corp's identity at every upgrade: the
counter-reset phantom as architecture. (The link, first drafted here as
a mine variant and then as a transport realization field, resolved
further still: links are their own KIND, competing on the same edges —
piece 5.)

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
- **The link corp provides hauling, essentially** (owner, final form,
  same day: "just like the haul corp does — but at different prices and
  constraints"). Links are their own KIND, writing candidates against
  the same edges the haul corp serves: haul offers any endpoints,
  per-tile body cost, spawnTime consumption; the link corp offers fixed
  endpoints, ~800/distance throughput, a 3% tax, and requires its
  structure standing. The engine funds whichever wins the edge —
  competition between kinds, no bundling, no realization field. One
  calculus covers the source link, the controller link, and the border
  links v1 hand-built in spec 26 to meet remote flow at the door —
  displacement, which v1 built as a mechanism and v2 prices. And the
  verb story simplifies: link-send now has ONE corporate user, so it
  lives in the link corp's vertical per piece 3 — link corp sends.
- **Sunk costs price as sunk — capital IS the anti-thrash** (owner:
  "now that a link exists and paid for, that source is the 'cheaper'
  one that wins in the planner unless something changes majorly"). The
  BUILD decision prices at full cost: a candidate link carries its
  capex and must beat hauling's displacement delta to fund. The
  STANDING link prices at marginal cost — the 3% and nothing else — and
  so wins its edge stably in every replan. "Something changes majorly"
  has a precise meaning: a challenger displaces standing capital only
  when its FULL-cost net beats the incumbent's MARGINAL-cost net.
  Generalized deliberately: **living bodies are sunk capital too** — a
  spawned fleet's cost is history and its marginal price near zero, so
  standing chains hold their funding until bodies near expiry, and the
  true re-decision happens at replacement time, at full cost again.
  Thrash dies economy-wide as correct accounting, not as a hysteresis
  rule. Companion rule: **pricing forgets sunk costs; the books never
  do** — capex stays on the ledger so the audit can answer "did the
  link pay back?" (realized displacement vs the projected delta:
  investment gets its own fidelity line).
- The general law is unchanged: corps own their capital; an exclusive
  asset sits on its corp's books, capex + opex as terms in the
  instance's net. This closes a named v1 class: assets nobody owned —
  the container demolished correctly-by-its-own-lights while another
  lens counted it (spec 54), the ownerless port buffer (spec 56), the
  balance sheet's `fixed` line that read "not measured" forever (spec
  47). A SHARED asset belongs to the corp that operates the shared
  function (the hub-side receiver, shared by many senders, to the
  core's operator; roads enter the routes that use them as a cost
  term).

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
- **Incumbency mostly EMERGES from sunk-cost pricing** (piece 5):
  standing capital — structures and living bodies alike — prices
  marginal-forward, so funded chains hold until expiry or a
  majorly-better challenger (full-cost net vs marginal-cost net). What
  stays engineered is only determinism: same world + same ledger = same
  plan, stable ordering everywhere, so unbuilt ties never flip-flop and
  plan diffs mean something. A residual hysteresis margin exists as a
  watch-item ONLY if measurement finds an oscillation the economics
  fails to kill.
- **Chains are assembled backward from sinks** (GOAP's own move —
  search from the goal): progress needs `energyAt(controller)`, a haul
  stage provides it and requires `energyAt(source)`, a mine stage
  provides that. The clearing step NETS positions per place first
  (piece 1's position book), then matches + to − through transport
  candidates. The engine composes chains from independent instances
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

**7. Logistics is the war** (owner 2026-08-18: "most of the CPU and
spawning is for carrying energy. We want to win on logistics… it's part
of the dependency chain to cover distances"). The stakes in the live
colony's own census: 1,068 of 2,127 standing body parts are CARRY —
half the empire's mass is transport, and movement dominates the intent
budget, so value-per-intent is won or lost here.
- **Distance is a provisioned good, priced in one currency:** cost per
  e/t·tile. Bodies pay PER TILE (terrain- and road-modified; v1
  hardened 0.26%/tile), links pay FLAT per hop (3% + capex), terminals
  flat per room (3.33%). Break-even distances fall out of the quotes
  and the engine segments the network automatically — the pricing IS
  the sophistication; no logistics module decides anything.
- **Distance closes the dependency chain:** a gap resolves as
  gap → transport candidate →
  `carryParts(flow, distance, terrain, roaded)` → `spawnTime`. That
  function is THE logistics formula — #148's route-sizing law
  generalized — owned by the one sizing module and exhaustively
  pinned. Most of what spawns, spawns because of distance; the chain
  says so explicitly.
- **Network design emerges across replans, without a network solver:**
  every funded chain carries a route; routes overlay into a TRAFFIC
  MAP; traffic generates next replan's infrastructure candidates (a
  road segment's ROI = crossing flow × per-tile savings − upkeep; a
  link candidate appears where flow × distance clears break-even;
  containers at mouths; hub placement later, same overlay).
  Plan-to-plan continuity like the stability rule — never map-state
  inside the search — and sunk capital anti-thrashes the loop.
- **The plan sizes fleets; the vertical dispatches them.** Plan-time:
  how many CARRY parts exist for these gaps. Run-time, inside the haul
  vertical, invisible behind the position-book boundary: which creep
  goes where this tick — pooling, consolidation, backhaul (the empty
  return leg is wasted capacity; spec 49's class). Dispatch can grow
  sophisticated without the planner growing a line.
- **The winning metric,** in the fidelity line from the day transport
  lands: delivered e/t per CARRY part and per movement intent — the
  desks already count the intents. v1's duty/idle taxonomy (H1,
  atSink/enRoute) is the diagnostic archive, ported the day the number
  disappoints.
- **Open, deliberately:** dispatch algorithm quality (execution detail,
  measured later, behind the boundary) and when intent COST enters the
  pricing currency (counted from day one; priced when the racing
  harness says it binds — the deferred-CPU ruling).

**8. The objective: control points over a fixed horizon — kept simple
on purpose** (owner 2026-08-18, closing the deferred "what does 'best'
mean": "You don't need to overcomplicate things either. It's just
Screeps. We could pick a horizon like 50,000 or 100,000 ticks.").
- **Terminal value: the control-point stream.** Every energy upgraded
  advances RCL and GCL at once, and GCL survives room loss and even
  respawn — the only output that is real in the long term. The owner's
  earlier pin ("mining without hauling doesn't result in any
  upgrading") was this objective peeking through.
- **The horizon is a constant: H = 100,000 ticks, flat, nothing counts
  beyond it.** No discounting, no meta-optimization (a horizon-racing
  harness was proposed and rejected the same day as gold-plating). An
  investment's value = the stream it adds within H minus its cost;
  payback beyond H is "never" — which is the archive's own idiom
  (TRANSPORT_NETWORK: a relocation "pays back in ~100,000 ticks — which
  is to say never"; v1's economists used this horizon implicitly, v2
  writes the constant down). ~66 capital generations. Lives in
  primitives with this docblock; moved only by ruling, and the
  investment fidelity line ("did the link pay back?") is the standing
  check that would motivate moving it.
- **Survival is a constraint, not a goal.** Heartbeat solvency (and
  later defense) FILTERS portfolios; value ranks the survivors. No
  "value of not dying" fudge terms in the objective.
- **Everything else is instrumental**, valued through H: RCL
  thresholds, structures, claims are worth the stream they enable —
  never scripted goals. Goals-as-checkpoints is mode-thinking; the
  search discovers that RCL3-by-tick-X is on the best path, nobody
  feeds it "reach RCL3".
- **Jurisdictions: the ladder governs operating flow; the valuation
  governs capital formation.** This tick's energy among standing sinks
  follows the ladder, axiomatically, no search consulted. Capital
  formation — bodies beyond replacement, structures, claims — follows
  valuation over H. If deep search ever disagrees with the ladder's
  ordering, it surfaces as a FINDING for the owner; the axiom is the
  owner's to move, never the code's.
- **Intents are the eventual denominator**: counted from day one at
  the desks; when the 300-CPU wall binds, the objective matures to
  control points PER INTENT — value-per-intent, literally
  (GRAND_STRATEGY's north star as the objective's adult form). No
  redesign; a denominator arrives with its measurement.

**9. The bank in the middle** (owner 2026-08-18: "from the very
beginning, split production and consumption against the bank. All my
energy production should go into the bank — typically buffered: a
container by the mine, a pile or container or storage in the base. We
use those banks to fund our consumption, like capex or controller
points. The overall concept is still very much the same").
- **Every corp trades with the bank, never with another corp.** The
  position book (piece 1) gets its counterparty: producers fill,
  consumers draw, nobody meets. Every chain is cut in half at a buffer
  — production chains run source → mouth container → bank; consumption
  chains run bank → spawn / controller / site — and matching
  trivializes into a fill side and a draw side coupled by the balance.
- **The bank is one logical entity with physical branches** — mouth
  containers, piles, base storage, later the terminal — each with its
  own HOLDING COST: a ground pile decays (v1's L1 class, ~35 e/t at its
  worst, becomes the bank's own cost line), a container caps at 2k,
  storage is nearly free. Containerizing a mouth is just capex that
  cheapens banking — piece 5 machinery, nothing new. At t0 the bank is
  degenerate (a pile, a workman's cargo); the SPLIT lives in the books
  from tick one, before it lives in structures.
- **The conservation identity, asserted every window:**
  inflow − outflow = Δbalance + decay. Production fidelity and
  consumption fidelity are separate F1 lines that must meet in the
  middle; any gap is by construction a measurement bug or an unpriced
  loss, named the tick it appears. (v1's waste ledger spent 20
  methodology revisions reconstructing this reconciliation from
  captures and still carried a −42.65 e/t residual; v2 gets it as a
  structural invariant.) The bank was v1's EMERGENT accounting concept
  — bankfeed, walked fill, "the bank cannot walk there", E4, ullage —
  promoted here from accounting fiction to structural entity.
- **Timing decouples — more anti-thrash:** investments draw from stock,
  not live flow; a production dip cancels nothing half-built; a
  consumer pause stalls no miner (buffers absorb at their holding
  cost). Decisions read the balance; flows just do their jobs.
- **Plan in rates; stocks are jitter and alarms** (owner 2026-08-18:
  "containers are too small to plan against — the ullage is too small;
  we have to virtualize its capacity based on the production and
  consumption rates"). A branch enters the plan as a STOCK only when
  its time constant (capacity / flow through it) exceeds the planning
  scale; otherwise it is a RATE JUNCTION the plan sees as (in-rate,
  out-rate) with the job of keeping them matched. Mouth container:
  2,000/10 e/t ≈ 200t → junction (the physical 2k smooths jitter and
  fills hauler loads — execution's business). Storage: 1M/~20 e/t ≈
  50,000t → stock (the warchest band, investment funding). The spawn's
  300 classifies itself as the rate obligation the heartbeat always
  was. One formula sorts every branch. The inversion is the payoff:
  instantaneous container level EXITS the decision loop (v1's
  three-worlds scar — core v37 sourceMouth: zero meant just-emptied,
  never-filled, or overflowing — came from reading it) and enters the
  ALARM loop: a stock trending monotonically across windows is a rate
  mismatch, a plan-vs-actual gap, a P0 at the seam; overflow decay
  self-reports through the conservation identity.
- **The ladder retires into the bank's draw policy** (resolving the
  piece-8 ladder discussion): obligations draw first (heartbeat
  solvency, the controller floor — owed, not valued), hurdle-cleared
  capital formation draws next (the hurdle: 1 control point per energy,
  what direct upgrading yields — so v1's growth-over-consumption
  ordering becomes a theorem, not a decree), the controller drains the
  residual, and the WARCHEST is the bank's reserve band. v1's
  seven-rung list was the fossil record of exactly this structure,
  hand-approximated before the valuation theory existed. Open, parked:
  the tail-risk deterrence floor (an owner-set obligation constant —
  measurable hazards like invader cadence price through `safe(place)`
  instead; awaiting the owner's ruling).
- **The founding kernel** (owner 2026-08-18: "plan on building our
  first spawn in a room and the container or pile in a shared location
  between the controller and the spawn"): the first spawn and the
  bank's first branch are CO-LOCATED, sited between the controller and
  the production side — the two forever-repeating draws (tender's
  refill, upgrader's feed) become steps, and every production chain has
  one terminus. The bank's tile is DESIGNATED at tick one even while it
  is a pile (the proto-bank is a place, not just a book entry); the
  container replaces the pile when its capex clears the hurdle like any
  investment. Doctrine gives the shape; pricing places the tile — 
  candidate positions score in piece 7's currency (expected
  flow×distance over terrain; v1's tenderReach/anchor sweep re-derived
  from the logistics currency, inheriting the late lesson that remote
  flows join the score once intel knows them). ONE founding procedure —
  the respawn (M7), every claim's new-spawn-site, and the milestone
  cells all pass through the same placement function; no founding mode,
  per piece 6. This is the layout the live v1 colony EVOLVED into at
  RCL4+ (storage beside spawn, the hub) promoted to the shape of the
  first spawn.

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

## Next: the graph lab (owner 2026-08-18, session close)

*"What we will do next is build a mini-game GUI that will visually
represent the graph and GOAP search, that we can iterate on
interactively to refine the mental model and engine."*

The proven v1 methodology (extension-sim, base-lab: build the
mini-game, develop the intuition, then commit the design) — with v2's
structural upgrade: **the engine is pure, so the lab hosts the REAL
engine.** Pricing, clearing, search are functions of plain data; the
GUI drives the same modules the bot ships. One implementation, two
hosts, no lab/production divergence — the lab is the engine's first
certification host. Staging worlds, stepping replans, watching the
match graph and the blocked frontier render: that is the mental model
(the preamble) made touchable, and the engine's design iterated at GUI
speed before any mockup run.

Sequencing: the lab comes before/alongside the certification ladder
below; the M1 code gate and the working agreement stand unchanged.

### The lab requirements (agreed 2026-08-22)

Shaped in requirements conversation with the owner; five forks put,
five ruled, recorded here per the working agreement (the owner naming
this section the record: "sure"). The engine of record is the planning
concept (pieces 1–9); the lab is its first host and first
certification. Acceptance criteria will live where they always do —
in the scenario files and their asserted replays — once built.

**Rulings (owner 2026-08-22):**

- **Result over search.** On plan-only vs stepped sequences: *"both.
  ultimately the search is less interesting than the result, generally
  speaking."* Both modes exist — inspect a single replan, and step a
  sequence — and the screen's star is the RESULT: the funded plan, its
  per-instance P&L, the blocked frontier with reasons, and the plan
  diff between replans. The search trace remains an engine OUTPUT
  (data: candidates considered, prices, prune/fund decisions,
  best-so-far per budget step — it is what makes the frontier's
  reasons and the certification replayable), but its visualization is
  a drill-down, never the main event.
- **The map is editable.** *"I'd like to be able to edit the map as
  well to place, move, and update properties on game elements, eg
  spawns, storages, buildings, energy sources."* The energy projection
  is therefore not a render but the scenario EDITOR: place, move,
  delete spawns, sources, containers/storage, the controller, the
  designated bank tile; edit their properties (stocks, capacities,
  level). Terrain loads from captured fixtures; a terrain brush is a
  nice-to-have. **Edits reprice live**: every edit re-runs the replan
  (depth-0 is cheap), so the match graph, the positions and the
  frontier react as elements move — distance as a priced good
  (piece 7) made touchable.
- **v0 scope agreed:** kinds mine / haul / upgrade / spawning, plus
  the bank as counterparty; commodities energy + spawnTime; depth-0.
  First scenario: the bootstrap cascade — piece 6's own designated
  first test, watched on screen from an empty ledger. Lab phase 2:
  `asset(id)`, the link kind, depth-1 — displacement and
  capex-vs-hurdle become visible.
- **Hand-vs-engine mode is deferred** (owner: "not critical"). The
  proposed play-against-the-planner scoring mode is not a
  requirement; revisit only if the objective conversation wants an
  instrument.
- **Tech settled** (owner: "sounds good. sure if react helps go for
  it."): a static browser page — the engine bundled by the existing
  toolchain (`npm run lab`), no server, nothing live to talk to.
  React is permitted for the GUI where it speeds iteration; any such
  dependency is lab-only, never imported from `src/`.

**Requirements (first round, carried):**

1. **The engine is the deliverable; the GUI derives nothing.** Engine
   modules are plain-data pure functions in `src/` (the
   `primitives.ts` convention — screeps-type-free), bundled into the
   lab and imported by the bot alike: one implementation, two hosts.
   If the GUI needs a fact the engine does not expose, the engine
   grows an output field — a GUI-side derivation is the two-lens
   disease in a new host.
2. **The map is input and projection, never search state.** The editor
   edits the WORLD; a pure world-assembly step derives places and
   route costs (real path distances over terrain) for the engine,
   which searches ledger space only. The 480-node door stays shut at
   the GUI too.
3. **Scenario files round-trip through the editor** (load → edit →
   save): map + element properties + bank stocks + ledger + previous
   plan + horizon, plain JSON, checked in. They double as the engine's
   unit-test fixtures (deterministic replay asserted — same world +
   same ledger = same plan, per piece 6) and converge toward mockup
   staging so a lab scenario can graduate into a mockup cell.
4. **Stepping is a believer world — steady-state, like the plan
   itself** (owner correction 2026-08-23: "we're just doing abstract
   steady state planning"): it applies the plan's own standing rates
   as cash. A live body persists; its replacement IS its amortized
   bill, paid continuously — there is no expiry event, and unfunded
   staffing lapses because the plan stopped renewing it. Discrete ttl
   churn and the spawn pipe are execution's business, measured at the
   mockup. Plan-vs-actual is zero here by construction, so the lab
   certifies ACCOUNTING — conservation identity, P&L composition,
   funding order, determinism, plan quiescence — and never fidelity.
   No lab number is quotable as a measured band; the mockup remains
   the truth host.
5. **Boundaries.** The GUI lives outside `src/` (top-level `lab/`) and
   is exempt from the ~3k src budget; the engine counts. The lab never
   touches live. M1's gate and the working agreement stand. The bot's
   cutover from `plan.ts` to the engine is its own owner-gated event.

### The corp contract (agreed 2026-08-22, second conversation)

The engine-facing shape of every corp kind, set by the owner: *"the bot
classes themselves must be structured to accept game assets (eg from
the planner) and give back some kind of scaling ie input & output
function. This is super important."* The broker: *"Planner provides —
it lives between the world and the corps. Either our fake synthetic
world or in the real world."* What a kind sees: *"just the assets.
It's kind of part of their contract."* Implementation detail was
delegated to the session, worked through priced examples, and closed:
*"Yeah I think you've got the picture."* The record:

- **`quote(handoff) → Offer`, pure.** The handoff is a typed record of
  assets — game objects INCLUDING the kind's currently-assigned creeps
  (sunk capital enters as handed assets) — plus planner-derived terms
  (route cost, body budget: the planner relaying other contracts'
  attributes, e.g. the spawn estate's capacity). The handoff type IS
  the kind's contract; a kind sees nothing else — no World, no plan,
  no Game.
- **The Offer is the scaling function as data**: a list of STEPS, one
  step = one body (or structure), each declaring marginal
  requires/provides rates in the frozen vocabulary. Saturation is the
  schedule ending; diminishing returns are declining marginal
  provides; `backedBy` marks a step already embodied, which quotes
  ~zero — incumbency and anti-thrash as a cheap first step, no engine
  machinery.
- **A body step's requires carries its full bill**: spawn machine time
  (`spawnTime` p/t) AND its parts bill (`energyAt` the spawn's bank
  branch, cost/1500). The spawning kind sells pure capacity (1/3 p/t
  per spawn). No double count, and the tender heartbeat becomes an
  identity: refill obligation = Σ funded parts bills, drawn first.
- **The engine loop, six verbs:** anchored quotes → net positions per
  place (bank as counterparty) → publish gaps → transport quotes →
  compose chains end-to-end → fund increments in marginal-net order
  under capacity and solvency, emitting the plan and the frontier with
  arithmetic reasons.
- **The solvency filter realizes the root.** Piece 8's
  heartbeat-solvency constraint, applied to each chain's ramp: on an
  empty ledger only the workman's one-body chain can fund itself, so
  the floor-priced root EMERGES — no flag, no mode (piece 6 made
  concrete). The workman joins v0's kind set as the fused converter,
  always quoting, outcompeted the moment specialist chains are
  solvent and cheaper. Harvest thereby gains a second corporate user
  and becomes a shared function per law 3's own rule.
- **Recorded retirements:** nearer-sources-first ordering and M1's
  RAMP_CAP both fall out of merit-order funding — the buy order IS the
  merit order, so the ramp cannot starve the residual by construction.
- **The tender is the spawning corp's own body** (owner 2026-08-23:
  "Hauling is specifically for energy logistics between corps. The
  tender is a specialist corp for filling extensions and spawns and
  it's a corp with body requirements just like others. Although a
  very simple one. It could be folded into the spawn corp itself." —
  folded in). The spawning vertical prices TWO services: machine time
  (the standing structures) and refill intake (tender bodies, sized by
  the one sizing module to the funded obligation over the estate's
  radius). Haul quotes never cover the spawn estate; the heartbeat's
  carrier is the spawning corp's own fleet, and its cost is one more
  line of the obligation paid first.

### Development steps (2026-08-22)

1. **Engine core** (`src/engine/`, `src/corps/`, `src/sizing.ts` —
   counts in the src budget): offer/vocabulary types, the ONE sizing
   module (law 5's home), quote functions for workman / mine / haul /
   upgrade / spawning, chain composition + merit funding + frontier.
   Suites: synthetic-kind market tests (clearing correctness with
   made-up schedules), the exhaustive sizing suite, the worked
   550-budget example pinned, the cascade staged across ledgers
   (empty → workman; income standing → specialists displace). The
   live bot keeps shipping `plan.ts` untouched.
2. **Lab scaffold** (`lab/`): `npm run lab`, scenario JSON
   round-tripping the editor, map editing, world assembly (real path
   distances over terrain), replan-on-edit.
3. **Views + stepping:** match graph / position matrix / frontier
   panels, P&L inspector, believer stepping, plan diffs; the
   bootstrap-cascade scenario checked in as the first certification.
4. **Phase 2:** `asset(id)`, the link kind, depth-1.
   **Landed 2026-08-23 with the clearing-order refactor** (owner:
   "let's do the gap derivation refactor along with the link corp",
   after the position book caught a hand-wired matching hole): the
   broker nets anchored offers first and DERIVES the gaps — nothing
   hand-wires a match, and the book stays the tripwire. Transport
   stages are ORDER BOOKS: haul bodies and link volleys compete on
   the same edge, standing capital first, then cheapest marginal
   unit — piece 5's "the engine funds whichever wins the edge" is
   literally the sort. The link kind prices the piece verbatim: a
   standing pair quotes marginal (the 3% tax, zero spawn time), a
   candidate quotes full cost (tax + capex/HORIZON) with its capex
   gated by stock (investments draw from stock — piece 9), so the
   network segments by distance with no logistics module deciding.
   H = 100,000 now lives in primitives under its ruling docblock.

The bot's cutover from `plan.ts` to the engine is a separate
owner-gated event once the lab has certified the design.

### The roadmap (agreed 2026-08-23)

Ordered by dependency; every item rides the standing machinery —
quotes, order books, capex over HORIZON, the position book — so each
is a vertical plus a registry entry, as the concept promised. Two
rulings recorded with it: **the map and graph are room-agnostic**
(owner: "the map and graph is pretty much room agnostic" — rooms are
walls the editor draws, never model structure), and **link outposts
consolidate haul routes** (owner: "consolidate multiple haul routes
into one link outpost given such a map" — a free-standing link is its
own PLACE, a bank branch in waiting: short collector hauls converge
on it, one trunk hop covers them all, and the book audits the joint).

**AMENDED (owner 2026-08-24): "we need to break the room agnostic
rule here. Yes I want to perform the spatial search to find the
optimal link placements."** Rooms enter the model for what the game
makes them: link-legality cells. A room is a 50×50 grid cell over the
map; a link pair is legal only within one room; and link range is
CHEBYSHEV — the wire fires through walls, so its cooldown ration
(800/range) is terrain-immune while every haul path pays the detour.
The placement search lives lab-side with the other spatial knowledge
(world assembly owns the map; the engine still searches ledger space):
it proposes STATION TILES — a mouth link in the source's reach, a hub
link by the bank — and the assembly hands the engine priced wire
options per edge. Maps otherwise stay any-size; walls stay the
editor's terrain, never model structure.

**Tier 1 — make the economy real:**
1. Build corp — the missing verb; retires the believer as interim
   builder. Unlocks the rest of the tier.
2. Extensions as investment — bodyBudget becomes ENDOGENOUS: an
   extension is a 3000e candidate whose payoff is bigger quotable
   bodies; the spawn estate grows itself the way the link cleared
   its hurdle, and spread-out estates raise the heartbeat's price.
3. Bank branches as real places — containers and storage with
   capacity and holding costs (piece 9's branch classification, pile
   decay as the bank's own line, the warchest band on screen).
4. Roads — a route-cost modifier from the traffic overlay, making
   every edge a three-way market (bodies off-road / on-road / link).

**Tier 2 — the cutover (M2, then M3):** runners execute the engine's
plan in the mockup, `plan.ts` retires, the M1 cell re-passes; then
the fidelity line measures actuals against expected/standing — the
believer certifies accounting, the mockup audits it.

**Tier 3 — beyond one room:** scout (coverage, axiom-priced) →
remote mining + the reserve corp (a pure multiplier corp) → claim /
new-spawn-site (the first depth-2 chain; the founding-kernel
placement function) → guard + tower with `safe(place)` (awaiting the
deterrence-floor ruling).

**Cross-cutting, pulled in when measurement demands:** the real depth
dial and the racing harness (where the deferred objective
conversation happens); the replacement-scale displacement rule
(standing fleets are currently immortal incumbents in steady state);
pricing spawnTime in merit once p/t binds; per-RCL link-count
scarcity (the REAL reason outposts consolidate in the game).

### Tier 1 landed — and the findings ledger (2026-08-23 overnight session; DRAFT, awaiting owner review)

The four Tier-1 items landed in order (build corp + approvals, extensions,
bank branches, roads — commits #176–#179 on the reboot branch), each with
its engine suite; the believer now plays the whole arc headless in ~26
chunks (certified in `test/unit/believer.test.ts`): cold start → ramp →
extension → container → warchest under real rot → link approval → site →
construction TIME → displacement → steady 16.9 e/t dividend, with
storage's unreachability printed every replan. A 15-agent adversarial
stress-hunt ran against the pre-session HEAD; its confirmed findings are
folded in below. **Nothing in this section is a ruling** — it is the
session's record of what broke, the arithmetic, and what each break
revealed. Items marked ⚖ deviate from or extend recorded doctrine and
need the owner's explicit ratification or reversal.

**Breaks that forced structural changes (landed, each pinned by a test):**

1. **A candidate structure on the order book strands its edge.** The
   funded-but-unbuilt link sat FIRST in the book (cheapest marginal), so
   the workable haul options behind it never funded and the flow stopped
   for the whole construction window. Reveal: the book may trade only
   what can move energy TODAY; investment is a separate plan section —
   `plan.approvals` — decided against the funded plan's own traffic
   (piece 7's "traffic generates candidates", literally).
2. **Without a warchest, no capex can EVER accumulate.** The controller
   drank the whole residual every replan, so stock never grew and every
   investment starved. Piece 9 names the reserve band; it is now
   structural: the target is Σ `awaiting stock` capex plus open sites'
   remaining — no constant. ⚖ v1's macro doctrine ("bank to the
   warchest, consumers burn the residual") is implemented as
   divert-EVERYTHING while below target, which lapses the upgrade fleet
   during accumulation and rebuys it after — visible fleet churn in the
   lab. Whether standing burners should keep drinking during
   accumulation is the owner's call.
3. **Zeno's construction site.** Deriving the burn as remaining/window
   re-priced a shrinking remainder each replan: geometric decay, a site
   that never finishes (33→16.7→8.3→… e/t, watched live). Reveal: a
   steady-state ledger cannot price completion time at all; the rate
   base must be the project's TOTAL (constant over its life), and the
   deeper completion-time economics wait for depth.
4. **Living fleets were immortal incumbents — twice.** Sunk-quote
   ordering (backed = 0 cost) meant the standing link could never take
   its edge back from the haul fleet it beat, in round 3 AND inside the
   order book. Reveal: the roadmap's own flagged "replacement-scale
   displacement rule": in a steady-state ledger replacement is
   continuous, so ordering prices bodies at their amortized bill;
   backed-first survives as the TIEBREAK (anti-thrash intact). ⚖ This
   reads piece 5's "until bodies near expiry" as "replacement time is
   always, a little" — ratify or bound it.
5. **#148 was not wired into the haul quote.** Bodies sized to budget on
   sliver flows (the 24-CARRY class, alive in v2) inflated edge unit
   costs so badly a 10000e link pair "won" a 2 e/t trickle at dist 5.
   Reveal: `haulerBodyFor(flow, dist, budget)` — each marginal body sized
   to the flow still uncovered; the candidate comparison prices the
   incumbent at the IDEAL fleet, never the quantized one.
6. **The residual let the controller drink owed bills** (stress-hunt,
   confirmed). Backed steps quote sunk-zero, so `refill` alone
   understated the heartbeat by the standing fleet's amortized
   replacement; the believer's bank drained at exactly that rate until
   pinned. Same class, spawn currency: `spawnUsed` started at zero each
   replan, so the capacity constraint eroded as steps became backed.
   Reveal: every standing obligation seeds its constraint —
   standingBills off the residual, standingSpawnEt into the machine, and
   `standingFeesEt` exported so the wire's tax reaches cash readers.
7. **Whole-step sinks strand sub-quantum residual forever** — and
   quantization noise swallowed counterfactual deltas whole (a +2 e/t
   extension gain read as Δ=0). Reveal: the last sink step funds
   PARTIALLY (utilization < 1 was already first-class); the controller
   drains the residual exactly. ⚖ Alters the worked-550 fixture's pinned
   numbers (upgrade 16 → 244/15, five steps).
8. **The survival budget is a regime, not a flag.** An any-creep-alive
   test deadlocked the cold start the moment the tender (the only
   affordable body) hired; sizing to instantaneous stock instead bred
   runt cohorts on every dip (spec-01's equilibrium, re-observed).
   Reveal: v1's law with "staffed" meaning PRODUCTION staffed — capacity
   when income can refill the estate, cash-in-hand floored at the
   spawn's 300 when production is dead.
9. **The binary ramp filter stalls the mid-bootstrap.** Any standing
   income lifted the solvency bound entirely, so one 1.25 e/t workman
   authorized a 950e specialist chain the executor could not buy for a
   hundred chunks — while the plan refused the affordable workmen that
   would have grown the income. Reveal: ramp solvency is CONTINUOUS —
   upfront ≤ stock + one project window of standing accumulation (net
   of bills and rot). Cold start reduces to the old stock-only rule.
10. **The estate is the bank's zeroth branch.** Charging pile rot on the
    whole bankStock ate the bootstrap workman's ~1 e/t net (the spawn's
    own 300 "rotted") and stalled the colony at one body forever.
    Reveal: spawn + extension stores are decay-free VESSELS — exactly
    bodyBudget worth — and the convexity applies only to the ground
    share above them.
11. **Pile decay bounds the reachable warchest** (the asymptote at
    vault + 1000·stream — v1's convexity docblock, promoted to a
    solvency law). Chasing capex beyond it would pause the dividend
    FOREVER and never arrive; the engine now prints `capex unreachable`
    and keeps the controller drinking. Storage (30000e) is genuinely
    unreachable for a 2-source container-branch economy — the printed
    line is the standing exhibit for the flow-funded-capex ruling below.

**Design-level findings awaiting owner rulings (recorded, not acted on):**

- **Losses are flows, not fees** (stress-hunt, confirmed 0.95): the
  link's 3% rides as a scalar `feeEt` while `provides` stays gross, so
  the position book never sees the loss and every cash reader must
  remember a side-channel (the believer forgot: 45e/chunk of phantom
  cash per trunked source — patched with `standingFeesEt`, but the
  honest fix is `provides: 0.97·flow` so the book itself enforces it,
  which also fixes the trunk slices charging tax on QUOTED rather than
  allocated flow). A vocabulary change — constitutional event.
- **Flow-funded capex.** "Investments draw from stock" meets the decay
  asymptote: big capex (storage, multi-link campaigns) physically cannot
  accumulate as stock in a pre-storage world — yet a build site absorbs
  at rate r just fine, funded from the divertable stream with stock as
  the BUFFER, not the prerequisite. Real colonies build storage exactly
  this way. Needs a ruling on the approval gate (rate-solvency vs
  stock-solvency) and on project pacing.
- **Per-edge quantization is #150 at plan time** (stress-hunt, 0.92):
  each (from→to) pair ceil()s its own fleet, so three same-direction
  sources buy more CARRY than one pooled fleet needs. Sizing the last
  body to the remainder (landed) shrinks the sliver but the cross-edge
  ceil remains: transport should quote a FLEET against the netted
  position book, with body→edge assignment behind the dispatch boundary
  (piece 7 already says dispatch lives there).
- **The radial bank is a waypoint tax** (0.9): a source 2 tiles from the
  controller pays the full source→bank→controller round trip because the
  view carries only star distances. Bank-as-counterparty (ledger truth)
  vs bank-as-waypoint (routing assertion) — the model needs a
  place-to-place distance function before Tier 3; the book stays cut at
  the bank financially either way.
- **The reserver is unquotable** (0.9): sourceCaps are broker constants;
  no Offer can MULTIPLY another corp's provides. Tier 3's "pure
  multiplier corp" needs either a `capacityAt(source)` commodity
  (vocabulary event) or caps as functions of funded steps.
- **Succession is inexpressible**: ttl reaches quotes only as a display
  note; a dying miner quotes as full standing capital to its last tick,
  and its replacement cannot coexist with it in the schedule (slots
  conflate simultaneity with succession). Fine for the believer (no
  expiry by ruling); blocks the mockup cutover (Tier 2) — the vocabulary
  needs an `expiresIn`/spawn-lead treatment there.
- **Spots and eviction**: standing room is a quote-side headcount, not a
  market constraint — a runt miner from a poorer era occupies a 1-spot
  source forever (quote exhaustion is a silent close, no frontier line),
  and piece 5's challenger arithmetic has no eviction implementation.
  Needs substitution steps or spot-capacity clearing.
- **Incumbency is keyed to corp-id strings**: creeps re-hand only to
  identically-named offers, so a route re-assignment (outpost coming
  online) culls a working fleet instead of letting it compete on the new
  edge; relatedly the outpost via/direct choice is a fresh-body
  heuristic OUTSIDE the book (it should be two competing chains on one
  sourceId). Re-handing should be by capability-at-place.
- **Commute is still priced at zero** (0.85): a 150-tile remote chain
  quotes ~+4.6 e/t and nets ~0 — bodies amortize over 1500 regardless of
  posting walk. v1's `effectiveLife` awaits its port into the sizing
  handoffs (piece 4 named the column; Tier 3 needs it).
  **LANDED 2026-08-24 — Addendum 6** (owner: "shouldn't the body be
  prorated for travel time"): effectiveLife ported; upkeep and machine
  time prorate per handoff-stated commute; the standing seeds follow.
- **energyAt is vessel-blind** (0.85): a 0-CARRY miner "feeds" a link it
  physically cannot load; the book calls it balanced. Vessel typing (or
  loading `requires`) is a frozen-vocabulary change — flagged before
  Tier 2 makes it a live fidelity gap.
- **Assorted, smaller**: the tender's machine time can be preempted by
  producers in the spawnTime currency (obligations-first is
  energy-only) — and the OBJECTIVE starves the same way: a 14-source
  one-spawn staged world mines 120 e/t forever with CP pinned at ZERO,
  because production wins the machine in merit order every replan, the
  upgrade sink never staffs, and the surplus rots at the bank (~92 e/t
  of holding at t3600) while the escape route — wire — is itself gated
  behind builder bodies the machine cannot spawn; value realization
  needs a reserved machine share or the backward clearing direction
  (left unattended for 15k ticks the same world wires NINE edges and
  containerizes the bank, yet still realizes zero CP: each freed p/t is
  re-spent on more production and site-feed fleets, never the sink,
  while the surplus rots at ~84 e/t above the container cap — the
  steady state is a bonfire; five STAGED wires with no incumbent fleet
  clear 76 e/t of upgrading instantly, so the lock is the incumbent
  fleet plus production-first ordering, not the wire supply); spawnTime is a placeless scalar (blocks multi-room);
  the hurdle exists only inside candidate arithmetic — a no-sink world
  still funds production at full merit (value realization needs the
  backward direction or a shadow price); swamp roads (5× build, 5× gain)
  are invisible to route-level pricing; link pairs are legal only WITHIN
  one room, but the room-agnostic lab happily wires any two places — a
  cross-room "wire" the game forbids — so Tier 3's view must carry room
  membership, cross-border flow stays haul, and multi-hop relay chains
  (buying back the 800/d throughput ration at extra capex and a second
  3% tax) are unmodeled single-hop-only today; the extension counterfactual
  bumps budget but not estateRadius (under-prices the heartbeat's
  growth); builder bodies amortize over 1500t for ~300t projects (the
  believer's cash pays full price, only the P&L flatters); depth-0
  differencing is blind behind the ramp filter (a too-poor world can't
  SEE that an extension would pay).

**The closing adversarial review** (4-lens fan-out over the night's full
diff, findings verified by skeptics; commit #181): confirmed and fixed —
the partial-funded sink step dropped its backed fee from
`standingFeesEt` (the phantom-cash class, at a second door); ramp
accumulation summed backed income UNTRIMMED by source caps (rival
fleets on one source double-counted); the bank-branch rung credited the
ROAD network's upkeep as a saving the build could not deliver (the
review's one HIGH — storage approvable on rot it cannot remove); any
kernel site froze ALL link/road evaluation for its whole build
(`isSitePlace("bank")` matched every eligible edge); sink fleets' bills
joined the refill obligation AFTER the tender coverage check (silent
under-coverage, third door); the roaded/unpaved fleet composition was
re-derived inline in the broker (law 5's second-sizing-site disease —
now `haulFleetBillEt` in the one module); and the believer test's
cp-capture re-armed while cp was zero, certifying a false narrative.
Adjudicated the OTHER way, recorded: ⚖ the review proposed the ramp
ceiling as a PURSE drawn down per funded bid; tried, and reverted —
plan targets are the steady-state ledger, not purchases (cash is the
executor's hire loop), and the purse serialized multi-source ramps for
no solvency gain. And recorded as an open finding: body purchases and
the warchest share one stock with no reservation between them — hires
can dip the bank below committed capex (the warchest re-diverts and
self-heals, but the burst is visible fleet churn).

**Addendum (owner 2026-08-24, second ruling):** "some optimal
placements would involve a sort of branching tree structure with M1..MN
hauling to L1 which transfers back to the link at the bank." Landed:
links become SCARCE (`linkBudget`, the per-RCL allowance staged as a
scenario knob), and the placement search grows from per-edge stations
into a NETWORK PLAN — greedy by value-per-link, a private adjacent
mouth where one source is worth a whole link, a shared collection
station where it is not. The station stands free of every mouth zone,
so the assembly classifies it as an OUTPOST and the standing trunk
machinery routes the members through it: the tree is collectors →
station → hub, certified end-to-end on the believer under a budget of
two links. A wire that clears its hurdle but not the allowance prints
`link budget` — never the warchest: no amount of saving mints another
link. Collector legs are Chebyshev-approximated (recorded; real paths
when the traffic overlay walks tiles), and the mouth's own loading
still rides the vessel-blindness finding.

**Addendum 2 (2026-08-24, the forest stall):** staging the wide world the
tree ruling asks for (two 3-source clusters, six spread singles, one
spawn, budget six) found the economy that plans BOTH trees at t0 and then
never builds either — 100+ chunks at zero build progress. Root-caused to
three separate breaks, each a model lesson:

- **The plan under-specified its own fleet** (law 4, at the executor
  seam). A quote may size its LAST body to the flow remainder (the
  sizing law's runt), but `CorpInstance` carried ONE `body`, so the
  believer hired `target − live` copies of the first — 0.0013 p/t of
  sustain over the quote per runted route. At a saturated spawn that
  0.0027 p/t total tipped the next seed over capacity. Fixed
  structurally: the instance now carries `hires` — the bought bodies in
  funded-step order — and the executor hires exactly that list. One
  representation of the fleet, plan-side (law 2 applied to bodies).
- **Zero-marginal machine time could be refused.** With the seed alone
  over capacity, the strict spawn check broke even increments demanding
  ZERO machine time — backed steps whose sustain is already seeded. One
  epsilon of overshoot defunded every sink, culled the fleets, culled
  the TENDER (the axiom!), and the next plan re-bought everything: a
  period-2 hire/cull oscillation, forever. The checks now gate only
  increments that demand machine time; a seed over capacity prints one
  `spawn capacity` line on `spawning:capacity` instead of cascading —
  signalled, never valved (law 4).
- **The ladder applies to the MACHINE currency** (the bonfire finding's
  fix, first rung): capital sinks' spawn needs are now RESERVED before
  phase-2 production bids consume the machine — without it a
  machine-bound world re-spends every freed p/t on more mining and its
  approved builds stall. The tender (obligations) outranks the reserve;
  the dividend's own share still awaits the owner's ruling.

With the three landed the forest closes end-to-end: both stations build,
two bank hubs share across rooms (west hub serves the west tree AND
sK's private wire), six links on a budget of six, and the dividend
flows. Also landed while staging it: the station-cluster enumeration
radius is a bound only (Chebyshev ≤ 20) and a member whose own
contribution prices negative is DROPPED rather than sinking its
cluster (a station needs two members that each genuinely pay). Design
finding, recorded not valved: the network plan approved
`station:e1+e2+e3`, but once the station STOOD the standing market
repriced e3's edge marginally and kept it on direct bodies (the leg +
3% tax lost to the shorter direct route) — the t0 tree and the settled
routing can disagree at the margin, because candidate pricing is
tree-at-once and standing pricing is edge-by-edge. The plan stays
honest either way (the book audits clean); whether the CANDIDATE should
price member-by-member against the standing alternative is an owner
call.

**Addendum 3 (owner 2026-08-24, third ruling — displacement):** on the
settled forest shedding e3 from its planned tree: "No but only close
ones would be leaving link transfer capacity on the table. We could
displace more hauling with a better placement." The investigation
(4-lens fan-out, one dynamic repro) found e3's price test PASSED — via
0.041 vs direct 0.051 e per e — and the shed was a phantom capacity
shortfall: assembly minted every outpost's trunk range from the
FIRST-found bank link (the border bank's off-room hub, an illegal
pair), 800/27 = 29.6 e/t instead of the legal pair's 800/23 = 34.8 —
0.37 e/t short of three members; quoteTrunk was then fed that same
illegal pair unchecked. The mis-shed member bought a road that
entrenched the wrong routing. Landed:

- **One lens on trunk legality.** ViewOutpost lost `range`/`distToBank`;
  the engine derives the trunk's pair AND ration from `linkPair` — the
  same legal-closest-pair rule the mouth books already used. An
  assembly-minted range was the v1 disease (a second lens on pair
  legality), and it was wrong at exactly the border-bank shape the
  believer itself builds.
- **Merit-ordered slice admission.** Via candidates gather first, sort
  by displaced saving (direct unit − leg unit − tax), and seat into the
  ration in that order — first-come-by-array-order gave a binding
  trunk's slices to whoever iterated first. The standing trunks now
  RE-SEAT membership every replan: in the forest, sI (74 tiles direct)
  and sN (76) each displace ~0.30 e/t and took the third slices from
  w3 (0.17) and e3 (0.10). Same six links, ~11% more CP at t9000
  (435,990 vs 391,966). e3 stays direct — outbid, not forgotten; the
  capacity is full, not on the table.
- **A standing direct wire never rides a tree.** The route heuristic
  compared BODY units on both sides and pulled sK/sL off their own
  standing pairs into double-taxed relays through the stations,
  stealing slices (caught in the first re-run). Direct marginal is the
  same 3% with no leg; the guard is absolute. (True relay chains —
  buying throughput back at a second tax — remain unmodeled, their own
  rung.)
- **stationSearch: the tile IS the economics.** The station tile is now
  the argmax of summed member savings (clipped at zero — close members
  opt out, the owner's line), with the room-legal hub chosen inside the
  search per tile, the ration merit-trimmed inside, and the fleet-bill
  staircase's wide ties broken toward displacement then compact legs.
  The old argmin-summed-ranges tile was blind to all of it: for a
  2-member cluster its objective is CONSTANT between the members and
  the centroid tiebreak split legs evenly, pricing marginal members
  out one CARRY pair from paying (pinned: the tie-plateau pair where
  the shift is free). Room legality was a post-hoc veto of a tile
  chosen blind; membership no longer requires the member's own mouth
  pair to be legal (only the station's room needs the hub). planNetwork
  consumes the search — one owner of the member arithmetic; the
  believer realizes the search's own hub (a first-member wireStations
  re-derivation could pick the wrong room's).

Recorded, not valved: the t0 candidate's member list is a birth record,
not a contract — the standing market re-seats better members than the
pair/triple ≤ 20 enumeration can name (sI/sN joined trees no candidate
enumerated; approvals price the enumerated tree, the settled trunk
earns the re-seated one; books clear either way). Whole-supply slices
still strand sub-slice remainders (4.8 e/t idle can't seat a 10 e/t
member). Best-outpost-only per source: a source whose best trunk is
full falls to bodies, never to the second-best standing trunk. The
route heuristic still prices roads at zero — a road paved for a direct
route strands when routing flips via. Membership is judged by two
oracles that can disagree at the margin (approval: fleet-bill staircase
on Chebyshev legs; routing: smooth haulUnit on real paths — one member
in a swampy pocket can be planned in and routed out). And the believer's
realize() re-derives the search on the MUTATED world: a re-search that
nulls or shifts at completion burns the project's capex with nothing
(or the wrong thing) standing — the honest fix is the approval carrying
its priced tiles as plan state, an owner conversation. Widening
enumeration (M1..MN groups, second stations, partial slices,
second-choice trunks) are the next rungs, owner-gated.

**Addendum 4 (2026-08-24, fourth conversation — the port anatomy: the
dampener and the link-and-bank tender; DRAFT, rulings requested):** two
questions put by the owner: whether a link fed by multiple haul routes
needs a DAMPENER — a container and a tender creep — and why; and the
link-and-bank tender that keeps the core link empty so incoming
transfers land, occasionally filling it instead when a send is called
for. Both answers turn out to be already bought on the live colony —
v1 ran this exact machine, measured every failure mode, and hardened
the doctrine (specs 26, 45, 49, 54, 56 and the primitives docblocks) —
so this record QUOTES the paid lessons rather than re-deriving them:
the porting law applied to design. Nothing below is a ruling; ⚖ marks
what needs one.

*Why the dampener — the wire's quantum against the routes' phases.*
The book prices a wire as a smooth ration (800/range e/t); the physical
device is a VOLLEY machine: one 800 store that must serve as both the
staged payload and the landing room, and a cooldown charged IN FULL
however little moves — the engine clamps a transfer to the target's
free space, so the partial volley is the waste mechanism, not a failed
retry (spec 45's trap note). Haul arrivals are wheeled quanta on
independent phases. One collector leg can be quantum-matched (v1
capped deposit bodies at the 16-CARRY landing quantum for exactly this
reason); N legs superpose, their phases drift with every replacement
body, and bursts meet the link mid-cooldown no matter how anything
staggers them. At that tile the fleet's two sizing laws collide (owner
2026-08-05: haulers "are sized for full time moving" — duty ~1.0 is
their contract — while the wire wants only full volleys, the cooldown
being flat): with no third element, one law breaks. v1 measured both
breaks. Haulers holding at full links: portWaits to 602t (spec 54),
22.4% of port arrivals holding (spec 56), fleet portWaitFrac 0.228 ≈
8.6 e/t of parked hauler value ≈ 17% of the colony's controller
delivery (spec 45). Partial volleys: hubClampShare 0.45–0.625, volleys
averaging 378–500 of 800 — the ration halved. Holding haulers until
the link clears is not a fix — the haul-vs-link exchange rate (walk
cost / tax cost = 1/0.03 = 33×, distance-independent) prices a
one-beat hold as losing to the whole 24e tax after ~1.9 idle
hauler-ticks, ~0.6 with three queued. And capacity was never the
defect: rho measured 0.85/0.78 — MARGINAL, not oversubscribed (spec
49) — which is what redirected v1 from "route less" to "buffer and
drain it". Hence the dampener, in v1's own anatomy (spec 54): **the
container is the mouth** — arrival space with no cooldown and no
writer limit, so any number of haulers dump and leave at full duty;
**the tender is the throat** — the single writer that keeps the link
topped, so it fires a full volley the tick cooldown ends and the
ration is actually realized; **the link is the pipe**. Two boundaries
keep it honest. It is VARIANCE machinery, never capacity: at assigned
flow ≥ the ration the buffer fills once and stays full (spec 45's
saturated band — there the routed load must come down, and the book
already trims slices to the ration). And it is what makes the station
auditable at all (law 4): with one writer, expected = min(supply,
ration) net of tax, derivable from the instance; with N racing writers
the expectation depends on their phases and the seam cannot even be
stated. The believer sees none of this by construction (steady-state
rates; plan-vs-actual zero), so the dampener is a Tier-2 fidelity item
of exactly the vessel-blindness class — designed now from the paid
record instead of re-bought at cutover.

*The model — port fields on the link corp instance (yes: the link
corp's own property).* v1 ran the ownership experiment so v2 doesn't
have to: a standalone PortTenderCorp shipped and lasted one commit —
"link, tender and container are ONE machine: the container is the
mouth, the tender is the throat, the link is the pipe. Splitting them
across owners is how the drain went missing" (spec 54: spec 49 sized
the buffer, and then nothing ever emptied it — 2000/2000, both of a
hauler's escape hatches shut). The owner had already named the shape
(2026-08-08: "the link+tender+container can all be ruled by the link
corp"; 2026-08-06: "there's no miner, but we still want a tender"),
and v2's own tender ruling points the same way (2026-08-23: filling
the estate is the spawning corp's own operation — so loading and
draining the wire is the link corp's own operation, never a haul
quote; haul serves edges, not the wire's ends). A haul-fed port
therefore carries, on the instance: its **container** — corp capital
per piece 5, CONTAINER_COST capex + CONTAINER_HOLD_ET on its own
books, an approval like any other; spec 56's deadlock (FOUR lenses
answering "which container is this port's", each locally defensible,
jointly guaranteeing the port never got one) is the named scar behind
owned-as-data, one predicate; its **tender** — the corp's own body,
offer steps with buys/spawnTime/parts bill, the spawning corp's tender
shape verbatim, a CARRY-heavy parked shuttle (spec 54's two-shapes
finding: the estate tender walks, the port tender parks); and its
**posture** — keep-topped. The bank hub is the same record,
degenerate: store = storage itself (nothing to build), tender parked
on the pivot tile adjacent to link and vault, posture inverted
(keep-empty). WHO LOADS decides who needs one: a private mouth loaded
by its adjacent miner needs none (the miner is the single writer —
once the vessel-blindness fix gives it the CARRY to load with); a
consumer-parked link (the eventual controller link — withdraw-only BY
RULE, spec 45) needs none; a haul-fed station always does. ⚖ Trigger
to ratify: HAUL-FED, not fan-in ≥ 2 — a single-route port still pays
the bounded mid-cooldown wait every trip, and v1 shipped the full
anatomy on every deposit port. ⚖ Pricing follows the anatomy and
AMENDS piece 5's sentence: a haul-fed standing pair is no longer "the
3% and nothing else" — marginal = tax + the tender's amortized bill +
the container's holding line; and the CANDIDATE station carries
container capex + tender bill in its full cost (v1 debited exactly
this in its link election: portTenderHaulEquivalent, spec 26 stage 5).
That closes the haul-fed half of the vessel-blindness finding; the
miner-fed half stays open. Placement inherits the anatomy: a station
tile must offer a container spot "best accessible to incoming hauling
routes as well as adjacent to the link of course" (owner 2026-08-06,
quoted in spec 56) plus a tender post adjacent to both, and the hub
keeps a pivot tile adjacent to link and storage — stationSearch
constraints, lab-side with the rest of the spatial knowledge.

*The link-and-bank tender — v1 answered this question verbatim* (owner
2026-08-07, preserved as CORE_SERVICE_CARRY_PER_SENDER's docblock):
"the core link has a feeder tender creep slave. It empties it to
ensure incoming links can transfer (links coming off cooldown) and
fills it when if necessary when it needs to send energy to the
upgraders." Keep-empty is SENDER protection: the sender pays the
cooldown while the transfer clamps to the hub's free store, so every
unit of residual at the hub taxes every sender's volley. v1 measured
the disease and the cure end to end: core empty only 26% of ticks,
half of all volleys clamped, ports running at half their ration; the
arrivals-first legs landed and clamp fell 0.625 → 0.154 (−75%, later
0.000) with coreEmptyShare 0.652 — "a drained core is that heartbeat
working, not congestion; the core link is a pass-through to storage by
design" (spec 45's verdict). The doctrine carries in three owner
lines: **drain on demand** ("They need to drain the core link pretty
much on demand. Anytime an incoming link is imminent. It can't be a
bottleneck." — 2026-08-05); **arrivals first** — inbound energy
outranks staged energy at every buffer: pre-drain to zero the tick any
sender stands loaded within near-fire, stage for an outbound send only
while no inbound is pending (v1's earlier partial form was an income
reserve carved out of the fill ceiling, CORE_LINK_INCOME_RESERVE; the
pre-drain superseded it); **landing room is the tender's job, never
the senders'** ("No the core link can always be tendered to the
storage" — 2026-08-06, the line that dissolved every send-side scheme
for protecting the hub). The FILL posture is the same body and the
same seam with direction as data — and its arbitration is pre-ruled by
v1's one counterexample: the controller-link port kept TOPPED by its
relay was spec 26's live collapse (t72512031, fleet 30→13, reverted) —
a receiver a fill posture may hold full is one no arrival needs.
Sizing is the record's sharpest lesson, because v1 corrected itself:
spec 45 floored the shuttle at one whole volley (16C, clear it in one
cycle) and the A/B refuted the premise — the mechanism is CONCURRENCY,
not capacity ("one creep working harder cannot cover two senders
arriving at once"): the hardened form is **one parked shuttle PER
inbound sender at 4 CARRY each** (the owner's own 8-for-our-room, 4 at
low RCL; a 2-tick withdraw+transfer cycle clears 800 in ~8t, inside
any sender's cooldown), while the 16C floor measured as over-insurance
— clamp 0.000, but 100 spawn parts ≈ 15% of the whole fleet on the
single most expensive corp. LINK_PAYLOAD_CARRY (16 — the landing
quantum, the deposit-body cap) and the shuttle's service body are
deliberately SEPARATE constants: "not the same quantity; they no
longer scale together." The CPU variant (8/sender, half the intents)
is recorded and unwired — the governor's trade, for when intent cost
joins the currency. What stays runner-side, behind the dispatch
boundary and stamped through the one counter: the same-tick sender
QUEUE (two senders firing at one 800-free hub blockade each other —
reserve free space within the tick, biggest payload first), full-volley
discipline only where we control the drain, and the senderFull relief
valve (income outranks cooldown efficiency at a saturated mouth). The
plan sizes the port; the vertical sequences the volleys.

*⚖ Rulings requested:* (1) the port anatomy as fields on the link corp
instance — container as corp capital, tender as corp body, posture as
data; (2) the marginal-price amendment to piece 5 — haul-fed pairs
price tax + tender bill + container hold, never bare 3%; (3) the
trigger rule — every haul-fed port gets the full anatomy, miner-fed
mouths and consumer-parked links get none; (4) arrivals-first as
carried doctrine: inbound outranks staged at every buffer, and a fill
posture may never cost landing room; (5) the sizing ports into the one
module, docblocks intact — LINK_PAYLOAD_CARRY and the deposit cap,
CORE_SERVICE_CARRY_PER_SENDER and shuttles-per-sender,
portTenderHaulEquivalent for the election; (6) certification shape: a
Tier-2 mockup cell (the believer cannot see sequencing), gauged the
way v1 learned to read this machine — clamp share, empty share, port
waits, volley average, hauler duty — bands pinned multi-draw before
anything is tuned.

**Addendum 4 RATIFIED — the first landing (owner 2026-08-24, fifth
conversation: "Alright so let's add this to refine our model."):**
rulings 1, 2, 3 and 5 are ratified and LANDED in the engine; 4 and 6
are ratified as doctrine and land with Tier 2 (the believer has no
runners to sequence). What the model now says, certified green
(93 unit + 8 integration, the believer arc extended):

- **The throat is a real body on the trunk's offer** — step 0, zero
  capacity, `portTenderBody(flow)` from the one module — referenced by
  EVERY member chain, so no member funds without affording it and it
  funds with whichever member funds first. The market gained the
  matching law: **a physical step funds and charges ONCE**, however
  many chains reference it (fund/charge idempotence by offer object —
  the first-member-only attachment was rejected because a poor bank
  could close the first chain and run the trunk throatless). The
  believer hires it through the standing `hires` machinery — which
  surfaced a latent indexing defect: hires were indexed by `backed`,
  which also counts structure-backed steps, so a mixed corp (pair-backed
  slices + an unbacked throat) could never hire; the index is now
  live-at-chunk-start, one meaning of "next hire" for every corp shape.
- **Piece 5's sentence is amended in the quotes**: a standing wire
  prices the 3% PLUS its port service — the per-sender hub shuttle
  (`CORE_SERVICE_CARRY_PER_SENDER`, ported with the owner's 2026-08-07
  quote and the concurrency A/B in its docblock) rides every wire's
  fee, and the standing buffer's `CONTAINER_HOLD_ET` rides the trunk's.
  Candidates carry the same terms plus capex, so displacement stays
  symmetric. ⚖ Recorded deviation, Tier-2 work: the hub service is
  FEE-form (the believer's steady-state representation — paid in cash
  every chunk) until the succession vocabulary lets it hire for real;
  the porttender wedge (a body charged, never spawned) is the failure
  mode that conversion closes, and fee-form charges no machine time.
- **The buffer approves as the standing trunk's OBLIGATION**, ahead of
  the merit spend — kit, never ROI (its benefit is Tier-2 sequencing
  the steady-state ledger cannot see, so pricing it as a candidate
  would refuse it and re-buy v1's 22.4%-of-arrivals-holding machine).
  It realizes as ground capital at the port (`Scenario.containers`),
  read back by ONE range-2 lens in assembly (spec 56's law), and its
  holding joins the trunk's fee the replan it stands. Station
  candidates price the whole anatomy in their hurdle — throat bill,
  hub fee, hold, container capex over H — so a tree cannot clear on
  arithmetic its own kit falsifies. Recorded gap: the purse pays the
  container at obligation time, one replan after the links — approval
  does not yet reserve it.
- **Collector legs cap at the landing quantum** — `LINK_PAYLOAD_CARRY`
  (16C, roaded 8 pairs), spec 45 leg 3 ported with its docblock: one
  arrival is one unload intent; surplus CARRY converts to standing
  time at the port, never throughput. Walking routes keep the 25-pair
  body limit; the trigger is the gap's `linkFed` flag, set only where
  a route unloads into a port.
- **The trigger rule holds by construction**: trunks (haul-fed) carry
  throat + buffer + hub fee; a direct mouth wire (miner-fed) carries
  the hub fee alone; the bank hub is storage-backed and triggers
  nothing. Pinned in `port.test.ts` end to end, and the believer's
  tree now grows the full anatomy on screen: station → trunk funds →
  buffer approved and built → throat hired.

**Addendum 4, second landing (owner 2026-08-24, sixth conversation:
"The link doesn't show as requiring a body though? (Neither do the
mines for that matter) — besides the surface fix investigate how our
engine let that happen in the first place."):** the first screenshots
showed it — the settled trunk's body column read "—", and the settled
MINES read "—" twice over: no body, and an empty `in` column. A
settled row claimed to require nothing at all. The investigation:

- **Root cause: `buys` conflated the purchase with the requirement.**
  The corp contract's cheap incumbency ("backedBy marks a step already
  embodied, which quotes ~zero — no engine machinery") zeroed the WHOLE
  step at embodiment: the price (correct — piece 5) and, with it, the
  body and its bills (wrong — piece 5's own companion rule: "pricing
  forgets sunk costs; the books never do"). `buys` was defined as "what
  funding purchases; absent when backed" — so the moment a body lived,
  the plan forgot it existed. Law 2's own enumeration — "target, BODY,
  source, route, expected e/t" — named a field the instance stopped
  carrying the day the forest-stall fix replaced `body` with `hires`,
  the un-hired tail: that fix served the executor (what to buy) and
  left the books blind (what is run).
- **The tell: compensating mechanisms had already accreted** — disease
  #2 rebuilding itself inside v2, caught at N=4: the market's
  `standingBills`/`standingSpawnEt` seeds (aggregates that knew what
  the rows denied), the broker's `creepById` re-join inside
  `steadyUnit` (replacement-scale pricing rebuilt from the view because
  the step had forgotten its body), the believer's live-at-start hire
  index (the previous commit's patch — itself a workaround for `backed`
  conflating structures with creeps), and the panel's `hires[0]` (the
  surface symptom). Each locally defensible; together, two-lens drift
  around one hole in the one representation.
- **The fix: the step states its body; the instance states its ROSTER;
  the books price replacement-scale.** `Step.buys` → `Step.body`,
  stated backed or not (the cost fields stay sunk-zeroed — funding
  untouched). `CorpInstance.hires` → `staff: {body, live}[]` — one
  entry per funded body step, `live` naming the backing creep; the
  executor buys exactly the nulls, in order (the believer now staffs BY
  NAME — the count-trim, the hire-index arithmetic, and the
  live-at-start patch all deleted). The instance builder folds a backed
  body's sustain into its row — machine time and the amortized parts
  bill at the bank — so a settled row's `in` column states its
  requirement again, and ⚖ its P&L prices at REPLACEMENT SCALE
  (piece 1's "cost e/t (amortized bodies)" made literal; the same rule
  the order books already priced by, so the three cost lenses collapse
  to two: funding sunk, books replacement). Settled nets shift down by
  their fleets' bills; any future band re-pins from the honest number.
  Two view re-joins deleted outright (`steadyUnit`'s creepById,
  `tenderCapacities`' creep lookup); the position book's bank demand
  now carries the standing fleet's bills, so the bank's net is the
  leftover NET of sustain — the conservation caption reads true.
- **Recorded, not valved:** `standingBills` (Σ every live creep — the
  market's pre-clear seed) and the rows' summed sustain (the funded
  employed) remain two computations that agree at quiescence; the seed
  must exist before clearing produces rows, so it stays — flagged as
  the next one-lens candidate. And a corp with genuinely no bodies
  (`spawning:capacity`; a miner-fed direct wire) prints "—" honestly:
  the column now distinguishes "runs on no body" from "forgot its
  body".

**Addendum 5 (owner 2026-08-24, seventh conversation — overflow at the
port: the excess is a rate, never a member):** *"when the sources flow
exceeds the link capacity keeping the remainder as a haul is good.
However instead of specifying a specific mine with a hauler they could
still bring all 30 (for example) to the outpost and the link can hire
a hauler for the excess. And by hiring a hauler I just mean the plan
has it."* Landed, certified green (95 unit + 8 integration):

- **Nobody sheds.** The old admission was whole-supply-or-skip: a
  binding ration named a specific member and sent its whole flow back
  to a full direct route. Now a member takes the WIRE that is left and
  the trunk's own OVERFLOW bodies walk the rest of its supply from the
  port to the bank — collectors always carry everything to the outpost,
  and the outpost→bank leg is a two-lane market inside one corp: the
  ration at the tax, the excess at the walk. The overflow haulers are
  plan rows exactly as the owner specified — steps on the trunk's offer
  with real bodies (`haulerBodyFor` on the corridor's WALKING distance,
  a new assembly fact: `ViewOutpost.distToBank`, deliberately distinct
  from the wire's Chebyshev range per the Addendum 3 scar), hired and
  re-handed through the same staff machinery as the throat.
- **Admission blends; merit still seats.** Addendum 3's
  displaced-saving order survives as WHO rides the cheap wire; the
  admission test becomes the member's blended gain — wire share at the
  tax, spill at the corridor walk, against its direct route. The
  economics fall out naturally: a far member straddles (8.6 wired + 1.4
  walked beats a 27-tile direct route), while a near member whose spill
  would ride a 28-tile corridor against a 16-tile direct route stays
  direct — the trunk-test pin held on the new arithmetic unchanged.
  This closes the trunk-side half of the whole-supply-slices finding
  (sub-ration remainders no longer strand un-seatable); member-side
  whole-supply routing (a source never splits via/direct) remains v0.
- **One source of truth for the offer's shape:** `quoteTrunk` returns
  the offer AND its member-step layout (throat, wire share, overflow
  bodies per source) — the broker assembles chains from the quote's own
  map rather than re-deriving indices, which would have been a second
  lens on the offer's layout.
- **Recorded, not valved:** station CANDIDATES still price in-ration
  (a proposed tree caps at 800/range — overflow economics enter the
  hurdle when measurement asks); the overflow corridor generates no
  ROAD candidates (round 3 paves only haul-corp gaps — the trunk's
  walking leg is invisible to it); throat-vs-hauler re-handing matches
  by shape and collides at 1C1M and at the roaded 2C:1M gait (fungible
  bodies, books-neutral, but named); and the wire tax still charges on
  quoted rather than allocated flow (the standing losses-are-flows
  ruling).

**Addendum 6 (owner 2026-08-24, eighth conversation: "Also shouldn't
the body be prorated for travel time"):** yes — and the ledger already
carried the finding by name ("Commute is still priced at zero (0.85):
a 150-tile remote chain quotes ~+4.6 e/t and nets ~0 — bodies amortize
over 1500 regardless of posting walk. v1's `effectiveLife` awaits its
port into the sizing handoffs"). Landed, closing that finding
(95 unit + 8 integration):

- **v1's `effectiveLife` ported with its docblock** — `max(1,
  CREEP_LIFE − commute)` — and both amortizations prorate over it:
  `upkeepEt` (the parts bill grows: a posted body re-buys sooner) and
  `spawnTimeEt` (the machine time grows the same way; a commuting body
  re-spawns more often per WORKING tick). Provides stay full — in
  steady state the fleet is always posted; the commute is paid as
  extra replacement, exactly v1's treatment.
- **The commute is handoff data** — the broker states each posting
  walk where it builds the handoff: miners park at their source
  (`distToBank`); upgraders and builders park at their feed and site;
  the trunk's THROAT walks the corridor once (`distToBank`); a route
  that touches the bank commutes ZERO — its first empty leg is a
  cycle, not a posting walk — which covers direct hauls, sink feeds,
  and the trunk's overflow haulers; a COLLECTOR leg never touches the
  bank and pays the walk through its nearer end. `Step.commute`
  carries it, so the market's sustain fold and the broker's
  replacement-scale book ordering prorate the BACKED books identically
  — funding, books, and ordering stay one arithmetic.
- **The standing seeds prorate too**: `standingBills` and
  `standingSpawnEt` read a per-corp commute registry filled where the
  handoffs are built — without this the heartbeat under-covers
  commuting fleets silently (the tender-check class, spec 57's door).
  A mixed-commute corp (the trunk: commuting throat, cycling overflow
  haulers) registers its majority value; the rows stay exact per step.
- **Re-pinned under the ruling**: the worked-550 residual (244/15 →
  ~16.2524 — mines at 10/25 and upgraders at the feed's 5 bill over
  their effective life), the feed-fleet bill (5·500/effectiveLife(5)),
  and the port suite's throat/miner bills at their walks. In-room the
  proration is percents; the finding's 150-tile remote class — where a
  chain's whole net was phantom — is what Tier 3 now inherits priced.
- **Recorded, not valved:** the broker's `haulUnit` admission heuristic
  and round-3 candidate arithmetic (station fleets, road ROI) stay
  commute-free — both sides of each comparison equally, and the books
  still price the real thing; thread it there when a mis-ranked
  candidate is measured. Movement speed is still gait-ideal: commute ≈
  tiles assumes full-speed walking, and the miner's 1-MOVE body
  actually crawls its walk at ~5 ticks/tile — the commute understates
  for MOVE-light bodies; the honest per-shape walk time is sizing's to
  derive when the fidelity line cares.

**Addendum 6 CORRECTED (owner 2026-08-24, ninth conversation: "No, I
think the haulers should start at the source. So they also have a time
to live penalty and a[m]ortization."):** the first landing exempted
bank-touching fleets on a cycle-credit argument — a newborn hauler's
first empty leg out "is a cycle, not a commute." Overruled, and the
ruling's convention is the better model twice over. First, it is ONE
rule where the exemption was two: **every body's posting is its
PICKUP** — direct fleets and collectors start at their source, the
trunk's overflow haulers start at the port (the whole trunk roster now
commutes the corridor, retiring the mixed-corp hedge in the seed
registry), workmen start at their source, miners and parked service
bodies at their posts; only bank-pickup bodies (sink feeds, the estate
tender, the hub service) commute zero. Second, the cycle-credit
argument was exact only if the rate model is exact — it credited the
walk out against boundary losses the model does not carry (a body dies
mid-route with cargo aboard; load/unload ticks; the crawl of
MOVE-light walks). Pickup-posting charges the walk as a time-to-live
penalty and amortizes over the remainder: conservative by about half a
load per life, which is roughly what the un-modeled losses cost —
self-insurance instead of optimism. Round 3 follows the same rule
honestly now: the incumbent fleet's replacement bill, the road
counterfactual, and the station members' both-sides fleet bills all
prorate by the pickup walk — bodies pay commutes, wires do not, so
displacement thresholds moved toward the wire by exactly the walk.
Re-pinned: the worked-550 residual (16.2524 → 16.2393 — the fleets'
walks joined the bills) and the machine-currency identity with the
fleets' commutes stated. 95 unit + 8 integration green.

**Finding (2026-08-24, the big-map demo — recorded, not valved): the
machine-lock.** Staging the owner's ask ("a big map with many sources,
more than the spawn capacity" — 26 sources, one spawn, 100×100) found
a sharper variant of the bonfire: cold-started, the world staffs
production chains in merit order until the machine saturates, and only
THEN do round-3 approvals arrive — 15 sites approved, ZERO ever built,
because the capital reserve is `min(need, free)` and the standing
fleet's seed leaves free ≈ 0.0100 p/t against a builder's 0.0127: the
reserve cannot claw machine back from standing production, so the
wires that would free the machine can never be built. Locked forever —
140 e/t delivered, 15 e/t upgraded, 124 e/t to a bank at 1.4M. The
same 26-source world staged in two phases (16 sources → wires land →
THEN the far tier arrives) settles healthily: 6/6 links, 16/26
staffed at 153.5 e/t, a 72 e/t dividend, the far tier dark behind
`spawn capacity` lines — and the merit order even displaced an
original member (nw2) for a better far source (f9). The lock is an
ORDER-OF-ARRIVAL hole in the forest-stall fix ("the ladder applies to
the MACHINE currency" reserved only FREE machine): capital formation
needs either a standing machine share (the same open ruling as the
dividend's share) or replacement-time displacement in the spawnTime
currency — production bodies not renewed while an approved build
starves. Owner conversation; sits with the bonfire findings.

**Budget note:** src stands at ~3.75k lines against the ~3k budget
(~3.2k before Addenda 4–5 landed; the growth is the anatomy's quotes,
the roster, the overflow lane, and the ported docblocks). The overage
is docblock prose carrying the session's incident record in place.
Trim or ratify.

## The scenario ladder (DRAFT 2026-08-18 — awaiting owner markup)

Shaped in-session, reorganized per the owner: **tied to behaviors and
abilities — one certification suite per corp kind; one behavior may
need several scenarios.** Preserved here as draft; criteria finalize
per the working agreement before code toward them.

- **Method:** isolation by WORLD STAGING, never bot stubbing — the
  whole bot runs in every scenario; the world is shaped so one behavior
  is the only interesting thing to do (e.g. hauling certified in a
  sourceless room with a pre-filled container). Every scenario carries
  four signal layers: outcome band (multi-draw), standing invariants
  (conservation identity, sizing oracle, no starvation, blocked
  reasons), the mechanic's PREDICTED signature (thresholds from
  primitives asserted in sim), and stability (plan diffs quiescent).
- **Tier 1 — ability certifications:** sizing (the property gauntlet +
  named regressions: the 24-CARRY hauler, #148, the runt floor);
  spawning (order execution 1:1, the double-buy stage, survival regime,
  throughput under load); harvesting (saturation, spots-constrained,
  regen honesty, the deposit); hauling (route sizing at 5/15/30,
  roaded reprice, pooling/no-fragmentation, jitter); upgrading (draw
  discipline, points=energy identity, floor obligation under
  scarcity); building (funded instances only, rate band, asset lands
  on books); banking (conservation under staged flows, branch
  classification, draw-order under scarcity); later: scouting,
  linking (volley discipline + displacement at predicted break-even),
  reserving/claiming, defense (pending the deterrence-floor ruling).
- **Tier 2 — composition certifications:** the chain (with FAULT
  INJECTION: a deliberately weak stage, asserting per-stage F1 names
  the culprit); the specialization flip at predicted capacity; the
  link-vs-haul market; the bootstrap cascade (the engine's first mini
  test, no modes); the investment loop (hurdle → build → books →
  payback audited).
- **Tier 3 — campaign certifications:** easy cold start to RCL3; the
  runt world on harsh captured terrain; the remote; claim-and-found.
  The grid ratchet wraps tier 3; BOT LEVEL v2 resumes.
- **Certification order = development order:** sizing → spawning →
  harvesting → hauling → banking → upgrading → building → compositions
  → the rest. A behavior is certified before its dependents are built.
- Old estate reuse: bootstrap→cold start; flow-handoff→the flip;
  storage-depot→banking/investment; runt-economy→the runt world;
  remote-mining→the remote; tower-defense→defense.

## The live rule

`master` is the deployed bot and stays deployable. Nothing from the v2
line deploys to the live account until M6 is green and the owner calls M7.
Deploy scripts remain pointed at whatever branch is checked out — so the
guard is procedural: **do not run `push-main` from the v2 line.**
