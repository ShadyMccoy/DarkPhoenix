# 06 — Expansion: claim the next room ("spread like a disease")

**Status:** not started. This is the payoff the node/ROI/spawn-placement
machinery was built for, and the owner's stated strategy: losing rooms is fine,
spreading is the win condition.
**Priority:** P2 (after the economy specs; an expansion that out-runs its
economy just starves two rooms instead of one).

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

### Unit: `test/unit/expansion/shouldExpand.test.ts` — exact, exhaustive gate

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

### Integration: `test/integration/expansion.test.ts`

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
