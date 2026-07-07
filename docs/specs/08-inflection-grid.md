# Spec 08 — The Inflection-Point Grid

**Status**: RUNNER BUILT (2026-07-07) — `npm run grid`. Implemented:
`test/grid/{GridCell,judge,pack,stage,runBatch,report}.ts` + `scripts/grid.ts`
CLI, with 17 unit tests over the pure judge/pack/ladder modules
(`test/unit/grid/`). First cells: the OrphanRescue canary trio + the
adoption-timing calibration cell (`test/grid/cells/`).

**Staging probe verdict** (scripts/probe-staging.ts, resolves errata
"Infeasible" #4): raw-db injection of `{type:'energy'}` piles WORKS (survives,
decays ceil(amount/1000)/tick per the game rule) and `{type:'constructionSite'}`
WORKS (survives with owner + structureType). The ~5 pile/site-dependent cells
are buildable via the `stage()` hook. Links are injectable via the grid's own
stage.ts (its structureCapacity covers `link: 800`, fixing errata #2).

**Measured calibration (calib-adoption-timing, RCL2 cold, sealed plain room,
source 5 tiles from spawn; REPRODUCED tick-for-tick across two runs)** —
recalibrate designer windows against these, not the guesses:

| pipeline stage | tick |
|---|---|
| terrain analyzed (Memory.nodes non-empty) | 9 |
| harvest corp commissioned | 11 |
| staged orphan re-adopted (corpId flip) | **11** |
| adopted miner on post beside source | 12 |
| unadoptable orphan recycled (25 grace + 5 walk) | 30 |
| first FLOW miner spawned | **138** |
| first FLOW hauler fielded (haul-t0 geometry) | 187 |
| first bulk hauler delivery reaches the spawn | **202** |
| first extension site placed / economyPlan published | 10 |

Implications: (a) adoption T0 ~= 11 well inside the 25-tick grace - the
staging mechanism ~30 cells depend on is PROVEN; use always-assertion
graceTicks ~= 15-20 for adoption warm-up. (b) A cold RCL2 colony takes ~138
ticks to field its first flow miner (jack economy + energy accumulation first)
- cells staging "first miner" moments need windows >= 150, and this number is
itself a spec-01 measurement (part of the cold-start dead window). Two runs
were tick-identical, so treat verdict flips as signal until proven otherwise.

**Runner performance**: 4-bot 150-tick world = ~58s wall clock including
setup; 12-bot 300-tick world = ~4min (retirement shrinks the active set as
cells decide); a single 20-tick cell = **3.3s**. Pad-room setup uses
test/grid/bulkPad.ts (single env rebuild) - the naive padNeighborTerrain path
at radius 3 re-deflates the whole terrain blob per room and takes MINUTES for
a batch (architect risk #1, confirmed).

**T0 ROW COMPLETE (2026-07-07)**: all 8 T0 cells + canary trio green, BOT
LEVEL 1 ratcheted. Observability lessons for future cells: (a) the mockup
DOES surface `spawning` on the spawn's db doc ({name, needTime, spawnTime}),
but in-progress creeps only appear in roomObjects at spawn COMPLETION -
assert immediacy via arrival time (body parts x 3 ticks back-derives the
start tick); (b) prefer "bulk single-tick store jump >= 40" over absolute
store thresholds for delivery assertions (spawns self-regen +1/tick below
300); (c) the no-corpId workType:'haul' decoy is the proven jack suppressor
for cells needing an untouched spawn bank (canary-verified never
adopted/recycled) - add two no-memory [MOVE] fillers to push otherCreeps >= 3
and bootstrap parks in its yield branch entirely (the "quiet room" kit).

**T1 ROW (2026-07-07)** - harness capabilities added and lessons:
- `GridCell.onTick(ctx)`: per-tick db interventions (pin a spawn's bank,
  one-shot triggers). CRITICAL: this db layer's `$set` with dotted paths
  (`"store.energy"`) silently NO-OPS - write whole objects
  (`store: {energy: N}`). Verified: the engine reads such writes (+1
  self-regen on top proves it).
- BootstrapCorp's SPAWN_COOLDOWN=10 gates on absolute Game.time
  (lastSpawnAttempt inits 0), so jack start ticks vary with the world clock -
  never assert exact jack timing, assert "prompt and first".
- Designed-cell dedupes: `churn-readopt-miner-hauler-live-corps` split into
  the existing canary (miner path) + `churn-readopt-hauler-route` (route
  match path); `churn-orphan-waits-then-recycles` folded into the recycle
  canary as a stand-still-through-grace assertion.
- `spawnexec-miner-carry-600-boundary` built as `-700-boundary` per errata
  wrong-behavior #1 (at exactly 600 the executor's rebuild drops the CARRY;
  700 is the true boundary-crossing observable: 5W1C3M, confirmed live).
- Window recalibrations from first runs: circuit-split 60->110 (the
  controller-circuit hauler's ~35-tick loaded walk), planner loop 400->500
  (cold d=22 loop: miner ~150, hauler ~250, first upgrader ~350+ - the
  spec-01 dead window re-measured at realistic distance).
- Assertion-scope lesson: "never moves while empty" must bind only BEFORE the
  first load - an empty hauler walking back to reload is correct circuit
  behavior, and the first run false-failed on it.
**Thesis**: optimize *feedback per second*. Long sims are mostly dead time
(spawning at 3 ticks/part, travel at ~1 tile/tick); the information lives at
inflection points — creep SHOULD spawn, creep freshly spawned, creep arrived
at its post, commission churned. The grid stages worlds AT those moments and
asserts the decision plus its immediate consequence inside a short verdict
window, running many cells in parallel as separate bot users in one
screeps-server-mockup world (engine ~233ms/tick flat + ~67ms/tick per bot, so
N cells amortize the engine).

The grid is also the repo's **success-metric ladder**: cells are tiered T0-T5
by world complexity, and the bot's level = highest tier T with every tier <= T
fully green. `test/grid/baseline.json` ratchets it in CI.

**Provenance**: designed by 8 seam-grounded designer agents + a grid architect
+ a feasibility reviewer (2026-07-07). 93 cells designed; 1 dropped by
review (move-worm-chain: zero production call sites — unit-test
instead); 92 remain. Cells flagged `[errata: ...]` have known
corrections in the Errata section that MUST be applied when building them —
several as-designed assertions contradict verified engine/bot behavior.

## Tier ladder

- T0 — Trivial (one spawn, one source ~5 tiles, existence proofs)
- T1 — Basic (one spawn, one source at 15-30 tiles, correct loops)
- T2 — Choice (2-3 sources, asymmetric distance/quality, prioritization)
- T3 — Adversity (swamp, mazes, pockets, corridors, congestion)
- T4 — Scale (multi-spawn / RCL4-5, extensions, storage, links, tender)
- T5 — Multi-room (remotes, borders, reservation, cross-room hauling)

Scoring: per-tier pass % per avenue; **bot level** = highest tier fully green
(strict — one red T1 cell caps the level at 0); "frontier" = highest tier with
any pass, reported for texture. CI exit 1 if bot level drops or any
baseline-green cell goes red.

## Grid runner architecture (verified against mockup source)

### World packing & isolation
One world per batch; one bot user per cell (username = cell id, e.g. "move-swamp-detour"). The packer assigns each cell a SLOT of 5 room-columns on a single row: cell k's home room = W{5k}N0, and multi-room cells put their second room in the adjacent column inside the slot (e.g. home W10N0 + remote W9N0 for an east neighbour — note W-name arithmetic: W10's east neighbour is W9, per parseRoomName in /workspace/darkphoenix/test/integration/loadLayout.ts:221). Stride 5 guarantees the nearest FOREIGN real room is >= 4 rooms away, which keeps it outside every bot's 7x7 (radius-3) analysis box. Designer cells' absolute room names (many collide on W0N0) are ignored; cells declare rooms by LOCAL handle ("home", "east") and the packer resolves names — except cells whose semantics depend on room-name arithmetic (plan-t5-sk-never-mined needs W3N4/W4N4 because isSourceKeeperRoom classifies by both coords %10 in [4,6]; /workspace/darkphoenix/src/flow/FlowGraph.ts:627 and /workspace/darkphoenix/src/execution/IncrementalAnalysis.ts:452), which use `pinnedRooms` and get a reserved block the packer verifies is >= 4 from every other slot. The packer must also SCREEN every allocated name against the SK predicate (row N0/N1 is always safe since y%10 in {0,1}). T5/two-room cells: yes, reserve 2 adjacent real rooms per slot; both are built with RoomBuilder.border() sealed except the aligned 2-tile gap between them (the existing remoteSource pattern, /workspace/darkphoenix/test/integration/scenario/library.ts:323). Rule: every room a creep can physically REACH must be a real border()-sealed ScenarioRoom — all-plain padNeighborTerrain padding (radius 1, needed so the native PathFinder never throws "Could not load terrain data", loadLayout.ts:251) is only for unreachable rooms. World build order per batch: world.reset() -> loadLayout(all cells' rooms) -> padNeighborTerrain(allRooms) -> addBot per cell -> per-cell state injection (RCL bumps via setRoomLevel/applyState-style db writes, staged containers/piles/orphan creeps/injected second spawns) -> enableMods(serverPath, mods) if the batch needs engine mods -> server.start(). Staging MUST finish before start() so tick 0 of the verdict window sees the staged world.

### Multi-bot mechanics
Verified from /workspace/darkphoenix/node_modules/screeps-server-mockup/src/world.js:162-180: each addBot({username, room, x, y, gcl=1, cpu=100, active=10000, modules}) (a) inserts a fresh db.users row, (b) sets env MEMORY+userId='{}' (per-user Memory), (c) inserts a users.code row with that bot's modules, (d) claims the target room's controller by direct db update (user, level 1, safeMode 20000) — bypassing any GCL check — and (e) inserts a working spawn. The tick loop (screepsServer.js:107-123) calls driver.getAllUsers(), which is db.users.find({active:{$ne:0}, cpu:{$gt:0}}) (/workspace/darkphoenix/node_modules/@screeps/driver/lib/index.js:144-151), and queues EVERY matching user, so N bots all run every tick; sim-parallel.ts already runs 11 bots this way in one world. Constraints found: usernames are NOT uniqueness-checked (packer must enforce unique cell ids); the reset() world pre-seeds Invader and Source Keeper users with active:0 so they never run; gcl:1 default means an IN-GAME claim of a second room would fail, but all T5 cells only reserve (ReservationCorp; CLAIM reservation is GCL-free) — pass gcl explicitly only if a future cell tests claiming; addOwnedRoom (loadLayout.ts:123) can grant extra owned rooms via db writes if ever needed. Per-bot verdict reads work via user.memory (env.get(MEMORY+id), user.js:42-45), returning the JSON-serialized exported Memory each tick — the same mechanism runWithCop.ts:65 uses. Per-user CPU is 100/tick with a 10000 bucket, unaffected by bot count; wall-clock cost is engine ~233ms + ~67ms per bot per tick (sim-parallel.ts header), which is what caps bots-per-world.

### Batch scheduling
Real verdict windows span 10-800 ticks (not 5-50): most movement/spawnexec/arrive/churn cells are <= 100, haul-t0 is 300, planner cells run 250-800. Partition cells into worlds by, in order: (1) MODS SIGNATURE — enableMods writes the server's db.json before start() (loadLayout.ts:170-175), so engine mods are world-global; cells needing freeEconomy (or any constant override) can only share a world with identical mod sets. RCL-gating is NOT a split criterion — it is per-cell db staging (setRoomLevel / Scenario applyState) in a shared world. (2) PINNED-ROOM conflicts (two cells pinning overlapping coordinates split). (3) WINDOW BAND — bucket into [<=60], [61-150], [151-350], [351-800] so a world's run length = max window of its cells and short cells don't ride 800-tick worlds. (4) MAX BOTS PER WORLD (default ~12; planner-band worlds 4-6) chunked from each bucket; each world gets a unique storage port (grid base 26000+n, matching the helper.ts port-per-server convention) and its own server/grid-<port> dir. Within one world: tick to batchWindow = max(cell windows), sampling each still-active cell per tick; when a cell's verdict is decided (early-fail on a violated `always`, early-pass when only `eventually` assertions remain and all are satisfied, or its window elapses), record the verdict and RETIRE its bot with db.users.update({_id:userId},{$set:{active:0}}) — verified getAllUsers filters active!=0, so a decided 15-tick cell stops costing ~67ms/tick in an 800-tick world. Cells with `always`/`atWindow` assertions retire only at their full window. Stop the world early when every cell is decided. Worlds run sequentially by default (CPU-bound); a --jobs N flag can run 2-3 worlds concurrently on distinct ports since each is an independent storage+runner+processor process trio.

### Verdict collection & cell interface
Per-tick loop identical in shape to sim-parallel.ts:146-160 / runWithCop.ts:60-70: after server.tick(), for each undecided cell build a CellSample — parse that bot's exported memory (await bot.memory, JSON.parse with {} fallback), lazily query db["rooms.objects"] per cell room (cached per tick), and hand it to each assertion's state machine. Exact TypeScript (test/grid/GridCell.ts):

```ts
import { ScenarioRoom } from "../integration/scenario/RoomBuilder";
import { ScenarioState } from "../integration/scenario/Scenario";

export type CellStatus = "pass" | "fail" | "timeout" | "error";

export interface CellSample {
  tick: number;                       // ticks since this batch world started (staging done at tick 0)
  memory: any;                        // parsed exported Memory of THIS cell's bot
  db: any;                            // raw mockup db handle for ad-hoc queries
  userId: string;                     // this cell's bot user id (creep/user-scoped queries)
  room(handle: string): string;       // resolve local handle ("home","east") -> packed room name
  objects(handle: string): any[];     // cached rooms.objects for one of this cell's rooms
}

export type CellCheck = (s: CellSample) => boolean;

export interface CellAssertion {
  name: string;                       // e.g. "miner parked on harvest tile"
  mode: "eventually" | "always" | "atWindow";
  check: CellCheck;
  graceTicks?: number;                // "always" only: ticks before enforcement starts
}

export interface GridCell {
  id: string;
  tier: 0 | 1 | 2 | 3 | 4 | 5;
  avenue: string;
  window: number;                     // verdict window, ticks
  sampleEvery?: number;               // default 1
  rooms: Record<string, (roomName: string) => ScenarioRoom>;  // "home" required
  adjacency?: Record<string, "E" | "W" | "N" | "S">;          // where extra handles sit vs home
  pinnedRooms?: Record<string, string>;                        // absolute names (SK-name cells)
  bot: { room: string; x: number; y: number; gcl?: number };   // room is a handle
  state?: ScenarioState;              // warm injection: controller level, structures, creeps, memory, idMap
  stage?(ctx: { db: any; C: any; userId: string; room(h: string): string }): Promise<void>;
  mods?: string[];                    // e.g. [FREE_ECONOMY_MOD] -> forces matching-mods batch
  assertions: CellAssertion[];
}
```

Semantics: PASS = every `always` unviolated from graceTicks through window AND every `eventually` satisfied at some sample <= window AND every `atWindow` true at the first sample >= window. FAIL = any `always` violated (fail fast, record the tick and a one-line world snapshot) or `atWindow` false. TIMEOUT = an `eventually` never satisfied by the window (reported distinctly from FAIL — it usually means "stuck", the grid's core signal). ERROR = staging/harness exception or the bot's memory unparsable for >5 consecutive samples. Flake policy: rerun-once — every non-PASS cell is re-queued into a fresh SOLO world (same layout, fresh port); the retry outcome is final, `flaky:true` recorded if it flipped, and a solo-pass-after-packed-fail additionally sets `packingSensitive:true` (an isolation/harness bug signal, not a bot bug). CorpCop (test/integration/diagnostics/CorpCop.ts) rides along as optional horizontal `always` assertions (orphaned-creep via snapshotFromMemory) that any cell can opt into.

### Scoring & ratchet
Per-cell verdicts aggregate two ways. (1) Per-tier pass % overall and per avenue (tier x avenue table, each cell "n/m green"). (2) BOT LEVEL = the highest tier T such that every tier <= T is 100% green across all avenues (a strict ladder: one red T1 cell caps the bot at level 0 even if T4 cells pass); also report the "frontier" (highest tier with any pass) for texture. Output: (a) human table to stdout — rows = tiers 0-5, columns = the 8 avenues, cells = pass/total with failing cell ids listed below, ending with "BOT LEVEL: N"; (b) machine artifact test/grid/last-run.json {timestamp, commit, botLevel, cells:[{id,tier,avenue,status,decidedTick,window,retries,flaky,packingSensitive}]}; (c) exit code for CI: compares against a committed ratchet file test/grid/baseline.json — exit 1 if botLevel drops OR any cell that passed in baseline now fails (per-cell ratchet catches regressions above the current level), exit 0 otherwise; --min-level N and --update-baseline flags. Over time this is the repo's success metric: baseline.json is updated deliberately in the same commit as the bot change that earned it, so `git log` on that file is the bot's level history, and CI keeps every subsequent commit at-or-above it.

### File layout
scripts/grid.ts — CLI entry, wired as "grid": "ts-node -P tsconfig.test.json scripts/grid.ts" in package.json (the exact convention of sim:parallel and the other sim:* scripts); flags: --tier N, --avenue name, --cell id, --jobs N, --no-retry, --json path, --min-level N, --update-baseline. test/grid/GridCell.ts — the interfaces above plus assertion helper constructors (eventually(name, check), always(name, check, grace), atWindow(name, check)). test/grid/pack.ts — slot allocator (stride-5 columns on N0, adjacency resolution, SK-name screening, pinnedRooms reservation + >=4-distance verification) and batch partitioner (mods signature -> pins -> window band -> maxBots chunking). test/grid/runBatch.ts — world lifecycle (reset, loadLayout, padNeighborTerrain, addBot-per-cell, per-cell state/stage, enableMods, start, tick/sample loop, user retirement via active:0, teardown). test/grid/judge.ts — pure assertion state machines + verdict semantics (unit-testable without a server, like CorpCop). test/grid/report.ts — table, ladder, JSON artifact, baseline ratchet + exit code. test/grid/baseline.json — committed ratchet. test/grid/cells/{movement,spawn-scheduler,spawn-exec,arrival,hauling,construction,churn,planner}.ts — each exports GridCell[]; test/grid/cells/index.ts — registry concatenating all avenues with a duplicate-id check. Reuses (absolute paths): /workspace/darkphoenix/test/integration/scenario/RoomBuilder.ts (terrain), /workspace/darkphoenix/test/integration/loadLayout.ts (loadLayout, padNeighborTerrain, setRoomLevel, enableMods, FREE_ECONOMY_MOD, addOwnedRoom), /workspace/darkphoenix/test/integration/scenario/Scenario.ts (ScenarioState + applyState — applyState is currently module-private and must be exported or extracted to test/grid/stage.ts), /workspace/darkphoenix/test/integration/mods/freeEconomy.js, and /workspace/darkphoenix/test/integration/diagnostics/CorpCop.ts. Cells live under test/grid (not scripts/) because they are declarative test data following the test/integration/scenario/library.ts pattern; scripts/ keeps only the runner CLI, matching the repo's existing split.

### Isolation rule (the load-bearing invariant)
SAFE PACKING RULE: (a) every reachable room of a cell is border()-sealed except aligned intra-cell gaps, (b) nearest rooms of two different cells are >= 4 apart in room-grid Chebyshev distance (stride-5 slots give exactly this), (c) all-plain padding only around the sealed cluster, never as a reachable room. Evidence: cross-room traversal in both the bot and the engine goes through Game.map.describeExits, which returns a direction ONLY if the room's OWN border row/col has >=1 plain tile — the engine builds gridData by counting terrain==0 along each 50-tile border (WorldMapGrid._buildGridData, /workspace/darkphoenix/node_modules/@screeps/driver/lib/runtime/mapgrid.js:68-121; consumed by describeExits at /workspace/darkphoenix/node_modules/@screeps/engine/src/game/map.js:20-46). A full RoomBuilder.border() ring therefore yields describeExits == {}, which simultaneously stops: ScoutCorp's BFS (MAX_SCOUT_DISTANCE = 5, /workspace/darkphoenix/src/corps/CorpConstants.ts:142; BFS at /workspace/darkphoenix/src/corps/ScoutCorp.ts:113-156), RoomDiscovery.discoverNearbyRooms/getDistanceToOwnedRoom (same describeExits BFS, /workspace/darkphoenix/src/utils/RoomDiscovery.ts:17-105), Game.map.findRoute, and physical movement (border walls). The ONE scan that ignores walls is get7x7BoxAroundOwnedRooms (radius 3, pure room-name arithmetic, RoomDiscovery.ts:140-216) feeding IncrementalAnalysis.ts:157 — it is terrain-only and object-blind (createMultiRoomTerrainCallback reads only Game.map.getRoomTerrain, /workspace/darkphoenix/src/spatial/RoomMap.ts:102-111), but a foreign REAL room inside the box would be folded into the colony's peak/territory node network; distance >= 4 keeps foreign real rooms outside every radius-3 box (sim-parallel's stride-2 "no overlap" comment is wrong at radius 3 — do not copy it). For open-exit cells (move-border-inward-step, move-scout-border-crossing, T5 remotes): scouts CAN walk out (RCL2+, distance <= 5), so the room behind any open edge must be a REAL sealed room with only the matching gap open (the remoteSource pattern) — a naked all-plain pad has 200 open border tiles, letting scouts continue outward and letting the PathFinder frontier touch terrain-less void rooms, which throws "Could not load terrain data" (Room.Terrain throws for rooms absent from staticTerrainData, /workspace/darkphoenix/node_modules/@screeps/engine/src/game/rooms.js:1223-1228). With (a)+(b), each cell's reachable exit-graph is closed over its own rooms and zero cross-cell interference channels remain.

### Risks
1. IncrementalAnalysis fidelity: the 7x7 box contains rooms with NO terrain data (padNeighborTerrain only pads radius 1), and one such room makes the whole 9-room analysis batch throw and get dropped (caught at src/execution/IncrementalAnalysis.ts:189-199) — including possibly the batch containing the home room, so packed-grid node networks can differ from production; mitigation is a bulk radius-3 all-plain pad, but padNeighborTerrain's per-room setTerrain recompresses the entire env TERRAIN_DATA each call (world.js updateEnvTerrain), which is O(rooms^2) and needs a bulk-insert variant with a single env rebuild (~700 pad rooms for a 15-cell world).
2. SK room-name classification: isSourceKeeperRoom (FlowGraph.ts:627, IncrementalAnalysis.ts:452) silently declassifies sources in any room with both coords %10 in [4,6] — the packer must screen every allocated AND pinned room name or cells will fail for a reason unrelated to their inflection point.
3. Retire-vs-invariant tension: retiring a decided bot (active:0) is what makes mixed-window worlds affordable, but an early-passed eventually-only cell stops being watched by CorpCop-style always rules; cells carrying always assertions must run their full window before retirement, and the judge must make this explicit per cell.
4. Nondeterminism: RUNNER_THREADS=2 means user execution order varies across runs; isolated cells are near-deterministic but not guaranteed — the rerun-once-solo policy masks real 50%-flaky bot bugs, so persistently flaky cells must be surfaced in the JSON artifact rather than silently passed.
5. Warm-fixture memory transplant: Scenario.applyState remaps object ids positionally (Scenario.ts:160-174) but injected Memory blobs also embed ROOM NAMES; re-homing warm-twoSourceRcl3Full memory from W0N0 to a packed slot needs a room-name rewrite pass, and a missed reference dangles silently (corps just do nothing) — exactly the failure the grid is meant to detect, indistinguishable from a bot bug.
6. applyState is module-private in test/integration/scenario/Scenario.ts and must be exported/extracted; duplicating its structure-schema gotchas (hits/hitsMax, neutral containers, storeCapacity vs storeCapacityResource) instead would rot.
7. Wall-clock budget: ~(233 + 67*bots) ms/tick means a 12-bot 350-tick world is ~6 min and the 800-tick planner band must be kept to 4-6 bots/world; total grid (~92 cells) is realistically 45-90 min sequential — CI needs --tier/--avenue subsetting and possibly --jobs 2-3 (verify memory headroom: each world is 3 child processes).
8. Verdict-window semantics drift: windows assume staging is complete at tick 0 and that tick counting starts at the first server.tick() after start(); any staging done after start (or bots added late) shifts every cell's window and invalidates designer-calibrated numbers like the 15-tick spawn-blocking-hauler cell.
9. addBot leaves safeMode:20000 on cold-start controllers while applyState clears it only when controller state is injected — harmless with no hostiles today, but any future cell staging hostile creeps will behave differently in cold vs warm cells.
10. Port/dir hygiene: each world binds a storage port that is not released synchronously on stop (helper.ts comment) — the grid must hand out unique ports per world and clean server/grid-* dirs, or batch N+1 hits EADDRINUSE mid-run.


---

# Cell catalog (92 cells)


## Avenue: Movement & travel

**Seam**: The movement seam is src/corps/movement.ts: travelTo (lines 45-61) forces a raw inward step when a creep stands on an exit tile (x/y==0|49) of the room holding its target — the border-bounce fix for the documented "miner flipping back and forth on the room border" bug (lines 2-16); isYielding (71-84) defines a yielding creep as my+workType=="upgrade"+standing exactly on memory.upgradeSpot; travelToBypass (101-119) paths with ignoreCreeps/maxRooms:1 and mutual-swaps through a yielding blocker, else falls back to travelTo. Consumers exercised by these cells: HarvestCorp.runHarvester (src/corps/HarvestCorp.ts:284-293) drives miners to sourceHarvestSpot at range 0 via travelTo, with minerApproach (46-50) arbitrating spot vs spread vs stay for multi-miner congestion ("miners standing around a source" bug, 41-45); HarvestCorp.moveToRemoteSource (267-271) travelTo across borders; CarryCorp.pickupEnergy cross-room travelTo (CarryCorp.ts:532-534) and deliverToController range-0 drop on the input tile via travelToBypass (746-758, the RCL2 ring-starve fix); nodeEnergy.workSpot (320-338) with the collect-range rule at 329 ("Collecting a real pile at range 2 was the original bug") and travelToBypass escape (331-336, "trapped-on-the-pile"); UpgradingCorp.runUpgrader park-and-settle via travelToBypass (UpgradingCorp.ts:185-198) with parkingTileFor caching memory.upgradeSpot (247-266) over nodeEnergy.controllerInputSpot/controllerParkingTiles (243-312, input tile reserved at 305); ScoutCorp travelTo to (25,25,targetRoom) (ScoutCorp.ts:194); Squad.moveAsWorm/wormOrder (Squad.ts:138-151, 216-218) — NOTE: zero production call sites (grep confirms only the definition). Staging leans on OrphanRescue re-adoption (src/execution/OrphanRescue.ts:96-136): injected creeps with workType "harvest"+assignedSourceId (or standing at the source), "haul"+assignedSourceId matching a commissioned carry route, or "upgrade"/"scout" by room get re-stamped to the live corp after the flow economy commissions it (first resolve <= ~FLOW_RESOLVE_INTERVAL=50 at RCL2 via startAtRcl), so verdict windows below include ~50 ticks adoption warm-up; the adoption moment is observable as exported Memory.creeps[name].corpId flipping from "staged" to a live corp id.

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `move-reach-harvest-spot` | T0 | 70t |  |
| `move-pickup-range-close` | T1 | 95t | Hauler stopped a tile short of the pile |
| `move-upgrader-park-settle` | T1 | 80t | RCL2 park/chase oscillation |
| `move-miner-congestion-open` | T2 | 75t | Miners standing around a source |
| `move-bypass-ring-deposit` | T2 | 85t | RCL2 ring-starve deadlock |
| `move-bypass-ring-escape` | T2 | 70t | Trapped-on-the-pile |
| `move-miner-pocket-holdoff` | T3 | 75t | Miner pile-up / displacement at a single-spot source |
| `move-swamp-detour` | T3 | 130t |  |
| `move-choke-corridor` | T3 | 115t |  |
| `move-border-inward-step` | T3 | 75t | Miner flipping back and forth on the room border |
| `move-scout-border-crossing` | T5 | 100t | Room-border bounce oscillation |

### `move-reach-harvest-spot` (T0) — Miner walks to the one designated harvest tile and stays

> **[errata: wrong-behavior #3]** — apply corrections before building.

- **Purpose**: Existence proof that travelTo delivers a creep to sourceHarvestSpot (bestAdjacentTile nearest the spawn) at range 0 and it holds the tile while harvesting.
- **World**: One room, border walls (RoomBuilder.border()). Spawn (25,25), controller (25,10), source (30,25) 5 tiles east. All plain interior.
- **Staged state**: Controller level 2 (startAtRcl/ScenarioState). Inject creep m1 [work,work,move] at (27,25) with Memory.creeps.m1 = {workType:'harvest', corpId:'staged', assignedSourceId:<idMap remap of source@30,25>}. No structures.
- **Expected**: Flow commissions the harvest corp (<= ~tick 50); OrphanRescue re-adopts m1 (OrphanRescue.ts:102-113); runHarvester travelTo(spot, range 0) seats it on (29,25) — the bestAdjacentTile nearest the spawn — and minerApproach returns 'stay' thereafter.
- **Assertion**: Within window: exported Memory.creeps.m1.corpId starts with 'mining-'; then world db shows m1 at (29,25) for >=5 consecutive ticks AND source.energy strictly decreases 4/tick over those ticks (2 WORK x 2).
- **Verdict window**: 70 ticks
- **Code refs**: `src/corps/HarvestCorp.ts:284-293`, `src/corps/nodeEnergy.ts:104-129`, `src/corps/nodeEnergy.ts:144-154`, `src/corps/movement.ts:45-61`, `src/execution/OrphanRescue.ts:96-114`

### `move-pickup-range-close` (T1) — Hauler closes to range 1 of the drop pile, not a tile short

> **[errata: wrong-behavior #3]** — apply corrections before building.

- **Purpose**: workSpot's collect-range rule: a real pile must be approached to range 1 (pickup range), not the range-2 drop distance.
- **World**: One room, border walls. Spawn (25,25), controller (25,8), source (25,45) ~20 tiles south. Plain interior.
- **Staged state**: RCL 2. Inject miner m1 [work x5, move x3] seated at the spot (25,44) with {workType:'harvest', corpId:'staged', assignedSourceId:<src>} — it drops 10/tick on its tile (no CARRY), organically creating the pile (dropped energy cannot be injected directly). Inject hauler h1 [carry,carry,move,move] energy 0 at (25,27) with {workType:'haul', corpId:'staged', assignedSourceId:<src>, working:false}.
- **Expected**: CarryCorp adopts h1 (OrphanRescue.ts:117-124); sourcePickupSpot resolves the pile at (25,44); workSpot computes range 1 (collect, not waitClear) and travelToBypass brings h1 adjacent; pickup fills the store.
- **Assertion**: Within window db shows h1.store.energy >= 100 (full), and on the first tick its store becomes >0 its position is at Chebyshev distance exactly 1 from (25,44) — never parked at distance 2 with an untouched pile for >5 ticks.
- **Verdict window**: 95 ticks
- **Known bug targeted**: Hauler stopped a tile short of the pile (range-2 collect), common in container-less remote mining — nodeEnergy.ts:329 comment
- **Code refs**: `src/corps/nodeEnergy.ts:320-338`, `src/corps/nodeEnergy.ts:162-195`, `src/corps/CarryCorp.ts:514-547`, `src/execution/OrphanRescue.ts:117-124`

### `move-upgrader-park-settle` (T1) — Upgraders settle on stable parking tiles and never squat the input tile

> **[errata: window #8]** — apply corrections before building.

- **Purpose**: travelToBypass + parkingTileFor deliver each upgrader to a distinct controllerParkingTiles slot, cached in memory.upgradeSpot, with no oscillation and the input tile left free.
- **World**: One room, border walls. Spawn (25,25), controller (25,10) with open surroundings, source (25,40).
- **Staged state**: RCL 2. Inject upgraders u1 [work,carry,move] at (24,22) and u2 [work,carry,move] at (26,22), each with energy 50 and Memory {workType:'upgrade', corpId:'staged'} (no upgradeSpot — they must earn one).
- **Expected**: UpgradingCorp adopts both by room (OrphanRescue.ts:127-135); parkingTileFor assigns distinct tiles from controllerParkingTiles(controller, inputSpot); travelToBypass walks them there; they park, upgrade in place, and drawFromInput never moves them.
- **Assertion**: By window end: u1 and u2 stand on two DISTINCT tiles that the harness recomputes as members of controllerParkingTiles (same algorithm as nodeEnergy.ts:292-312); neither ever ends a tick on the input tile; both positions unchanged for the final 10 ticks; exported Memory.creeps.u*.upgradeSpot equals each creep's standing tile; controller.progress increased.
- **Verdict window**: 80 ticks
- **Known bug targeted**: RCL2 park/chase oscillation — upgrader leaves its tile for a stray pile and is marched back every tick (UpgradingCorp.ts:222-227 comment)
- **Code refs**: `src/corps/UpgradingCorp.ts:179-205`, `src/corps/UpgradingCorp.ts:247-266`, `src/corps/nodeEnergy.ts:243-312`, `src/corps/movement.ts:101-119`

### `move-miner-congestion-open` (T2) — Two miners at an open source: one takes the spot, the other spreads

> **[errata: wrong-behavior #3, wrong-behavior #8, window #8]** — apply corrections before building.

- **Purpose**: minerApproach arbitration — exactly one miner claims the static spot; the second spreads to another adjacent tile and both harvest instead of queueing.
- **World**: One room, border walls. Spawn (25,25), source (25,40) fully open (8 free neighbours), controller (10,10).
- **Staged state**: RCL 2. Inject miners m1 [work,work,move] at (24,36) and m2 [work,work,move] at (26,36), both {workType:'harvest', corpId:'staged', assignedSourceId:<src>}.
- **Expected**: Both re-adopted into the same HarvestCorp; the first arrival seats on the spot (25,39, bestAdjacentTile nearest spawn); the second computes spotHeldByOther=true and 'spread' -> travelTo(source, range 1) to a different adjacent tile; both harvest simultaneously.
- **Assertion**: Within window there are >=5 consecutive ticks where exactly one of {m1,m2} is on (25,39), the other is at range 1 of the source on a different tile, and source.energy falls 8/tick (both harvesting); at no point do both idle at range >=2 of the source.
- **Verdict window**: 75 ticks
- **Known bug targeted**: Miners standing around a source — extra miners all insisting on the one occupied static tile, blocked two tiles out, never harvesting (HarvestCorp.ts:41-45 comment)
- **Code refs**: `src/corps/HarvestCorp.ts:46-50`, `src/corps/HarvestCorp.ts:284-293`, `src/corps/nodeEnergy.ts:104-129`, `src/corps/movement.ts:45-61`

### `move-bypass-ring-deposit` (T2) — Hauler penetrates a full upgrader ring via yield-swap and drops on the input tile

- **Purpose**: travelToBypass mutual swap through a yielding parked upgrader lets a loaded hauler reach the range-0 controller input tile when the ring has no gap.
- **World**: One room, border walls. Controller (25,10) in a walled nook: walls placed so the controllerInputSpot has EXACTLY 3 parking tiles around it (e.g. walls at (23,9)-(23,13) and (27,9)-(27,13) plus (24,9),(26,9) — harness must recompute inputSpot/parkingTiles from the final terrain with the nodeEnergy algorithm and adjust walls until |parkingTiles|==3). Spawn (25,25), source (25,40).
- **Staged state**: RCL 2. Inject 3 upgraders [work,carry,move] parked one per parking tile, each with Memory {workType:'upgrade', corpId:'staged', upgradeSpot:{x,y}=its own tile, working:true} and energy 50. Inject hauler h1 [carry,carry,move,move] with energy 100 at (25,20), Memory {workType:'haul', corpId:'staged', assignedSourceId:<src>, working:true, deliverSinkId:'controller'}.
- **Expected**: deliverToController routes h1 to the input tile at range 0 (CarryCorp.ts:751-756); the blocked first step finds a yielding upgrader (isYielding true: on its upgradeSpot) and both swap the same tick; h1 stands on the input tile and drops 100; the displaced upgrader walks back next tick.
- **Assertion**: Within window: a dropped-energy object (db type 'energy') with amount >=100 exists ON the recomputed input tile, and on the drop tick h1 occupies that tile; every displaced upgrader is back on its Memory.upgradeSpot tile within 2 ticks of its swap.
- **Verdict window**: 85 ticks
- **Known bug targeted**: RCL2 ring-starve deadlock — parked upgraders wall the input off, the shared pile never grows, the camp starves (movement.ts:95-99, nodeEnergy.ts:288-291 comments)
- **Code refs**: `src/corps/movement.ts:71-119`, `src/corps/CarryCorp.ts:722-758`, `src/corps/nodeEnergy.ts:243-312`, `src/corps/UpgradingCorp.ts:185-193`

### `move-bypass-ring-escape` (T2) — Empty hauler trapped on the pile swaps OUT through the ring

- **Purpose**: The reverse bypass: a hauler standing on the input tile, fully ringed, must swap through a yielding upgrader to leave for its next pickup instead of being walled in.
- **World**: Identical nook layout to move-bypass-ring-deposit (3 parking tiles, all walls the same).
- **Staged state**: RCL 2. Same 3 parked upgraders (each with upgradeSpot=own tile, energy 50). Inject hauler h1 [carry,carry,move,move] energy 0 standing ON the input tile, Memory {workType:'haul', corpId:'staged', assignedSourceId:<src>, working:false}. Inject a seated 5-WORK miner at the source spot so a pickup target (pile) exists.
- **Expected**: pickupEnergy routes h1 to sourcePickupSpot; workSpot's travelToBypass finds the first step blocked by a yielding upgrader and swaps through (nodeEnergy.ts:331-336); h1 escapes the ring and heads for the source.
- **Assertion**: h1 leaves the input tile within 5 ticks of adoption (corpId flip in exported Memory) and its Chebyshev range to the source spot strictly decreases over the following 10 ticks; all 3 upgraders are back on their upgradeSpot tiles by 2 ticks after the swap.
- **Verdict window**: 70 ticks
- **Known bug targeted**: Trapped-on-the-pile — hauler drops on the controller pile, the ring walls it in on the input tile and it never leaves (nodeEnergy.ts:331-335 comment)
- **Code refs**: `src/corps/nodeEnergy.ts:320-338`, `src/corps/movement.ts:101-119`, `src/corps/CarryCorp.ts:514-547`

### `move-miner-pocket-holdoff` (T3) — Second miner at a 1-spot pocketed source holds off, never displaces the holder

- **Purpose**: minerApproach 'spread' at a source with zero free adjacent tiles must not shove the seated miner off the only harvest tile or wedge the pocket mouth.
- **World**: One room, border walls. Source (10,25) pocketed with the pocket() helper (walls on all 8 neighbours except the north opening, so (10,24) is the only free adjacent tile). Spawn (25,25), controller (40,10).
- **Staged state**: RCL 2. Inject m1 [work,work,move] seated at (10,24) and m2 [work,work,move] at (14,25), both {workType:'harvest', corpId:'staged', assignedSourceId:<src>}.
- **Expected**: m1 -> 'stay' (onSpot); m2 -> spotHeldByOther && !adjacent -> 'spread' -> travelTo(source, range 1) finds no free adjacent tile (ERR_NO_PATH) and m2 idles nearby; m1 harvests uninterrupted.
- **Assertion**: For 20 consecutive ticks within the window: m1 is at (10,24) EVERY tick and source.energy strictly decreases 4/tick; m2 never occupies (10,24) and never ends two consecutive ticks adjacent to m1's tile blocking it (no displacement, no swap).
- **Verdict window**: 75 ticks
- **Known bug targeted**: Miner pile-up / displacement at a single-spot source (HarvestCorp.ts:41-50 comment)
- **Code refs**: `src/corps/HarvestCorp.ts:46-50`, `src/corps/HarvestCorp.ts:284-293`, `src/corps/movement.ts:45-61`, `scripts/sim-parallel.ts:49-57`

### `move-swamp-detour` (T3) — Hauler detours around a swamp band through the plains gap

> **[errata: wrong-behavior #6]** — apply corrections before building.

- **Purpose**: moveTo's default terrain costs (swamp 5x) make the round-trip route thread the plains corridor instead of wading the band.
- **World**: One room, border walls. Spawn (25,25), controller (25,8), source (25,42). Horizontal swamp band rows y=32..34 spanning x=1..48 EXCEPT a plain gap at x=18..19 (swampBand + carve-back).
- **Staged state**: RCL 2. Inject seated miner [work x5, move x3] at the source spot (25,41) ({workType:'harvest', corpId:'staged', assignedSourceId:<src>}) to grow the pile. Inject hauler h1 [carry,carry,move,move] energy 0 at (25,28) with {workType:'haul', corpId:'staged', assignedSourceId:<src>, working:false}.
- **Expected**: h1's route to the pile and back to the spawn network bends west through the x=18..19 gap: the detour (~+14 tiles) is cheaper than 3 swamp rows at 5x. Delivery completes normally.
- **Assertion**: Sampling h1's db position every tick over the window: it NEVER stands on a swamp tile (terrain mask check), AND it completes one full cycle — store goes 0 -> 100 (>= a tick at range 1 of the pile) -> 0 while at range <=1 of the spawn (spawn store rises that tick).
- **Verdict window**: 130 ticks
- **Code refs**: `src/corps/movement.ts:60`, `src/corps/CarryCorp.ts:514-547`, `src/corps/CarryCorp.ts:672-696`, `scripts/sim-parallel.ts:45-47`

### `move-choke-corridor` (T3) — Miner and hauler transit a 1-wide wall gap without deadlocking

> **[errata: wrong-behavior #3, wrong-behavior #7]** — apply corrections before building.

- **Purpose**: Opposing traffic through a single-tile choke between spawn side and source side must resolve — no head-on standoff freezing both creeps.
- **World**: One room, border walls. Vertical wall at x=15 with a single gap at y=25 (vWall(g,15,[25,25])). Source (8,25) west of the wall, spawn (25,25) and controller (35,10) east.
- **Staged state**: RCL 2. Inject miner m1 [work,work,move] at (20,25) (east side, must cross west) and hauler h1 [carry,carry,move,move] energy 0 at (22,25), both corpId 'staged' with workType 'harvest'/'haul' and assignedSourceId <src>.
- **Expected**: m1 crosses the gap and seats at (9,25) (bestAdjacentTile nearest spawn); h1 follows, fills from the pile, and re-crosses EAST through the same gap — possibly meeting later westbound traffic — and delivers to the spawn.
- **Assertion**: Within window: m1 is seated at (9,25) and stays; h1 is observed loaded (store>0) at some x>15 tile (proves an eastbound re-crossing); NEITHER creep's position is identical for more than 10 consecutive ticks unless m1 is on its spot (no frozen standoff in or near the gap).
- **Verdict window**: 115 ticks
- **Code refs**: `src/corps/movement.ts:45-61`, `src/corps/HarvestCorp.ts:284-293`, `src/corps/nodeEnergy.ts:320-338`, `scripts/sim-parallel.ts:42-44`

### `move-border-inward-step` (T3) — Creep on its target room's exit tile steps straight inward, never oscillates

> **[errata: infeasible #5, wrong-behavior #3]** — apply corrections before building.

- **Purpose**: travelTo's border-bounce fix: on an exit tile of the room holding the target, take the raw inward step (movement.ts:54-57) instead of letting moveTo shove the creep back across.
- **World**: Home room with border walls EXCEPT an open east-edge exit slot at x=49, y=24..26 (exit tiles must exist). Spawn (25,25), controller (25,10), source (44,25). padNeighborTerrain pads the east neighbour all-plain.
- **Staged state**: RCL 2. Inject miner m1 [work,work,move] at (49,25) — on the exit tile — with {workType:'harvest', corpId:'staged', assignedSourceId:<src@44,25>}. NOTE: pre-adoption the idle creep may be engine-shunted into the neighbour room and drift; the assertion therefore keys off the adoption moment.
- **Expected**: Once adopted, runHarvester calls travelTo(spot(43,25), range 0); with the creep on a home exit tile the forced step is LEFT to (48,25); thereafter normal pathing seats it at (43,25). It never flips back across the border.
- **Assertion**: After exported Memory shows m1.corpId beginning 'mining-': the first tick m1 stands on a home-room exit tile (x==49) is followed NEXT tick by x==48; from then on m1 never again occupies an edge tile of the home room nor appears in the east neighbour's db objects; by window end m1 is seated at (43,25) with source.energy decreasing.
- **Verdict window**: 75 ticks
- **Known bug targeted**: Miner flipping back and forth on the room border — the exact symptom the travelTo inward-step fix exists for (movement.ts header)
- **Code refs**: `src/corps/movement.ts:2-16`, `src/corps/movement.ts:45-61`, `src/corps/HarvestCorp.ts:284-293`, `test/integration/loadLayout.ts:251-266`

### `move-scout-border-crossing` (T5) — Scout crosses into the neighbour room and penetrates to the interior without bouncing

> **[errata: wrong-behavior #2]** — apply corrections before building.

- **Purpose**: Cross-room travelTo end-to-end: moveTo carries the creep over the border, then the inward-step rule fires on the target room's exit tile so the scout makes real progress toward (25,25) of the remote room.
- **World**: Two real rooms: home W0N0 (spawn (25,25), source (25,40), controller (25,10), border walls except an open east-edge slot y=20..30) and neighbour W1N0 (all-plain with border walls except the matching open west-edge slot y=20..30, plus a small interior wall stub so terrain is non-degenerate). Other neighbours padded.
- **Staged state**: RCL 2. Inject scout s1 [move] at (30,25) with Memory {workType:'scout', corpId:'staged'}. (ScoutCorp adopts by room per OrphanRescue ROLE_KIND.)
- **Expected**: ScoutCorp assigns an unexplored neighbour (W1N0 is the only enterable one) and travelTo drives s1: it crosses the border, lands on W1N0's x==0 exit tile, takes the forced RIGHT step to x==1, and closes on (25,25,W1N0); intel for W1N0 gets recorded.
- **Assertion**: Within window: s1 appears among W1N0 db objects; within 2 ticks of first appearing there it stands at an interior tile (x>=1 and not on any W1N0 edge tile the tick after landing); it does NOT re-enter W0N0 during the next 15 ticks; its range to (25,25,W1N0) decreases over 10 consecutive ticks; exported Memory shows room intel recorded for W1N0.
- **Verdict window**: 100 ticks
- **Known bug targeted**: Room-border bounce oscillation — remote creep re-enters the room it came from and flips forever (movement.ts:2-16)
- **Code refs**: `src/corps/ScoutCorp.ts:194`, `src/corps/movement.ts:45-61`, `src/execution/OrphanRescue.ts:127-135`, `test/integration/remote-mining.test.ts:44-70`

**Open questions (Movement & travel)**:
- Squad.moveAsWorm has no production callers (grep over src/ finds only the definition at Squad.ts:138) — the move-worm-chain cell only works if the harness ships a test-build hook that constructs a Squad and drives moveAsWorm from a Memory flag; otherwise demote it to a unit test on wormOrder + a mocked moveAsWorm and drop the cell.
- Adoption-based staging assumes the flow economy commissions harvest/carry corps within ~50 ticks of an RCL2 start (FLOW_RESOLVE_INTERVAL=50) and that OrphanRescue then re-stamps injected creeps; hauler re-adoption specifically requires a CarryCorp with getAssignmentForSource(assignedSourceId) (OrphanRescue.ts:117-124) — verify a single-source RCL2 room always commissions a carry route, or the ring/pickup cells' haulers get recycled after ORPHAN_GRACE_TICKS=25 instead of driven.
- ScenarioState cannot inject dropped-energy piles (only structures/creeps) — pile-dependent cells stage a seated CARRY-less miner to generate the pile organically; if the harness gains raw db insert of {type:'energy'} objects, windows shrink ~10 ticks.
- Injected creep memory rides in ScenarioState.memory (Memory.creeps.*) with idMap remapping for assignedSourceId — ScenarioCreep itself has no memory field; confirm the harness merges a partial Memory (just creeps.*) without clobbering the bot's own first-tick Memory initialization.
- RoomBuilder.border() walls the full room edge, so border-crossing cells (move-border-inward-step, move-scout-border-crossing) need custom terrain rows leaving exit slots, and padNeighborTerrain pads all-plain neighbours (loadLayout.ts:265) — verify the mockup engine's edge-transfer semantics for a stationary creep parked on an exit tile pre-adoption (it may shunt the creep into the neighbour room; the assertions key off the adoption moment to tolerate this, but confirm the creep is not lost).
- move-bypass-ring-* wall coordinates must be tuned until the harness's recomputation of controllerInputSpot/controllerParkingTiles (same algorithm as nodeEnergy.ts:243-312) yields exactly 3 parking tiles — hardcoding tile coords without recomputation will drift from the bot's own resolution.
- ScoutCorp target selection is unverified (does it always pick the one enterable neighbour, and how soon after RCL2 start does the scout corp commission?) — if it can pick a padded-but-walled neighbour or delays past ~50 ticks, the move-scout-border-crossing window needs re-baselining.
- Verdict windows above INCLUDE ~50 ticks of flow-resolve/adoption warm-up; if the harness later supports injecting full corp Memory (Scenario.state.memory + idMap of a captured snapshot), each staged cell's window shrinks by ~50 ticks but the Memory schema is fragile across bot versions.


## Avenue: Spawn decisions (SHOULD spawn — the scheduler)

**Seam**: The seam is the demand-driven spawn pipeline: corps emit SpawnDemands (HarvestCorp.getSpawnDemand src/corps/HarvestCorp.ts:365-426 with blocking:current===0 at :418 and the cold-start-only 2-WORK runt floor at :400-402; CarryCorp.getSpawnDemand src/corps/CarryCorp.ts:823-905 with HAULER_MIN_CARRY=3 and blocking:current===0; UpgradingCorp.getSpawnDemand src/corps/UpgradingCorp.ts:328+ gated on roomHasHauler at ~:345, value 90; ConstructionCorp builders value 95/blockingWhenEmpty:false at src/corps/ConstructionCorp.ts:124-126, tankers 94/blocking at :133-135; ReservationCorp value 92/producesIncome at src/corps/ReservationCorp.ts:137-170). SpawnDirector.runSpawnScheduling (src/execution/SpawnDirector.ts:39-113) gates on FLOW_MIN_RCL=2 (:34), skips busy spawns WITHOUT touching demand timers (:58-65), stamps Memory.spawnDemandFirstSeen keyed `${spawn.id}:${buyerCorpId}:${role}` (:76), prunes timers only for evaluated spawns (:109-112), and groups a source's miner+haulers into one income unit with groupStarted = miner-in-field (collectDemands :128-178; reserver forced groupId+groupStarted=true at :199-222). SpawnScheduler.spawnPriority (src/spawn/SpawnScheduler.ts:158-173) ranks strictly tiered: INCOME_TIER=1e6 (groupId+producesIncome), +BLOCKING=1e4, +STARTED=1e3, base value 50-110; non-income blocking gets only +1e3. starvationBoost lifts a demand aged >= STARVATION_THRESHOLD=300 by STARVED_TIER=3e6 for a one-shot spawn (:184-209). scheduleSpawn (:236-297) implements hold-for-blocking: an unaffordable-but-buildable blocking demand returns null when income>0 (:280-283), or at income==0 sets holdForBlocking/holdStrict so lower non-blocking (and, strict, even income-producing) demands are skipped (:254-292); withMinerPrecedence (:311-313) drops any hauler demand whose groupStarted===false. Decisions are externally observable: SpawningCorp.executeSpawn names creeps `${role}-${buyerCorpId.slice(-6)}-${tick}` with memory {corpId, workType} (src/corps/SpawningCorp.ts:120-167), so role/order/body of every spawn is readable from the world db, and spawnDemandFirstSeen from exported Memory.

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `spawn-first-miner-outranks-all` | T0 | 80t | colonyHasMiner counting bootstrap jacks made every flow mine |
| `spawn-no-hauler-before-miner` | T1 | 90t | green haulers parked at minerless sources in every room |
| `spawn-hold-strict-first-hauler` | T1 | 60t | first-hauler deadlock: spending the dribble on extra miners/ |
| `spawn-93-fresh-miner-beats-scaling-hauler` | T2 | 40t | #93: STARTED >> URGENT let one source's endless scaling-haul |
| `spawn-hold-full-miner-regrow` | T2 | 80t | runt-economy collapse: 1-WORK miners under energy pressure k |
| `spawn-starved-builder-one-shot` | T3 | 40t | value-95 builder never won a slot against the +1e6 income ti |
| `spawn-timer-survives-busy-spawn` | T4 | 150t | resetting a demand's clock whenever the spawn was busy meant |
| `spawn-blocking-hauler-spawns-at-min-scaled` | T4 | 15t |  |
| `spawn-reserver-started-income` | T5 | 25t | reserver at bare value 92 sat below every income corp and ev |
| `spawn-reserver-yields-to-blocking-miner` | T5 | 40t |  |

### `spawn-first-miner-outranks-all` (T0) — First miner outranks everything at flow handoff

> **[errata: window #2]** — apply corrections before building.

- **Purpose**: At a cold RCL2 start the scheduler's very first spawn must be the source's first miner (income+blocking = 1e6+1e4+~100), never a hauler (filtered by withMinerPrecedence), upgrader (returns [] without a hauler), or builder (95).
- **World**: W0N0, 50x50 bordered wall ring plus two interior 5-tile wall stubs near (10,10) and (40,40) to give the distance transform an interior peak; spawn (25,25), source (30,25) ~5 tiles, controller (25,10).
- **Staged state**: cold via startAtRcl level 2 (controller {level:2, progress:0}); no creeps, no structures beyond the spawn.
- **Expected**: Bootstrap may field jack creeps, but the first scheduler-spawned creep (name prefix miner-/hauler-/upgrader-/builder-/tanker-/reserver-) is a miner; upgrader demand is absent (roomHasHauler false) and the hauler demand is dropped while groupStarted is false.
- **Assertion**: Within the window, a creep whose name matches ^miner- appears in the world db, and at every tick before it appears there is NO creep matching ^(hauler|upgrader|builder|tanker|reserver)-; the miner's body is [WORK,WORK,MOVE] (cold-start runt floor, cost 250 at 300 capacity) and its Memory.creeps entry has workType 'harvest'.
- **Verdict window**: 80 ticks
- **Known bug targeted**: colonyHasMiner counting bootstrap jacks made every flow miner non-blocking so the bootstrap-to-flow handoff never happened (HarvestCorp.ts:432-439 comment)
- **Code refs**: `src/spawn/SpawnScheduler.ts:158-173`, `src/spawn/SpawnScheduler.ts:311-313`, `src/corps/HarvestCorp.ts:400-426`, `src/corps/UpgradingCorp.ts:328-346`, `src/execution/SpawnDirector.ts:34`, `src/corps/SpawningCorp.ts:153`

### `spawn-no-hauler-before-miner` (T1) — No hauler before its source's miner is fielded

- **Purpose**: withMinerPrecedence must drop a source's hauler demand until that source's HarvestCorp has a creep in the field (groupStarted), even when the spawn is always flush with energy.
- **World**: W0N0 bordered plain with interior wall stubs; spawn (25,25), source (25,45) ~20 tiles, controller (25,8).
- **Staged state**: startAtRcl level 2, cold; staging trick: harness patches the spawn's db store.energy back to 300 EVERY tick so no decision is ever energy-gated - an eager scheduler would spawn the hauler instantly if the precedence filter were broken.
- **Expected**: First flow spawn is the miner; the source's first hauler only begins spawning once the miner exists in Game.creeps (groupStarted flips true as soon as the miner is spawning), never before.
- **Assertion**: At every tick in the window: count(db creeps ^hauler-) == 0 OR count(^miner-) >= 1; AND (non-vacuous) by window end both exist with firstTick(^hauler-) > firstTick(^miner-); the first hauler has >= 3 CARRY parts.
- **Verdict window**: 90 ticks
- **Known bug targeted**: green haulers parked at minerless sources in every room (withMinerPrecedence doc, SpawnScheduler.ts:299-310)
- **Code refs**: `src/spawn/SpawnScheduler.ts:311-313`, `src/execution/SpawnDirector.ts:143-178`, `src/corps/CarryCorp.ts:823-905`

### `spawn-hold-strict-first-hauler` (T1) — Strict hold for the blocking first hauler - no runt, no extra miner

- **Purpose**: When the blocking first hauler (minCost 300) is unaffordable, holdForBlocking+holdStrict must refuse an AFFORDABLE scaling-miner demand (250) so energy accumulates to the hauler's 3-CARRY floor instead of bleeding out on lower income producers.
- **World**: W0N0 bordered plain; spawn (25,25), open 8-spot source (25,40) ~15 tiles (totalWork 5 at 300 cap gives affordableWork 2, so a 250-cost scaling miner demand persists after the first miner), controller (25,8).
- **Staged state**: startAtRcl level 2, cold; harness waits until the first ^miner- creep exists, then sets the spawn's db store.energy to 260 (above the 250 scaling-miner min, below the 300 hauler min) and stops interfering.
- **Expected**: scheduleSpawn holds: no second miner spawns at 260-299 energy despite being affordable (strict hold because the blocking hauler producesIncome); when energy reaches 300 (spawn self-regen / jack deliveries) the first hauler spawns at exactly the 3-CARRY floor.
- **Assertion**: From the stage tick: spawn.spawning stays null in the db while store.energy < 300 (in particular no second ^miner- creep is created), and the next creep created is ^hauler- with body exactly 3xCARRY+3xMOVE (cost 300).
- **Verdict window**: 60 ticks
- **Known bug targeted**: first-hauler deadlock: spending the dribble on extra miners/upgraders meant the spawn never accumulated the hauler body (SpawnScheduler.ts:226-234 comment)
- **Code refs**: `src/spawn/SpawnScheduler.ts:254-296`, `src/corps/CarryCorp.ts:880-905`, `src/corps/HarvestCorp.ts:365-402`, `src/execution/SpawnDirector.ts:233-243`

### `spawn-93-fresh-miner-beats-scaling-hauler` (T2) — Fresh source's first miner beats another source's scaling hauler

- **Purpose**: BLOCKING (1e4) above STARTED (1e3): a minerless source's first miner (1e6+1e4+~100) must outrank a started source's 2nd+ hauler (1e6+1e3+<=110) - the #93 monopoly regression.
- **World**: Two-source room per warm-two-source fixture: W0N0 bordered, spawn (25,25), source A (15,30), source B (35,30), controller (25,10), RCL2+.
- **Staged state**: Load warm two-source fixture (creeps+memory+structures), then surgically stage the decision: delete source B's miner and ALL of source B's haulers from the db (and their Memory.creeps entries), and delete one of source A's haulers so A has an active scaling-hauler demand (fielded CARRY < carryNeeded); leave spawn+extensions energy at fixture values (>= 300).
- **Expected**: Next spawn is B's first miner (blocking fresh income), not A's replacement/scaling hauler, even though the hauler demand's raw value (90+min(carryNeeded,20)) can exceed the miner's ~100.
- **Assertion**: Per-tick invariant over the window: never (creeps with Memory corpId == A's carry corp >= fixture count) while B has zero ^miner- creeps; decisively, the first creep created after the stage tick is ^miner- whose Memory.creeps corpId is B's harvest corp, and it appears before any new ^hauler- creep.
- **Verdict window**: 40 ticks
- **Known bug targeted**: #93: STARTED >> URGENT let one source's endless scaling-hauler demand monopolise the spawn so the second source never got a miner (SpawnScheduler.ts:144-152 comment)
- **Code refs**: `src/spawn/SpawnScheduler.ts:144-173`, `src/execution/SpawnDirector.ts:143-159`, `src/corps/HarvestCorp.ts:405-426`, `src/corps/CarryCorp.ts:895-905`

### `spawn-hold-full-miner-regrow` (T2) — Hold accumulates 700 for a full replacement miner instead of spawning small

- **Purpose**: A dead miner's blocking demand with minCost==desiredCost (700 at 800 capacity, no runt floor since colonyHasMiner) plus income>0 must make scheduleSpawn return null - nothing else spawns - until the full 5-WORK body is affordable.
- **World**: warm-twoSourceRcl3Full fixture world: W0N0 bordered, spawn (25,25), sources (15,30)/(35,30), controller (25,10), RCL3 with 10 extensions (800 capacity) and containers.
- **Staged state**: Load warm-twoSourceRcl3Full; harness deletes source A's miner (miner-t-7840-360) from the db, then sets spawn+extension stores to total 400 energy (below the 700 miner min, above hauler/upgrader/tanker mins). Haulers remain alive so estimateIncome > 0.
- **Expected**: The unaffordable blocking miner tops the ranking; income>0 branch returns null outright, so the spawn idles - no upgrader, tanker, or hauler spawns - while hauler deliveries refill to 700, then a full 5-WORK miner spawns (buildMinerBody(5,800)=WORKx5+CARRY+MOVEx3, cost 700).
- **Assertion**: From stage until room energy >= 700, db spawn.spawning stays null (zero creeps created); the first creep created after stage is ^miner- with exactly 5 WORK parts and body length 9; no creep with fewer WORK parts or another role spawns in between.
- **Verdict window**: 80 ticks
- **Known bug targeted**: runt-economy collapse: 1-WORK miners under energy pressure kept the source under-mined and every later creep a runt too (HarvestCorp.ts:387-398 comment; runt-economy.test.ts)
- **Code refs**: `src/spawn/SpawnScheduler.ts:276-296`, `src/corps/HarvestCorp.ts:387-403`, `src/spawn/BodyBuilder.ts:63-120`, `src/execution/SpawnDirector.ts:233-243`

### `spawn-starved-builder-one-shot` (T3) — Starved builder gets exactly one preemptive spawn after 300 ticks

> **[errata: wrong-behavior #8]** — apply corrections before building.

- **Purpose**: starvationBoost lifts a demand aged >= STARVATION_THRESHOLD=300 by STARVED_TIER=3e6, above all income tiers, for exactly one spawn; backdating Memory.spawnDemandFirstSeen fast-forwards the age without 300 real ticks.
- **World**: warm-twoSourceRcl3Full fixture world (two sources, RCL3, 800 capacity); one source's haul route kept under-staffed so an affordable income demand recurs every tick.
- **Staged state**: Load warm-twoSourceRcl3Full; delete two of source A's haulers (persistent affordable scaling-hauler demand, priority ~1e6+1e3+110); ensure a construction site exists (fixture's remaining extension sites, else inject one) so the builder demand (value 95, blockingWhenEmpty false) appears; harness reads exported Memory, finds the spawnDemandFirstSeen key ending ':builder', and rewrites its value to Game.time-300.
- **Expected**: On the next tick the spawn is free, effectivePriority(builder)=3,000,095 beats every income demand, so the builder spawns despite an affordable hauler demand the same tick; afterwards the builder demand disappears, its timer key is pruned, and income spawning resumes (one-shot).
- **Assertion**: Within 15 ticks of the backdate (plus any in-flight spawn remainder), a ^builder- creep starts spawning in the db while at least one hauler demand was affordable (proved by a ^hauler- being the NEXT spawn after the builder); exported Memory.spawnDemandFirstSeen no longer contains the ':builder' key within 15 ticks after the builder spawn starts.
- **Verdict window**: 40 ticks
- **Known bug targeted**: value-95 builder never won a slot against the +1e6 income tier, so a placed construction site sat unbuilt indefinitely (SpawnScheduler.ts:177-184 comment)
- **Code refs**: `src/spawn/SpawnScheduler.ts:184-209`, `src/spawn/SpawnScheduler.ts:244-249`, `src/execution/SpawnDirector.ts:72-80`, `src/execution/SpawnDirector.ts:109-112`, `src/corps/ConstructionCorp.ts:124-126`, `src/corps/Squad.ts:159-180`

### `spawn-timer-survives-busy-spawn` (T4) — Demand aging survives a busy spawn

- **Purpose**: A busy spawn is skipped WITHOUT evaluating (SpawnDirector.ts:64) and the prune loop only clears timers for evaluated spawns (:109-112), so a chronically-outranked demand's spawnDemandFirstSeen stamp must stay constant across long spawn-busy periods instead of resetting.
- **World**: W0N0 bordered plain, spawn (25,25), two far sources (8,45)/(42,45) (~28 tiles: big hauler fleets), controller (25,8); RCL4.
- **Staged state**: startAtRcl level 4 + inject 20 extensions (energy 50 each) via ScenarioState structures for 1300 capacity; run warmup until a construction site exists and a ':builder' key appears in exported Memory.spawnDemandFirstSeen (income bodies at 1300 cap are 20-26 parts, so the spawn is busy 60-78 ticks at a stretch).
- **Expected**: Across at least two spawn-busy periods the builder key's value never changes and is never deleted-and-restamped; only when the builder demand actually disappears (creep spawned or sites gone) at an EVALUATED spawn does the key get pruned.
- **Assertion**: Reading exported Memory every tick for the window: spawnDemandFirstSeen[':builder' key] exists and equals its first-observed value at every tick where the db spawn has spawning != null, including across >= 2 distinct busy periods of >= 20 ticks each; the key is never re-stamped to a later tick while the builder demand persists.
- **Verdict window**: 150 ticks
- **Known bug targeted**: resetting a demand's clock whenever the spawn was busy meant a room forever spawning income never let the builder age to its backstop (SpawnDirector.ts:60-64 comment)
- **Code refs**: `src/execution/SpawnDirector.ts:58-65`, `src/execution/SpawnDirector.ts:72-80`, `src/execution/SpawnDirector.ts:109-112`

### `spawn-blocking-hauler-spawns-at-min-scaled` (T4) — Blocking hauler spawns immediately at the scaled 3-CARRY min, not held for the full body

> **[errata: window #3]** — apply corrections before building.

- **Purpose**: The deliberate asymmetry to the miner hold: an AFFORDABLE blocking demand spends now with energyBudget=min(desiredCost, energyAvailable) ('afford-min-scaled'), because the first hauler is what refills the spawn - holding for the desired 13-CARRY body would deadlock.
- **World**: W0N0 bordered plain, spawn (25,25), source A (25,45) ~20 tiles with container, second source (10,30), controller (25,8); RCL4 with 20 extensions (1300 capacity, so desiredCarry can reach 13 while minCost stays 300).
- **Staged state**: RCL4 warm state (captured via snapshot-warm at RCL4, or startAtRcl(4)+injected extensions with warmup) with source A's miner alive and mining; harness deletes ALL of source A's haulers (blocking first-hauler demand, minCost 3x100=300, desiredCost up to 1300) and sets spawn+extension stores to total exactly 320.
- **Expected**: scheduleSpawn takes the affordable blocking hauler immediately with budget 320 - a 3xCARRY+3xMOVE body - rather than waiting for 1300; after refill, later haulers are bigger (healing toward desiredCarry).
- **Assertion**: Within 10 ticks of the stage, a ^hauler- creep starts spawning with exactly 3 CARRY parts (cost 300) while room energy was < desiredCost; stretch: within +100 ticks a second ^hauler- for the same corp spawns with > 3 CARRY.
- **Verdict window**: 15 ticks
- **Code refs**: `src/spawn/SpawnScheduler.ts:263-275`, `src/corps/CarryCorp.ts:835-905`, `src/spawn/SpawnScheduler.ts:299-313`

### `spawn-reserver-started-income` (T5) — Reserver ranks as started income - above all consumption

> **[errata: infeasible #3]** — apply corrections before building.

- **Purpose**: collectDemands forces the reserver into the income tier with groupStarted=true (1e6+1e3+92), so once a remote source is being mined the reserver outranks the builder (95) and scaling upgraders (90) instead of starving at its base value.
- **World**: Home W0N0 bordered, spawn (25,25), sources (15,30)/(35,30), controller (25,10), RCL3 with 10 extensions (800 capacity >= 650 CLAIM+MOVE); remote W1N0 adjacent with neutral controller (25,25) and source (20,25); open exits between the rooms, both bordered otherwise.
- **Staged state**: Home loaded from a warm RCL3-full state (fully staffed: both sources mined+hauled, upgraders fielded, NO blocking home demands); inject a remote miner creep at W1N0 (19,25) body [WORK,WORK,MOVE], user=bot, with Memory.creeps entry {workType:'harvest', corpId:<home harvest corp or synthetic live corp>} so ReservationCorp.targetRooms() sees a harvest creep in an unowned, unreserved controller room; room energy >= 650.
- **Expected**: ReservationCorp emits a reserver demand (value 92, producesIncome, forced groupStarted) and it wins the next spawn over the value-95 builder and value-90 upgrader demands.
- **Assertion**: Within the window a ^reserver- creep starts spawning at the home spawn with body exactly [CLAIM,MOVE] (cost 650) and Memory workType 'reserve'; no new ^upgrader- or ^builder- creep spawns before it; stretch (+60 ticks): db W1N0 controller acquires reservation by the bot's user id.
- **Verdict window**: 25 ticks
- **Known bug targeted**: reserver at bare value 92 sat below every income corp and every blocking consumer, so the remote stayed at unreserved half-rate forever (SpawnDirector.ts:203-208 comment)
- **Code refs**: `src/execution/SpawnDirector.ts:197-222`, `src/corps/ReservationCorp.ts:71-86`, `src/corps/ReservationCorp.ts:137-170`, `src/spawn/BodyBuilder.ts:467-490`

### `spawn-reserver-yields-to-blocking-miner` (T5) — Reserver yields to a blocking home miner

> **[errata: infeasible #3]** — apply corrections before building.

- **Purpose**: Started-income reserver (1e6+1e3+92 = 1,001,092) must NOT preempt a fresh/regrow home miner's blocking demand (1e6+1e4+~100 = 1,010,100): reservation is optimization, a dead home source is the critical path.
- **World**: Same two-room world as spawn-reserver-started-income (home W0N0 RCL3/800 cap + remote W1N0 with neutral controller, source, and injected remote harvest creep).
- **Staged state**: Same warm staffed home state + remote miner injection; additionally the harness deletes home source B's miner from the db and sets spawn+extension stores to total 800 (both the 700 miner min and the 650 reserver affordable).
- **Expected**: Both demands are present and affordable the same tick; the blocking miner outranks the started-income reserver, so the miner spawns first; the reserver follows only after the miner (and any refill wait).
- **Assertion**: The first creep created after the stage tick is ^miner- with 5 WORK parts (Memory corpId = source B's harvest corp); no ^reserver- creep exists in the db before that miner creep does.
- **Verdict window**: 40 ticks
- **Code refs**: `src/spawn/SpawnScheduler.ts:158-173`, `src/execution/SpawnDirector.ts:197-222`, `src/corps/HarvestCorp.ts:405-426`

**Open questions (Spawn decisions (SHOULD spawn — the scheduler))**:
- applyState (test/integration/scenario/Scenario.ts:137-158) inserts injected creeps only into scenario.bot.room - the T5 cells' remote-room harvest creep needs either a per-creep room field added to ScenarioCreep or a direct db rooms.objects insert by the harness.
- Mid-run Memory patching (backdating spawnDemandFirstSeen, cell spawn-starved-builder-one-shot) must read env.keys.MEMORY+botId and write back between the bot's end-of-tick write and next read; verify screeps-server-mockup write ordering so the patch is not clobbered.
- Warm-fixture surgery (deleting a specific corp's creeps/haulers) must keep commissionedCorps rosters and Memory.creeps consistent enough that corp hysteresis/ORPHAN_GRACE_TICKS=25 does not retire the corp or distort demands before the verdict - needs one dry run per cell.
- No RCL4 warm fixture exists (only warm-twoSourceRcl3Full); cells spawn-timer-survives-busy-spawn and spawn-blocking-hauler-spawns-at-min-scaled need a snapshot-warm capture at RCL4 or a startAtRcl(4)+injected-extensions warmup, which lengthens their effective setup (not verdict) time.
- Whether bootstrap jacks spawn at a cold startAtRcl(2) start decides which hold branch (income>0 return-null vs income==0 holdStrict) cells spawn-first-miner/no-hauler/hold-strict exercise; the assertions are written to pass under either, but the per-tick spawn-energy patch trick needs verifying against the engine's own spawn energy regen (does a db store overwrite race the processor?).
- Construction-site presence for the builder demand (cells 6-7) relies on the bot placing its own sites at RCL3/4; if plan timing is late the harness must inject a constructionSite db object - its accepted schema (progress/progressTotal/user) in the mockup needs confirming.
- Confirm the db field shape for an in-progress spawn (spawn doc 'spawning' object) in screeps-server-mockup so the 'spawn stayed idle' assertions (cells 3, 5) read the right decisive field.
- Cell rooms must be spaced >= 2 rooms apart per sim-parallel.ts practice so one bot's analysis box never overlaps another cell; the two T5 cells each consume a 2-room strip plus padded neighbours.


## Avenue: Spawn execution & body correctness (freshly spawned)

**Seam**: The seam is the demand->execution pipeline: SpawnDirector.collectDemands (src/execution/SpawnDirector.ts:128-225, with the flow-id prefix strips sourceKey at :143 and id.replace(/^carry-/,"") at :168) -> scheduleSpawn (src/spawn/SpawnScheduler.ts:236-297, tiers STARVED 3e6 / INCOME 1e6 / +BLOCKING 1e4 / +STARTED 1e3 at :158-204, withMinerPrecedence :311-313) -> SpawningCorp.executeSpawn (src/corps/SpawningCorp.ts:120-167; memory stamp {corpId, workType, spawnedBy} at :152-155; hauler CARRY:MOVE unit builder at :194-207) -> src/spawn/BodyBuilder.ts (buildMinerBody :63-122 with MINER_CARRY_MIN_CAPACITY=600 reserved at :61,:72-73; buildHaulerBody 1.2x buffer :174; buildUpgraderBody containerFed :385-407; buildReserverBody :467-478; MAX_BODY_PARTS=50 at :40). Demand sizing lives in HarvestCorp.getSpawnDemand (src/corps/HarvestCorp.ts:365-426, cold-start 2-WORK floor :399-402), CarryCorp.getSpawnDemand (src/corps/CarryCorp.ts:823-904, HAULER_MIN_CARRY=3 :885, even-split :863-871, maxCarryPerHauler=floor(capacity/100) :835), UpgradingCorp.getSpawnDemand (src/corps/UpgradingCorp.ts:328-408, roomHasHauler gate :288-294 checking corpId.startsWith("hauling-")). Runt recycling: HarvestCorp.flagMinerRuntForRecycling (src/corps/HarvestCorp.ts:243-262, gate = energyAvailable >= cost of runt+1 WORK body) and CarryCorp.flagRuntForRecycling (src/corps/CarryCorp.ts:274-290, gate = energyAvailable >= (minCarry+1)*100), both over pickRuntToRecycle (src/corps/recycle.ts:33-47). Key staging enabler: OrphanRescue.readoptTarget (src/execution/OrphanRescue.ts:96-136) re-adopts an injected creep with a dummy corpId into the correct live corp by workType+position/assignedSourceId, sidestepping the fact that corp ids embed sourceId.slice(-4) and cannot be pre-computed for idMap. Tick order (src/main.ts:194,201,360): corps work -> rescueOrphans -> runSpawnScheduling, so recycle flags and readoptions land before the scheduler spends energy. Capacity ladder from getMaxSpawnCapacity (src/planning/EconomicConstants.ts:267-291): 300/550/800/1300 at RCL1-4, realized via injected extensions (energyCapacityAvailable is what demands read, SpawnDirector.ts:67-70).

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `spawnexec-first-miner-stamp-300` | T0 | 35t | flow-id prefix regressions: harvestKind |
| `spawnexec-miner-body-550` | T1 | 35t |  |
| `spawnexec-miner-carry-600-boundary` | T1 | 35t | the CARRY-reservation ordering bug the comment at BodyBuilde |
| `spawnexec-first-hauler-group-prefix` | T1 | 45t | flow 'source-'/'carry-' prefix mismatch making groupStarted  |
| `spawnexec-hauler-carry-route-distance` | T2 | 60t |  |
| `spawnexec-upgrader-containerfed-workheavy` | T2 | 40t | the documented mobile-unit waste bug |
| `spawnexec-miner-runt-recycle-affordable` | T3 | 50t | the runt catch-22 |
| `spawnexec-miner-runt-immortal-at-cap` | T3 | 40t | the inverse guard of the runt fix: 'never disrupt a working  |
| `spawnexec-hauler-runt-recycle-pounce` | T3 | 45t | runt-fleet heal |
| `spawnexec-bodies-at-1300-rcl4` | T4 | 70t |  |
| `spawnexec-reserver-body-multiroom` | T5 | 90t |  |

### `spawnexec-first-miner-stamp-300` (T0) — First flow miner: memory stamp + cold-start floor at 300

- **Purpose**: executeSpawn stamps corpId/workType/spawnedBy that resolve to a live commissioned corp, and the colony's first miner spawns at the 2-WORK cold-start floor (never 1W) within a 300-energy budget.
- **World**: Room W1N1, bordered walls, one interior wall cluster near (30,25) for a distance-transform peak. Spawn at (25,25). Source pocketed to 1 mining spot at (19,25) via pocket() (~6 tiles path). Controller at (35,20).
- **Staged state**: startAtRcl bumps controller to level 2. No extensions (capacity 300); spawn energy 300. Inject decoy hauler creep [CARRY,MOVE] at (24,23) with memory {corpId:'stale-decoy', workType:'haul', assignedSourceId:<source idMap ref>} to suppress BootstrapCorp's immediate-jack path (BootstrapCorp.ts:151).
- **Expected**: After the first flow solve (~tick 10-20), the scheduler funds the blocking miner (income+blocking tier); executeSpawn spawns it with the cold-start floor body 2W1M (250) and stamps memory.
- **Assertion**: Within window: a creep named miner-*-<tick> exists in world db with body exactly [WORK,WORK,MOVE]; its exported Memory.creeps entry has workType=='harvest', spawnedBy matching 'spawning-*', and corpId=='mining-W1N1-harvest-<last4 of source id>' which equals a live corp id under exported Memory.commissionedCorps; its orphanedSince stays unset for 25+ ticks after spawn.
- **Verdict window**: 35 ticks
- **Known bug targeted**: flow-id prefix regressions: harvestKind.materialize must strip 'source-' (src/corps/kinds/harvestKind.ts:72-77) or the spawned miner's corpId never resolves and it orphans/freezes
- **Code refs**: `src/corps/SpawningCorp.ts:152-155`, `src/corps/HarvestCorp.ts:399-402`, `src/spawn/BodyBuilder.ts:63-122`, `src/execution/OrphanRescue.ts:42`

### `spawnexec-miner-body-550` (T1) — Miner body scales to 550 capacity, no CARRY below 600

- **Purpose**: buildMinerBody at RCL2 full capacity yields 4W2M (500) and must NOT include the CARRY part (550 < MINER_CARRY_MIN_CAPACITY=600).
- **World**: Room W2N1, bordered, wall cluster for a planning peak. Spawn (25,25). Pocketed source at (15,25) (~10 tiles). Controller (35,20).
- **Staged state**: RCL2. 5 extensions injected adjacent to spawn (correct store schema, hits/hitsMax), all FULL: energyAvailable=550, capacity=550. Decoy hauler [CARRY,MOVE] injected with workType 'haul' + assignedSourceId (bootstrap suppression).
- **Expected**: Scheduler grants budget min(desiredCost=500, 550); executeSpawn spawns the first miner as exactly 4 WORK, 0 CARRY, 2 MOVE.
- **Assertion**: Within window, spawn.spawning goes non-null and the new harvest-workType creep's body in world db is exactly 4x WORK + 2x MOVE (zero CARRY parts); room energyAvailable drops by exactly 500 on the spawn tick.
- **Verdict window**: 35 ticks
- **Code refs**: `src/spawn/BodyBuilder.ts:61-73`, `src/spawn/BodyBuilder.ts:86-121`, `src/corps/SpawningCorp.ts:132-136`, `src/planning/EconomicConstants.ts:267-276`

### `spawnexec-miner-carry-600-boundary` (T1) — Miner gains exactly 1 CARRY at the 600-capacity boundary

> **[errata: wrong-behavior #1]** — apply corrections before building.

- **Purpose**: At energyCapacity exactly 600 the CARRY slot is reserved BEFORE the WORK loop (BodyBuilder.ts:72-73), producing 4W1C2M (550) - the link-feed body shape appears at, not above, MINER_CARRY_MIN_CAPACITY.
- **World**: Room W3N1, bordered, wall cluster peak. Spawn (25,25). Pocketed source at (17,25) (~8 tiles). Controller (33,18).
- **Staged state**: RCL3 (so >5 extensions legal). Exactly 6 extensions injected, all FULL: capacity=600, energyAvailable=600. Decoy hauler [CARRY,MOVE] with workType 'haul' + assignedSourceId.
- **Expected**: First miner spawns as exactly [W,W,W,W,CARRY,M,M] cost 550: the reserved CARRY did not get eaten by the WORK loop, and WORK count stays 4 (not 5, since 650 > 550 residual budget).
- **Assertion**: Within window the spawned harvest creep's body contains exactly 4 WORK, exactly 1 CARRY, exactly 2 MOVE.
- **Verdict window**: 35 ticks
- **Known bug targeted**: the CARRY-reservation ordering bug the comment at BodyBuilder.ts:71-73 guards: without reserving, the WORK loop spends the whole budget and the CARRY never fits
- **Code refs**: `src/spawn/BodyBuilder.ts:61`, `src/spawn/BodyBuilder.ts:72-73`, `src/spawn/BodyBuilder.ts:113-116`

### `spawnexec-first-hauler-group-prefix` (T1) — First hauler spawns once its miner is in the field (prefix-strip grouping)

- **Purpose**: SpawnDirector's sourceKey prefix stripping (SpawnDirector.ts:143,166-168) must mark the carry demand groupStarted once the harvest corp has a fielded miner; otherwise withMinerPrecedence silently drops every hauler demand and the mined energy strands forever.
- **World**: Room W4N1, bordered, wall cluster peak. Spawn (25,25). Pocketed source (15,25) (~10 tiles). Controller (35,20).
- **Staged state**: RCL2, 5 extensions FULL (550 avail). Inject miner [W,W,W,W,MOVE] ON the pocket harvest tile with memory {corpId:'stale-x', workType:'harvest'} - OrphanRescue readopts it into the harvest corp within 1-2 ticks of materialization (readoptTarget finds source within range 1). No decoy hauler (the blocking-first-hauler demand IS the subject); tolerate one bootstrap jack.
- **Expected**: Carry demand becomes eligible (groupStarted true via matching source key), blocking first hauler spawns with 1:1 CARRY:MOVE pairs, CARRY >= HAULER_MIN_CARRY=3.
- **Assertion**: Within window a creep with workType 'haul' and corpId 'hauling-W4N1-hauling-<last4>' is spawned whose body has CARRY count == MOVE count and CARRY >= 3; meanwhile the injected miner shows harvesting (source energy in db decreasing).
- **Verdict window**: 45 ticks
- **Known bug targeted**: flow 'source-'/'carry-' prefix mismatch making groupStarted always false -> withMinerPrecedence drops the hauler demand -> 'miner mines, energy piles, no hauler ever spawns'
- **Code refs**: `src/execution/SpawnDirector.ts:143`, `src/execution/SpawnDirector.ts:160-177`, `src/spawn/SpawnScheduler.ts:311-313`, `src/corps/CarryCorp.ts:885-886`, `src/corps/SpawningCorp.ts:194-207`

### `spawnexec-hauler-carry-route-distance` (T2) — Hauler CARRY sized to route distance (near vs far source)

> **[errata: wrong-behavior #4]** — apply corrections before building.

- **Purpose**: The hauler bodyParam (desiredCarry) derives from the flow-solved carryParts = rate*roundTrip/50, so the far source's first hauler must carry strictly more than the near source's; both bodies keep 1:1 pairs.
- **World**: Room W5N1, bordered. Spawn (25,25). Two pocketed sources: NEAR at (18,25) (~7-8 path tiles), FAR at (25,10) with a short wall detour making ~15 path tiles. Controller (35,30).
- **Staged state**: RCL3, 10 extensions FULL (capacity/available 800). Inject two miners [W,W,W,W,MOVE] on each pocket tile (dummy corpIds, workType 'harvest' - both readopt). Inject decoy hauler [CARRY,MOVE] assigned to NEAR source (suppresses bootstrap; near corp then has fieldedCarry=1).
- **Expected**: FAR's blocking hauler (higher value 90+carryNeeded, blocking tier) spawns first at full budget: CARRY ~ ceil(carryPartsFor(10,15))=7 (bracket 6-9 pending plan buffer), CARRY==MOVE. NEAR's next hauler, when it spawns, has fewer CARRY (~4, bracket 3-5).
- **Assertion**: Within window: first spawned haul-workType creep is owned by the FAR carry corp and has CARRY==MOVE with CARRY in [6,9]; any NEAR-corp hauler spawned in the window has CARRY in [3,5]; FAR first-hauler CARRY > NEAR first-hauler CARRY (decisive monotonicity).
- **Verdict window**: 60 ticks
- **Code refs**: `src/economy/primitives.ts:44-55`, `src/corps/CarryCorp.ts:831-871`, `src/corps/SpawningCorp.ts:194-207`, `src/spawn/BodyBuilder.ts:165-215`

### `spawnexec-upgrader-containerfed-workheavy` (T2) — Upgrader spawns WORK-heavy via containerFed bodyStrategy pass-through

- **Purpose**: UpgradingCorp declares bodyStrategy 'containerFed' and executeSpawn must thread it to buildUpgraderBody: at 550 the body is 4W1C2M (550), not the mobile 2W1C1M unit that wastes 250 energy.
- **World**: Room W6N1, bordered, wall cluster peak. Spawn (25,25). Pocketed source (18,25) (~7 tiles). Controller (33,25) ~8 tiles from spawn.
- **Staged state**: RCL2, 5 extensions FULL (550). Fully staff income so upgrader demand is the only spend: inject miner [W,W,W,W,MOVE] on pocket tile (workType 'harvest') + hauler [C,C,C,C,M,M,M,M] (workType 'haul', assignedSourceId) - hauler readopts to 'hauling-...' id which also satisfies the roomHasHauler gate (UpgradingCorp.ts:288-294).
- **Expected**: Blocking first upgrader spawns with the containerFed shape: budget 550 -> 4 WORK, exactly 1 CARRY, 2 MOVE. A 'mobile' regression yields at most 2 WORK for the same budget.
- **Assertion**: Within window a creep with workType 'upgrade' spawns whose body has WORK >= 3 and exactly 1 CARRY (decisively distinguishes containerFed from mobile at 550); its corpId matches the live upgrading corp id in exported Memory.
- **Verdict window**: 40 ticks
- **Known bug targeted**: the documented mobile-unit waste bug (BodyBuilder.ts:388-390: at 550 the 2W/1C/1M unit affords ONE unit, 2 WORK, 250 wasted) and loss of the bodyStrategy pass-through parameter
- **Code refs**: `src/corps/UpgradingCorp.ts:359-405`, `src/corps/SpawningCorp.ts:127`, `src/corps/SpawningCorp.ts:183`, `src/spawn/BodyBuilder.ts:385-407`

### `spawnexec-miner-runt-recycle-affordable` (T3) — Runt miner recycled only when a bigger body is affordable RIGHT NOW

- **Purpose**: flagMinerRuntForRecycling fires when energyAvailable covers the runt+1-WORK body while the spawn is idle, then the corp respawns at full size - the runt catch-22 fix (no waiting for room-maxed).
- **World**: Room W7N1, bordered. Spawn (25,25). Pocketed 1-spot source at (19,25) (~6 tiles) with capacity 1500 (rate 5 -> totalWork 3). Controller (33,20).
- **Staged state**: RCL2, 5 extensions FULL (550 avail). Inject: runt miner [W,W,MOVE] ON pocket tile (workType 'harvest', dummy corpId -> readopt); hauler [C,C,C,C,C,M,M,M,M,M] (workType 'haul', assignedSourceId) so carry demand is met; two upgraders [W,W,W,W,C,M,M] and [W,C,M] near controller (workType 'upgrade') to absorb upgrader targetCount, leaving no competing demand.
- **Expected**: Gate check: maxWorkPerMiner=buildMinerBody(3,550).workParts=3 > runt's 2; upgradeCost=buildMinerBody(3,550).cost=400 <= 550 -> runt flagged recycling, walks ~6 tiles to spawn, recycled; harvest corp respawns a 3-WORK miner (desiredWork=3).
- **Assertion**: Within window: exported Memory shows the injected 2W creep get recycling=true; the creep disappears from world db (recycled at spawn, energy refund visible as spawn store bump or tombstone); a NEW harvest-workType creep spawns with exactly 3 WORK - and never another 1-2 WORK miner (anti-thrash).
- **Verdict window**: 50 ticks
- **Known bug targeted**: the runt catch-22 (HarvestCorp.ts:236-241): old gate required energyAvailable >= energyCapacityAvailable, which a runt-fed room never reached, making runts immortal
- **Code refs**: `src/corps/HarvestCorp.ts:243-262`, `src/corps/recycle.ts:33-62`, `src/spawn/BodyBuilder.ts:63-122`, `src/main.ts:194-360`

### `spawnexec-miner-runt-immortal-at-cap` (T3) — No recycle when the capacity cannot build a bigger miner

- **Purpose**: pickRuntToRecycle returns null when the creep already has maxWorkPerMiner parts for the room's capacity: a 2W miner at 300 capacity must never be flagged - recycling only fires for a guaranteed upgrade.
- **World**: Room W8N1, bordered, wall cluster peak. Spawn (25,25). Pocketed full source (3000) at (19,25) (~6 tiles). Controller (33,20).
- **Staged state**: RCL2, NO extensions (capacity 300), spawn FULL (300). Inject miner [W,W,MOVE] on pocket tile (workType 'harvest', readopt) + decoy hauler [C,C,C,M,M,M] (workType 'haul', assignedSourceId, suppresses bootstrap).
- **Expected**: maxWorkPerMiner=buildMinerBody(5,300).workParts=2 == runt's 2 -> pickRuntToRecycle null every tick; the miner keeps harvesting undisturbed for the whole window even though the spawn is idle and full.
- **Assertion**: Throughout the window: the injected miner's exported memory never gains recycling=true, the creep never moves off the pocket tile toward spawn, and the source's db energy decreases (it keeps mining).
- **Verdict window**: 40 ticks
- **Known bug targeted**: the inverse guard of the runt fix: 'never disrupt a working creep to chase a body we cannot afford' (recycle.ts:10-11)
- **Code refs**: `src/corps/recycle.ts:40-46`, `src/corps/HarvestCorp.ts:250-253`, `src/spawn/BodyBuilder.ts:63-122`

### `spawnexec-hauler-runt-recycle-pounce` (T3) — Hauler runt swapped out when spawn momentarily flush

- **Purpose**: CarryCorp.flagRuntForRecycling retires the smallest hauler only when fleet>=2, minCarry<maxCarryPerHauler, and energyAvailable >= (minCarry+1)*100 - the pounce-when-flush gate - and the replacement is never another 1-CARRY runt.
- **World**: Room W9N1, bordered. Spawn (25,25). Pocketed full source (18,25) (~8 tiles). Controller (33,22).
- **Staged state**: RCL2, 5 extensions FULL (550). Inject: miner [W,W,W,W,MOVE] on pocket tile (workType 'harvest'); hauler runt [CARRY,MOVE] and hauler [C,C,C,C,M,M,M,M] both with workType 'haul' + assignedSourceId (readopt into same carry corp); upgraders [W,W,W,W,C,M,M] and [W,C,M] at controller to blunt competing demand.
- **Expected**: Gate passes on the first corp tick (550 >= (1+1)*100): the 1-CARRY hauler gets recycling=true, delivers/walks to spawn, is recycled; the corp's fieldedCarry gap then respawns a hauler with CARRY >= 3.
- **Assertion**: Within window: the injected 1-CARRY creep's exported memory gains recycling=true and the creep is removed from world db at the spawn; any haul-workType creep spawned afterwards in the window has CARRY >= 3 and CARRY == MOVE.
- **Verdict window**: 45 ticks
- **Known bug targeted**: runt-fleet heal ('we pounce whenever the spawn momentarily carries a full-ish load', CarryCorp.ts:262-272); regression risk: gate misread as requiring room fully maxed, stalling the heal forever
- **Code refs**: `src/corps/CarryCorp.ts:274-290`, `src/corps/CarryCorp.ts:849-871`, `src/corps/recycle.ts:50-62`, `src/corps/CarryCorp.ts:885-886`

### `spawnexec-bodies-at-1300-rcl4` (T4) — RCL4 (1300): miner caps at 5W1C3M; hauler pairs within cap

- **Purpose**: At high capacity the miner body must CAP at desiredWork=5 (5W1C3M, 700) rather than growing monstrous, and the follow-on hauler must keep 1:1 pairs sized to the route under maxCarryPerHauler=13.
- **World**: Room W10N1, bordered, wall cluster peak. Spawn (25,25). Pocketed full source at (13,25) (~12 path tiles). Controller (35,18).
- **Staged state**: RCL4 via startAtRcl. 20 extensions injected, ALL FULL: capacity/available 1300. Decoy hauler [CARRY,MOVE] with workType 'haul' + assignedSourceId (bootstrap suppression; makes first real hauler non-blocking but income+started tier still wins).
- **Expected**: First miner spawns exactly 5 WORK + 1 CARRY + 3 MOVE (cost 700, room energy drops 1300->600); after its ~27-tick spawn completes and it reaches the source, the route hauler spawns with CARRY==MOVE and CARRY in [5,8] (carryPartsFor(10,12)=5.2).
- **Assertion**: Within window: (a) a harvest creep with body exactly 5xWORK+1xCARRY+3xMOVE appears; (b) room energyAvailable decreases by exactly 700 that tick; (c) a subsequent haul creep spawns with CARRY==MOVE, 5<=CARRY<=8, total parts <= 26 (respecting the 13-carry cap).
- **Verdict window**: 70 ticks
- **Code refs**: `src/spawn/BodyBuilder.ts:63-122`, `src/planning/EconomicConstants.ts:267-276`, `src/corps/CarryCorp.ts:835`, `src/corps/SpawningCorp.ts:194-207`

### `spawnexec-reserver-body-multiroom` (T5) — Reserver spawns as CLAIMx2+MOVEx2 for a mined remote

> **[errata: infeasible #3]** — apply corrections before building.

- **Purpose**: buildReserverBody at 1300 capacity yields exactly 2 CLAIM + 2 MOVE (2x650), stamped workType 'reserve', and only once a miner is already harvesting the remote (ReservationCorp gate).
- **World**: Two rooms: home W11N1 (bordered, spawn (25,25), pocketed local source (18,25), controller (33,20)) and remote W12N1 sharing an open border passage; remote source at (10,25) ~20 tiles from home spawn, remote controller (40,40).
- **Staged state**: Home RCL4, 20 extensions FULL (1300). Fully staff home (inject miner on pocket + hauler 6C6M with assignedSourceId + upgraders). Inject a REMOTE miner [W,W,W,W,W,MOVE] standing on the remote source's harvest tile (workType 'harvest', dummy corpId) so readoption + the reservation trigger see the remote as actively mined. Seed scout intel in Memory if the planner requires room knowledge to commission the remote source.
- **Expected**: ReservationCorp proposes; its demand rides the income tier (groupStarted, SpawnDirector.ts:197-222); executeSpawn builds buildReserverBody(1300,2): body exactly [CLAIM,CLAIM,MOVE,MOVE], cost 1300; the reserver then moves toward the border.
- **Assertion**: Within window: a creep spawns with body exactly [CLAIM,CLAIM,MOVE,MOVE] (in that part order), exported memory workType=='reserve' and corpId matching the live reservation corp; by window end its position has moved >= 5 tiles toward the W12N1 exit.
- **Verdict window**: 90 ticks
- **Code refs**: `src/spawn/BodyBuilder.ts:467-478`, `src/corps/SpawningCorp.ts:191-193`, `src/execution/SpawnDirector.ts:197-222`, `src/corps/SpawningCorp.ts:138-151`

**Open questions (Spawn execution & body correctness (freshly spawned))**:
- First-solve timing: flow corps materialize when economyNeedsBootstrap fires (nodes exist, no harvest corps, Game.time % 10 == 0, main.ts:276-288) after incremental spatial analysis completes; all verdict windows assume corps by ~tick 10-20 - calibrate once with a probe cell, or widen windows if analysis of a walled room takes longer.
- idMap remapping substitutes whole object ids in the Memory JSON (Scenario.ts:160-170); corp ids embed sourceId.slice(-4) so injected creeps CANNOT be pre-bound to their corp. Every staged-creep cell relies on OrphanRescue readoption (OrphanRescue.ts:96-136: workType 'harvest' + standing within 1 of the source; workType 'haul' + memory.assignedSourceId as the RAW game id per CarryCorp.getAssignmentForSource:1026-1028; workType 'upgrade' by room). If readoption misfires, most staging collapses - verify this mechanism first (it is itself a valuable cell).
- BootstrapCorp spawns a jack IMMEDIATELY when a room has zero haulers and zero jacks (BootstrapCorp.ts:151) even at RCL2+; cells suppress it with an injected decoy hauler (workType 'haul'). Confirm the decoy counts before its readoption tick and that a bootstrap jack in cells that omit the decoy (spawnexec-first-hauler-group-prefix) does not push the hauler spawn past the window.
- Exact hauler CARRY counts: executeSpawn's hauler path sizes from bodyParam=desiredCarry (plan carryParts), NOT buildHaulerBody, and it is unverified whether CommissionedHauler.carryParts includes the 1.2 buffer (buildHaulerBody applies it separately at BodyBuilder.ts:174). Distance is solver path-distance, not straight-line. Hauler assertions therefore use brackets/monotonicity, not exact equality - tighten after first green run.
- Upgrader cell assumes the flow solve allocates >=3 energy/tick to the controller sink in a staffed single-source room (else allocated falls back to 2 and desiredWork=2, breaking the WORK>=3 assertion). Verify allocation, or assert 'CARRY==1 and cost within 50 of budget' as the containerFed discriminator instead.
- ConstructionCorp may place sites (source/controller containers, roads) and inject builder demands that drain spawn energy mid-window in the T3 recycle cells; the recycle FLAG is set in corp work before runSpawnScheduling (main.ts:194 vs :360) so flagging is safe, but replacement-body assertions (exactly 3 WORK / CARRY>=3) could see a reduced budget - consider asserting the flag+recycle as decisive and the replacement size as secondary.
- The runt-recycle cell wants a 1500-capacity source (rate 5) to keep upgrader targetCount small; confirm Scenario/mockup supports setting source energyCapacity below 3000, else restage at rate 10 with three injected upgraders and recompute (runt gate cost stays 400 at 550 capacity).
- Injected extensions must carry the exact owned-structure store schema plus hits/hitsMax or the engine purges them (Scenario.ts:114-118), and energyCapacityAvailable must then equal 550/600/800/1300 as staged - verify once per capacity rung.
- T5 reserver cell: ReservationCorp only targets a remote already being mined, and the planner may need scouted room intel (Memory seeding) before it commissions the remote source at all; without a supported intel-seeding path this cell may need the scout loop to run first, blowing the window - highest feasibility risk of the set.


## Avenue: Arrival -> work transitions (the creep is AT its post; does it work?)

**Seam**: This avenue exercises the per-creep work executors at the moment of arrival: (1) miner harvest + approach — HarvestCorp.runHarvester (/workspace/darkphoenix/src/corps/HarvestCorp.ts:276-322), the pure minerApproach spot/spread/stay decision (:46-50), and the full-store source-link feed (:300-306; transfer+harvest are separate intent groups so both fire in one tick); (2) the spot resolvers — sourceHarvestSpot convergence on the container tile (/workspace/darkphoenix/src/corps/nodeEnergy.ts:144-154 via bestAdjacentTile :104-129), sourcePickupSpot's container/pile/waitClear ladder (:162-195), controllerInputSpot + controllerParkingTiles (:243-312); (3) the workSpot executor's range logic — collect at range 1, bare deposit at range 2, waitClear at range 2, travelToBypass escape (:320-362); (4) upgrader parked model — runUpgrader/tryUpgrade/drawFromInput/parkingTileFor (/workspace/darkphoenix/src/corps/UpgradingCorp.ts:170-266; upgrade = 1 energy/WORK/tick); (5) builder build + refuel-in-place (/workspace/darkphoenix/src/corps/ConstructionCorp.ts:892-946; build = 5 energy/WORK/tick, build and withdraw are different action groups); (6) hauler controller delivery, range-0 bare drop on the exact input tile (/workspace/darkphoenix/src/corps/CarryCorp.ts:722-759). Staging invariant used by every cell: injected creeps carry a stale corpId and are re-adopted by OrphanRescue (/workspace/darkphoenix/src/execution/OrphanRescue.ts:96-136) once the first flow solve materializes corps (cold-start bootstrap solve gate at /workspace/darkphoenix/src/main.ts:276-290, fires on Game.time % 10 === 0 after analysis; corps materialize next runCommissionHost); harvest rate 2/WORK/tick, ORPHAN_GRACE_TICKS=25 bounds inert-blocker lifetime only for creeps WITH a corpId (no-corpId creeps are never touched, OrphanRescue.ts:161). Adoption tick T0 is externally observable: exported Memory.creeps[name].corpId enters CorpCop liveCorpIdsFromMemory (/workspace/darkphoenix/test/integration/diagnostics/CorpCop.ts:183-196); corp actual-vs-budget corroboration via Memory.corpVariance snapshots every 25 ticks (/workspace/darkphoenix/src/main.ts:208-210).

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `arrive-miner-on-spot-harvests` | T0 | 35t | ZOMBIE-MINER flake: scenario-economy alternate failures with |
| `arrive-miner-converges-to-container` | T1 | 40t | 'source piles up un-hauled' |
| `arrive-hauler-withdraws-stocked-container` | T1 | 30t |  |
| `arrive-upgrader-parked-upgrades-every-tick` | T1 | 35t |  |
| `arrive-upgrader-dry-withdraws-in-place` | T2 | 35t | RCL2 oscillation |
| `arrive-miner-stays-when-spot-held` | T2 | 30t | 'miners standing around a source' |
| `arrive-hauler-pile-pickup-range1` | T2 | 35t | range-2 pile collection |
| `arrive-builder-builds-and-refuels-in-place` | T2 | 45t | build/fetch toggle |
| `arrive-miner-threads-pocket-opening` | T3 | 40t |  |
| `arrive-hauler-escapes-upgrader-ring` | T3 | 40t | trapped-on-the-pile |
| `arrive-miner-feeds-source-link` | T4 | 35t |  |
| `arrive-hauler-drops-on-input-tile` | T2 | 35t | RCL2 starve |

### `arrive-miner-on-spot-harvests` (T0) — FLAGSHIP: zombie miner — on-spot miner harvests next tick

- **Purpose**: A miner already standing on sourceHarvestSpot must harvest the tick after its corp claims it (approach='stay' path), never idling adjacent to the source — the exact ZOMBIE-MINER signature (mining corp 0/10 actual).
- **World**: One 50x50 room: plain with border walls; two 4x4 interior wall blocks at (10-13,10-13) and (38-41,38-41) for a DT peak; spawn (25,25); source (25,30); controller (18,20).
- **Staged state**: Controller level 2, progress 0. Creep m1 body [work x5, move], energy 0, placed ON sourceHarvestSpot(source, spawnPos) (cell builder imports nodeEnergy.sourceHarvestSpot to compute the tile — deterministic bestAdjacentTile nearest spawn, here (24,29)). Memory injection: Memory.creeps.m1 = {corpId:'stale-mining', workType:'harvest', assignedSourceId:'SRC1'} with idMap entry {oldId:'SRC1', type:'source', room, x:25, y:30}.
- **Expected**: OrphanRescue re-adopts m1 into the source's HarvestCorp on the first tick the corp is live (m1 is in range 1 of the source); minerApproach returns 'stay'; creep.harvest fires every subsequent tick at 10 energy/tick, overflow dropping on its tile (no CARRY).
- **Assertion**: Arm T0 = first tick exported Memory.creeps.m1.corpId is in liveCorpIdsFromMemory (assert T0 <= 20). Over [T0+1, T0+11]: source db object's energy field decreases by >= 80, m1's (x,y) never changes, and (corroboration) the first Memory.corpVariance snapshot at a tick >= T0+1 shows the mining corp actual > 0 — the zombie signature is actual == 0.
- **Verdict window**: 35 ticks
- **Known bug targeted**: ZOMBIE-MINER flake: scenario-economy alternate failures with a mining corp at 0/10 actual (docs/specs/00-corp-framework.md:248, docs/specs/01-rcl5-cold-start-stall.md:37)
- **Code refs**: `/workspace/darkphoenix/src/corps/HarvestCorp.ts:276-322`, `/workspace/darkphoenix/src/corps/HarvestCorp.ts:46-50`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:144-154`, `/workspace/darkphoenix/src/execution/OrphanRescue.ts:96-114`, `/workspace/darkphoenix/src/main.ts:276-290`

### `arrive-miner-converges-to-container` (T1) — Drop-miner converges on container tile and drops into it

- **Purpose**: sourceHarvestSpot must resolve to the built source container's tile; an off-spot miner walks there (approach='spot'), and its CARRY-less harvest overflow lands IN the container — the convergence that fixes 'source piles up un-hauled'.
- **World**: One room: plain + border, DT wall blocks as in flagship; spawn (25,25); source (25,30); controller (18,20).
- **Staged state**: Controller level 2. Container at (25,31) (adjacent to source) with energy 0 (hits 250000 per Scenario.ts structureHits). Creep m1 body [work x5, move x5] (1 tile/tick on plain), energy 0, placed at (29,34) (~4 tiles from container). Memory.creeps.m1 = {corpId:'stale-mining', workType:'harvest', assignedSourceId:'SRC1'} + idMap for the source.
- **Expected**: After adoption, runHarvester computes spot = container pos (built-container branch), travelTo(range 0) walks m1 onto (25,31) in <=6 ticks, then harvest fires; overflow energy from the 0-capacity store drops on the container tile and is absorbed into the container store (~10/tick).
- **Assertion**: Arm T0 on adoption (corpId live). Assert: by T0+8, m1 pos == (25,31); over [T0+8, T0+20] the container db object's store.energy rises by >= 80 and source energy falls by >= 80; no dropped-energy object > 100 exists on any tile other than the container tile.
- **Verdict window**: 40 ticks
- **Known bug targeted**: 'source piles up un-hauled' — miner parks on an arbitrary adjacent tile and drops where haulers never visit (comment nodeEnergy.ts:131-143)
- **Code refs**: `/workspace/darkphoenix/src/corps/nodeEnergy.ts:144-154`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:104-129`, `/workspace/darkphoenix/src/corps/HarvestCorp.ts:284-293`

### `arrive-hauler-withdraws-stocked-container` (T1) — Hauler at stocked source container withdraws immediately

- **Purpose**: An empty hauler already at range 1 of a stocked source container must withdraw a full load on its first worked tick (sourcePickupSpot container branch + workSpot collect range 1), without wandering first.
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); source (25,32); controller (18,20).
- **Staged state**: Controller level 2. Container at (25,33) (adjacent to source, = harvest spot) holding 1500 energy. Creep h1 body [carry x6, move x6] (cap 300), energy 0, placed at (24,32) (range 1 of container). Memory.creeps.h1 = {corpId:'stale-hauling', workType:'haul', working:false, assignedSourceId:'SRC1'} + idMap for the source (haul re-adoption requires the assignedSourceId match, OrphanRescue.ts:117-125).
- **Expected**: On adoption, runHauler -> pickupEnergy -> sourcePickupSpot returns {container} (store > 0) -> workSpot collect at range 1 -> withdraw fills 300 in ONE intent; working flips true next tick and it departs toward the spawn network.
- **Assertion**: Arm T0 on adoption. Assert: h1 pos unchanged until its store becomes nonzero; by T0+3 h1 store == 300 and container store.energy == 1200; by T0+3 h1 has not moved from (24,32); (consequence) by window end h1 pos != (24,32) (it departed loaded).
- **Verdict window**: 30 ticks
- **Code refs**: `/workspace/darkphoenix/src/corps/nodeEnergy.ts:162-195`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:320-353`, `/workspace/darkphoenix/src/corps/CarryCorp.ts:514-547`, `/workspace/darkphoenix/src/execution/OrphanRescue.ts:117-125`

### `arrive-upgrader-parked-upgrades-every-tick` (T1) — Parked upgrader with energy upgrades every single tick

- **Purpose**: An upgrader standing on its cached parking tile with a full store must call upgradeController EVERY tick (no idle/reposition gaps) — the parked-model core invariant.
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); controller (25,10); source (25,32).
- **Staged state**: Controller level 2, progress 0, downgradeTime null. Cell builder imports controllerInputSpot + controllerParkingTiles to compute the input tile and first parking tile P for this terrain. Creep u1 body [work x4, carry x4, move x2], energy 200 (full), placed on P. Memory.creeps.u1 = {corpId:'stale-upgrading', workType:'upgrade', working:true, upgradeSpot:{x:P.x, y:P.y}}. (Re-adoption: role 'upgrade' -> same-room upgrade corp, OrphanRescue.ts:129-135.)
- **Expected**: parkingTileFor keeps the cached valid tile (no move); working=true -> tryUpgrade fires each tick: controller progress += 4/tick for ~50 ticks of fuel.
- **Assertion**: Arm T0 on adoption. Over [T0+2, T0+12]: controller db progress increases by >= 36 (of the ideal 40 — at most one missed tick) and u1's (x,y) is identical at every sampled tick. Regression fires if progress stalls >= 2 consecutive ticks while u1 still holds energy.
- **Verdict window**: 35 ticks
- **Code refs**: `/workspace/darkphoenix/src/corps/UpgradingCorp.ts:170-215`, `/workspace/darkphoenix/src/corps/UpgradingCorp.ts:247-266`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:243-312`

### `arrive-upgrader-dry-withdraws-in-place` (T2) — Dry upgrader withdraws from input spot without leaving its tile

- **Purpose**: An empty parked upgrader must refill from the controller input container via withdraw WITHOUT moving (drawFromInput), then resume upgrading — never chasing scattered drops (the RCL2 oscillation).
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); controller (25,10); source (25,32).
- **Staged state**: Controller level 2. Container C at (25,12) (range 2 of controller — becomes controllerInputSpot's buffer branch) holding 800 energy. Creep u1 body [work x4, carry x4, move x2], energy 0, placed on a parking tile adjacent to C and within range 3 of controller (builder imports controllerParkingTiles(controller, C.pos) and uses tiles[0]). Memory.creeps.u1 = {corpId:'stale-upgrading', workType:'upgrade', working:false, upgradeSpot:tiles[0]}. Optional decoy (pending pile-injection support): 200-energy drop pile at (30,16).
- **Expected**: working=false -> drawFromInput withdraws 200 from C in one intent (upgrader is range 1 from input, never moves); next tick working flips true -> upgrades 4/tick.
- **Assertion**: Arm T0 on adoption. Assert: u1 (x,y) constant over the ENTIRE window; by T0+4 container store.energy <= 600 and u1 store == 200; over [T0+4, T0+14] controller progress rises >= 36. Regression (oscillation/chase) fires on any position change.
- **Verdict window**: 35 ticks
- **Known bug targeted**: RCL2 oscillation — upgrader leaves its park tile for a stray pile, parkingTileFor marches it back, it never settles (comment UpgradingCorp.ts:222-227)
- **Code refs**: `/workspace/darkphoenix/src/corps/UpgradingCorp.ts:228-240`, `/workspace/darkphoenix/src/corps/UpgradingCorp.ts:170-205`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:243-276`

### `arrive-miner-stays-when-spot-held` (T2) — Second miner stays adjacent when spot is held — no spot-pile-up

- **Purpose**: minerApproach must return 'stay' for a miner adjacent to the source whose static spot is occupied by another creep — it harvests from where it is instead of shuffling at the occupied tile (the 'miners standing around a source' gridlock).
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); source (25,30) with >= 3 free adjacent tiles; controller (18,20).
- **Staged state**: Controller level 2. Inert blocker b1 body [move], energy 0, placed ON sourceHarvestSpot (computed via import; (24,29)) with NO Memory.creeps entry at all (no corpId -> OrphanRescue skips it forever, line 161 — permanent blocker). Miner m1 body [work x5, move], energy 0, at (26,30) (adjacent to source, not the spot). Memory.creeps.m1 = {corpId:'stale-mining', workType:'harvest', assignedSourceId:'SRC1'} + idMap.
- **Expected**: On adoption: spotHeldByOther=true, adjacentToSource=true, onSpot=false -> approach 'stay'; m1 issues no move and harvests 10/tick from (26,30).
- **Assertion**: Arm T0 on adoption. Over [T0+1, T0+12]: m1 (x,y) == (26,30) at every tick AND source energy decreases by >= 80 (phrased >= to tolerate bootstrap jacks). Regression fires if m1 changes position (the bug walks it at the occupied spot tile and it neither arrives nor harvests).
- **Verdict window**: 30 ticks
- **Known bug targeted**: 'miners standing around a source' — extra miners insist on the one static tile, pile up blocked two tiles out, never harvest (comment HarvestCorp.ts:38-45)
- **Code refs**: `/workspace/darkphoenix/src/corps/HarvestCorp.ts:46-50`, `/workspace/darkphoenix/src/corps/HarvestCorp.ts:284-293`, `/workspace/darkphoenix/src/execution/OrphanRescue.ts:157-165`

### `arrive-hauler-pile-pickup-range1` (T2) — Hauler collects a bare ground pile at range 1, not range 2

> **[errata: infeasible #4]** — apply corrections before building.

- **Purpose**: workSpot collect for a real pile must use range 1 and actually pick up — the original 'hauler stopped a tile short' bug left it at range 2 with store 0 forever.
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); source (25,32); controller (18,20). No container anywhere near the source.
- **Staged state**: Controller level 2. Injected dropped-energy object: 400 energy on the harvest-spot tile (computed via import; (24,31)) — requires the ScenarioState pile extension (see open questions). Creep h1 body [carry x6, move x6], energy 0, at (25,26) (~6 tiles away). Memory.creeps.h1 = {corpId:'stale-hauling', workType:'haul', working:false, assignedSourceId:'SRC1'} + idMap.
- **Expected**: sourcePickupSpot returns the pile pos (no container, pile > 0 within range 1 of source); workSpot collect computes range 1, travels to adjacency, pickup fills store to 300 in one intent.
- **Assertion**: Arm T0 on adoption. By T0+12: h1 store >= 250 AND the pile's remaining amount <= 150 AND at the pickup tick h1 was at range exactly <= 1 of the pile tile. Regression: h1 parks at range 2 with store 0 for >= 5 consecutive ticks.
- **Verdict window**: 35 ticks
- **Known bug targeted**: range-2 pile collection — 'the hauler stopped a tile short, common in remote mining where there is no container' (comment nodeEnergy.ts:327-329)
- **Code refs**: `/workspace/darkphoenix/src/corps/nodeEnergy.ts:320-353`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:181-195`, `/workspace/darkphoenix/src/corps/CarryCorp.ts:514-547`

### `arrive-builder-builds-and-refuels-in-place` (T2) — Builder at a site builds every tick and refuels in place

> **[errata: infeasible #4]** — apply corrections before building.

- **Purpose**: A builder parked at range <=3 of a site with a container at its feet must build 5/WORK/tick continuously PAST the point its initial store runs dry — refuelInPlace (pickup/withdraw is a different action group than build) must keep it topped so the build/fetch toggle never appears.
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); source (25,32); controller (25,10).
- **Staged state**: Controller level 2. Injected extension construction site at (28,25), progress 0/3000 (needs the ScenarioState constructionSite extension — see open questions). Container at (30,25) with 1000 energy. Creep b1 body [work x2, carry x2, move x2], energy 100 (full), placed at (29,25) — range 1 of container, range 1 of site. Memory.creeps.b1 = {corpId:'building-<ROOM>-construction', workType:'build', working:true} — this corp id is DETERMINISTIC (Corp.generateId = type-nodeId; constructionKind nodeId = `${room}-construction`), so the claim is instant when the per-room construction corp materializes.
- **Expected**: runBuilder: working -> doBuild (site progress +10/tick) and, same tick, refuelInPlace withdraws from the adjacent container whenever free capacity > 0 — b1's store never reaches 0, so it builds without a single fetch pause. Unrefueled it would go dry at tick 10.
- **Assertion**: Arm T0 on adoption (corpId claimed). Over [T0+2, T0+22] (spanning DOUBLE the 10-tick unrefueled fuel horizon): site db progress increases by >= 180 (ideal 200, one missed tick slack), with no window of 3 consecutive ticks where progress is flat; container store decreased by >= 150; b1 (x,y) constant.
- **Verdict window**: 45 ticks
- **Known bug targeted**: build/fetch toggle — builder drains to empty and loses ticks to pure refuelling, roughly halving effective build rate (comment ConstructionCorp.ts:910-916)
- **Code refs**: `/workspace/darkphoenix/src/corps/ConstructionCorp.ts:892-923`, `/workspace/darkphoenix/src/corps/ConstructionCorp.ts:930-946`, `/workspace/darkphoenix/src/corps/ConstructionCorp.ts:951-969`, `/workspace/darkphoenix/src/corps/Corp.ts:151-158`

### `arrive-hauler-drops-on-input-tile` (T2) — Controller-bound hauler drops EXACTLY on the input tile (range 0)

- **Purpose**: With no controller container, a loaded controller-circuit hauler must stand ON controllerInputSpot and drop there — a range-2 drop scatters the pile outside the upgrader ring's reach (the RCL2 starve).
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); controller (25,10); source (25,32). No container anywhere near the controller.
- **Staged state**: Controller level 2. Hauler h1 body [carry x6, move x6], energy 300 (FULL), placed at (25,18) (~6 tiles south of the input area). Memory.creeps.h1 = {corpId:'stale-hauling', workType:'haul', working:true, homeSink:'controller', deliverSinkId:'controller', haulerSlot:0, assignedSourceId:'SRC1'} + idMap. (deliverSinkId pre-set = the trip decision is already made; runHauler only re-decides on the empty->full flip, CarryCorp.ts:301-318.)
- **Expected**: deliverEnergy -> deliverToController -> bare-tile branch: travelToBypass(range 0) to the computed input tile, then drop(RESOURCE_ENERGY) lands 300 on that exact tile.
- **Assertion**: Cell builder imports controllerInputSpot to compute expected tile I. Arm T0 on adoption. By T0+12: a dropped-energy db object exists at exactly (I.x, I.y) with amount >= 250, h1's pos == I at the drop tick, and NO dropped-energy object >= 50 exists on any other tile within range 3 of the controller. Regression: pile appears at range 2 from I (hauler dropped early).
- **Verdict window**: 35 ticks
- **Known bug targeted**: RCL2 starve — 'a range-2 drop lands on the hauler's own tile, scattered out of the ring's reach' (comment CarryCorp.ts:746-750)
- **Code refs**: `/workspace/darkphoenix/src/corps/CarryCorp.ts:722-759`, `/workspace/darkphoenix/src/corps/CarryCorp.ts:295-330`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:243-276`

### `arrive-miner-threads-pocket-opening` (T3) — Pocketed source: miner threads the 1-tile opening and mines

- **Purpose**: With a source walled to a single mining tile, sourceHarvestSpot must resolve to that one tile and the miner must thread the opening and start harvesting — arrival adversity where any spot mis-resolution or approach deadlock shows immediately.
- **World**: One room: plain + border, DT wall blocks at (38-41,38-41); source at (10,25) pocketed per sim-parallel pocket() (all 8 neighbours walled except (10,24), the north opening); spawn (14,20); controller (20,12).
- **Staged state**: Controller level 2. Creep m1 body [work x5, move x5], energy 0, placed at (12,22) (~3 plain tiles from the opening). Memory.creeps.m1 = {corpId:'stale-mining', workType:'harvest', assignedSourceId:'SRC1'} + idMap.
- **Expected**: sourceHarvestSpot = (10,24) (only walkable adjacent tile); approach 'spot' walks m1 through the pocket mouth in <=5 ticks; harvest fires every tick thereafter at 10/tick.
- **Assertion**: Arm T0 on adoption. By T0+7 m1 pos == (10,24); over [T0+7, T0+19] source energy decreases by >= 100 and m1 never moves again. Regression: m1 oscillates outside the pocket or sits adjacent-but-off-spot with source energy flat.
- **Verdict window**: 40 ticks
- **Code refs**: `/workspace/darkphoenix/src/corps/nodeEnergy.ts:104-129`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:144-154`, `/workspace/darkphoenix/src/corps/HarvestCorp.ts:284-293`

### `arrive-hauler-escapes-upgrader-ring` (T3) — Empty hauler swaps out through a parked upgrader ring

> **[errata: window #7]** — apply corrections before building.

- **Purpose**: A hauler that just emptied on the controller input tile, walled in by a parked upgrader, must SWAP through it via travelToBypass (workSpot's collect travel) instead of being trapped forever — while the displaced upgrader returns to its slot and keeps upgrading.
- **World**: One room engineered so the bare controllerInputSpot has exactly ONE walkable neighbour: controller (25,10) inside a 1-wide corridor (walls at x=24 and x=26 for y=8..16, wall row y=8 at x=24..26), corridor open south to the room; spawn (25,25); source (25,32). Cell builder verifies via import: controllerInputSpot == (25,11), controllerParkingTiles == [(25,12)].
- **Staged state**: Controller level 2. Upgrader u1 body [work x2, carry x2, move], energy 100, ON (25,12) with Memory.creeps.u1 = {corpId:'stale-upgrading', workType:'upgrade', working:true, upgradeSpot:{x:25,y:12}}. Hauler h1 body [carry x6, move x6], energy 0 (just dropped), ON the input tile (25,11), Memory.creeps.h1 = {corpId:'stale-hauling', workType:'haul', working:false, assignedSourceId:'SRC1'} + idMap.
- **Expected**: h1 (empty -> collect) routes to its source; only exit (25,12) is occupied by the yielding parked upgrader; travelToBypass executes the mutual swap (movement.ts:91-114); u1 walks straight back to (25,12) next tick and keeps upgrading.
- **Assertion**: Arm T0 = later of both creeps' adoption ticks. By T0+6, h1 pos != (25,11) and h1 y > 12 (it exited the corridor); by T0+20 h1 is within range 2 of the source; u1 is back on (25,12) within 3 ticks of the swap and controller progress still rises >= 2/tick averaged over [T0, T0+20]. Regression (trapped-on-the-pile): h1 sits on (25,11) >= 10 consecutive ticks.
- **Verdict window**: 40 ticks
- **Known bug targeted**: trapped-on-the-pile — the upgrader ring walls the hauler in on the input tile and it never leaves (comments nodeEnergy.ts:330-336, CarryCorp.ts:751-753)
- **Code refs**: `/workspace/darkphoenix/src/corps/nodeEnergy.ts:320-338`, `/workspace/darkphoenix/src/corps/movement.ts:66-114`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:243-312`, `/workspace/darkphoenix/src/corps/UpgradingCorp.ts:185-190`

### `arrive-miner-feeds-source-link` (T4) — Full-store miner feeds the adjacent source link and keeps mining

> **[errata: infeasible #2]** — apply corrections before building.

- **Purpose**: A miner with zero free capacity standing by a source link must transfer its load into the link AND harvest in the same tick (separate intent groups) — the link-mining handoff at HarvestCorp.ts:300-306.
- **World**: One room: plain + border, DT wall blocks; spawn (25,25); source (25,32); controller (18,20). No storage/core link staged, so runLinks is a no-op and the source link just accumulates.
- **Staged state**: Controller level 5. Link at (24,32) (range 1 of the harvest spot (24,31) AND within 2 of the source) — REQUIRES the Scenario.ts structureCapacity 'link' fix (currently returns 0; see open questions), injected with energy 0, capacity 800, user-owned. Miner m1 body [work x5, carry x1, move x3], energy 50 (store FULL), placed on the harvest spot (24,31). Memory.creeps.m1 = {corpId:'stale-mining', workType:'harvest', assignedSourceId:'SRC1'} + idMap.
- **Expected**: On the first worked tick: getFreeCapacity == 0 -> findInRange finds the link (free capacity > 0) -> transfer(50) AND harvest(10) both fire; store refills from harvest in ~5 ticks and feeds again — a sustained ~10/tick pump into the link.
- **Assertion**: Arm T0 on adoption. By T0+3 link db store.energy >= 50; over [T0, T0+20] link store rises to >= 130 (two-plus volleys, proving the refill loop) AND source energy decreases by >= 150 AND m1 never moves. Regression: link stays at 0 while dropped energy piles on the miner tile.
- **Verdict window**: 35 ticks
- **Code refs**: `/workspace/darkphoenix/src/corps/HarvestCorp.ts:295-313`, `/workspace/darkphoenix/src/corps/nodeEnergy.ts:67-73`, `/workspace/darkphoenix/src/execution/LinkRunner.ts:25`, `/workspace/darkphoenix/test/integration/scenario/Scenario.ts:199-213`

**Open questions (Arrival -> work transitions (the creep is AT its post; does it work?))**:
- Dropped-energy injection (arrive-hauler-pile-pickup-range1, optional decoy in arrive-upgrader-dry-withdraws-in-place): ScenarioState has no piles field; needs a small extension inserting {type:'energy', resourceType:'energy', energy:N, x, y, room} into rooms.objects — verify the mockup engine keeps/decays injected drop docs rather than purging them on tick 1.
- Construction-site injection (arrive-builder-builds-and-refuels-in-place): ScenarioState.structures only covers built structures; needs a doc shaped like {type:'constructionSite', structureType:'extension', progress:0, progressTotal:3000, user:bot.id, room, x, y} — verify the engine accepts injected sites and processes build intents against them.
- Link store schema (arrive-miner-feeds-source-link): /workspace/darkphoenix/test/integration/scenario/Scenario.ts:199-213 structureCapacity() has no 'link' case, so an injected link gets storeCapacityResource {energy: 0} and every transfer returns ERR_FULL — add link: 800 (hits default 1000 is already correct) before building this cell.
- Adoption latency calibration: all cells stage cold Memory and rely on incremental terrain analysis + the mod-10 bootstrap solve (/workspace/darkphoenix/src/main.ts:276-290) + next-tick CommissionHost materialization + OrphanRescue re-adoption. Estimated T0 <= 20 ticks but CPU-budgeted analysis length is unmeasured for these rooms — measure once, and arm each verdict clock on the observable adoption event (exported Memory.creeps[name].corpId entering CorpCop liveCorpIdsFromMemory, /workspace/darkphoenix/test/integration/diagnostics/CorpCop.ts:183-196) rather than absolute ticks; if analysis routinely exceeds ~15 ticks, widen windows or pre-inject Memory.nodes from a snapshot.
- Harvest-overflow-into-container (arrive-miner-converges-to-container): the design assumes the engine's _drop-resource path absorbs a CARRY-less miner's overflow into a container on the same tile; verify against the screeps-server-mockup engine version before trusting the container-store assertion (fallback: assert dropped-energy accumulates on the container tile).
- travelToBypass swap predicate (arrive-hauler-escapes-upgrader-ring): movement.ts:66-114 swaps only through creeps recognized as yielding parked upgraders — confirm the staged upgrader (workType 'upgrade', on its upgradeSpot, energy > 0) satisfies the exact predicate, and that the engine honors mutual move intents (both creeps moving into each other's tiles) in one tick.
- Bootstrap jack interference: BootstrapCorp tracks only its own creepNames (no adoption of injected creeps) but its starvation fallback may still spawn 1-2 jacks that harvest the cell's source — all source-drain assertions are phrased as >= thresholds and position assertions are per-creep (the engine never pushes creeps), but verify jacks cannot occupy an asserted tile (e.g. the harvest spot in the blocker cell) before mass runs.
- Flat-terrain node risk: the brief states an all-plain room yields zero nodes, yet scripts/sim-parallel.ts ships plain rooms that apparently run — verify once whether the border-only DT suffices; every cell spec includes interior 4x4 wall blocks regardless, placed away from the action area.
- T5 deliberately omitted: remote/intel-source HarvestCorps carry sourceId 'intel-ROOM-X-Y' while OrphanRescue readopt matches getSourceId() === source.id (real id, /workspace/darkphoenix/src/execution/OrphanRescue.ts:102-114), so staged remote miners cannot re-adopt; multi-room arrival cells need full snapshot Memory injection (test/integration/scenario/Snapshot.ts) and belong to a remote-mining avenue.
- Inert blocker lifetime (arrive-miner-stays-when-spot-held): a creep with NO Memory.creeps entry is skipped by OrphanRescue (line 161) and never recycled — but confirm no other pass (e.g. SpawningCorp stamping, bootstrap emergency logic) claims un-stamped creeps mid-run.


## Avenue: Hauling logistics & delivery routing

**Seam**: The hauler trip-decision seam in src/corps/CarryCorp.ts: state flip at full load (runHauler :295-330) fixes the trip destination once via deliverSinkId (:316), routed by permanent homeSink circuits assigned proportionally to solver flowRates (assignCircuit :652-660, pickSinkByAllocation :136-166). Critical divert is gated by SPAWN_DIVERT_FILL=0.5 (:54, spawnNetworkCritical :584-593) with the RCL2-stall regression documented at :48-54; under the tender regime spawnNetworkHungry (:596-620) instead uses the spawn structure alone plus DEPOT_BUFFER=150 (:62). Delivery runs deliverEnergy (:558-573, full-sink fallback), deliverToSpawn (:672-715) which under room.memory.extensionTenderActive degrades haulers to a source->depot bus with depotBankTarget (:76-78) = DEPOT_BUFFER for containers / STORAGE_BANK=10000 for storage (:73), returning false at the bank target so surplus spills to deliverToController (:722-759, controllerInputSpot in nodeEnergy.ts:243-276). The tender flag is recomputed every tick by ExtensionTenderCorp.work (:90-106, fail-safe at :103) and the last leg by runTender (:113-148). Dedicated-build-source stand-down is yieldsToBuild (:975-996) via shouldDrainDedicatedSource (:109-118) with DEDICATED_SOURCE_DRAIN_FILL=0.5 (:90) and DEDICATED_SOURCE_DRAIN_PILE=300 (:101), driven by ConstructionCorp.updateDedicatedSource (:383-393). Scavenging: SCAVENGE_THRESHOLD=750 and scavengeRate cap (src/economy/scavenge.ts:26,56-58, collectStocks :73-77, detectRoomStocks :96-114) promoted by flowAdapter.detectTransientSources (src/economy/flowAdapter.ts:74-84), consumed by CarryCorp's scavenger path (:464-470, :541-546, isScavenger :550-552) and nodeEnergy.scavengeSpot (:203-220). Re-solve cadence FLOW_RESOLVE_INTERVAL=50 (src/main.ts:121).

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `haul-t0-first-delivery` | T0 | 300t |  |
| `haul-t1-circuit-split` | T1 | 60t | per-trip sink re-rolling thrash |
| `haul-t1-spawn-full-spill` | T1 | 25t |  |
| `haul-t2-critical-divert` | T2 | 30t |  |
| `haul-t2-no-divert-above-half` | T2 | 30t | RCL2 stall: controller-bound hauler diverted on ANY spawn fr |
| `haul-t2-scavenge-threshold` | T2 | 150t |  |
| `haul-t3-dedicated-standdown` | T3 | 100t | haulers competed with construction tankers for the dedicated |
| `haul-t3-dedicated-resume-container` | T3 | 90t |  |
| `haul-t3-dedicated-resume-groundpile` | T3 | 90t | bare-pile dedicated source left the hauler frozen while the  |
| `haul-t4-tender-bus-regime` | T4 | 60t | haulers schooling on one half-full extension tile |
| `haul-t4-tender-death-failsafe` | T4 | 50t | dead tender deadlocking the colony |
| `haul-t4-storage-bank-and-spill` | T4 | 60t | depot soaked up every spare load and the controller starved |

### `haul-t0-first-delivery` (T0) — Hauler exists and completes one spawn refill loop

> **[errata: window #9]** — apply corrections before building.

- **Purpose**: Existence proof that the RCL2 flow economy fields a haul-workType creep that picks up mined energy and refills the spawn.
- **World**: W0N0 sealed: perimeter wall ring at x/y in {1,48} plus a 3x3 interior wall stub at (6,6) for a DT peak. Spawn (25,25), source (25,30) ~5 tiles, controller (20,25) ~5 tiles.
- **Staged state**: cold, except controller bumped to level 2 via startAtRcl (skips BootstrapCorp ownership).
- **Expected**: Bot spawns a scaled miner then a hauler; hauler shuttles source pile/container -> spawn and the spawn store returns to full after spawn events drain it.
- **Assertion**: By tick 300: exported Memory.creeps contains >=1 entry with workType==='haul', AND world db spawn store.energy is observed at 300 (full) on some tick AFTER an earlier tick where it was <=250 (a completed refill delivery, not the initial 300).
- **Verdict window**: 300 ticks
- **Code refs**: `src/corps/CarryCorp.ts:295-330 (runHauler loop)`, `src/corps/CarryCorp.ts:823-904 (getSpawnDemand, blocking first hauler)`, `src/corps/nodeEnergy.ts:162-195 (sourcePickupSpot)`

### `haul-t1-circuit-split` (T1) — Fleet splits into spawn/controller home circuits per flow allocation

- **Purpose**: assignCircuit hands each new hauler the sink furthest behind its flow share, so a 3-hauler fleet staffs BOTH circuits in proportion to flowRates instead of all re-rolling per trip.
- **World**: W0N0 sealed ring + interior stub. Spawn (25,25), source (25,42) ~17 tiles with container staged 1500 energy, controller (25,8) ~17 tiles.
- **Staged state**: Warm snapshot memory containing the source's CarryCorp with haulerAssignments to both spawn-* and controller-* sinks (flows ~3:7). Staged creeps: 1 miner (5W3M) on the source container; 3 haulers 4C4M, energy 0, at (25,27..29), memory {corpId: <carry corp id>, workType:'haul'} with NO homeSink. Controller level 2-3.
- **Expected**: Each hauler fills at the container and on its working flip gets a permanent homeSink: first 'spawn', then 'controller', 'controller' (per pickSinkByAllocation on 3:7 flows). No hauler re-rolls thereafter.
- **Assertion**: By tick 40 all 3 exported Memory.creeps hauler entries have homeSink set, with the multiset of homeSink values exactly matching pickSinkByAllocation applied to the exported haulerAssignments (for 3:7 flows: one 'spawn', two 'controller'); values unchanged from tick 40 to tick 60; controller input tile pile/container AND spawn store both increase within the window.
- **Verdict window**: 60 ticks
- **Known bug targeted**: per-trip sink re-rolling thrash (replaced by permanent homeSink circuits, CarryCorp.ts:301-314 comment)
- **Code refs**: `src/corps/CarryCorp.ts:652-660 (assignCircuit)`, `src/corps/CarryCorp.ts:136-166 (pickSinkByAllocation)`, `src/corps/CarryCorp.ts:301-317 (flip-time circuit assignment)`, `src/types/Memory.ts:344 (homeSink persisted)`

### `haul-t1-spawn-full-spill` (T1) — Spawn-homed hauler spills to controller when the whole spawn network is full

- **Purpose**: deliverEnergy's fallback: when the committed sink can't take the load (getCirculationTarget returns null), the hauler helps the other sink instead of idling.
- **World**: W0N0 sealed ring + stub. Spawn (25,25), source (25,42), controller (25,10) with a staged container at (25,12) energy 0 (becomes controllerInputSpot buffer). No extensions.
- **Staged state**: Warm memory with carry corp. Spawn store forced to 300/300 (db update). One hauler 6C6M staged at (25,30) with store.energy=300 (full), memory {corpId, workType:'haul', working:true, homeSink:'spawn', deliverSinkId:'spawn'}.
- **Expected**: deliverToSpawn finds every spawn-zone structure full and returns false; fallback delivers to the controller container instead; hauler never idles adjacent to the full spawn.
- **Assertion**: Within 25 ticks the container at (25,12) store.energy >= 250 while the spawn store.energy stays pinned at 300 for the whole window (no spawn transfer possible, no idle: hauler's db position reaches range<=1 of (25,12)).
- **Verdict window**: 25 ticks
- **Code refs**: `src/corps/CarryCorp.ts:558-573 (deliverEnergy fallback)`, `src/corps/CarryCorp.ts:396-428 (getCirculationTarget all-full -> null)`, `src/corps/CarryCorp.ts:722-759 (deliverToController)`, `src/corps/nodeEnergy.ts:243-276 (controllerInputSpot)`

### `haul-t2-critical-divert` (T2) — Critically-low spawn diverts a controller-homed hauler

- **Purpose**: spawnNetworkCritical: at <50% network fill (SPAWN_DIVERT_FILL) the flip-time decision overrides homeSink 'controller' with deliverSinkId 'spawn' for that trip.
- **World**: W0N0 sealed ring + stub. Spawn (25,25), source (25,42) with container staged 1200, controller (25,8) with container (25,10) energy 0.
- **Staged state**: Warm memory with carry corp (flows to both sinks). Spawn store forced to 100/300 (33% < 50%). One hauler 6C6M staged EMPTY adjacent to the source container, memory {corpId, workType:'haul', working:false, homeSink:'controller'}. No other haulers.
- **Expected**: Hauler withdraws to full within ~2 ticks; the working flip sets deliverSinkId='spawn' despite homeSink='controller'; it travels ~17 tiles and transfers, topping the spawn to 300; remainder falls through to the controller.
- **Assertion**: Exported Memory.creeps[hauler].deliverSinkId==='spawn' within 5 ticks of the fill (while homeSink stays 'controller'), AND world spawn store.energy reaches 300 by tick 30.
- **Verdict window**: 30 ticks
- **Code refs**: `src/corps/CarryCorp.ts:316 (flip-time critical override)`, `src/corps/CarryCorp.ts:584-593 (spawnNetworkCritical)`, `src/corps/CarryCorp.ts:54 (SPAWN_DIVERT_FILL=0.5)`, `src/types/Memory.ts:337 (deliverSinkId persisted)`

### `haul-t2-no-divert-above-half` (T2) — Spawn at >=50% does NOT steal the controller hauler (RCL2-stall regression)

> **[errata: wrong-behavior #5]** — apply corrections before building.

- **Purpose**: Guard the RCL2-stall fix: free capacity >= 50 alone (old rule) must no longer divert; at 200/300 fill the controller keeps its allocated share.
- **World**: Identical to haul-t2-critical-divert: spawn (25,25), source container (25,42) 1200 energy, controller container (25,10) energy 0.
- **Staged state**: Same warm memory and single controller-homed hauler staged empty at the source container; spawn store forced to 200/300 (66% fill, free=100 >= SPAWN_PRIORITY_FREE_CAPACITY=50 which the OLD buggy rule diverted on).
- **Expected**: Flip sets deliverSinkId='controller'; the full 300 load lands in the controller container; the spawn receives nothing from the hauler.
- **Assertion**: Exported Memory.creeps[hauler].deliverSinkId==='controller' within 5 ticks of fill, controller container (25,10) store.energy >= 250 by tick 30, AND spawn store.energy never exceeds 200 during the window.
- **Verdict window**: 30 ticks
- **Known bug targeted**: RCL2 stall: controller-bound hauler diverted on ANY spawn free capacity every trip, controller starved (documented CarryCorp.ts:48-54, 578-583)
- **Code refs**: `src/corps/CarryCorp.ts:44-54 (SPAWN_PRIORITY_FREE_CAPACITY vs SPAWN_DIVERT_FILL rationale)`, `src/corps/CarryCorp.ts:576-593 (spawnNetworkCritical gate)`, `src/corps/CarryCorp.ts:316 (flip-time decision)`

### `haul-t2-scavenge-threshold` (T2) — 750+ ground pile spawns a scavenge route; sub-750 pile is ignored

> **[errata: infeasible #4, window #4]** — apply corrections before building.

- **Purpose**: detectTransientSources promotes only stocks >= SCAVENGE_THRESHOLD=750 into transient sources that field a dedicated scavenger hauler; smaller piles are left alone.
- **World**: W0N0 sealed ring + stub. Spawn (25,25), one source (12,25) warm-staffed (miner+container+1 hauler), controller (25,8). NO depot/extensions (so no tender pile-fallback interference). Piles far from source and spawn: 900 energy at (40,40), 600 energy at (40,10).
- **Staged state**: Warm RCL2/3 memory with the source's mining+carry corps. Piles inserted as dropped 'energy' db objects at t=0.
- **Expected**: Next economy rebuild (<=50 ticks) promotes only the 900 pile: a corp keyed scavenge-W0N0-40-40 appears, a scavenger hauler spawns (~18 ticks) and drains it via scavengeSpot pickup; the 600 pile only decays (~1/tick) and never gets a corp.
- **Assertion**: By tick 150: exported Memory contains a corp/commission id containing 'scavenge-W0N0-40-40' AND none containing 'scavenge-W0N0-40-10'; world pile at (40,40) <= 550 (clearly below its ~750 decay-only trajectory) AND pile at (40,10) >= 400 (decay-only, no pickup event).
- **Verdict window**: 150 ticks
- **Code refs**: `src/economy/scavenge.ts:26 (SCAVENGE_THRESHOLD=750)`, `src/economy/scavenge.ts:73-77 (collectStocks filter)`, `src/economy/flowAdapter.ts:74-84 (detectTransientSources)`, `src/corps/CarryCorp.ts:464-470,541-546 (scavenge-id parse + pickup)`, `src/corps/nodeEnergy.ts:203-220 (scavengeSpot)`

### `haul-t3-dedicated-standdown` (T3) — Dedicated build source fields no haulers while the builder drains it

- **Purpose**: yieldsToBuild: with dedicatedBuildSourceId set, container below 50% and no 300+ pile, the source's CarryCorp returns [] from getSpawnDemand and existing haulers stop pickup - the construction tankers get the full output.
- **World**: W0N0 sealed ring + stub. Spawn (25,25). Source A (10,25) warm-staffed (miner, container, 1 hauler). Source B (40,25) with miner and container staged 400/2000. Extension construction site at (38,25) (nearest source is B, so updateDedicatedSource keeps B). Controller (25,8), level 2-3.
- **Staged state**: Warm memory: carry corps for A and B (B's with 0 creeps), construction corp with 1 builder + 1 tanker staged near the site, Memory.rooms.W0N0.dedicatedBuildSourceId = B's id (idMap-remapped).
- **Expected**: B's corp yields: no hauler is ever spawned for B; A's circuit keeps running; B's container is touched only by the tanker/builder.
- **Assertion**: For every sampled tick in a 100-tick window (spanning 2 flow resolves): no exported Memory.creeps entry has workType==='haul' AND corpId===B's carry-corp id, while >=1 such entry exists for A's corp id; construction site progress at (38,25) increases (build actually consuming B's output).
- **Verdict window**: 100 ticks
- **Known bug targeted**: haulers competed with construction tankers for the dedicated source's output (rationale at CarryCorp.ts:961-974)
- **Code refs**: `src/corps/CarryCorp.ts:975-996 (yieldsToBuild)`, `src/corps/CarryCorp.ts:829 (getSpawnDemand yield gate)`, `src/corps/CarryCorp.ts:517 (pickupEnergy stand-down)`, `src/corps/ConstructionCorp.ts:383-393 (updateDedicatedSource)`

### `haul-t3-dedicated-resume-container` (T3) — Haulers resume when the dedicated source's container backs up past 50%

- **Purpose**: shouldDrainDedicatedSource: container >= 50% (DEDICATED_SOURCE_DRAIN_FILL) means the builder isn't keeping pace, so the corp un-yields and hauls the surplus to the core.
- **World**: Same room as haul-t3-dedicated-standdown, but source B's container staged at 1400/2000 (>= 1000 threshold).
- **Staged state**: Same warm memory (dedicatedBuildSourceId=B, site at (38,25), builder+tanker staged, B carry corp with 0 creeps).
- **Expected**: yieldsToBuild returns false (1400 >= 0.5*2000); B's getSpawnDemand fires (blocking first hauler); a hauler spawns (~18 ticks), walks ~15 tiles, withdraws from B's container and delivers to spawn/controller.
- **Assertion**: Within 90 ticks: exported Memory.creeps gains an entry with workType==='haul' AND corpId===B's carry-corp id (contrast: standdown cell forbids this), AND on some tick that creep's db object sits within range 1 of B's container with store.energy >= 100 (loaded), AND the spawn store or controller input container subsequently increases by >= 100.
- **Verdict window**: 90 ticks
- **Code refs**: `src/corps/CarryCorp.ts:109-118 (shouldDrainDedicatedSource)`, `src/corps/CarryCorp.ts:90 (DEDICATED_SOURCE_DRAIN_FILL=0.5)`, `src/corps/CarryCorp.ts:975-996 (yieldsToBuild resume path)`, `src/corps/CarryCorp.ts:888-903 (blocking first-hauler demand)`

### `haul-t3-dedicated-resume-groundpile` (T3) — A 300+ ground pile at a bare dedicated source un-freezes its haulers

> **[errata: infeasible #4]** — apply corrections before building.

- **Purpose**: The ground-pile analogue of the container check: pile >= DEDICATED_SOURCE_DRAIN_PILE=300 within range 1 of the dedicated source must trigger resume even with no container to inspect.
- **World**: Same room as haul-t3-dedicated-standdown, but source B has NO container: miner staged on its harvest tile, dropped-energy pile of 400 staged on that tile. Site at (38,25).
- **Staged state**: Warm memory identical (dedicatedBuildSourceId=B, B carry corp 0 creeps); pile inserted as db 'energy' object.
- **Expected**: groundPile=400 >= 300 -> yieldsToBuild false -> B fields a hauler that walks to the pile and picks up (a single-tick drop of ~its free capacity), then delivers home; without the fix the pile would only grow (+10/tick miner) and decay.
- **Assertion**: Within 90 ticks: a Memory.creeps entry with workType 'haul' and B's corpId exists AND the pile at B's tile shows a single-tick decrease >= 100 (pickup event - decay alone is ~1/tick and mining adds +10/tick, so any >=100 one-tick drop is decisive).
- **Verdict window**: 90 ticks
- **Known bug targeted**: bare-pile dedicated source left the hauler frozen while the pile grew and decayed (documented CarryCorp.ts:92-101)
- **Code refs**: `src/corps/CarryCorp.ts:92-101 (DEDICATED_SOURCE_DRAIN_PILE rationale)`, `src/corps/CarryCorp.ts:109-118 (shouldDrainDedicatedSource ground branch)`, `src/corps/CarryCorp.ts:986-994 (groundPile findInRange)`

### `haul-t4-tender-bus-regime` (T4) — Tender regime: haulers run the source->depot bus, tender does extensions, surplus spills

- **Purpose**: With a core depot and live tender, haulers must fill only the spawn structure and the depot (to DEPOT_BUFFER=150), never fan across extensions; the tender does the last leg; surplus spills to the controller.
- **World**: W0N0 sealed ring + stub. Spawn (25,25) full 300. Depot container (24,24) staged 0. 10 extensions staged 0 energy in a row y=21, x=20..29. Source (25,42) container 1800 + miner. Controller (25,8) with input container (25,10) energy 0.
- **Staged state**: Warm RCL3 memory (carry corp + ExtensionTenderCorp). Staged: 2 haulers 6C6M empty at the source (homeSink 'spawn' and 'controller'); tender 6C6M beside depot, memory {corpId: tender corp id, workType:'tank'}.
- **Expected**: Tick 1 sets extensionTenderActive=true. Spawn full -> first spawn-circuit load lands in the depot (>=150), later loads return false and spill to the controller; tender withdraws from depot and fills extensions nearest-first. Haulers never touch an extension.
- **Assertion**: Memory.rooms.W0N0.extensionTenderActive===true by tick 5; by tick 60: depot store observed >=150 on some tick, sum of extension stores >= 200 (tender leg), controller input container >= 250 (spill), AND neither hauler's db position is ever within range 1 of any extension at y=21 during the window.
- **Verdict window**: 60 ticks
- **Known bug targeted**: haulers schooling on one half-full extension tile (ExtensionTenderCorp.ts header comment)
- **Code refs**: `src/corps/ExtensionTenderCorp.ts:103 (flag set)`, `src/corps/ExtensionTenderCorp.ts:113-148 (runTender)`, `src/corps/CarryCorp.ts:672-696 (deliverToSpawn bus + spill-on-false)`, `src/corps/CarryCorp.ts:62,76-78 (DEPOT_BUFFER/depotBankTarget)`, `src/corps/nodeEnergy.ts:36-45 (coreDepot)`

### `haul-t4-tender-death-failsafe` (T4) — Dead tender clears the flag within a tick; haulers revert to direct extension filling

- **Purpose**: The fail-safe at ExtensionTenderCorp.work: extensionTenderActive is recomputed every tick from live tenders, so killing the tender must immediately return haulers to the circulation-fill path - no deadlock.
- **World**: Same room as haul-t4-tender-bus-regime, but extensions staged FULL (50 each) and depot staged 400.
- **Staged state**: Same warm memory + staged tender and 2 haulers (one full, mid-route near spawn). HARNESS ACTION at tick 15: delete the tender creep's db object AND set 4 extensions (x=20..23,y=21) store.energy=0 (simulated spawn burst).
- **Expected**: Tick 16-17: work() sees tenders.length===0 -> flag false. Haulers take the non-tender deliverToSpawn path and fan to the 4 empty extensions via getCirculationTarget, refilling them directly.
- **Assertion**: Memory.rooms.W0N0.extensionTenderActive===false by tick 18 (<=3 ticks after the kill), AND all 4 zeroed extensions have store.energy===50 by tick 45, with at least one refill tick showing a haul-workType creep's db position within range 1 of that extension (tender is gone, so only haulers can have filled them).
- **Verdict window**: 50 ticks
- **Known bug targeted**: dead tender deadlocking the colony (the fail-safe documented at ExtensionTenderCorp.ts:99-103)
- **Code refs**: `src/corps/ExtensionTenderCorp.ts:99-103 (per-tick flag recompute)`, `src/corps/CarryCorp.ts:678 (extensionTenderActive branch)`, `src/corps/CarryCorp.ts:698-715 (direct circulation fill path)`, `src/corps/CarryCorp.ts:396-428 (getCirculationTarget)`

### `haul-t4-storage-bank-and-spill` (T4) — Storage banks to 10k then spills surplus to the controller

- **Purpose**: depotBankTarget: a storage depot is topped by spawn-circuit haulers until STORAGE_BANK=10000, after which deliverToSpawn returns false and loads spill to the controller; controller-circuit haulers are never diverted to fill the bank (spawnNetworkHungry keeps the small DEPOT_BUFFER rule).
- **World**: W0N0 sealed ring + stub, controller level 4. Spawn (25,25) full. Storage (24,24) staged 9800 energy (it is the coreDepot). 20 extensions staged FULL (RCL4 set). Source (25,42) container 1800 + miner. Controller input container (25,10) energy 0.
- **Staged state**: Warm RCL4 memory (carry corp, tender corp). Staged: tender 6C6M beside storage (keeps extensionTenderActive true); 2 spawn-circuit haulers 6C6M staged FULL at the source (working:true, deliverSinkId:'spawn', homeSink:'spawn'); 1 controller-circuit hauler staged full (homeSink:'controller', deliverSinkId:'controller').
- **Expected**: First spawn-circuit load banks into storage (9800 -> ~10100, crossing STORAGE_BANK); subsequent spawn-circuit loads find spawn full, storage at bank target -> deliverToSpawn false -> spill to controller. The controller-circuit hauler keeps deliverSinkId 'controller' throughout (bank never diverts it).
- **Assertion**: Storage store.energy >= 10000 by tick 25 and stays <= 10400 for the rest of the window (bank capped, not soaking every load); controller input container gains >= 250 AFTER the tick storage first crossed 10000; exported Memory shows the controller-circuit hauler's deliverSinkId==='controller' at every sampled tick.
- **Verdict window**: 60 ticks
- **Known bug targeted**: depot soaked up every spare load and the controller starved (documented CarryCorp.ts:683-688)
- **Code refs**: `src/corps/CarryCorp.ts:73 (STORAGE_BANK=10000)`, `src/corps/CarryCorp.ts:76-78 (depotBankTarget)`, `src/corps/CarryCorp.ts:683-695 (bank-then-false spill)`, `src/corps/CarryCorp.ts:602-614 (spawnNetworkHungry small-buffer rule for storage)`, `src/corps/nodeEnergy.ts:36-45 (coreDepot prefers storage)`

**Open questions (Hauling logistics & delivery routing)**:
- Warm-memory staging: cells 2-12 stage creeps whose memory.corpId must match a live corp inside the injected Memory, or OrphanRescue idles/recycles them after ORPHAN_GRACE_TICKS=25 mid-window. Existing fixtures (test/integration/scenario/fixtures/warm-*.json) don't match each cell's geometry - the grid likely needs per-cell snapshot capture (Snapshot.ts) or a Memory-synthesis helper that fabricates carry/tender corp entries with predictable ids (legacyNodeId in src/corps/kinds/carryKind.ts:49-51), plus idMap remapping for source/spawn/container ids.
- Mid-run world mutation: haul-t4-tender-death-failsafe needs a harness hook to run db updates between ticks (kill tender, zero 4 extensions at tick 15); loadScenario currently only stages at t=0.
- Mutating the bot's own auto-created spawn store (100/300 and 200/300 in the divert cells) requires a direct db['rooms.objects'].update after addBot - applyState only inserts NEW structures; confirm the mockup accepts a partial store update on the spawn.
- ExtensionTenderCorp corp id in serialized Memory: verify the 'moving' kind's commissioned-corp key/id so a staged tender creep's corpId can be pointed at it; if tender corps are only created at runtime, cells 10-12 may need to let the bot spawn the tender (adds ~20-30 ticks to windows).
- Per-tick Memory export cost: deliverSinkId/homeSink/extensionTenderActive assertions require sampling bot.memory every tick for N parallel bots; confirm this doesn't dominate the tick budget (the CorpCop pattern already does it for one bot).
- Flow re-resolve every 50 ticks may rewrite haulerAssignments mid-window; assignments should re-derive identically from an unchanged world, but windows that straddle a Game.time%50 boundary should tolerate a 1-2 tick blip (or cells should be started just after a resolve).
- Confirm mock-engine dropped-energy decay is ceil(amount/1000)/tick as on live servers - the scavenge cell's decay-only baseline (600->~450 over 150 ticks) depends on it.
- ConstructionCorp.updateDedicatedSource re-derives dedicatedBuildSourceId as the source nearest the FIRST construction site each pass - the dedicated-source cells must have exactly one site, placed nearest source B, or the staged flag gets rewritten to source A.
- Terrain non-degeneracy: verify a perimeter wall ring plus one 3x3 interior stub is enough of a distance-transform peak for the planner to produce nodes in every cell room (the prompt's all-plain caveat); if not, reuse the vWall/pocket helpers from scripts/sim-parallel.ts:35-56.
- Sealed rooms (full wall ring at x/y=1,48) remove exits - confirm the bot's ScoutCorp/remote logic tolerates a room with zero exits without throwing (otherwise leave one gap and rely on bot-user isolation).


## Avenue: Construction & infrastructure placement

**Seam**: ConstructionCorp.work() gates placement on activeSites===0 (src/corps/ConstructionCorp.ts:192-211) and tryPlaceNextSite (:432-514) walks a strict ladder: (1) source container at RCL>=CONTAINER_MIN_RCL=3 (:60) only when a drop pile within range 1 of the source sums >= SOURCE_CONTAINER_PILE_THRESHOLD=200 (:81, :576-581), placed on the miner's harvest tile via sourceHarvestSpot (nodeEnergy.ts:144-154, which delegates to the deterministic nearest-to-spawn bestAdjacentTile nodeEnergy.ts:104-129); (1.5) core-depot container beside the spawn (:457-463, findMissingCoreDepot :533-541, skipped once room.storage exists); (2) extensions up to EXTENSION_LIMITS[rcl] (:36-45) via findGridPosition (:699-811): checkerboard (x+y)%2===0 (:764), Chebyshev 2-6 from a source (:754-761), >=3 walkable neighbors (:773-786), avoiding spawn+-1 / source+-1 / controller+-2 (:707-733) — with an explicit cap guard (:469-483) so a maxed extension set cannot starve later rungs; (2.5) storage at RCL>=STORAGE_MIN_RCL=4 within 2 of spawn (:490-493, :549-558); (2.7) links at RCL5+ (LINK_LIMITS :66): core link beside storage first (:614-618), then source links only for sources with range>LINK_MIN_SOURCE_RANGE=8 to storage, farthest first (:620-631); (3) controller container last, within 2 of the controller (:507-513, :641-648). PLACEMENT_COOLDOWN=10 with a negative-clock guard (:50, :436-440); every placement logs "[Construction] Placed <type> site at (x, y)" (:521). Repair: REPAIR_TO=0.99 / REPAIR_SPAWN_BELOW=0.6 hysteresis (src/corps/repair.ts:18,:26, wantsMaintenanceBuilder :53-63, pickRepairTarget most-decayed :37-44), driven from plan()/getSpawnDemand when no sites exist (ConstructionCorp.ts:153-157, :1058-1064) and executed by self-fueling doMaintenance (:872-890). The corp is materialized per owned spawn-room by constructionKind (src/corps/kinds/constructionKind.ts:61-106) with deterministic id `building-<room>-construction` (Corp.ts:124-128, :151-156), so builder creeps can be pre-staged by Memory {corpId, workType:"build"} (Squad membership match, Squad.ts:80-90). All assertions below are external: construction-site objects (type/structureType/x/y) and container hits in the world db, exported Memory.creeps, and the corp's console line.

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `cons-ext-first-site-checkerboard` | T0 | 60t |  |
| `cons-src-container-on-pile` | T1 | 60t |  |
| `cons-depot-when-pile-thin` | T1 | 60t |  |
| `cons-one-site-at-a-time` | T2 | 60t |  |
| `cons-ext-before-ctrl-container` | T2 | 60t | controller-container-before-extensions stall: building the f |
| `cons-ctrl-container-last` | T2 | 60t |  |
| `cons-repair-starts-below-60` | T2 | 120t |  |
| `cons-repair-stops-at-99` | T2 | 100t |  |
| `cons-pocket-container-exact-tile` | T3 | 60t | miner-drop / container-tile divergence: miner parked on an a |
| `cons-capguard-storage-rcl4` | T4 | 60t | over-cap extension retry starvation: before the in-ladder ca |
| `cons-link-core-first` | T4 | 60t |  |
| `cons-link-farthest-source` | T4 | 60t |  |

### `cons-ext-first-site-checkerboard` (T0) — First extension site exists and obeys grid rules

- **Purpose**: At RCL2 (container rungs gated off) the corp's first-ever placement is an extension whose tile satisfies every findGridPosition predicate.
- **World**: W0N0, bordered plain room (RoomBuilder.border() interior peak). Spawn (25,25), controller (25,10), single source (25,32) ~7 tiles from spawn.
- **Staged state**: controller {level:2, progress:0}; no structures, no creeps, cold Memory.
- **Expected**: One construction site appears; structureType=extension; tile has (x+y)%2===0, Chebyshev 2-6 from (25,32), not within 1 of spawn, not within 1 of source, not within 2 of controller, and >=3 non-wall neighbors. Console emits '[Construction] Placed extension site at (x, y)'.
- **Assertion**: Within window, world db contains exactly one object type=constructionSite with structureType='extension' for this bot, and its (x,y) passes all six predicates above (checked externally against the staged terrain grid); site count never exceeds 1.
- **Verdict window**: 60 ticks
- **Code refs**: `src/corps/ConstructionCorp.ts:473-483`, `src/corps/ConstructionCorp.ts:699-811`, `src/corps/ConstructionCorp.ts:764`, `src/corps/ConstructionCorp.ts:773-786`, `src/corps/ConstructionCorp.ts:521`

### `cons-src-container-on-pile` (T1) — Pile >=200 fires the source-container rung first

- **Purpose**: Rung 1 of the ladder outranks depot and extensions when the >=200 drop-pile demand signal is present at RCL3.
- **World**: W2N0, bordered plain room. Spawn (25,25), controller (25,10), single source (25,40) ~15 tiles from spawn.
- **Staged state**: controller {level:3}; injected dropped-energy object (db type='energy') amount 400 at (25,39) (adjacent to source; decay ~1/tick keeps it >=200 all window). No structures, cold creeps/Memory.
- **Expected**: First site placed is a CONTAINER within range 1 of the source (the harvest tile), NOT a depot container by the spawn and NOT an extension, even though both are also missing.
- **Assertion**: Within window, the first constructionSite in the room has structureType='container' and Chebyshev distance <=1 from (25,40); no site with structureType='extension' and no container site adjacent to the spawn exists at any sampled tick before it.
- **Verdict window**: 60 ticks
- **Code refs**: `src/corps/ConstructionCorp.ts:445-451`, `src/corps/ConstructionCorp.ts:574-591`, `src/corps/ConstructionCorp.ts:81`, `src/corps/nodeEnergy.ts:144-154`

### `cons-depot-when-pile-thin` (T1) — Pile <200 skips rung 1; core depot placed beside spawn

- **Purpose**: SOURCE_CONTAINER_PILE_THRESHOLD gates rung 1, letting the core-depot rung fire: a container lands adjacent to the spawn.
- **World**: W4N0, identical to cons-src-container-on-pile: spawn (25,25), controller (25,10), source (25,40), bordered plain.
- **Staged state**: controller {level:3}; injected drop pile of 150 at (25,39) (decays downward, never crosses 200). No structures, cold.
- **Expected**: First site is a CONTAINER at Chebyshev distance 1 from the spawn (findMissingCoreDepot via bestAdjacentTile), and NO container site appears within 1 of the source during the window.
- **Assertion**: Within window, a constructionSite structureType='container' exists with max(|x-25|,|y-25|)===1; zero container sites within range 1 of (25,40) at every sampled tick.
- **Verdict window**: 60 ticks
- **Code refs**: `src/corps/ConstructionCorp.ts:81`, `src/corps/ConstructionCorp.ts:576-581`, `src/corps/ConstructionCorp.ts:457-463`, `src/corps/ConstructionCorp.ts:533-541`

### `cons-one-site-at-a-time` (T2) — Never a second site while one is active

- **Purpose**: The activeSites===0 gate serializes placement: with two sources both signalling for containers, only one site exists at any tick.
- **World**: W6N0, bordered plain. Spawn (25,25), controller (25,10), sources (15,30) and (35,30).
- **Staged state**: controller {level:3}; injected drop piles of 400 at (16,29) and (34,29) (both sources qualify for rung 1 simultaneously). No structures, cold creeps.
- **Expected**: A single container site is placed at one source; the second source's container and all later rungs wait. Since a 5000-cost container cannot finish in-window with no fielded builders, the site count stays exactly 1 after first placement.
- **Assertion**: At every sampled tick in the window, count of this bot's constructionSite objects <= 1; after first placement the count === 1 and the site's structureType==='container' within range 1 of one of the two sources.
- **Verdict window**: 60 ticks
- **Code refs**: `src/corps/ConstructionCorp.ts:192-211`, `src/corps/ConstructionCorp.ts:201`, `src/corps/ConstructionCorp.ts:436-440`, `src/corps/ConstructionCorp.ts:50`

### `cons-ext-before-ctrl-container` (T2) — Extensions outrank the controller container

- **Purpose**: With source containers and depot satisfied but the extension set unfinished, the next site is an extension — never the controller container.
- **World**: W8N0, bordered plain. Spawn (25,25), controller (25,10), sources (15,30) and (35,30).
- **Staged state**: controller {level:3}; injected structures: containers at (15,29),(35,29) (on-source) and (24,25) (depot, adjacent to spawn), all full hits; 5 extensions (energy 50) at (22,24),(28,24),(22,26),(28,26),(24,22) — 5 of the RCL3 cap of 10. No controller container. Cold creeps.
- **Expected**: Next placed site is structureType='extension' (rung 2), and no container site appears within 2 of the controller during the window (rung 3 must wait).
- **Assertion**: Within window, a constructionSite structureType='extension' exists; at every sampled tick zero constructionSites with structureType='container' within Chebyshev 2 of (25,10).
- **Verdict window**: 60 ticks
- **Known bug targeted**: controller-container-before-extensions stall: building the far, hard-to-feed controller container first stalled the whole build set (ordering rationale documented at ConstructionCorp.ts:466-469)
- **Code refs**: `src/corps/ConstructionCorp.ts:465-483`, `src/corps/ConstructionCorp.ts:466-469`, `src/corps/ConstructionCorp.ts:507-513`

### `cons-ctrl-container-last` (T2) — Controller container fires once everything else is done

- **Purpose**: The last rung: with containers, depot, and all 10 RCL3 extensions built, the corp places the controller container within range 2 of the controller.
- **World**: W10N0, same layout as cons-ext-before-ctrl-container (spawn 25,25; controller 25,10; sources 15,30 / 35,30), bordered plain.
- **Staged state**: controller {level:3}; containers at (15,29),(35,29),(24,25); ALL 10 extensions (energy 50) at (22,24),(28,24),(22,26),(28,26),(24,22),(26,22),(22,28),(28,28),(20,24),(30,24). No controller container. Cold creeps.
- **Expected**: The only structure the ladder still wants is the controller container: a container site appears within Chebyshev 2 of (25,10) (bestAdjacentTile picks the walkable tile nearest the spawn, ~(23..27,12)).
- **Assertion**: Within window, a constructionSite structureType='container' exists with max(|x-25|,|y-10|) <= 2, and no site of any other structureType is placed.
- **Verdict window**: 60 ticks
- **Code refs**: `src/corps/ConstructionCorp.ts:507-513`, `src/corps/ConstructionCorp.ts:641-648`, `src/corps/ConstructionCorp.ts:672-693`

### `cons-repair-starts-below-60` (T2) — Maintenance builder spawns below 60% and repairs most-decayed first

- **Purpose**: REPAIR_SPAWN_BELOW hysteresis triggers a maintenance builder only when a container drops under 60%, and pickRepairTarget sends it to the most-decayed container first.
- **World**: W12N0, bordered plain, fully-built RCL3 room (nothing left to construct): spawn (25,25), controller (25,10), sources (15,30)/(35,30).
- **Staged state**: controller {level:3}; ALL 10 extensions (energy 50, positions as cons-ctrl-container-last); containers: A at (15,29) hits 137500/250000 (55%, energy 1000), B at (35,29) hits 187500/250000 (75%, energy 0), depot (24,25) full, controller container (25,12) full. Cold creeps (income creeps spawn first — window includes that queue).
- **Expected**: wantsMaintenanceBuilder fires (A < 0.6*max); a creep with Memory workType='build', corpId='building-W12N0-construction' spawns, walks ~10 tiles to A, and A.hits starts rising; B is untouched while it is healthier than A.
- **Assertion**: Within window: exported Memory.creeps gains an entry {workType:'build', corpId ending '-construction'} whose creep exists in the db; container A's hits strictly increase from 137500; container B's hits remain 187500 (+/- decay) at every sampled tick. Negative control: no such builder exists before A is the staged 55%... i.e. no second maintenance builder for B.
- **Verdict window**: 120 ticks
- **Code refs**: `src/corps/repair.ts:26`, `src/corps/repair.ts:37-44`, `src/corps/repair.ts:53-63`, `src/corps/ConstructionCorp.ts:153-157`, `src/corps/ConstructionCorp.ts:1058-1064`, `src/corps/ConstructionCorp.ts:872-890`

### `cons-repair-stops-at-99` (T2) — Repair plateaus at the 99% ceiling

- **Purpose**: A fielded maintenance builder repairs a decayed container up to REPAIR_TO=0.99 and then stops — hits plateau below hitsMax instead of topping out.
- **World**: W14N0, same fully-built RCL3 room as cons-repair-starts-below-60 (spawn 25,25; controller 25,10; sources 15,30/35,30).
- **Staged state**: controller {level:3}; all 10 extensions + 4 containers as before, except container A (15,29) hits 240000/250000 (96%) with energy 1500. Injected builder creep 'b1' body [work,work,carry,move] energy 50 at (15,28), with injected Memory.creeps.b1 = {corpId:'building-W14N0-construction', workType:'build', role:'builder'} so the squad claims it (2 WORK = 200 hits/tick, self-fuels from A; 240000->247500 = ~38 ticks).
- **Expected**: Builder repairs A until hits >= 247500 (0.99*250000), then doMaintenance's pickRepairTarget returns null and repair stops; hits never reach 250000.
- **Assertion**: Within window, container A's hits cross >= 247500; final hits < 250000; and hits are non-increasing (plateau, modulo a decay event) for the last 10 sampled ticks after crossing — max observed hits <= 247500 + 200 (one tick of overshoot).
- **Verdict window**: 100 ticks
- **Code refs**: `src/corps/repair.ts:18`, `src/corps/repair.ts:37-44`, `src/corps/ConstructionCorp.ts:856-858`, `src/corps/ConstructionCorp.ts:872-890`, `src/corps/Squad.ts:80-90`, `src/corps/Corp.ts:151-156`

### `cons-pocket-container-exact-tile` (T3) — Container lands exactly on the pocketed miner tile

- **Purpose**: sourceHarvestSpot convergence: with a 1-spot pocketed source, the container site must land on the single harvest tile — the same tile the miner stands and drops on.
- **World**: W16N0, bordered plain with pocket(g,10,25): source (10,25) walled on all 8 neighbors except the northern opening (10,24). Spawn (25,25), controller (25,10).
- **Staged state**: controller {level:3}; injected drop pile 400 at (10,24). No structures, cold creeps.
- **Expected**: Container site placed at EXACTLY (10,24) — the only walkable adjacent tile, hence the unambiguous bestAdjacentTile/sourceHarvestSpot result; any other tile is a wall and would orphan the miner's drop pile.
- **Assertion**: Within window, a constructionSite structureType='container' exists at x===10 && y===24; additionally, if a miner has reached the source by end of window, its creep position equals (10,24) (site tile === miner tile).
- **Verdict window**: 60 ticks
- **Known bug targeted**: miner-drop / container-tile divergence: miner parked on an arbitrary adjacent tile and dropped energy where haulers (routed to the planned container tile) never collected it, piling up un-hauled (fix documented at nodeEnergy.ts:135-140)
- **Code refs**: `src/corps/ConstructionCorp.ts:583-588`, `src/corps/nodeEnergy.ts:144-154`, `src/corps/nodeEnergy.ts:104-129`, `scripts/sim-parallel.ts:49-56`

### `cons-capguard-storage-rcl4` (T4) — Maxed extensions unblock the storage rung

- **Purpose**: The in-ladder extension cap guard: with extensions at the RCL4 cap, the corp must fall through to placing STORAGE within 2 of the spawn instead of retrying an over-cap extension every cooldown.
- **World**: W18N0, bordered plain. Spawn (25,25), controller (25,10), sources (15,30)/(35,30).
- **Staged state**: controller {level:4}; 20 extensions (energy 50, checkerboard tiles clear of spawn+-2 so a storage tile stays free); containers at (15,29),(35,29) (closes rung 1) and depot (24,25) (closes rung 1.5); no storage, no piles. Cold creeps. RCL4 capacity = 300+20*50 = 1300.
- **Expected**: The one site placed is structureType='storage' at Chebyshev <=2 from the spawn (bestAdjacentTile prefers the nearest free tile, likely (24,24)); no extension site ever appears.
- **Assertion**: Within window, a constructionSite structureType='storage' exists with max(|x-25|,|y-25|) <= 2; zero constructionSites with structureType='extension' at every sampled tick; console shows '[Construction] Placed storage site'.
- **Verdict window**: 60 ticks
- **Known bug targeted**: over-cap extension retry starvation: before the in-ladder cap guard, an open gate (wanted container/storage) with maxed extensions made the corp attempt an over-cap extension every cooldown forever, starving all later rungs (guard rationale at ConstructionCorp.ts:469-472)
- **Code refs**: `src/corps/ConstructionCorp.ts:469-483`, `src/corps/ConstructionCorp.ts:490-493`, `src/corps/ConstructionCorp.ts:549-558`, `src/corps/ConstructionCorp.ts:63`

### `cons-link-core-first` (T4) — First link goes beside the storage

- **Purpose**: Link network anchoring: at RCL5 with zero links, the corp places the CORE link adjacent to the storage before any source link.
- **World**: W20N0, bordered plain. Spawn (25,25), controller (25,10), sources (15,30)/(35,30) (source-to-storage ranges ~9-11, both >8 and thus link-eligible — the core must still win).
- **Staged state**: controller {level:5}; storage at (24,25) energy 10000 (Scenario loader needs storeCapacity for storage — supported); 30 extensions (energy 50) in a checkerboard block at x 30-44, y 30-40 (clear of spawn+-2); source containers (15,29),(35,29). No links, no piles. Cold creeps.
- **Expected**: The one site placed is structureType='link' at Chebyshev <=1 from the storage (bestAdjacentTile around (24,25)), NOT near either source, despite both sources qualifying for source links.
- **Assertion**: Within window, a constructionSite structureType='link' exists with max(|x-24|,|y-25|) <= 1; zero link sites within range 2 of either source at every sampled tick.
- **Verdict window**: 60 ticks
- **Code refs**: `src/corps/ConstructionCorp.ts:499-503`, `src/corps/ConstructionCorp.ts:614-618`, `src/corps/ConstructionCorp.ts:66`

### `cons-link-farthest-source` (T4) — Second link picks the farthest >8-range source

- **Purpose**: Source-link selection: with the core link built, the next link goes adjacent to the FARTHEST source beyond LINK_MIN_SOURCE_RANGE=8; a <=8-range source never gets one, and LINK_LIMITS[5]=2 blocks a third.
- **World**: W22N0, bordered plain. Spawn (25,25), controller (10,10). THREE sources: near (30,27) (range 6 from storage — excluded by the >8 rule), mid (25,42) (range 17), far (45,44) (range 21).
- **Staged state**: controller {level:5}; storage (24,25) energy 10000; CORE LINK already built at (23,24) (within 2 of storage; loader's structureCapacity needs a 'link'->800 case); 30 extensions as in cons-link-core-first; source containers at (30,26),(25,41),(44,44) (make each harvest spot deterministic and close rung 1). Cold creeps.
- **Expected**: The one site placed is structureType='link' adjacent to the far source's harvest spot (within Chebyshev 2 of (45,44)); nothing near mid (25,42) or near (30,27). After placement, links+sites = 2 = LINK_LIMITS[5], so no further link site appears.
- **Assertion**: Within window, exactly one constructionSite structureType='link' exists, with Chebyshev distance <= 2 from (45,44); at every sampled tick zero link sites within range 2 of (25,42) or (30,27).
- **Verdict window**: 60 ticks
- **Code refs**: `src/corps/ConstructionCorp.ts:620-631`, `src/corps/ConstructionCorp.ts:624-625`, `src/corps/ConstructionCorp.ts:72`, `src/corps/ConstructionCorp.ts:66`, `src/corps/nodeEnergy.ts:144-154`

**Open questions (Construction & infrastructure placement)**:
- Dropped-energy pile injection is not in ScenarioState (test/integration/scenario/Scenario.ts supports controller/structures/creeps/memory only): cells cons-src-container-on-pile, cons-depot-when-pile-thin, cons-one-site-at-a-time, cons-pocket-container-exact-tile need a small extension inserting db objects {type:'energy', room, x, y, energy: N, resourceType:'energy'} — schema must match what the mockup engine's drop/decay processor expects or the pile gets purged like malformed structures.
- Corp materialization latency on cold Memory: constructionKind corps appear via the flow planner; if the first resolve is at tick ~FLOW_RESOLVE_INTERVAL=50 rather than tick 1, all 60-tick placement windows are tight — calibrate once with a probe (scripts/debug-construction.ts pattern) and, if needed, shift windows to first-resolve+15.
- Pre-staged builder (cons-repair-stops-at-99) depends on (a) the deterministic corp id 'building-<room>-construction' (Corp.ts:151-156 — verify no idGenerator override in the sim harness) and (b) the injected creep surviving ORPHAN_GRACE_TICKS=25 if the corp materializes late; also unclear whether the bot's cold-start Memory init preserves a partially-injected Memory.creeps map or rewrites it.
- Scenario.ts structureCapacity() has no 'link' case (returns 0), so the pre-built core link in cons-link-farthest-source would get storeCapacityResource {energy:0} — needs a one-line loader extension (link: 800) or the engine may mishandle its store.
- Container decay scheduling on freshly-inserted containers (nextDecayTime/decayTime fields are not set by the loader): the plateau assertion in cons-repair-stops-at-99 tolerates one decay event, but verify the mockup doesn't decay-purge or instantly decay containers inserted without a decay timestamp.
- cons-repair-starts-below-60 window (120) assumes the maintenance builder demand (producesIncome:false, low spawn tier) gets a spawn slot behind at most ~2 income spawns in a fully-built room; if the cold-start income queue is longer, either pre-stage a miner+hauler pair with corp Memory or extend the window.
- Spawn-adjacent staged tiles: cells relying on bestAdjacentTile picks (depot at (24,25), storage near (24,24), core link near (23,24)) assume those tiles are not occupied by the bot's own early placements or by injected extensions — the harness must keep injected extension blocks outside spawn+-2 and storage+-2, as specified per cell.
- This avenue tops out at T4: ConstructionCorp only ever places in its spawn's room (work() derives everything from spawn.room), so a T5 multi-room placement cell has no seam to exercise — remote-room infrastructure would be a different corp/avenue.


## Avenue: Commission churn, orphan rescue, and disaster recovery

**Seam**: The rescue/recovery seam is the tick-ordered pair main.ts:194 (runCommissionHost) -> main.ts:201 (rescueOrphans). materializeCommissions (src/economy/CorpKind.ts:136-171) deletes a corp whose commission vanished unless hasLiveCreeps (src/execution/CommissionHost.ts:120,127-132), in which case it sets corp.retiring=true; SpawnDirector.ts:151-200 skips retiring corps for all demand collection. OrphanRescue (src/execution/OrphanRescue.ts) claims creeps by memory.corpId against liveCorpIds (commissioned store + registry.bootstrapCorps + spawningCorps, lines 80-89); readoptTarget (96-136) re-adopts miners via findInRange(FIND_SOURCES,1)/assignedSourceId into the harvest corp with matching getSourceId, haulers via CarryCorp.getAssignmentForSource (src/corps/CarryCorp.ts:1026-1029, which prefixes "source-"), other roles via ROLE_KIND same-room; otherwise orphanAction (57-68) waits ORPHAN_GRACE_TICKS=25 (line 42) then driveRecycle (src/corps/recycle.ts:50-62) at nearestSpawn (139-146, falls back to Game.spawns[0] cross-room). Commission repopulation after a reset is bounded by economyNeedsBootstrap (main.ts:277-289, Game.time%10 when nodes exist and no harvest corps) and FLOW_RESOLVE_INTERVAL=50 (main.ts:121,288). BootstrapCorp (src/corps/BootstrapCorp.ts) is the disaster layer: immediate activation on zero haulers+jacks (184-189), 5-tick starvation timer below 300 room energy with <3 other creeps (33,39,180-213), hard cap BOOTSTRAP_MAX_JACKS=2 (45,213), jack stand-down only when otherCreeps>=3 AND >=1 workType-harvest AND >=1 workType-haul (156-177, recycleJack 230-243), and anti-downgrade rescue at RCL>=2 dispatching one antidowngrade-* jack (workType "upgrade", corpId=bootstrap id) when ticksToDowngrade<ANTI_DOWNGRADE_TRIGGER_TICKS=3000, recycling once >=ANTI_DOWNGRADE_SAFE_TICKS=7000 and empty (254-323; CorpConstants.ts:174-176; SPAWN_COOLDOWN=10, JACK_BODY [WORK,CARRY,MOVE]=200 energy=9 spawn ticks). Corp id conventions the cells stamp/assert: `bootstrap-<room>-bootstrap` (Corp.ts:151-158 + BootstrapCorp createBootstrapCorp nodeId), harvest runtime id `mining-<room>-harvest-<sourceId last4>` (src/corps/kinds/harvestKind.ts:52-54), carry `hauling-<room>-hauling-<last4>` (carryKind.ts:49-51), commission store keys `harvest-source-<gameId>`/`carry-source-<gameId>` (verified in test/integration/scenario/fixtures/warm-two-source.json). Staging tricks verified: Memory.commissionedCorps/bootstrapCorps injection with idMap string-remap round-trips (fixtures + Scenario.ts:160-174); creeps injected WITHOUT corpId are invisible to OrphanRescue (OrphanRescue.ts:161) but counted by BootstrapCorp's workType tallies — perfect inert scenery.

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `churn-readopt-miner-hauler-live-corps` | T1 | 10t | #92 orphaned creeps freeze on tile until death after commiss |
| `churn-readopt-after-resolve-churn` | T2 | 30t | #92 |
| `churn-orphan-waits-then-recycles` | T1 | 50t |  |
| `churn-retiring-corp-runs-creeps-no-spawns` | T3 | 60t | Pre-hysteresis behavior stranded already-spawned miners/haul |
| `churn-jack-immediate-no-haulers` | T0 | 15t |  |
| `churn-jack-starvation-timer` | T2 | 25t |  |
| `churn-jack-standdown-flow-established` | T2 | 30t |  |
| `churn-jack-no-standdown-haulers-only` | T2 | 30t | Recycling on haulers alone collapsed the colony when no flow |
| `churn-jack-cap-two` | T3 | 80t |  |
| `churn-antidowngrade-dispatch` | T2 | 20t |  |
| `churn-antidowngrade-recover-recycle` | T3 | 90t |  |
| `churn-remote-orphan-walks-home` | T5 | 130t |  |

### `churn-jack-immediate-no-haulers` (T0) — Bootstrap jack spawns immediately when no haulers or jacks exist

- **Purpose**: Existence proof of the disaster layer: zero creeps -> noHaulers -> BootstrapCorp bypasses the starvation timer and spawns a jack with the bootstrap corpId.
- **World**: Minimal walled plain room with interior stub; spawn (25,25), source (30,25) 5 tiles away, controller (20,25).
- **Staged state**: cold
- **Expected**: BootstrapCorp created on first tick (CorpRunner), noHaulers forces starvationStartTick past threshold, trySpawn fires immediately (lastSpawnAttempt=0 so cooldown passes at any shared-world Game.time); jack is 3 parts = 9 spawn ticks.
- **Assertion**: By T0+4 spawn.spawning is non-null and the spawning creep's name matches /^jack-/; by T0+13 that creep exists in db with exported Memory.creeps[name].corpId === 'bootstrap-<R>-bootstrap' and workType 'harvest'.
- **Verdict window**: 15 ticks
- **Code refs**: `src/corps/BootstrapCorp.ts:151-189`, `src/corps/BootstrapCorp.ts:329-364`, `src/execution/CorpRunner.ts:52-93`, `src/corps/Corp.ts:151-158`

### `churn-readopt-miner-hauler-live-corps` (T1) — Orphan miner and hauler re-adopted into live corps within a tick

- **Purpose**: readoptTarget hands a bogus-corpId miner to the harvest corp for the source it stands on, and a bogus-corpId hauler to the carry corp routing its assignedSourceId, without consuming the grace window.
- **World**: One walled 50x50 room; short interior wall stub near (15,15) so the distance transform has a peak. Spawn (25,25), source S1 (35,25), controller (15,35).
- **Staged state**: Warm memory (nodes/colony/commissionedCorps captured via snapshot-warm pattern, idMap-remapped) containing harvest-source-S1 (corp.id mining-<R>-harvest-<last4>) and carry-source-S1 (corp.id hauling-<R>-hauling-<last4>). Creeps: miner-legit [work,work,move] at (34,25) with corpId=harvest corp.id, workType harvest (keeps corp alive through the empty-solver-commission tick via hasLiveCreeps); hauler-legit [carry,move] at (30,25) corpId=carry corp.id, workType haul, assignedSourceId=S1; orphan-miner [work,work,move] at (36,25) adjacent S1, corpId 'mining-DEAD-harvest-0000', workType harvest; orphan-hauler [carry,carry,move] at (28,25), corpId 'hauling-DEAD-hauling-0000', workType haul, assignedSourceId=S1 (idMap-remapped).
- **Expected**: On the first 1-2 ticks rescueOrphans re-adopts both orphans: miner via findInRange(FIND_SOURCES,1) match on getSourceId, hauler via getAssignmentForSource('source-'+S1). No orphanedSince survives; nobody recycles.
- **Assertion**: By T0+5 exported Memory.creeps['orphan-miner'].corpId === Memory.commissionedCorps['harvest-source-<S1>'].corp.id and Memory.creeps['orphan-hauler'].corpId === Memory.commissionedCorps['carry-source-<S1>'].corp.id; both entries lack orphanedSince; both creep docs still present in world db at T0+10.
- **Verdict window**: 10 ticks
- **Known bug targeted**: #92 orphaned creeps freeze on tile until death after commission churn
- **Code refs**: `src/execution/OrphanRescue.ts:96-136`, `src/execution/OrphanRescue.ts:165-175`, `src/corps/CarryCorp.ts:1026-1029`, `src/execution/CommissionHost.ts:120-132`

### `churn-orphan-waits-then-recycles` (T1) — Unadoptable orphan waits exactly the grace window then recycles at spawn

- **Purpose**: orphanAction returns wait for 25 ticks (creep must NOT move or die early), then driveRecycle walks it to the nearest spawn and recycleCreep returns its body energy.
- **World**: Walled room with interior stub; spawn (25,25), source (40,40) far/irrelevant, controller (10,10). Orphan staged at (33,25), 8 plain tiles east of spawn.
- **Staged state**: Cold memory. One creep orphan-hauler [carry,move] energy 0 at (33,25), memory {corpId:'hauling-DEAD-0000', workType:'haul'} with NO assignedSourceId (readoptTarget deterministically null). workType haul also suppresses BootstrapCorp's noHaulers immediate activation, keeping the room quiet.
- **Expected**: orphanedSince set tick ~1; creep stands still through tick 25; from tick 26 driveRecycle moves it toward spawn (~8 ticks), recycleCreep on adjacency.
- **Assertion**: Creep's db position unchanged from T0+2 through T0+24 and creep alive through T0+25; creep doc removed from rooms.objects between T0+26 and T0+45 (its ageTime ~T0+1500 proves recycle, not natural death); a dropped-energy object appears within range 1 of spawn at removal.
- **Verdict window**: 50 ticks
- **Code refs**: `src/execution/OrphanRescue.ts:42`, `src/execution/OrphanRescue.ts:57-68`, `src/execution/OrphanRescue.ts:177-183`, `src/corps/recycle.ts:50-62`

### `churn-readopt-after-resolve-churn` (T2) — Orphan survives commission churn: wait then readopt before grace expires

- **Purpose**: When the corp itself is demobilized (no live creeps carry it through), the orphan must WAIT (orphanedSince stopwatch), be re-adopted the tick the %10 economyNeedsBootstrap solve re-commissions the source, and never hit the 25-tick recycle.
- **World**: Walled room with interior stub; spawn (25,25), source S1 (35,25), controller (15,35).
- **Staged state**: Warm memory with nodes/colony (so economyNeedsBootstrap can fire without spatial analysis) and a commissionedCorps harvest-source-S1 entry, but the ONLY creep is orphan-miner [work,work,move] adjacent S1 with corpId 'mining-DEAD-harvest-0000', workType harvest — so tick 1 materializeCommissions demobilizes the injected harvest corp (hasLiveCreeps false: churn staged).
- **Expected**: Tick ~1: orphanedSince set (wait). Within <=10 ticks (next Game.time%10===0, main.ts:277-289) the solve re-emits harvest-source-S1, the corp materializes, and rescueOrphans re-adopts the miner the same tick. Recycle never fires (readopt beats grace 25).
- **Assertion**: Exported Memory.creeps['orphan-miner'].orphanedSince appears by T0+3; by T0+15 corpId matches /^mining-<R>-harvest-/ AND equals Memory.commissionedCorps harvest entry's corp.id with orphanedSince deleted; creep doc still present in world db at T0+30 (not recycled) and source energy is decreasing.
- **Verdict window**: 30 ticks
- **Known bug targeted**: #92 — the exact re-solve churn window ORPHAN_GRACE_TICKS exists for
- **Code refs**: `src/execution/OrphanRescue.ts:42`, `src/execution/OrphanRescue.ts:57-68`, `src/economy/CorpKind.ts:159-167`, `src/main.ts:277-291`

### `churn-jack-starvation-timer` (T2) — Starvation fallback waits BOOTSTRAP_STARVATION_THRESHOLD=5 ticks before spawning

- **Purpose**: The <300 energy + <3 other creeps path must arm the starvation stopwatch, hold spawn for 5 ticks, then spawn a jack — distinguishing timed starvation from the noHaulers bypass.
- **World**: Walled room with stub; spawn (25,25), source (35,30), controller (15,30).
- **Staged state**: Post-load db update sets the spawn's store to 250 energy. One inert scenery creep 'hauler-scenery' [move,carry] at (45,45) with memory {workType:'haul'} and NO corpId (OrphanRescue skips corpId-less creeps; BootstrapCorp counts it, so noHaulers=false, otherCreeps=1<3, energy 250<300 -> isStarving path).
- **Expected**: First bootstrap tick T1 sets starvationStartTick=T1 and does NOT spawn; at T1+5 shouldSpawn flips and trySpawn succeeds (250>=JACK_COST 200; spawn regen +1/tick keeps energy <300 throughout).
- **Assertion**: Exported Memory.bootstrapCorps[R].starvationStartTick === T1 (nonzero) by T0+3; spawn.spawning stays null and no /^jack-/ creep exists through T1+4; spawn.spawning non-null with a /^jack-/ name within [T1+5, T1+12].
- **Verdict window**: 25 ticks
- **Code refs**: `src/corps/BootstrapCorp.ts:33`, `src/corps/BootstrapCorp.ts:39`, `src/corps/BootstrapCorp.ts:180-213`, `src/corps/BootstrapCorp.ts:341-343`

### `churn-jack-standdown-flow-established` (T2) — Jacks recycle once >=1 flow miner AND >=1 flow hauler exist

- **Purpose**: Stand-down gate: with otherCreeps>=3, noHaulers false, and both workType harvest and haul present, existing jacks take the recycleJack path and no new jack spawns.
- **World**: Walled room with stub; spawn (25,25), source (33,25), controller (15,30). Jacks staged 2 tiles from spawn.
- **Staged state**: Memory.bootstrapCorps[R] injected (idMap-remapped spawnId/sourceId): {id:'bootstrap-<R>-bootstrap', nodeId:'<R>-bootstrap', creepNames:['jack-a','jack-b'], starvationStartTick:0}. Creeps jack-a (27,25) and jack-b (27,26), body [work,carry,move], energy 0, memory {corpId:'bootstrap-<R>-bootstrap', workType:'harvest'}. Inert scenery (no corpId): miner-scenery [move] (43,43) workType harvest; hauler-scenery-1 [move] (44,44) and hauler-scenery-2 [move] (44,45) workType haul.
- **Expected**: otherCreeps=3>=3, totalHaulers=2+2(jacks)>0, flowMiners=1 and flowHaulers=2 -> flowEstablished -> recycleJack: both jacks (empty stores) walk 2 tiles and are recycled at spawn; starvationStartTick reset; nothing respawns.
- **Assertion**: Both jack-a and jack-b removed from world db by T0+15; no creep matching /^jack-/ exists at any sample through T0+30; exported Memory.bootstrapCorps[R].creepNames is empty by T0+20.
- **Verdict window**: 30 ticks
- **Code refs**: `src/corps/BootstrapCorp.ts:156-177`, `src/corps/BootstrapCorp.ts:230-243`, `src/execution/CorpRunner.ts:62-86`

### `churn-jack-no-standdown-haulers-only` (T2) — Jacks do NOT recycle when only haulers exist (no flow miner)

- **Purpose**: Regression for the collapse where jacks recycled on haulers alone with nothing harvesting: flowEstablished requires BOTH >=1 miner and >=1 hauler, so haulers-only must keep jacks working.
- **World**: Same walled room shape as churn-jack-standdown: spawn (25,25), source (33,25), controller (15,30).
- **Staged state**: Same injected Memory.bootstrapCorps + jack-a/jack-b as churn-jack-standdown-flow-established, but scenery is 3 corpId-less [move] creeps ALL with workType 'haul' at (43,43),(44,44),(44,45) — zero workType harvest.
- **Expected**: otherCreeps=3 and noHaulers=false enter the yield branch, but flowMiners=0 -> flowEstablished false -> runCreep: jacks stay alive and go harvest/deliver instead of recycling.
- **Assertion**: jack-a and jack-b present in world db at every sample through T0+30; at least one jack's position differs from its staged tile by T0+10 (being driven, not stranded); source (33,25) db energy has decreased by T0+30; no jack removed before T0+30.
- **Verdict window**: 30 ticks
- **Known bug targeted**: Recycling on haulers alone collapsed the colony when no flow miners had spawned (BootstrapCorp.ts:162-164 comment)
- **Code refs**: `src/corps/BootstrapCorp.ts:160-176`, `src/corps/BootstrapCorp.ts:373-443`

### `churn-antidowngrade-dispatch` (T2) — Controller at ticksToDowngrade<3000 triggers exactly one rescue jack

- **Purpose**: runAntiDowngrade dispatches a single antidowngrade-* jack (workType 'upgrade', bootstrap corpId) when the injected downgrade timer is below ANTI_DOWNGRADE_TRIGGER_TICKS, winning the spawn ahead of the starvation jack.
- **World**: Walled room with stub; spawn (25,25), source (32,25), controller (18,25) 7 tiles from spawn.
- **Staged state**: ScenarioState.controller {level:2, downgradeTime: loadGameTime+2500} (ticksToDowngrade ~2500 < 3000). Cold memory otherwise; spawn at default 300 energy >= JACK_COST 200.
- **Expected**: First bootstrap tick: atRisk true, emergencyJackNames empty, lastEmergencyAttempt=0 passes cooldown, !spawn.spawning, energy ok -> spawnCreep(JACK_BODY, 'antidowngrade-...', {workType:'upgrade', corpId:bootstrap id}). runAntiDowngrade runs before the starvation trySpawn in work(), so the emergency jack takes the spawn first (9 ticks).
- **Assertion**: spawn.spawning non-null by T0+4 with spawning creep name matching /^antidowngrade-/; by T0+13 that creep is in db and exported Memory.creeps[name] has workType 'upgrade' and corpId 'bootstrap-<R>-bootstrap'; exactly ONE /^antidowngrade-/ creep exists at every sample through T0+20 (no double dispatch).
- **Verdict window**: 20 ticks
- **Code refs**: `src/corps/BootstrapCorp.ts:254-289`, `src/corps/CorpConstants.ts:174-176`, `src/corps/BootstrapCorp.ts:136-139`

### `churn-retiring-corp-runs-creeps-no-spawns` (T3) — Corp with live creeps but vanished commission retires: runs creeps, requests no spawns

- **Purpose**: materializeCommissions hysteresis: a corp absent from the commission union but with live creeps is retained with retiring=true, keeps driving its creeps, and SpawnDirector requests nothing for it.
- **World**: Walled room; spawn (25,25); open source S1 (35,25) for the normal economy; source S2 (12,25) enclosed in a FULL wall ring (no gap — solver cannot reach it, so its commission never re-appears) with one interior free tile at (13,25); controller (25,40).
- **Staged state**: Warm memory with commissionedCorps entry harvest-source-S2 (corp.id mining-<R>-harvest-<S2 last4>, creepNames ['miner-pocket']); creep miner-pocket [work,work,move] at (13,25) inside the ring adjacent S2, memory {corpId: that corp.id, workType:'harvest'}.
- **Expected**: Tick 1: no commission for S2 in the union, but hasLiveCreeps true -> retained, retiring=true. The retained corp still runs (runCommissionedCorps iterates the whole store): miner harvests S2. SpawnDirector skips retiring corps, so no replacement/extra creep with that corpId ever spawns. The miner is claimed every tick (corp.id in liveCorpIds), so OrphanRescue never touches it.
- **Assertion**: Through T0+60 (spanning a %50 re-solve): exported Memory.commissionedCorps['harvest-source-<S2>'] persists every sample; Memory.creeps['miner-pocket'].corpId unchanged and orphanedSince never set; count of db creeps with that corpId stays exactly 1; S2's db energy strictly decreases while the miner is adjacent (proof the retiring corp runs its creep).
- **Verdict window**: 60 ticks
- **Known bug targeted**: Pre-hysteresis behavior stranded already-spawned miners/haulers as orphans the instant a re-solve dropped a commission (CommissionHost.ts:115-119 comment)
- **Code refs**: `src/execution/CommissionHost.ts:110-132`, `src/economy/CorpKind.ts:159-171`, `src/execution/SpawnDirector.ts:151-200`, `src/execution/OrphanRescue.ts:80-89`

### `churn-jack-cap-two` (T3) — Bootstrap never exceeds 2 concurrent jacks under sustained starvation

- **Purpose**: BOOTSTRAP_MAX_JACKS=2 holds even when starvation persists across multiple spawn cycles and cooldowns (the unused MAX_JACKS=3 in CorpConstants must not leak in).
- **World**: Adversity so flow cannot establish inside the window: source (10,25) pocketed to a single mining spot (pocket() helper), swamp band x/y between spawn (40,25) and source (swampBand rows 20-30 west half), controller (40,40).
- **Staged state**: cold
- **Expected**: noHaulers -> immediate activation; jack 1 spawns (~9 ticks), jack 2 after SPAWN_COOLDOWN=10 as energy allows (spawn regen + jack deliveries); the third clause of shouldSpawn keeps pressure on but the creepNames.length < 2 guard caps the fleet across the whole window.
- **Assertion**: At every tick through T0+80: count of db creeps with name matching /^jack-/ <= 2 AND exported Memory.bootstrapCorps[R].creepNames.length <= 2; additionally at least 1 jack exists by T0+15 and 2 exist at some tick (the cap is actually exercised, not vacuous).
- **Verdict window**: 80 ticks
- **Code refs**: `src/corps/BootstrapCorp.ts:45`, `src/corps/BootstrapCorp.ts:207-215`, `src/corps/CorpConstants.ts:20`, `src/corps/CorpConstants.ts:65`

### `churn-antidowngrade-recover-recycle` (T3) — Rescue jack pushes timer past 7000 then recycles itself

- **Purpose**: The full anti-downgrade loop: a staged full rescue jack upgrades (+~99 ticksToDowngrade per tick, CONTROLLER_DOWNGRADE_RESTORE=100), crosses ANTI_DOWNGRADE_SAFE_TICKS=7000, and once safe && empty recycles at spawn; emergencyJackNames nonempty blocks a second dispatch.
- **World**: Walled room with stub; spawn (25,25), source (35,25), controller (15,25) 10 tiles west of spawn.
- **Staged state**: ScenarioState.controller {level:2, downgradeTime: loadGameTime+2600}. Memory.bootstrapCorps[R] injected with emergencyJackNames:['antidowngrade-stage'] (spawnId/sourceId idMap-remapped, id 'bootstrap-<R>-bootstrap'). Creep antidowngrade-stage [work,carry,move] energy 50 at (17,25) (range <=3 of controller), memory {corpId:'bootstrap-<R>-bootstrap', workType:'upgrade', working:true}.
- **Expected**: Jack upgrades 1 energy/tick: ticksToDowngrade 2600 -> >=7000 after ~45 upgrade ticks; store empties at ~50; safe && empty -> recycleJack walks ~9 tiles to spawn and is recycled (~T0+65). No second antidowngrade jack ever spawns.
- **Assertion**: At some sample <= T0+60, db controller.downgradeTime - gameTime >= 7000; controller.level === 2 at every sample (never downgraded); antidowngrade-stage removed from world db by T0+90; never more than one /^antidowngrade-/ creep at any sample.
- **Verdict window**: 90 ticks
- **Code refs**: `src/corps/BootstrapCorp.ts:262-323`, `src/corps/BootstrapCorp.ts:230-243`, `src/corps/CorpConstants.ts:175`, `src/execution/CorpRunner.ts:62-86`

### `churn-remote-orphan-walks-home` (T5) — Orphan stranded in a spawnless remote room walks home to recycle

- **Purpose**: nearestSpawn falls back to Game.spawns[0] when the creep's room has no spawn, so a cross-room orphan must survive grace, border-cross, and recycle at the home spawn instead of decaying in place.
- **World**: Two rooms: home H with spawn (25,25), source (35,30), controller (15,30), interior stub; adjacent remote room R to the east with open exit tiles on the shared border, its own interior stub, no structures. Orphan staged at R (25,25).
- **Staged state**: Cold memory plus creep orphan-remote [carry,move,move] energy 0 in room R at (25,25), memory {corpId:'hauling-DEAD-0000', workType:'haul'} with no assignedSourceId (readoptTarget null; corpId set so OrphanRescue owns it).
- **Expected**: Waits 25 grace ticks in R (unclaimed, no corp in R), then driveRecycle targets Game.spawns[0] in H: moveTo paths ~25 tiles to the border, crosses, ~25 more to spawn, recycles on adjacency. Home-room bootstrap jack noise is irrelevant (assertions by name).
- **Assertion**: orphan-remote's db doc unmoved and alive through T0+25; its room field flips R->H between T0+26 and T0+90 (border crossed); doc removed from db by T0+130 with dropped energy appearing within range 1 of the home spawn (recycled, not expired: ageTime ~T0+1500).
- **Verdict window**: 130 ticks
- **Code refs**: `src/execution/OrphanRescue.ts:139-146`, `src/execution/OrphanRescue.ts:57-68`, `src/corps/recycle.ts:50-62`

**Open questions (Commission churn, orphan rescue, and disaster recovery)**:
- Spawn-energy staging: Scenario.ts cannot mutate the addBot spawn's store, so churn-jack-starvation-timer needs a small post-load db update (db['rooms.objects'].update spawn store.energy=250) — needs a one-line extension to the cell runner. Also confirm mockup addBot's default spawn energy is 300 (several cells assume energyAvailable=300 at T0).
- churn-retiring-corp-runs-creeps-no-spawns assumes the planner never emits a commission for a fully wall-enclosed source (no path -> no node/edge). If the solver does commission it, the corp gets refreshed (retiring=false) and the cell breaks; fallback staging is a fabricated source id (corp retained but cannot run its creep, weakening the runs-creeps half of the assertion).
- recycleCreep refund size for small fresh creeps in screeps-server-mockup: confirm a nonzero dropped-energy object actually appears (engine drops bodyCost*CREEP_CORPSE_RATE scaled by remaining life). If it rounds to 0 for [carry,move], the dropped-energy sub-assertions in churn-orphan-waits-then-recycles and churn-remote-orphan-walks-home should fall back to creep-doc-removal-before-ageTime only.
- Warm-memory staging (nodes/colony/commissionedCorps) for the readopt cells: hand-building Memory.nodes/colony is brittle; the safer path is capturing one warm snapshot per cell layout with scripts/snapshot-warm.ts and then surgically editing corpIds/creeps. Verify economyNeedsBootstrap (main.ts:277-289) actually fires from injected nodes without a full spatial-analysis pass in these hand-edited worlds.
- Shared-world clock: all cells run in one world, so Game.time at cell start (T0) is arbitrary. downgradeTime must be computed as loadGameTime+delta at injection, and per-cell tick offsets (T1 for the starvation timer cell) must be measured from each bot's first executed tick, not from 0. Cadence-based events (%10 solve) land within <=10 ticks of T0 but not at a fixed offset — assertions above already use windows, not exact ticks.
- Cross-room moveTo in churn-remote-orphan-walks-home: driveRecycle uses plain creep.moveTo(spawn) toward another room; confirm the mockup's PathFinder + padNeighborTerrain handles the cross-room route (existing remote-mining.test.ts suggests yes, but for corp-driven creeps, not OrphanRescue's bare moveTo).
- Per-bot console/Memory export plumbing: assertions read exported Memory per tick (CorpCop pattern) — sim-parallel.ts must subscribe to each bot user's memory export separately; confirm memory export size stays under the mockup's per-user cap once warm fixtures (nodes + commissionedCorps) are injected for several bots at once.


## Avenue: Planner correctness — source selection, budgets, multi-spawn arbitration, remote economics

**Seam**: The seam is planColony() in src/economy/CorpPlanner.ts and its live adapter src/economy/flowAdapter.ts. Phase 1 selectProducers (CorpPlanner.ts:189-243): each source is assigned to its nearest spawn (nearestSpawn, :173-182, ties by spawn id), sources with netEnergy<=0 are excluded outright (:199; netEnergy in primitives.ts:73-75 = rate - MINER_COST/effectiveLife(d) - haulerOverhead; for a rate-10 source break-even is 10=(690+40d)/(1500-d) → d≈286 path tiles), survivors are taken per spawn in net/spawnParts order (:222) until the mining budget miningBudgetPerSpawn() = SPAWN_PARTS_PER_TICK(1/3, economics.ts:46) * MINING_BUDGET_FRACTION(0.6, primitives.ts:93) = 0.2 parts/tick is spent (:227; first source always taken since the guard is `spent > 0`). Phase 2 routeToSinks (CorpPlanner.ts:280-346): a reserve pre-pass fills sinks with reserve>0 first (:337-339 — only the controller has one: ANTI_DOWNGRADE_RESERVE=2, flowAdapter.ts:40,145), then a value-descending pass (spawn 100 > construction 70 > controller 50 > storage 1, CorpPlanner.ts:99-104) fills each sink to capacity pulling nearest-source-first, priced from haulPos when link-served (:309-314; detectLinkHaulPositions flowAdapter.ts:92-106 via coreLink/sourceLink nodeEnergy.ts:52-72). Sink capacities from buildColonyProblem (flowAdapter.ts:128-147): spawn clamped to max(demand,1) with demand fixed at 10 (FlowGraph.ts:156), construction 5 e/t per site (CONSTRUCTION_ABSORB_RATE, flowAdapter.ts:42), controller/storage = totalSupply. SK-room sources never enter the graph (FlowGraph.ts:116; also IncrementalAnalysis.ts:414,452-464). Remote: reservable sources are valued at 3000 (IncrementalAnalysis.ts:571-601 couldReserveLive lift, gated on homeCapacity>=650) and ReservationCorp (ReservationCorp.ts:71-85 targetRooms = 'a workType harvest creep stands in an unowned controllered room', getSpawnDemand :137-171, body 1CLAIM+1MOVE=650 via BodyBuilder.buildReserverBody). The decisive external observable is Memory.economyPlan written every solve by publishRoster (flowAdapter.ts:165-201): corps entries {kind:mine, sourceId:`source-<gameId>`, spawnId:`spawn-<gameId>`}, {kind:haul, carry, fromId, toId}, {kind:upgrade|build, work=ceil(allocated/1|5)} — ids map to world-db object _ids by position (FlowTypes.ts:485,509). Solves land at Game.time%10 (bootstrap) then %50 (main.ts:121,288), so plan-level verdicts are readable within ~30-60 ticks.

| Cell | Tier | Window | Targets bug |
|---|---|---|---|
| `plan-t0-single-source-commissioned` | T0 | 80t | spawn resource not claimed by any node -> 'No spawn sinks -  |
| `plan-t1-single-source-loop` | T1 | 350t |  |
| `plan-t2-asymmetric-both-staffed` | T2 | 300t | far-source abandonment / travel-cost mis-accounting that asy |
| `plan-t2-sink-source-pairing` | T2 | 100t | spawn-sink-soaks-everything: all energy parked at spawn, con |
| `plan-t2-antidowngrade-construction` | T2 | 450t | controller starvation during construction |
| `plan-t3-netzero-maze-excluded` | T3 | 250t | analytic distance estimate ignoring walls/swamps -> colony o |
| `plan-t3-budget-subset` | T3 | 250t |  |
| `plan-t4-two-spawn-nearest` | T4 | 250t | double-staffing / miner pile-up on one source when multiple  |
| `plan-t4-link-haul-pricing` | T4 | 300t |  |
| `plan-t5-remote-mined` | T5 | 800t | remote valuation collapsing 3000->1500 the moment a miner gr |
| `plan-t5-reserver-dispatch` | T5 | 500t |  |
| `plan-t5-sk-never-mined` | T5 | 450t |  |

### `plan-t0-single-source-commissioned` (T0) — Single near source gets commissioned at all

- **Purpose**: Existence proof: with one spawn and one source 5 tiles away the planner publishes exactly one mine corp for that source plus at least one haul corp, and the spawn starts building a creep.
- **World**: W0N0, bordered plain room (RoomBuilder.border()). Spawn (25,25), source (25,30) [path d≈5], controller (25,10).
- **Staged state**: controller {level:2} (skip bootstrap so the flow economy owns the room); no creeps, no structures — otherwise cold.
- **Expected**: First solve (economyNeedsBootstrap, Game.time%10 after nodes exist, main.ts:276-288) publishes Memory.economyPlan with one kind:'mine' entry whose sourceId is source-<dbId of the (25,30) source> and spawnId is spawn-<dbId>; the spawn begins spawning a miner.
- **Assertion**: By tick 60 exported Memory.economyPlan.corps contains exactly 1 'mine' entry with sourceId === `source-${dbSourceId}` and >=1 'haul' entry; by tick 80 the world-db spawn object has spawning non-null (or a creep with Memory.creeps[name].workType==='harvest' exists).
- **Verdict window**: 80 ticks
- **Known bug targeted**: spawn resource not claimed by any node -> 'No spawn sinks - cannot assign miners' -> zero miners forever (fixed by attachOwnedSpawnsToNodes, IncrementalAnalysis.ts:466-511)
- **Code refs**: `src/economy/CorpPlanner.ts:189-243`, `src/economy/flowAdapter.ts:165-201`, `src/execution/IncrementalAnalysis.ts:475-511`, `src/main.ts:276-288`

### `plan-t1-single-source-loop` (T1) — Realistic-distance loop with anti-downgrade floor

- **Purpose**: With one source at realistic distance the plan closes the full loop (mine, haul, upgrade) and the controller allocation equals exactly the ANTI_DOWNGRADE_RESERVE floor of 2, since the spawn sink (demand 10) legitimately soaks the rest of a 10 e/t supply.
- **World**: W2N0, bordered plain room. Spawn (25,25), source (25,47) [path d≈22], controller (25,10).
- **Staged state**: controller {level:2}; otherwise cold.
- **Expected**: Plan: 1 mine entry; haul entries covering both the controller reserve (2 e/t) and the spawn (8 e/t, capped by demand=10); upgrade corp with work === 2 (ceil(ANTI_DOWNGRADE_RESERVE/1)). Then the loop physically runs: miner sits by the source, source drains, controller progress ticks up.
- **Assertion**: By tick 60 economyPlan has exactly 1 mine entry and an 'upgrade' entry with work === 2; by tick 200 the (25,47) source db object has store.energy < energyCapacity while a creep with workType 'harvest' is within 1 tile of it; controller.progress at tick 350 > controller.progress at tick 200.
- **Verdict window**: 350 ticks
- **Code refs**: `src/economy/CorpPlanner.ts:294-343`, `src/economy/flowAdapter.ts:40`, `src/economy/flowAdapter.ts:128-147`, `src/flow/FlowGraph.ts:156`

### `plan-t2-asymmetric-both-staffed` (T2) — Near and far source both staffed when both profitable

- **Purpose**: selectProducers orders by net/parts but must staff BOTH sources when the 0.2 parts/tick budget covers them (near d≈5: 0.010 parts; far d≈21: 0.017 parts; total 0.027 << 0.2) — the far source must not be silently abandoned.
- **World**: W4N0, bordered plain room. Spawn (25,25), near source (22,22), far source (46,46) [path d≈21], controller (25,8).
- **Staged state**: controller {level:3}; 10 extensions around spawn (energy 50 each) so the full 5W3M=650 miner is affordable and fields fast.
- **Expected**: economyPlan carries 2 mine entries (both sourceIds) at every resolve; within the window both sources are actively mined (harvest creep adjacent, source energy below cap).
- **Assertion**: By tick 80 economyPlan.corps contains exactly 2 'mine' entries covering both db source ids; at some sampled tick <= 300 BOTH source db objects simultaneously satisfy store.energy < energyCapacity with a workType 'harvest' creep within 1 tile; neither mine entry disappears at any %50 resolve in the window.
- **Verdict window**: 300 ticks
- **Known bug targeted**: far-source abandonment / travel-cost mis-accounting that asymmetricTwoSource was built to expose (library.ts:34-43)
- **Code refs**: `src/economy/CorpPlanner.ts:219-242`, `src/economy/primitives.ts:73-98`, `test/integration/scenario/library.ts:44-64`

### `plan-t2-sink-source-pairing` (T2) — Value routing pulls nearest source per sink; spawn cannot soak surplus

- **Purpose**: routeToSinks fills each sink from the nearest supply (CorpPlanner.ts:309-314) and the spawn sink capacity is clamped to demand=10 so the second source's output reaches the controller.
- **World**: W6N0, bordered plain room. Spawn (10,25) with source A (6,25) beside it; controller (43,25) with source B (46,25) beside it.
- **Staged state**: controller {level:3}; 10 extensions prebuilt near spawn + containers at (6,24),(46,24),(43,27) prebuilt (mirror twoSourceRcl3Full) so little/no construction competes; extensions energy 50.
- **Expected**: Reserve pass: controller reserve 2 pulled from B (nearest). Value pass: spawn (cap 10) drains A entirely; controller fills from B's remaining 8. So every controller-bound haul has fromId=source-B, the spawn-bound haul has fromId=source-A, and upgrade work >= 4 (would be exactly 2 if the spawn soaked the surplus).
- **Assertion**: By tick 100 economyPlan.corps: every 'haul' entry with toId === `controller-${ctrlId}` has fromId === `source-${Bid}`; >=1 'haul' entry with toId === `spawn-${spawnId}` has fromId === `source-${Aid}`; no haul A->controller; 'upgrade' entry work >= 4.
- **Verdict window**: 100 ticks
- **Known bug targeted**: spawn-sink-soaks-everything: all energy parked at spawn, controller crawls at the reserve floor (the clamp comment at flowAdapter.ts:61-69 documents the fix)
- **Code refs**: `src/economy/CorpPlanner.ts:294-345`, `src/economy/flowAdapter.ts:128-147`, `src/flow/FlowGraph.ts:151-158`

### `plan-t2-antidowngrade-construction` (T2) — Controller never starves while construction absorbs the surplus

- **Purpose**: The reserve pre-pass (CorpPlanner.ts:337-339) guarantees the controller ANTI_DOWNGRADE_RESERVE=2 e/t before construction (value 70 > controller 50) drains the pool, so the controller keeps ticking during the RCL2 extension build-out.
- **World**: W8N0, bordered plain room. Spawn (25,25), sources (18,32) and (32,32) [d≈8 each, supply 20], controller (25,10).
- **Staged state**: controller {level:2}; otherwise cold — the bot places its own RCL2 extension sites (~tick 50-150), creating construction sinks at 5 e/t each.
- **Expected**: While >=2 extension construction sites exist: economyPlan simultaneously contains >=1 'build' corp and an 'upgrade' corp with work === 2 (exactly the reserve — spawn 10 + sites soak the rest of the 20); controller progress still strictly increases; extensions actually complete.
- **Assertion**: At every %50 resolve between tick 150 and 400 where >=2 constructionSite objects exist in db: economyPlan has >=1 'build' entry AND an 'upgrade' entry with work === 2; controller.progress at tick 450 > progress at tick 200; extension (built) count in db at tick 450 > 0.
- **Verdict window**: 450 ticks
- **Known bug targeted**: controller starvation during construction — the regime threeChamberRcl2 and probe-antidowngrade.ts were built for; ANTI_DOWNGRADE_RESERVE is the fix under test
- **Code refs**: `src/economy/CorpPlanner.ts:337-339`, `src/economy/flowAdapter.ts:40-42`, `src/economy/flowAdapter.ts:180-195`

### `plan-t3-netzero-maze-excluded` (T3) — Source past net-zero effective distance is never mined

- **Purpose**: netEnergy<=0 exclusion (CorpPlanner.ts:199, primitives.ts:73-75) must use REAL path distance: a source ~33 tiles away as the crow flies but ~340 tiles through a serpentine maze has net ≈ -2.5 e/t and must not be staffed, while the near source is.
- **World**: W10N0, bordered room. Spawn (25,15), near source (30,15), controller (25,8). South half is a serpentine: 8 full-width wall rows at y=26,29,32,35,38,41,44,47 with 2-tile gaps alternating at x=2/x=47 (2-wide corridors between), maze source at (44,48) at the innermost corridor end — walkable but ~330-350 path tiles from spawn (build deep enough that measured pathDistance >= 320; net(320)=10-(690+12800)/1180 ≈ -1.4).
- **Staged state**: controller {level:2}; otherwise cold.
- **Expected**: economyPlan only ever contains the near source's mine entry; the maze source is excluded at every resolve (not merely delayed), and no harvester ever walks the maze.
- **Assertion**: At every %50 resolve from tick 60 through 250: economyPlan.corps 'mine' entries == exactly 1 and its sourceId === `source-${nearId}`; at no sampled tick does any creep with workType 'harvest' stand within 2 tiles of the maze source or south of y=26.
- **Verdict window**: 250 ticks
- **Known bug targeted**: analytic distance estimate ignoring walls/swamps -> colony opens hauls it can never bring home profitably ('lots of miners out, little energy back', documented at NodeNavigator.ts:128-133)
- **Code refs**: `src/economy/CorpPlanner.ts:194-199`, `src/economy/primitives.ts:73-75`, `src/nodes/NodeNavigator.ts:122-168`

### `plan-t3-budget-subset` (T3) — Mining budget staffs only the affordable subset

- **Purpose**: Per-spawn 0.2 parts/tick budget (CorpPlanner.ts:210-227, primitives.ts:93-98): near source (d≈10, 0.011 parts) + two profitable maze sources at d≈200/204 (0.130/0.133 parts each, net ≈ +3.3) — near + exactly ONE far source fits (0.141); the second far source (0.274 > 0.2) must be skipped, deterministically the same one every resolve.
- **World**: W12N0, bordered room. Spawn (25,15), near source (28,15), controller (25,8). Serpentine of 5 wall rows at y=26,30,34,38,42 (2-wide corridors, gaps alternating x=2/x=47) ending in a small open 6x6 chamber around (42,46); far sources at (40,46) and (46,46) [measured path d must land ~190-215 for both].
- **Staged state**: controller {level:3}; 10 extensions prebuilt (energy 50) so far-posted bodies are affordable.
- **Expected**: economyPlan has exactly 2 mine entries: the near source plus the better net/parts far source (the shorter-path one, (40,46)); the third source is never staffed and never visited by a harvester; the selection is stable across resolves.
- **Assertion**: At every %50 resolve from tick 60 through 250: economyPlan 'mine' entries == exactly 2, containing `source-${nearId}` and `source-${far40Id}` and never `source-${far46Id}`; no workType 'harvest' creep within 2 tiles of (46,46) at any sampled tick.
- **Verdict window**: 250 ticks
- **Code refs**: `src/economy/CorpPlanner.ts:210-242`, `src/economy/primitives.ts:83-98`, `src/corps/economics.ts:46`

### `plan-t4-two-spawn-nearest` (T4) — Two spawns: each source assigned to its nearest spawn, one miner per source

- **Purpose**: nearestSpawn assignment (CorpPlanner.ts:173-182,196) and per-spawn budgets: with two spawns, each source's mine entry must carry the nearest spawn's id, no source gets two mine entries (maxMinersPerSource=1, FlowTypes.ts:377), and no more than one harvester works a source.
- **World**: W14N0, bordered plain room. Bot spawn A (10,25); injected spawn B (40,25). Sources: SA (5,25) [d(A)=5], SB (45,25) [d(B)=5], SC (23,30) [d(A)=13 < d(B)=17]. Controller (25,10).
- **Staged state**: controller {level:7} (RCL7 allows 2 spawns); structures: spawn at (40,25) energy 300 (needs name field — see open questions); 10 extensions prebuilt energy 50.
- **Expected**: Mine entries: SA->spawn-A, SB->spawn-B, SC->spawn-A; exactly one mine entry per source id; after the workforce settles, at most one harvest creep adjacent to each source.
- **Assertion**: By tick 100 economyPlan has exactly 3 'mine' entries with spawnId mapping {SA:spawn-A, SB:spawn-B, SC:spawn-A} (ids resolved from db by position) and no duplicated sourceId; at every sampled tick from 200-250 each source has <= 1 workType 'harvest' creep within 1 tile.
- **Verdict window**: 250 ticks
- **Known bug targeted**: double-staffing / miner pile-up on one source when multiple spawns contend
- **Code refs**: `src/economy/CorpPlanner.ts:173-182`, `src/economy/CorpPlanner.ts:189-243`, `src/flow/FlowTypes.ts:377`, `src/execution/IncrementalAnalysis.ts:466-511`

### `plan-t4-link-haul-pricing` (T4) — Link-served source hauled (and priced) from the core link

- **Purpose**: detectLinkHaulPositions (flowAdapter.ts:92-106) must set haulPos to the core link for a source with its own link, so routeToSinks prices its hauling from the core (CorpPlanner.ts:312) — tiny carry — while an unlinked twin at the same walk distance gets full-distance carry.
- **World**: W16N0, bordered plain room. Spawn (25,25), storage (23,25), core link (22,24) [within 2 of storage], controller (25,10). Linked source (44,44) with source link (43,43) [within 2]; unlinked source (6,44). Both sources ~d 19-26 from spawn.
- **Staged state**: controller {level:5}; structures: storage (energy 0), link (22,24), link (43,43) (links need store schema support — see open questions), 10 extensions energy 50.
- **Expected**: Both sources mined. Haul entries from the linked source are priced from (22,24): carry <= 3 for core-adjacent sinks (e.g. 8 e/t over d=3 -> ceil(1.28)=2); haul entries from the unlinked source carry full distance (e.g. 8 e/t over d≈26 -> ceil(8.6)=9). Consequence: the core link's store receives energy once the miner feeds the source link and runLinks fires.
- **Assertion**: By tick 100 economyPlan: 2 'mine' entries; every 'haul' entry with fromId === `source-${linkedId}` and toId in {spawn-,storage-} has carry <= 3, while >=1 'haul' entry with fromId === `source-${unlinkedId}` has carry >= 8; total carry summed from linked < total from unlinked. By tick 300 the core link db object has store.energy > 0.
- **Verdict window**: 300 ticks
- **Code refs**: `src/economy/flowAdapter.ts:92-106`, `src/economy/CorpPlanner.ts:60-66`, `src/economy/CorpPlanner.ts:309-314`, `src/corps/nodeEnergy.ts:52-72`

### `plan-t5-remote-mined` (T5) — Profitable adjacent-room source gets opened and stays open

- **Purpose**: Full remote pipeline: scout -> intel/territory claim -> reservable-source 3000 valuation (IncrementalAnalysis.ts:571-601) -> net-positive cross-room mine commission -> miner physically works the remote; and the commission does not thrash out of the plan once opened.
- **World**: Home W18N0: bordered, exit gap tiles (0,24),(0,25) plain; spawn (25,25), source (25,40), controller (25,10). Remote W19N0: bordered, gap (49,24),(49,25); source (25,25) [total path ≈60-70 from home spawn, net ≈ +7], unowned controller (25,40). (remoteSource library shape.)
- **Staged state**: controller {level:3}; 10 extensions prebuilt energy 50 (capacity 800 >= 650 unlocks couldReserve 3000 valuation and the reserver).
- **Expected**: A mine entry for the remote source appears and a workType 'harvest' creep stands in W19N0 within the horizon (existing test observed ~tick 600-750); once opened, the remote mine entry persists across consecutive resolves (no 3000<->1500 valuation flapping).
- **Assertion**: By tick 800: economyPlan contains a 'mine' entry with sourceId === `source-${remoteSourceId}` AND a creep with Memory.creeps[name].workType === 'harvest' is located in W19N0 (db room objects); from first appearance, the remote mine entry is present at >= 3 consecutive %50 resolves.
- **Verdict window**: 800 ticks
- **Known bug targeted**: remote valuation collapsing 3000->1500 the moment a miner grants vision, making the planner thrash the remote open/closed (couldReserveLive lift comment, IncrementalAnalysis.ts:576-586)
- **Code refs**: `src/execution/IncrementalAnalysis.ts:571-601`, `src/economy/CorpPlanner.ts:194-199`, `test/integration/scenario/library.ts:323-354`, `src/execution/IncrementalAnalysis.ts:321-393`

### `plan-t5-reserver-dispatch` (T5) — Reserver dispatched once a harvester works the remote (staged)

- **Purpose**: ReservationCorp.targetRooms triggers purely on 'a workType harvest creep stands in an unowned controllered room' (ReservationCorp.ts:71-85) and getSpawnDemand requests one 650-cost CLAIM+MOVE reserver (ReservationCorp.ts:137-171, BodyBuilder.buildReserverBody) — staged with an injected harvester to skip the ~600-tick scout phase.
- **World**: Same two-room shape as plan-t5-remote-mined but rooms W21N0 (home) / W22N0 (remote): home spawn (25,25), home source (25,40), controller (25,10); remote source (25,25), unowned remote controller (25,40); aligned 2-tile border gaps.
- **Staged state**: controller {level:3}; 10 extensions energy 50 (capacity 800 >= reserver 650); injected creep in the REMOTE room at (24,25): body [work x5, move], energy 0, Memory.creeps entry {workType:'harvest', corpId:'staged-remote'} (needs per-creep room support in applyState — see open questions). The creep grants standing vision so refreshNodeResourcesFromCache claims the remote source immediately.
- **Expected**: targetRooms includes the remote room from tick 1; a reserver is queued and spawned quickly; it walks to the remote controller and reserves it; meanwhile the planner commissions the remote source off the injected vision.
- **Assertion**: By tick 150 a creep whose db body contains a 'claim' part exists (spawned by home spawn); by tick 200 economyPlan contains a 'mine' entry for `source-${remoteSourceId}`; by tick 500 the remote controller db object has reservation.user === bot user id.
- **Verdict window**: 500 ticks
- **Code refs**: `src/corps/ReservationCorp.ts:71-85`, `src/corps/ReservationCorp.ts:137-171`, `src/spawn/BodyBuilder.ts:467-479`, `src/execution/IncrementalAnalysis.ts:321-393`

### `plan-t5-sk-never-mined` (T5) — Source Keeper room source is never mined even when nearest

- **Purpose**: SK-room sources must never enter the flow graph (FlowGraph.ts:116, isSourceKeeperRoom FlowGraph.ts:627-640) even when the SK source is the closest, most profitable-looking source available — and the exclusion must be a choice, not inability (the home source still gets mined).
- **World**: Home W3N4 (not SK: x%10=3): bordered, spawn (10,25), west-border exit gap (0,24),(0,25), home source (40,40) [d≈33], controller (25,10). SK room W4N4 (x%10=4,y%10=4): bordered, east gap (49,24),(49,25), source (45,25) [d≈20 from home spawn — CLOSER than the home source], no controller.
- **Staged state**: controller {level:3}; 10 extensions energy 50 (scouts will visit W4N4 within MAX_SCOUT_DISTANCE=5 and record the tempting source in intel).
- **Expected**: At every resolve the plan mines only the home source; no mine entry ever references the SK source; no harvester ever enters W4N4.
- **Assertion**: At every %50 resolve from tick 60 through 450: economyPlan 'mine' entries never include `source-${skSourceId}` and DO include `source-${homeSourceId}` (from its first appearance onward); at no sampled tick is a creep with workType 'harvest' located in W4N4 (db room objects).
- **Verdict window**: 450 ticks
- **Code refs**: `src/flow/FlowGraph.ts:107-138`, `src/flow/FlowGraph.ts:624-640`, `src/execution/IncrementalAnalysis.ts:410-418`, `src/execution/IncrementalAnalysis.ts:447-464`

**Open questions (Planner correctness — source selection, budgets, multi-spawn arbitration, remote economics)**:
- applyState in test/integration/scenario/Scenario.ts:137-158 inserts injected creeps with room hard-coded to the bot's home room — plan-t5-reserver-dispatch needs a per-creep room field (small Scenario extension) to place the staged harvester in the remote room.
- Injected second spawn (plan-t4-two-spawn-nearest): applyState's structure insert (Scenario.ts:114-133) sets no `name` or `spawning:null` field on a spawn doc; the engine keys Game.spawns by name, so the second spawn likely needs a Scenario extension before it is usable/attachable as a spawn sink.
- Scenario.ts structureHits/structureCapacity have no 'link' entry (capacity would be 0), and a storage doc gets user+numeric storeCapacity — plan-t4-link-haul-pricing needs link store schema (storeCapacityResource energy 800, hits 1000) added or the engine may purge/neuter the links; also confirm runLinks fires for injected (non-built) links at RCL5.
- Injected staged harvester has a corpId matching no live corp, so OrphanRescue recycles it after ORPHAN_GRACE_TICKS=25; plan-t5-reserver-dispatch relies on the ReservationCorp demand firing and the real remote commission taking over (via the vision the creep grants) before recycle — if that race is too tight, the cell needs the creep's corpId pointed at a live corp or the grace window widened for the cell.
- Maze cells (plan-t3-*) assume PathFinder in the mockup completes the serpentine within maxOps=4000 and that pathDistance returns real step counts (NodeNavigator.ts:143-160 falls back to the analytic estimate on incomplete paths, which would silently flip the expected verdict); the harness should log/verify the measured path length once per cell, and wall placement must be tuned so measured d lands in the specified bands (>=320 for net-zero exclusion; ~190-215 for the budget subset).
- Terrain analysis over 1-2-tile-wide maze corridors may produce degenerate territories that fail to claim the corridor-end sources (the '.pocket' sim scenario suggests wall-adjacent claiming works, but a long corridor is untested); the maze-end open chamber in plan-t3-budget-subset is a hedge — verify node/territory claiming before trusting a red verdict.
- Multi-spawn arbitration assertion assumes graph spawn-sink ids are `spawn-<gameObjectId>` and economyPlan.spawnId preserves them (verified in code: FlowTypes.ts:509, flowAdapter.ts:169) — but attachOwnedSpawnsToNodes must actually claim the INJECTED spawn (it scans room.find(FIND_MY_SPAWNS)); if the engine does not surface the injected spawn there, the cell is infra-blocked.
- Room-name allocation for the parallel grid must reserve SK-pattern names (both coords %10 in 4-6) exclusively for plan-t5-sk-never-mined — any other cell accidentally placed in an SK-named room will refuse to mine and go red for the wrong reason.
- Verdict timing assumes first solve at Game.time%10 within ~30 ticks of start (analysis converging in a few ticks on a 1-2 room world); on multi-room cells the first full territory pass may take longer — the tick-60/80/100 plan-level deadlines may need one-time calibration against an actual run.
- plan-t2-sink-source-pairing and plan-t4 cells assume the bot does not spontaneously open construction sinks that consume the routed surplus (staged with all RCL-appropriate extensions+containers prebuilt); if ConstructionCorp still places tower/road sites, the upgrade-work thresholds (>=4) are the tolerant floor — verify once and recalibrate rather than assert exact allocations.


---

# Errata — feasibility review corrections

Apply these when building the flagged cells; each was verified against engine
or bot source by the reviewer.


## Infeasible as designed (fixes included)

1. move-worm-chain: confirmed zero production call sites (grep: only Squad.ts:138 definition + wormOrder unit tests). Needs a modified test main.js compiled with a worm driver — that is not the shipping bot. Worse, staged members with corpId 'wormtest' are unclaimed by any live corp, so OrphanRescue flags them orphaned and starts driveRecycle at +25 ticks (OrphanRescue.ts:42,165-183), issuing move intents that fight the worm inside the 45-tick window. Fix: drop the cell; wormOrder is already unit-tested (test/unit/corps/Squad.test.ts:167-186) — add a moveAsWorm unit test with mocked creeps instead.

2. arrive-miner-feeds-source-link: confirmed infeasible as-is — Scenario.ts structureCapacity() (test/integration/scenario/Scenario.ts:199-213) has no 'link' case, so an injected link gets storeCapacityResource {energy:0} and every miner transfer returns ERR_FULL; link store stays 0 forever. Fix (harness): add link:800 to structureCapacity and insert links as owned structures (user, storeCapacityResource) before building this cell.

3. spawn-reserver-started-income / spawn-reserver-yields-to-blocking-miner / spawnexec-reserver-body-multiroom (remote-creep staging): applyState inserts creeps ONLY into scenario.bot.room (Scenario.ts:92-158, `room` param = bot.room; ScenarioCreep has no room field), so the remote-room harvest creep cannot be injected via ScenarioState. Fix: stage() raw db insert into the remote room; and give that creep memory {workType:'harvest'} with NO corpId — OrphanRescue skips no-corpId creeps forever (OrphanRescue.ts:161) so it is never recycled/marched home, while ReservationCorp.targetRooms only checks workType+room (ReservationCorp.ts:71-84), keeping the reserver trigger alive for the whole window. With a live/synthetic corpId the creep gets driven home or recycled at +25 ticks and the demand can evaporate mid-window.

4. Pile/construction-site-dependent cells (arrive-hauler-pile-pickup-range1, arrive-builder-builds-and-refuels-in-place, haul-t2-scavenge-threshold's staged piles, haul-t3-dedicated-resume-groundpile, haul-t3 site staging): ScenarioState supports only controller/structures/creeps/idMap/memory (Scenario.ts:18-37) — no dropped-energy and no constructionSite docs. Only feasible through the architecture's stage() raw-db hook; the engine's acceptance of injected {type:'energy'} and {type:'constructionSite'} docs is unverified and must be probed once before these ~5 cells are built. (Cells that generate piles organically via a CARRY-less miner are fine.)

5. move-border-inward-step (staging, not concept): the engine auto-transfers ANY creep standing on an edge tile at tick end (engine processor/intents/creeps/tick.js:51-77, unconditional isAtEdge -> interRoom), so m1 injected at (49,25) ping-pongs into the EAST neighbour every tick until adoption. The cell leaves that neighbour as an all-plain padNeighborTerrain pad — a REACHABLE pad room violates the architecture's own isolation rule, and moveTo issued from inside it can expand into terrainless rooms and throw 'Could not load terrain data', aborting the bot's entire ErrorMapper-wrapped tick. Fix: make the east neighbour a real border()-sealed ScenarioRoom with only the matching 3-tile gap (remoteSource pattern) and pad ITS neighbours; the adoption-armed assertion then works.

6. Feasibility positives verified (no change needed): downgradeTime IS settable (ScenarioState.controller, Scenario.ts:20,100-111); Memory.spawnDemandFirstSeen can be pre-seeded via state.memory (idMap can remap the embedded spawn id by position) and mid-run backdating works — the mockup re-reads Memory from env each tick and SpawnDirector reads Memory.spawnDemandFirstSeen fresh (SpawnDirector.ts:43); the bot's INIT does NOT clobber injected Memory (initCorps/persistState preserve unknown keys; cleanupDeadCreeps only prunes entries with no live creep, and db-injected creeps exist in Game.creeps from tick 1); source energyCapacity 1500 IS injectable (LayoutObject.attributes merges over DEFAULT_ATTRIBUTES, loadLayout.ts:25-52,91-94); decoy-hauler bootstrap suppression works from tick 1 (BootstrapCorp.ts:147-152 counts workType 'haul' creeps directly).


## Assertions contradicting verified behavior

1. spawnexec-miner-carry-600-boundary asserts a body the pipeline does not produce: the demand prices the desired body at room CAPACITY (600 -> 4W1C2M, 550), but the executor REBUILDS at energyBudget=min(desiredCost,energyAvailable)=550 (SpawnScheduler.ts:270 -> SpawningCorp.ts:132,181), and buildMinerBody(5,550) drops the CARRY because 550 < MINER_CARRY_MIN_CAPACITY=600 (BodyBuilder.ts:61-73). Actual spawn at 600 capacity is 4W2M, zero CARRY; the CARRY first appears when desiredCost itself reaches >=600 (capacity ~700 -> 5W... at 700 the executor gets budget 700 and builds 4W1C2M-equivalent... verified: buildMinerBody(5,700)=5W? no — 650 budget after carry gives 5W3M=650 +C =700, i.e. 5W1C3M at capacity 700). Either restage at capacity 700 asserting the CARRY appears there, or keep 600 and pin the no-CARRY-at-600 executor/demand mismatch as a known wart — as written the cell fails against correct-per-code behavior.

2. move-scout-border-crossing asserts interior penetration ScoutCorp never performs: intel is recorded the first tick the scout's room name equals targetRoom — i.e. while standing on the ENTRY EDGE tile (ScoutCorp.ts:158-177); it then retargets, and in a sealed 2-room world findStaleRoomExcluding returns nothing fresh so targetRoom=homeRoom and it immediately walks back. Once home with no target it idles ON the exit tile and the engine edge-shunt bounces it into W1N0 again — an infinite ping-pong (a real latent bot bug, but not the asserted behavior). 'Stands at an interior tile', 'does not re-enter W0N0 for 15 ticks', and 'range to (25,25,W1N0) decreases over 10 ticks' all fail by design. Redesign: assert intel recorded for the east room + scout returns home; use a 3-room chain if you want sustained interior progress; separately pin the idle-scout-parks-on-exit-tile ping-pong as its own finding.

3. Movement cells hardcode the WRONG harvest-spot tiles: bestAdjacentTile keeps the FIRST tile at minimal spawn-distance in dx/dy=-1..1 iteration order (strict '<', nodeEnergy.ts:115-127), so ties resolve to the smallest (x,y)-ish corner, not the straight-line tile. move-reach-harvest-spot expects (29,25) but code seats (29,24); move-miner-congestion-open expects (25,39) -> actually (24,39); move-choke-corridor expects (9,25) -> (9,24); move-border-inward-step expects (43,25) -> (43,24); move-pickup-range-close seats its miner on (25,44) but the resolved spot is (24,44), so the adopted miner relocates one tile and splits the pile under the range-1 assertion. Fix: compute expected tiles by importing sourceHarvestSpot/bestAdjacentTile in the cell builder (exactly what the arrival avenue already does).

4. spawnexec-hauler-carry-route-distance NEAR-corp bracket is wrong: the decoy hauler occupies a fleet slot, so NEAR's demand takes the runt-HEAL branch (current >= targetHaulers -> desiredCarry = maxCarryPerHauler = 8 at 800, CarryCorp.ts:863-871), not the even split (~4). A flush tick spawns a NEAR hauler with up to 8 CARRY, breaking 'NEAR CARRY in [3,5]' and possibly 'FAR > NEAR'. Fix: assert only FAR-first ordering + FAR CARRY in [6,9], or make the decoy non-adoptable (workType 'haul', NO corpId, assignedSourceId of a nonexistent source) so it suppresses bootstrap without joining NEAR's fleet.

5. haul-t2-no-divert-above-half asserts 'spawn store never exceeds 200' — the ENGINE violates it: spawns self-regenerate +1 energy/tick whenever room energyAvailable < 300 (verified @screeps/engine processor/intents/spawns/tick.js:44-46), so the store climbs 201,202,... with a perfectly-behaved bot. Fix: assert deliverSinkId==='controller' + controller container >=250 + no single-tick spawn-store jump >=50 (a hauler transfer signature) instead of an absolute ceiling.

6. move-swamp-detour asserts a detour moveTo will not take: with moveTo defaults (plain 2 / swamp 10), wading the 3-row band costs +3*8=24 vs the x=18..19 gap detour of ~14 extra tiles = +28 — the pathfinder correctly WADES and 'never stands on a swamp tile' fails. Fix the geometry: widen the band to >=4-5 rows (4*8=32 > 28) or move the gap within ~5 columns of the corridor, and recompute both costs in the cell builder.

7. move-choke-corridor 'no position identical >10 consecutive ticks' false-fails on legitimate behavior: h1 (100 capacity) waits stationary at the pile while the 2-WORK miner trickles 4/tick — ~25 ticks of correct standing-still collecting partial pickups (the bus fills completely before departing, CarryCorp.ts:320-329). Add an exception for h1 within range 1 of the pile/pickup spot (and for pre-adoption idling).

8. Minor label/expectation nits: spawn-93's 'known_bug #93' actually corresponds to the unnumbered STARTED>>URGENT monopoly comment (SpawnScheduler.ts:144-152); commit #93 is the starved-builder fix covered by spawn-starved-builder-one-shot. move-miner-congestion-open's expected text says the adjacent second miner 'spreads', but minerApproach returns 'stay' when adjacentToSource && spotHeldByOther (HarvestCorp.ts:46-50) — the assertion outcome (one on spot, one at range 1, 8/tick drain) still holds, but fix the prose so a failure is diagnosed correctly.


## Verdict-window corrections

1. Arrival avenue windows (30-45 ticks) are the tightest in the catalog and hang on an unmeasured 'T0 <= 20' cold-adoption estimate (analysis -> %10 bootstrap solve gate at main.ts:276-280 -> next-tick materialization -> OrphanRescue flip). Movement avenue budgets ~50 ticks for the same event. Run one calibration probe per terrain family first; until measured, set arrival windows to >=60 and keep the T0-armed clocks (assert T0 <= 25, fail as ERROR not FAIL if adoption never happens).

2. spawn-first-miner-outranks-all (window 80): with no decoy, BootstrapCorp spawns a jack immediately (BootstrapCorp.ts:151-152) and drains the initial 300; the flow miner then waits on jack deliveries plus the spawn's 1/tick self-regen. 80 is tight — widen to ~120, or the 'eventually a ^miner- appears' clause times out on slow jack round-trips.

3. spawn-blocking-hauler-spawns-at-min-scaled (window 15): fails whenever the spawn is mid-spawn at stage time (RCL4 income bodies are 20-26 parts = 60-78 busy ticks). The harness must stage on spawn-idle (wait for spawning==null before deleting haulers/setting stores), or the window needs +80.

4. haul-t2-scavenge-threshold (window 150): promotion waits for the next %50 economy rebuild (up to 50t) + scavenger spawn (~12-18t + queue) + ~20-tile walk + multiple trips (scavengeRate(900)=6 e/t sizes a small ~3-4 CARRY body moving ~150-200/trip) before the pile can hit <=550. Expect ~165-220 ticks worst case — widen to 250-300, or relax the drain clause to 'any single-tick drop >=100 at (40,40)'.

5. spawn-93 (window 40): OK only because warm-twoSourceRcl3Full stages exactly 800 energy (spawn 300 + 10x50 extensions, verified in the fixture JSON) and B's regrow minCost is the full 700 (colonyHasMiner kills the runt floor, HarvestCorp.ts:400-402). Any pre-stage drain (in-flight spawn, tender) makes 40 too short — add a stage-time energy>=700 precondition or widen to 80.

6. Movement avenue rationale fix: windows cite '~50 ticks adoption warm-up (FLOW_RESOLVE_INTERVAL=50)' but the cold-start gate is economyNeedsBootstrap at Game.time % 10 (main.ts:276-280) after analysis — warm-up is analysis+<=10, not 50. Keep the 70-95 windows (slack covers unmeasured analysis) but correct the model so future window tuning doesn't anchor on the wrong cadence.

7. Ring cells (move-bypass-ring-*, arrive-hauler-escapes-upgrader-ring): staged upgraders hold 50 energy = ~50 ticks of 1-WORK fuel, which runs dry right at the ~50-tick adoption boundary; isYielding needs no energy (movement.ts:71-84) so swaps still pass, but any 'controller progress rises' side-clause needs energy >=150 staged or should be dropped.

8. Always-mode assertions need adoption grace: move-miner-congestion-open 'at no point do both idle at range >=2' and move-upgrader-park-settle 'neither ever ends a tick on the input tile' both false-fail pre-adoption / in transit (the path to a far-side parking tile can legitimately cross the input tile). Arm always-assertions at T0 (+ a few ticks for park-settle transit), matching the GridCell graceTicks facility the architecture already defines.

9. haul-t0-first-delivery (window 300) is the lone T0 riding the [151-350] batch band; flow-handoff-style geometry completes the first refill by ~120-150 — trim to ~200 so tier-0 smoke worlds stay short.


## Coverage gaps — cells to add

1. OrphanRescue itself (#92, commit 67d28fe) has no dedicated cell despite EVERY staged cell depending on it: nothing asserts (a) readopt flips corpId within the grace window, (b) a corpId-bearing creep with no matching work is walked to the spawn and recycled after ORPHAN_GRACE_TICKS=25 (the 'creeps standing around until they die' freeze), (c) no-corpId creeps are never touched (OrphanRescue.ts:161). A T1 cell here doubles as the canary for the staging mechanism of ~30 other cells — build it first.

2. Miner 2x2 over-split wart (docs/TESTING_THE_ECONOMY.md:72; pinned in test/unit/corps/runtRecycling.test.ts:32): pickRuntToRecycle returns null once total work >= needed (recycle.ts:36), so a cold-start [2W,2W] fleet never consolidates to one 5W even at 800+ capacity. No grid cell pins this current-behavior wart; a T3 spawnexec cell would make a future consolidation fix a visible baseline diff.

3. Hauler even-split (#63, CarryCorp.ts:852-867 — the [2,2]-not-[3,1] fleet shape): no cell asserts the split across a multi-hauler fleet; spawnexec-hauler-carry-route-distance only brackets single first-haulers.

4. isYielding negative space: no cell asserts a NON-yielding blocker is NOT swapped through (movement.ts:66-84 deliberately excludes miners-on-spot and off-spot creeps) — a hauler must path AROUND a seated miner, never yank it off its source. Cheap variant of the ring cells.

5. travelTo pass-through case: movement.ts:50-54 only forces the inward step when the exit tile belongs to the TARGET's room; no cell asserts normal moveTo border-crossing while traversing an intermediate room (regression here would strand every remote route, and both border cells as designed exercise only the target-room edge).

6. Tender-regime divert asymmetry (CarryCorp.ts:596-614): spawnNetworkHungry diverts a controller hauler when the depot is below DEPOT_BUFFER=150 but must STOP diverting once the buffer is met; neither tender cell pins the controller-starve regression this guards.

7. Scavenger stand-down: only promotion (>=750) is covered; nothing asserts the drained-stock path (scavengeSpot null -> carry home -> corp demobilizes at the next rebuild, scavenge.ts:11-14) — the leak mode is a zombie scavenger corp.

8. Anti-downgrade / #59 supply-before-demand observable: while upgraders are gated on roomHasHauler (UpgradingCorp.ts:332-344), only BootstrapCorp.runAntiDowngrade keeps the controller alive; no cell asserts controller.downgradeTime never regresses during the gated phase — cheap rider assertion on spawn-no-hauler-before-miner.

9. CarryCorp circuit reassignment: committedSinkHasFlow -> re-assignCircuit when a controller route's flow vanishes (CarryCorp.ts:634-660) is uncovered — the failure mode is a hauler forever bussing a dead circuit.


## Tier notes

1. Tier population as delivered: spawn-scheduler and spawn-exec cover T0-T5 fully; arrival covers T0-T4 with T5 deliberately omitted (rationale verified: remote corps carry intel-ROOM-X-Y source ids while OrphanRescue readopt matches getSourceId()===source.id, OrphanRescue.ts:102-113 — genuinely un-stageable without snapshot Memory); movement covers T0/T1/T2/T3/T5 but has NO T4 (candidate: multi-creep traffic at RCL4 body sizes through the choke, or a loaded-vs-empty fatigue case); hauling as shown covers T0-T4 with no T5 (the input truncates mid haul-t4-tender-death-failsafe — if no T5 exists, a remote-source haul route is the natural fill).

2. move-worm-chain is mis-tiered at T2: a feature with zero production call sites is not an inflection point of the shipping bot at any tier — demote to unit tests and free the slot (see infeasible).

3. arrive-miner-on-spot-harvests as the T0 flagship is well-placed: the zombie-miner signature is the documented flake (docs/specs/00-corp-framework.md:248, 01-rcl5-cold-start-stall.md:37,78) and the corpVariance corroboration channel (main.ts:208-210) is real.

4. haul-t0-first-delivery is the only T0 with a 300-tick window — semantically fine as an existence proof, but it forces tier-0 smoke runs into the long batch band (see window_fixes).

5. spawn-93-fresh-miner-beats-scaling-hauler at T2 is the scheduler avenue's highest-leverage regression cell (the tiering comment it guards, SpawnScheduler.ts:144-157, is the load-bearing design decision) — correctly tiered, just fix the #93 label (see wrong_behavior).

6. The reserver pair (T5) is correctly the deepest tier: it requires two rooms, remote staging, AND the collectDemands forced-grouping (SpawnDirector.ts:197-222 verified: groupId=c.id, groupStarted=true, so 1,001,092 vs blocking miner 1,010,100 — the yields-to-blocking-miner ordering the cell asserts is exactly what the code computes).
