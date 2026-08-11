# 06 — Expansion: claim the next room ("spread like a disease")

**Status:** implemented. All three pieces are live — the pure `shouldExpand`
trigger + campaign state machine (`economy/expansion.ts`), the ClaimCorp
(`corps/kinds/claimKind.ts`, `corps/ClaimCorp.ts`), and sink-based founding via
the flow planner's `NEW_SPAWN_SITE_VALUE`. Acceptance moved from the
single-shot integration test the design named below to the T5 grid cells
`exp-t5-claimer-claims-and-founds` and `exp-t5-founding-funnels-to-completion`
(`test/grid/cells/expansion.ts`), which exercise the claim moment and the
sink-founding moment against real terrain. This is the payoff the
node/ROI/spawn-placement machinery was built for, and the owner's stated
strategy: losing rooms is fine, spreading is the win condition.
**Priority:** P2 (after the economy specs; an expansion that out-runs its
economy just starves two rooms instead of one).

## UN-PARKED AND FIXED 2026-08-11 (owner: "It's time to claim a room... I want the full fix")

The founding cell had been red since the refactor era and PARKED 2026-07-28;
the live trigger had NEVER fired (GCL 32, 554k banked, zero campaigns ever
opened at t72918307). Both were reader-pair deadlocks in the spec 56 D2 shape —
each side locally defensible, jointly a starvation — and the plan layer was
verified INNOCENT by direct probe before either fix (site admitted, priced 85,
funded, build commission published; the funnel existed on paper the whole
time):

