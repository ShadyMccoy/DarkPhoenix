# 25 — Emergent dedication: route economics replace the dedicatedToBuild flag

**Status:** PHASE 3 IMPLEMENTED 2026-07-21 (owner: "let's work on phase 3
flag retirement - develop and test that locally") — the flag is RETIRED
end-to-end: `PlannerSource`/`CommissionedMiner`/`MinerAssignment`/flow-v6
fields deleted (flow v7), `detectTrunkBuildingSources` + the adapter wiring
gone, the pool-zeroing and demotion exemption removed (the plain
zero-routed contract is honest again), the waste-ledger P9 carve-out
dropped, and CarryCorp's trunk-receipt stand-down retired (the plan's
routes ARE the stand-down; the older home-room `dedicatedBuildSourceId`
spill-guard mechanism remains).

REVISED 2026-07-22 per the owner's no-residual directive ("I'm not so sure
about road building remotes sending energy home ... only build one (or
some) of the roads at a time, and just make sure to plan the economy as a
sound economy around it. There shouldn't be any residual - we can just
make a bigger builder if we need to consume all the energy from the source
mine during that time"). Two halves:

- **Plan (flowAdapter)**: remote construction sites cluster to the nearest
  mined source that satisfies the hub rule (nearer to the source than the
  source's hub; storage rooms excluded — home sites stay bank-funded).
  A clustered site's sink capacity is the SOURCE'S RATE pro-rata by
  remaining work — not the projectAbsorbRate completion horizon — so the
  source's whole output routes to its cluster and NOTHING ships home while
  the cluster stands. The pool-absorb budget now covers only UNCLUSTERED
  sites. Pin: "SOURCE-LOCAL sites price at the SOURCE'S RATE"
  (flowAdapter.test.ts).
- **Crew (constructionKind → ConstructionCorp)**: each spawn-room
  commission carries `poolAllocatedRate` — the summed construction
  allocations of the SPAWNLESS rooms that spawn staffs. builderPlan's home
  branch sizes the pool crew to the MAX of the two funding tracks (bank
  work capped by the absorb horizon, cluster work at the plan's
  source-funded rate) — max, never sum, because the crew works one project
  at a time (owner: "body parts standing around ... is one form of
  waste"). The source-funded rate joins AFTER the home-stock clamp: its
  fuel is the mine, not the depot. Pins: builderSizing.test.ts ("bigger
  builder" + MAX-not-SUM), constructionKind.test.ts (rate attribution +
  materialize threading + drop-to-zero on cluster completion).

Gated locally (unit 1180 + build + trio) and DEPLOYED 2026-07-22 on the
owner's go-ahead (the t72487226 audit measured the flag-era mechanism
dark-dedicating the trunk QUEUE — 30 e/t zero-routed and zero-building —
and the owner chose immediate deploy over holding local).

**VERIFIED LIVE END-TO-END 2026-07-22** (captures t72488716→t72489965):
income restored to all 7 sources on deploy (+30 e/t, routed 70/70 since);
the cee0 cluster formed live (15 construction sinks, source→site routes
in the plan, zero flags anywhere); mid-build 2:1 repricing engaged at
paved ≥0.5 exactly per `partialPaveRatio`; the trunk built 35→45/50 in
one day after 2,600 ticks frozen. Companion mechanisms that made it
stick: the project ledger (sink admission from corp memory — retired the
vision flap) and receipt-charged buildPool (retired the blind-room
crew deadlock). The completion transition (sinks vanish → full rate
home) is the one acceptance behavior not yet observed live; expected
within ~2 windows at the current build rate. Open live-verification item for the deploy:
the pool TANKER detail still fetches from the bank for whatever the pool
head is — if the head is a source-funded cluster site, that is bank energy
walking a route the plan funds from the mine; watch for it in the first
post-deploy capture (the crew's self-feed from the pile may make tankers
moot there).

Previously: PHASE 1 IMPLEMENTED 2026-07-21 (owner: "start on spec 25") —
the role-rule refinement + remote-sink admission + pool-absorb budget, with
the dedicatedToBuild flag still standing (coexistence: its pool-zeroing
keeps the new edges inert for currently-dedicated sources). Mechanics:
a LOCAL-BUILD PRE-PASS in routeToSinks (between spawn overhead and the
deposit fill, restricted to deposit sources nearer the sink than their
hub) implements tests 1–5; `main.ts` admits ANY visible room's own sites
(acceptance test 0's gate); per-site capacities are pro-rata shares of one
projectAbsorbRate pool budget (the floor-sum fix). Phase 2 = live
verification (source→site routes in captures); phase 3 = flag retirement
(tests 6–8, v7 bump, delete the three exemptions).

Originally PROPOSED (owner-directed 2026-07-21: "a lot of times adding the
flags has these very negative counter effects ... maybe what we should be
doing is visiting the planning module and getting it to behave the way we
want by working out some of these nuances rather than patching on a flag in
the tail end").

## The problem, from evidence

`dedicatedToBuild` (the trunk-build flag) needed THREE patches in its first
day live (t72480337, spec 14 audit log):

1. The FUNDED⇒ROUTED demotion read the flag's designed zero-routing as rot
   and dropped all 5 dedicated miners — funded mining 70 → 20 e/t, 193
   hauler parts stranded (fix: an exemption in the demotion).
2. Telemetry could not tell designed zero-routing from actual rot (fix:
   thread the flag through CommissionedMiner → MinerAssignment → flow
   segment v6).
3. The waste ledger's P9 rot detector would false-FAIL every capture for
   the whole trunk build (fix: a carve-out reading the v6 flag).

That is the trap-list signature of a mechanism-class problem: the flag
BYPASSES the router (zeroing the source's pool in `routeToSinks`) instead of
expressing its intent in the economics, so every rule that reasonably
assumes "routes nothing = dead" needs an exemption, forever.

**Root cause**: the hub-and-spoke role rules (CorpPlanner.routeToSinks) are
absolute — mined sources may ONLY deposit to the hub; construction sinks may
ONLY draw the bank. The owner's directive "feed the Z-to-A remote builder
from the source, and disable hauling anything home until the road is
finished" is a ROUTING statement (source → adjacent road sites), but the
role rules made it inexpressible as routing, so it shipped as a bypass flag.

## Design: the nuance, in the planner

Refine ONE role rule: **a mined source may route to a construction sink that
is nearer to it than its hub** (equivalently: construction sinks accept
mined supply at distances shorter than the source→hub deposit distance;
everything else keeps drawing the bank). Nearest-first then does the rest:

- A trunk road site sits 0–10 tiles from its source; the hub is 30–55 away.
  The fill routes source → trunk sites FIRST (cheapest edges in the whole
  problem), and only the residual (if any) deposits home. While the trunk's
  absorb ≥ the source's rate, nothing ships home — the owner's dedication,
  emergent from prices.
- The source is ROUTED, so the FUNDED⇒ROUTED demotion applies to it
  unchanged — the exemption retires.
- P9 sees real routed flow (source → construction) — the v6 flag and the
  ledger carve-out retire.
- When the road completes, the sink disappears from the problem and the
  source's output re-routes home on the next solve — the "resume hauling at
  the 2:1 rate when the paved receipt lands" transition falls out instead of
  being coded in the flag's lifecycle.
- Home construction is untouched: home sites are nearer the hub/bank than
  any source, so they keep drawing the bank.

**Anti-pump stays structural**: this ADDS mined→near-construction edges
only. The bank still never deposits, storage still never self-feeds, and
bank→construction (home sites) is unchanged.

**Absorbs the filed per-site-floor item** (spec 14, 2026-07-21): per-site
construction sinks currently each carry the max(5, …) projectAbsorbRate
floor — 10 road sites = 50 e/t of plan demand against a pool absorbing ~7.
With source-supplied sites, a site's demand is bounded by its supplier's
rate and its own remaining work; the per-site floor's sum stops being
bank-funded fantasy. (Exact treatment in the acceptance tests; if the floor
sum still distorts bank-funded home sites, that residual stays a separate
work item.)

## What retires

- `PlannerSource.dedicatedToBuild`, `CommissionedMiner.dedicatedToBuild`,
  `MinerAssignment.dedicatedToBuild`, the flow v6 sources[] field (v7 bump
  removes it), the adapter's `trunkBuildingSources` wiring, the pool-zeroing
  in `routeToSinks`, the demotion exemption, and the waste-ledger P9
  carve-out.
- CarryCorp's `yieldsToBuild` receipt-read (the standing-fleet half of the
  flag) — replaced by the same plan-derived signal every hauler already
  uses: no planned route home = no haul (verify before deleting; if live
  fleets need a transition ramp, keep it one release and retire on the next).

## Acceptance tests (write first)

0. **No off-plan construction logistics** (owner 2026-07-21: "construction
   crew tankers definitely should be part of the plan"; measured
   t72484107: zero construction sinks in the solve while the pool crew's
   18C:8M tanker worked remote sites entirely off-ledger): once remote
   construction sinks are admitted (this spec's routing refinement), the
   plan's parts ledger charges the crew's WORK **and** its haul/tanker
   logistics for every standing site, home or remote — no construction
   body class exists outside the ledger. Pin: a remote-site world's P4
   table carries the construction-haul charge; the corp's fielded tanker
   parts reconcile against it.

Unit (CorpPlanner.test.ts unless noted):

1. **Emergent dedication**: hub world, source S with road sinks 3 tiles
   away (total absorb ≥ S.rate) and hub 40 away ⇒ ALL of S routes to the
   road sinks, zero deposits home, S's verdict "funded", miner stands. No
   flag anywhere in the problem.
2. **Residual deposits**: road sinks absorb 4 of S's 10 ⇒ 4 routes to the
   sites, 6 deposits to the hub (partial dedication is fine — it's just
   routing).
3. **Completion transition**: same world minus the road sinks ⇒ S's full
   rate deposits home (the resume-hauling behavior, no lifecycle code).
4. **Role guard**: a construction sink FARTHER from the source than its hub
   still draws the bank, never the source (home-site behavior pinned).
5. **Anti-pump unchanged**: the bank still routes to no storage sink; the
   existing structural-anti-pump pins stay green verbatim.
6. **Demotion, unexempted**: with the flag gone, a zero-routed source (its
   road sinks vanished AND the ledger starved its deposit) demotes exactly
   as the t72445337 pin demands — the exemption's deletion is red-green'd.
7. **Telemetry v7** (flowPlan.test.ts): sources[] carries no
   dedicatedToBuild; the source→construction routes appear in haulers[]
   (the audit reads dedication as ROUTES, not a flag).
8. **P9 honest again** (ledger): a trunk-building capture reads routed ≥
   the source→site flows; no carve-out branch.

Integration: the regression trio, plus a grid cell staging a remote trunk
(sites + source, no receipts) asserting the source→site routes appear in
the plan and the miner survives the solve — the receipts-gated blind spot
rule (CLAUDE.md sim trap) applied to this behavior.

## Migration order (each step gated)

1. Land the role-rule refinement + tests 1–5 with the flag still present
   (the flag's pool-zeroing makes the new edges moot where it's set — the
   two mechanisms coexist one release).
2. Verify live: trunk sources show source→site routes in a capture.
3. Retire the flag end-to-end (tests 6–8, v7 bump, delete the exemptions).
4. Verify live again; update spec 14's audit log with plan-vs-actual.

## Phase 4 — A/Z aggregation: two sinks per trunk, not N (owner 2026-07-22)

Phase 3 priced per-site construction correctly (source-cluster vs pool),
but left the sinks **per-site**: a trunk places all its tiles as
construction sites at once (roads don't hold the build queue), so a 20-tile
trunk is 20 sinks, and the solver emits ONE micro hauler-edge per (source,
site) pair — 20 sub-0.3-CARRY edges from one source (measured t72505602:
construction sinks spiked 1–4 → 30, P2 34/44 micro-routes, ~18% of P4's
source-route parts phantom-ish). They never materialize as distinct creeps
(per-source carry aggregation), but they fragment the plan, the P2/P4
ledger, and the solver's work.

Owner directive: **split each trunk road into two AGGREGATE sinks** — `A`
(home end, a project built by the home pool crew from the bank) and `Z`
(source end, built by a builder+hauler funded from the source mine) —
**split proportional to energy flow**: `f_Z = sourceRate / (sourceRate +
homeSupply)`, where homeSupply is the bank-surplus draw (the pool tankers'
fuel). Each end owns the share of the road its energy can push; the split
is by cumulative REMAINING WORK from the source end (a swamp tile costs
more, so work is the honest measure of reach).

Implementation (aggregation is a PLAN concern; the crew still builds real
per-tile game sites):
- `economy/roadSegments.ts` (PURE): `splitRoadByEnergyFlow` (the f_Z split)
  and `aggregateTrunkRoadSinks` (collapse matched trunk-road records into
  one Z + one A per route; non-trunk construction — extensions, containers,
  in-room roads, single-tile trunks — passes through per-site).
- `economy/roadSegmentsGame.ts` (ADAPTER): `collectTrunkRoutes` decodes the
  roadRoutes `tiles3` receipts into SOURCE→HOME ordered tiles + mine rate;
  `homeBankSupply` reads the largest owned-storage surplus.
- `main.ts addConstructionSitesToFlow`: aggregate BEFORE admission, so the
  graph sees 2 sinks per trunk. The Z aggregate sits at the mine-most
  standing tile → the phase-3 cluster test (nearer-source-than-hub)
  classifies it to the source; A sits at the home-most tile → pooled. No
  change to the fill or the cluster logic — they see 2 sinks and route one
  source→Z edge + one home A project.

The builder+hauler falls out of the existing machinery once Z is one clean
sink: the source's per-source carry commission carries the single Z route
(the hauler), and the source room's remote rung builds it (the builder) —
no new corp.

Acceptance (receipts-gated — the trio stages no roadRoutes, so this is the
CLAUDE.md sim-trap blind spot): `test/unit/economy/roadSegments.test.ts`
(16 pins on the split + aggregation) and
`test/unit/economy/roadSegmentsGame.test.ts` (the tiles3 decode + the cedc
20-sites→2-sinks incident staged end-to-end). Live verification: a
trunk-building capture shows construction sinks return toward 1–4 (two per
active trunk), P2 micro-routes drop, and the road still builds.
