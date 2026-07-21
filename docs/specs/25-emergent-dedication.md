# 25 — Emergent dedication: route economics replace the dedicatedToBuild flag

**Status:** PROPOSED (owner-directed 2026-07-21: "a lot of times adding the
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
