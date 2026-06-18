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
   `shouldExpand(gcl, ownedRooms, candidates)` — pure. Expand when
   `gcl.level > ownedRooms.length` AND a candidate node has
   `roi.score >= EXPAND_MIN_SCORE` AND its room is not owned/reserved-hostile
   AND the home room is RCL ≥ 4 (can afford a claimer + seed builders).
   Persist the chosen target in `Memory.expansion = { roomName, nodeId,
   spawnPos, sinceTick }` so the campaign survives resets; clear it when the
   new room's spawn finishes or after `EXPAND_TIMEOUT` (20k ticks) of no
   progress.
2. **ClaimCorp** (pattern: ReservationCorp — it is 80% identical): demands one
   claimer (CLAIM+MOVE, 650), walks to `Memory.expansion.roomName`, claims the
   controller. Off-budget, non-blocking, value below income corps. Demobilizes
   (recycles) once the controller is owned.
3. **Founding:** once the room is owned, place the spawn site at
   `Memory.expansion.spawnPos` (from spawnPlacements). Seed it: the existing
   BootstrapCorp activates on any owned room with a spawn... but there is no
   spawn yet — so the home room sends `EXPAND_SEED_BUILDERS` (2 jacks,
   WORK/CARRY/MOVE, role reuses BootstrapCorp's jack behavior with a target
   room) to build the spawn site, self-feeding from the new room's sources.
   When the spawn completes, the normal machinery (survey → corps → flow)
   takes over with zero new code — that's the design's whole bet, and the
   integration test below proves it.

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

### Regression gate

Unit suite; `flow-handoff`, `world-layout`, `storage-depot` green.

## Out of scope

Military escort, claiming contested rooms, multi-spawn placement in the new
room, abandoning failed rooms (losing rooms is, per the owner, fine).
