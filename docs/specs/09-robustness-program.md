# 09 — Robustness program: surviving worlds we didn't design

**Status:** IN PROGRESS. Phase 1 DONE (boot-real cells green); phase 4 LANDED
2026-07-12 (black box → RawMemory segment 5 + Memory.blackBoxTail, watchdog
rules in `telemetry/watchdogs.ts` evaluated by the bot and relayed by
telemetry-app, `npm run capture:incident` emits fixture + skeleton cell);
phase 5 PARTIAL 2026-07-12 (CpuGovernor with unit-pinned shedding order:
telemetry → solve cadence → construction/paving → scouting; per-phase
bulkheads in main.ts recording to the black box; Memory schema versioning
still open). Phase 6 partial (economic standdown). Phases 2-3 open.
**Priority:** P0 for phase 2 (chaos harness) next.

## Why

The bot's 90+ green grid cells all run in worlds we authored, and those worlds
encode our own assumptions: staged RCL2, 5-tile sources, open plains. The
first run on CAPTURED live terrain (shard3 W1N6 - an ordinary room, 55%
walls, sources at path ~15-25) found a P0 in twenty minutes: a fresh colony
wedges in bootstrap forever (spec 01, REAL-TERRAIN COLD-START WEDGE). The
owner's strategy is respawn-tolerant - "we spread like a disease; losing a
room is fine" (spec 07). That strategy is only sound if **standing a colony
up from nothing, on an arbitrary real room, is bulletproof and cheap**. Today
it provably is not. Robustness here is not defense; it is regeneration.

Testing conventions: grid cells per spec 08 (`npm run grid`, ratcheted in
`test/grid/baseline.json`; ALWAYS `npm run build` first); real-map fixtures
via `npm run capture:rooms`; real-map sims via `npm run sim:real`.

---

## Phase 1 — Cold-start on real terrain (P0, the keystone)

The measured failure: jacks take ~550t to reach RCL2 (vs ~30 synthetic), then
keep the spawn bank at ~99/300 forever, so the first flow miner's ~250 floor
never funds. Zero flow creeps by t=1200.

Work items:
1. **Bootstrap yields the bank**: once RCL>=2 and a blocking flow-miner
   demand is waiting (Memory.spawnDemandFirstSeen has a miner entry), the
   BootstrapCorp stops SPAWNING jacks (existing jacks keep working) until the
   first flow miner is fielded. The bank then fills at jack-delivery rate and
   the miner floor funds in bounded time.
2. **Distance-aware bootstrap**: jack body/count sized from the real path
   distance spawn->nearest source (the analysis already computes it), not the
   synthetic-world constant. A 25-tile room wants fewer, bigger jacks.
3. **Auto spawn placement is part of the bot, not the harness**: promote
   sim-real-rooms' pickSpawnSpot heuristic (open plain tile nearest the
   source/controller centroid) into `src/` and have the harness call the
   bot's own placement, so placement quality is tested code. (Live respawns
   place the spawn manually today, but expansion (spec 06) needs this
   anyway.)

Acceptance:
- New grid avenue `resilience`, cells `boot-real-terrain-miner-lands` and
  `boot-real-terrain-rcl3`: FIXTURE-BASED rooms (see phase 3) from 3 captured
  layouts stratified easy/medium/hard; first flow miner by a distance-derived
  bound; RCL3 within N ticks. Windows are long (800-2000t) - one solo world
  per cell, planner band.
- `npm run sim:real -- --home W1N6 --ticks 2000` reaches RCL3 with >= 2
  sources worked and >= 1 hauler route paved or building.
- Spec 01's wedge paragraph gets a FIXED stamp with the measured timeline.

## Phase 2 — Chaos harness: manufactured unforeseen (P0)

"Unforeseen" cannot be enumerated, but it can be sampled. Two generators:

1. **Fault injection library** (`test/grid/chaos.ts`): composable onTick
   interventions against the mockup db - `killCreeps(pct|filter)`,
   `drainSpawnBank()`, `wipeMemoryKey(path)` (corps store, creep memories,
   room memory), `deleteStructure(type)`, `dropEnergy(x,y,n)`,
   `stunCreep(name, ticks)` (fatigue pin). Each returns a receipt the cell
   asserts against.
2. **Seeded world fuzzer** (`test/grid/fuzzRoom.ts`): deterministic
   room generator from a seed - wall density, swamp bands, source count 1-2,
   distances drawn from the REAL-MAP distributions measured off the fixture
   library (not uniform noise). Every failure archives its seed; a failed
   seed becomes a permanent fixture cell.

New `resilience` cells (T2-T4), all invariant-style assertions (CorpCop rides
along; "colony returns to a working state" rather than scripted outcomes):
- `chaos-massacre-refield`: kill 100% of creeps at t=N -> a miner is fielded
  again within M, no orphan leaks, controller never downgrades.
- `chaos-memory-amnesia`: wipe Memory.commissionedCorps (+ creep corpIds) ->
  hydration + OrphanRescue re-adopt the live fleet; no creep idles > K ticks.
- `chaos-dangling-ids`: corrupt assignedSourceId/corpId references to
  nonexistent ids -> corps shed them without freezing (the documented
  silent-corp-death mode).
- `chaos-container-loss`: delete the source container mid-run -> mining
  degrades to drop-mining and the ladder rebuilds it.