1. **The funnel (the red cell): crew dispatch never read the plan's pricing.**
   The build-pool consolidation (2026-07-20/22, "one crew marches wherever the
   work is") sends the whole crew to the pool's HEAD room, and the pool sorted
   home-first-then-distance — so the solver's 85-valued founding site waited
   behind home's self-refilling 70-valued site queue forever (measured: six
   home sites placed across the red run's 1800t window, zero energy east).
   Fix: `buildPool` ranks rooms by the SAME goal valuation the adapter prices
   sinks with (`goals.constructionSiteValue`, one shared rule) applied to the
   ledger's own `structureType`; ties keep home-first-then-nearest, so worlds
   without a founding-class site order byte-identically. Cell green: progress
   climbs @136, spawn stands @531 (vs never; historical pre-refactor green was
   ~790 — the crew now goes STRAIGHT to the founding site), campaign closes
   @532.
2. **The trigger: the placement sweep never priced a candidate.**
   `expansionCandidates` drops any node without a placement, but the sweep
   selected top-5 nodes by ECONOMIC value — owned territory always wins that
   ranking, so `Memory.spawnPlacements` never held an unowned node and
   `shouldExpand` starved at `candidates=[]` regardless of GCL or bank. Fix:
   `buildPlacementContexts` runs a second lane — top-N unowned nodes by
   `expansionScore`, the same score the trigger ranks with — deduped into one
   sweep job.
3. **The claim commission joins the books** (spec 39 phase 4 tail): the
   standing claimer priced at `claimerSpawnLoad()` (CLAIM+MOVE over
   CLAIM_LIFETIME, ~0.0033 p/t) on both sides — the kind's declaration and
   `infraSpawnLoad`/`infraSpawnEnergy`'s new campaign term — extending the
   `Σ(auxiliary) === infraSpawnLoad` identity to claiming. Campaign CAPEX
   (founding spawn 15k, seed bodies) stays financed by the `shouldExpand`
   bank gate; only the standing body is priced.

Also fixed in passing: `sim:real`'s `--gcl` flag fed a LEVEL straight into
`addBot`'s POINTS field (the CLAUDE.md grid-staging trap), so no real-map sim
could ever reach the trigger; and the sim's report now prints the trigger's
whole input (top unowned scores | placement | intel) so a silent
`shouldExpand=false` is attributable from the report alone.

### Same-day follow-up: the CLAIM was never a replan trigger, and the monthly cadence turned that gap into a month

Running the full grid for the ratchet surfaced `exp-t5-claimer-claims-and-founds`
red - and the bisect put its first red at **#152 (6ce940f)**, BEFORE this
tranche (this branch's parent 82ff82b red; #151 green 4/4). Mechanism, measured
from the cell's own console: **ONE planning pass in 500 ticks** - the claim
landed @~t35 and `updateExpansionCampaign` (which places the founding site)
never ran again. `planTriggers`' docblock always promised *"claim placed"* as a
trigger, but the snapshot carried only `Memory.expansion?.roomName` - which the
claim does not change - and `spawnCount` moves only when the founding spawn
STANDS. Under the old 50/150t cadence the un-wired trigger cost at most a
cadence and no cell ever noticed; under the fiscal-month term (spec 46 phase A,
live in #152) the same gap parked the founding for the month.

Fix (this branch): **ownership is the durable transition** - `planTriggerReason`
fires `owned-room:<name>` when a room appears in the owned-room snapshot
(`rclByRoom`) and `owned-room-lost:<name>` when one vanishes, exactly the
claim's world effect and future-proof for any room gain/loss. Cell green:
claim @t47, founding site placed **@t48** - the forced replan lands the next
tick. Live consequence: the claim -> founding handoff is immediate instead of
waiting out the month's frozen plan.

**Filed, deliberately NOT fixed here: `cons-recycle-pad-mature-room` red on
master, first red at #158 (dbad248).** That commit's RCL8 build-out added
`wantsAnotherTower` (tower target 2, was hard-silenced at one forever) plus a
~70-line ConstructionCorp reorder, and the new tower want now competes in the
one-rung-per-pass ladder ahead of the recycle pad - the spec 58(b)
rung-starvation class (measured: master's first placement pass takes the pad;
#158+ takes the tower/extensions and the pad misses its 80t window). Whether
the pad should outrank a wanted tower is a LADDER-ORDER ruling on a
deliberate owner change - the bandaid doctrine says interrogate the mechanism,
not patch its symptom from a side branch. The cell's baseline `pass` claim is
KEPT so the ratchet stays visible (the same treatment this spec's founding red
got in July).

## What already exists

- Node ROI with expansion candidates: `global.showNodes()` ranks
  `!roi.isOwned` nodes by score (`nodes/Node.ts`, IncrementalAnalysis).
- Fine-grained spawn placement: `Memory.spawnPlacements` (best spawn tile per
  top node) maintained on the planning cadence
  (`execution/SpawnPlacementScheduler.ts`).
- Multi-room nodes, remote mining, scouting/intel, reservation — a remote
  room's economics are already understood before claiming.
- Test scaffolding: `addOwnedRoom` in `test/integration/loadLayout.ts` fakes
  an N-room player; `world-layout.test.ts` exercises multi-room analysis.

Missing: the act of claiming — a trigger, a claimer creep, and founding
(first spawn construction + bootstrap) in the new room.

## Design

Three small pieces, all riding existing rails:

1. **Trigger** (in the planning phase, cheap + interval-gated):
   `shouldExpand(gcl, ownedRooms, candidates, bankedEnergy)` — pure. Expand
   when `gcl.level > ownedRooms.length` AND a candidate node has
   `roi.score >= EXPAND_MIN_SCORE` AND its room is not owned/reserved-hostile
   AND **savings underwrite the campaign** (owner doctrine 2026-07-10:
   "saved up stocks fund and plan producer corps"): `bankedEnergy >=
   EXPANSION_CAPEX + SAFETY_RESERVE` where CAPEX ≈ claimer 650 + the spawn
   site's 15k + seed bodies. Capital replaces the crude RCL gate: a colony
   expands exactly when it has accumulated the investment, timing emergent
   from the bank - producers are investments with a CAPEX hump, and the
   bank exists to cross humps.
   Persist the chosen target in `Memory.expansion = { roomName, nodeId,
   spawnPos, sinceTick }` so the campaign survives resets; clear it when the
   new room's spawn finishes or after `EXPAND_TIMEOUT` (20k ticks) of no
   progress.
2. **ClaimCorp** (pattern: ReservationCorp — it is 80% identical): demands one
   claimer (CLAIM+MOVE, 650), walks to `Memory.expansion.roomName`, claims the
   controller. Off-budget, non-blocking, value below income corps. Demobilizes
   (recycles) once the controller is owned.
3. **Founding — an ECONOMIC SINK, not a scripted campaign** (owner directive
   2026-07-09: "the colony prioritizes investing in the new rooms/spawns for
   long-term growth... an abstract economy/flow planner energy flow, and the
   behavior falls out of it, not narrowly programmed as a flag"). Once the
   room is owned, place the spawn site at `Memory.expansion.spawnPos` and let
   the COLONY PLANNER see it as a construction sink with the expansion value:

       DEFAULT_SINK_VALUE: spawn 100 > NEW-SPAWN SITE ~85 > construction 70
                           > controller 50 > storage 1

   Refinement (owner, same directive): the controller value is a function of
   PROGRESS REMAINING TO THE NEXT LEVEL, not of the level itself. Remaining
   is what prices the marginal energy: a fresh L1 needs 200 (huge value per
   energy), an L7 needs up to 10.4M (tiny) - AND a controller at 99% of ANY
   level has a small remainder again, so closing out a nearly-done level is
   correctly treated as valuable. One curve captures both:

       controllerValue(remaining) = clamp(40..90, 90 - k * ln(remaining))
       (k such that remaining=200 -> ~90, remaining=10.4M -> ~40; L8 idle
        floor below storage-adjacent work)

   So a freshly claimed room's controller outvalues every mid-level
   controller in the colony, and once its spawn stands, upgraders and
   haulers "from all around all stream in" - zero coordination code, just
   the value ordering. (A small-remainder controller above ordinary
   construction at 70 is correct: the cheap hop unlocks the next rung of
   the room's own ladder.)

## Prerequisite audit (2026-07-09) - the rails mostly exist

- Construction sinks are discovered in ALL OWNED rooms (main.ts
  addConstructionSitesToFlow gates on controller.my, NOT on having a spawn) -
  a claimed room's spawn site is visible to the solver as-is.
- Haul routes already cross room borders with no room filter:
  CorpPlanner.routeToSinks ranks every supply against every sink by real
  pathDistance, and the hauler's spawn comes from the SOURCE's nearest spawn
  (spawnBySource) - so home-source -> new-room-site routes and parent-spawn
  attribution both work structurally today.
- The ONE missing piece: per-INSTANCE sink values. flowAdapter sets
  `value: DEFAULT_SINK_VALUE[kind]` uniformly; the expansion site value
  (~85) and controllerValue(remaining) both need the adapter to price each
  sink individually (PlannerSink.value already exists per sink - only the
  adapter needs to differentiate; PriorityManager's 0-100 machinery is
  vestigial w.r.t. the solver and should not be revived for this).

   Everything the owner described then falls out of the existing machinery,
   the same way the build-out funneling (spec 10 G6 fix) already works
   in-room:
   - The parent room finishes its own sites (value 70 beats controller 50),
     then - having no better sink than the new-spawn site (85) - funnels its
     surplus THERE instead of upgrading. "New spawns just have a higher
     priority than upgrading."
   - Every owned room in range routes to the same sink, because the solver
     pairs supply with the highest-value unmet sink by net energy - multiple
     rooms all funnel to the new spawn with zero coordination code.
   - A mining op opened in/near the claimed room hauls STRAIGHT to the site:
     nearest-supply pairing (grid cell plan-t2-sink-source-pairing proves the
     mechanism in-room) makes the local source the site's cheapest supplier.
   - "Within reason" is already priced in: the live spawn network (100) and
     the anti-downgrade reserve pre-pass stay ahead of expansion, and
     netEnergy pricing refuses routes whose haul overhead exceeds the energy
     delivered.
   When the spawn completes, the sink vanishes, the room surveys, and the
   normal machinery (bootstrap → corps → flow) takes over with zero new
   code — that's the design's whole bet, and the integration test below
   proves it.

   Audit list for the sink to be visible to the solver (task list): the flow
   graph must admit construction sinks in rooms whose sites the colony can
   see (owned room, no spawn yet); haul routes must be allowed to cross room
   borders to a sink room with no spawn of its own; commissionsFromPlan must
   attribute the new room's corps to the PARENT spawn until the new spawn
   stands.

## Acceptance tests

> Implemented locations (2026-07): the gate lives in
> `test/unit/economy/expansion.test.ts`, claimer demand in
> `test/unit/corps/ClaimCorp.test.ts` + `test/unit/framework/claimKind.test.ts`,
> and the end-to-end arc in the T5 grid cells (`test/grid/cells/expansion.ts`)
> rather than the standalone `test/integration/expansion.test.ts` the design
> below sketched — that file was never created; the grid cells own its
> acceptance. The scenarios below are the original design intent, preserved.

### Unit: `test/unit/economy/expansion.test.ts` — exact, exhaustive gate

1. GCL 2, 1 owned room, candidate score 50 (≥ threshold) → `true`.
2. GCL 1, 1 owned room, any candidate → `false` (no GCL headroom).
3. GCL 3, 1 owned room, best candidate score below threshold → `false`.
4. Home RCL 3 → `false` regardless of candidates.
5. Candidate in a room owned by another player (intel) → that candidate is
   skipped; next-best chosen.
6. Determinism: equal scores → lexicographically smaller nodeId picked.

### Unit: claimer demand (pattern: `ReservationCorp.test.ts`)

1. With `Memory.expansion` set and no claimer alive → exactly one demand,
   `role === "claimer"`, `blocking === false`, cost 650.
2. Claimer alive → no demand. Controller owned → no demand AND the corp
   reports demobilization (recycle flag), mirroring the reserver pin.

### End-to-end: the T5 expansion grid cells (`test/grid/cells/expansion.ts`)

Realised as two grid cells rather than the single integration test sketched
here: `exp-t5-claimer-claims-and-founds` (the claim moment — held-funded
claimer walks in, claims the controller, founding spawn site placed at the
campaign's `spawnPos`) and `exp-t5-founding-funnels-to-completion` (the
sink-founding moment — energy funnels cross-room to the site, the spawn
completes, and the campaign closes). The original single-test design intent,
preserved for reference:

World: two real-terrain rooms side by side (W0N0 owned at RCL4 with the
storage-depot layout; W1N0 with 2 sources + controller, layout via
`loadLayout`), free-economy mod, GCL forced ≥ 2 via db. Run ≤ 3000 ticks,
sample every 50. ALL must hold:

1. W1N0's controller becomes owned by "player" (claim happened).
2. A spawn STRUCTURE exists in W1N0 (founding completed, not just sited).
3. After the spawn exists, within 600 further ticks: ≥ 1 creep whose memory
   `corpId` starts with `mining-` is harvesting in W1N0 (the normal economy
   took over — the zero-new-code bet).
4. Throughout: W0N0's controller never downgrades (home economy not gutted
   by the campaign) — assert `controller.level` stays 4+ every sample.
5. `Memory.expansion` is cleared by the end (campaign closed out).
6. The economic signature of sink-based founding: while the new-spawn site
   exists and home has no sites of its own, the published plan's controller
   allocation sits at the anti-downgrade reserve (upgrading paused, surplus
   funneled to the site) - and recovers once the spawn stands.

### Regression gate

Unit suite; `flow-handoff`, `world-layout`, `storage-depot` green.

## Out of scope

Military escort, claiming contested rooms, multi-spawn placement in the new
room, abandoning failed rooms (losing rooms is, per the owner, fine).