- `chaos-energy-shock`: drain bank + floor piles at t=N (simulates a raid's
  economic damage without combat) -> recovery without deadlock (the spec-01
  starve fixes generalized).
- `fuzz-cold-start@K-seeds`: K seeded rooms, invariants only. Nightly (not
  per-push) - runtime budget ~30-60 min; `--seeds` flag to reproduce.

Acceptance: avenue lands with every cell green, ratcheted; a FUZZ_SEEDS.md
documents archived failures and their fixes.

## Phase 3 — Real-terrain fixture tier (P1)

1. **Fixture library**: capture 12-20 rooms stratified by measured
   difficulty (wall %, mean source path distance, swamp %, SK adjacency):
   open / maze / swampy / SK-adjacent / tunnel-candidate. Committed under
   test/fixtures/real-rooms/ with a small INDEX.md (stats per room).
2. **Grid fixture rooms**: GridCell.rooms accepts `fixture("shard3-W1N6")`
   alongside RoomBuilder functions (loader is already format-compatible;
   the packer needs only a name-remap pass, same as handles).
3. **Real-terrain versions of the load-bearing behaviors**: cold start
   (phase 1), remote pipeline on a real 2-room cluster, two-owned-rooms
   linearity (sim:multiroom's check on real maps), road paving verdicts on
   real path distances (tunnel-candidate room pins the wall-road economics).

Acceptance: a `real` avenue (or tier tag) in the grid with its own ratchet
line in baseline.json; CI runs it on the same cadence as T4-T5.

## Phase 4 — Live-incident pipeline (P1): production failures become cells

The missing rung between telemetry and the grid.

1. **Black box**: the bot maintains a ring buffer (RawMemory segment, the
   telemetry-app already reads segments) of the last ~200 ticks of decisions:
   spawns attempted/held (+why), commissions churned, demand ages, controller
   downgrade timer, errors caught by ErrorMapper. Compact fixed-shape rows.
2. **`npm run capture:incident -- --shard S --room R`**: pulls the black box
   + `capture:rooms --around R` + current Memory snapshot into
   test/fixtures/incidents/<date>-<room>/, and emits a skeleton grid cell
   staging that room + memory with TODO assertions.
3. **Watchdogs in telemetry-app**: alert when (a) no spawn for N ticks at
   RCL>=2 (the wedge signature), (b) downgradeTime under threshold,
   (c) bucket collapse, (d) black-box error rate.

Acceptance: a drill - manufacture an incident on a private/local server,
run capture:incident, and land its cell red->green within one session.

## Phase 5 — Blast-radius hardening (P2)

1. **Phase bulkheads in main.ts**: each phase (analysis, planning, corps,
   spawning, telemetry) in its own try/catch with a per-phase error counter
   in the black box - one corp's throw must not abort the tick's remaining
   phases. (ErrorMapper today saves the PROCESS, not the tick.)
2. **Memory schema versioning**: Memory.schemaVersion + a validate-or-rebuild
   pass on hydration - malformed/stale shapes are dropped and rebuilt (the
   corps already rebuild from commissions; make that the guaranteed path),
   never crash-looped. Chaos cells from phase 2 double as its tests.
3. **CPU governor**: a small src/execution/CpuGovernor.ts with ordered
   degradation when bucket falls (skip telemetry -> stretch solve interval ->
   pause construction/paving -> freeze scouting), each step logged to the
   black box. Grid can pin the ORDER with a stubbed cpu clock (unit tests);
   real effect verified on the live server only.

## Phase 6 — Minimal defense, on the owner's terms (P2-P3, spec 07)

Respawn-tolerance does not need towers to win fights; it needs to not feed
invaders and to fail cheap:
1. **Hostile-room standdown**: ScoutCorp already records hostiles; consume
   the intel - remote corps demobilize (haulers/miners recalled or recycled)
   while a remote room is hostile, resume on all-clear. This is economics,
   not combat, and it is the highest-value defense item per line of code.
2. **Safe-mode policy**: activate when hostiles are within N of the spawn
   and no tower exists (one function + one cell staging an Invader-user
   creep - the mockup pre-seeds the Invader user).
3. **Tower runner**: spec 07 as written (~1 hour) whenever picked up; the
   flow sink already exists.

Acceptance: `defense-remote-standdown` and `defense-safemode-fires` cells;
spec 07 status updated when the runner lands.

---

## Sequencing and cost

| Phase | Depends on | Rough cost | Gate it moves |
|---|---|---|---|
| 1 cold start | fixtures exist (done) | 1-2 sessions | the respawn strategy works at all |
| 2 chaos | - | 1-2 sessions | unforeseen-by-construction coverage |
| 3 real tier | 1 | 1 session | assumptions can't hide in authored worlds |
| 4 incidents | telemetry segments | 1 session | prod failures compound into tests |
| 5 bulkheads | - | 1 session | one bug != one dead tick |
| 6 defense-lite | scout intel (exists) | 0.5-1 session | stop feeding invaders |

Phases 1 and 2 first, in that order (1 is a measured P0; 2's fuzzer needs 1's
fixes to produce signal instead of rediscovering the wedge K times). 3-6 can
interleave. Every phase lands as ratcheted grid cells - the program's own
success metric is the baseline file's history.
