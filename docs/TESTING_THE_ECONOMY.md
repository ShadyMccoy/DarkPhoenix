# Testing & Tuning the Economy

How we test the flow economy, how we measure whether a change actually helps, and
the hard-won learnings behind the current model. Pair this with
`ECONOMIC_FRAMEWORK.md` (the model itself).

## Environment setup FIRST (sandboxes / fresh clones)

Before trusting ANY grid or integration result on a fresh clone or sandbox, run:

```
npm run setup:test-env    # idempotent; builds what `npm install` may have skipped
npm run probe:mockup      # 30s smoke check: exit 0 = bot scripts actually execute
```

**The trap this avoids (measured, 2026-07-26 — it cost most of a session):**
`npm install` builds two native modules and one webpack bundle via install
scripts. In sandboxes the `isolated-vm` native build often fails under parallel
make, rolling back the whole install; the standard workaround
(`npm install --ignore-scripts`) then silently skips
`@screeps/driver/build/runtime.bundle.js`. Without that bundle **every mockup
bot dies at script load** — and invisibly, because `screeps-server-mockup`'s
console parser drops the `error` field of console events. The signature:

- the server ticks fine, cells/tests run to their windows,
- every bot produces **zero** console output (no `[Spawning]`, no `[Init]`),
- every economy assertion times out ("no site placed", "no miner producing"),
- the runner log (`server/*/logs/engine_runner.log`) shows a clean start and
  nothing else.

That signature means **broken environment, not broken bot**. Do not triage
cells, lower baselines, or blame host load until `npm run probe:mockup` passes —
it subscribes to the raw console channel and PRINTS the swallowed script-load
error. `scripts/setup-test-env.sh` documents and rebuilds all three artifacts
(isolated-vm, the driver's native addon, the runtime bundle).

**A GREEN probe does not mean the grid baseline reproduces** (measured
2026-08-05, spec 46; ~1h). With `setup:test-env` + `probe:mockup` both clean
and the unit suite and all three regression integration tests green, a full
`npm run grid` still reported `bot level dropped: 4 -> 0` with 21
baseline-green cells regressed — mostly `timeout`, spanning avenues the
change under test could not touch. Re-running the regressed subset ALONE
(11 cells, no batch load) reproduced 9 of them, so it was not merely a
full-run bucket drain.

The decisive move is the BASE COMPARISON, and it is cheap:

```
git checkout HEAD~1 -- src/ && npm run build      # base bot, same sandbox
npx ts-node -P tsconfig.test.json scripts/grid.ts --cell <the,regressed,ids>
git checkout HEAD -- src/ && npm run build        # restore
```

The base commit failed the SAME 9 cells with the SAME assertions and the same
`BOT LEVEL: -1` — the sandbox's own timing/CPU, not the diff. A grid verdict
is only evidence about a change when the base scores differently in the same
sandbox; a raw red run here is unattributed. **Never ratchet the baseline
DOWN to make such a run pass** — the baseline is the success metric, and a
cell red only in this sandbox has earned nothing. Prefer targeted cells that
actually exercise the change (they run in ~40s each and were green
throughout), and report the full-grid result as unattributable rather than as
a regression or a pass.

Two more sandbox facts, hard-won the same session:

- **Staged containers decay 5,000 hits on tick 1** (no `nextDecayTime` staged),
  dropping below the 99% repair ceiling — the repair detail then claims a
  staged room's ONLY builder and freezes the build under test. Cells that
  stage a container near a builder should freeze decay in `stage()`:
  `db["rooms.objects"].update({room, type: "container"}, {$set: {nextDecayTime: gameTime + 10000}})`.
- The mockup db's `update()` applies to **all** matching docs (LokiJS), but
  `$set` with dotted paths silently no-ops — write whole objects (see the
  CLAUDE.md trap list).

## The test toolkit

The economy is an emergent result of many pieces talking to each other, so we test
it at three altitudes — each cheap, each pinning a different seam.

### 1. Fleet harnesses (unit, ~10ms) — *what does the pipeline build?*

`test/unit/harness/` drives the REAL spawn pipeline (corp `getSpawnDemand` →
`collectDemands` → `scheduleSpawn` → `SpawningCorp.executeSpawn`) and reports the
fleet it produces. No re-implementation: whatever they print is what the live
colony builds for the same inputs.

- `spawnHarness.ts` → `simulateMinerFleet` — miner WORK sizing / cold-start splits.
- `haulerHarness.ts` → `simulateHaulerFleet` — hauler CARRY sizing, even-splits, ratios.
- `upgraderHarness.ts` → `simulateUpgraderFleet` — upgrader count/size, the #59 gate,
  the #62 build rebalance.

The fake spawn returns a room (`find(FIND_MY_CREEPS)`, `memory`) so room-aware corp
logic (the upgrader's delivery-loop gate, the hauler's `yieldsToBuild`) runs for
real — the bug we found earlier was tests passing for the *wrong* reason because
`Game.getObjectById` returned null and that logic was silently skipped.

### 2. Decision moments (unit, ~10ms) — *what spawns NEXT?*

`test/unit/spawn/nextSpawn.test.ts` + `harness/spawnDecision.ts` freeze single
economic moments and assert the one creep the director would spawn next (miner
before upgrader, hold-for-blocking, fund-one-corp-fully, the supply-before-demand
gate, …). Bugs hide in the *seams* between demand generation and scheduling, which
a pure-scheduler test (synthetic demands) structurally can't reach.

### 3. Integration probes (server, minutes) — *does it work end to end?*

`test/integration/` runs the compiled bot on the real engine: `flow-handoff`
(bootstrap→flow), `scenario-economy` (every source mined+hauled across geometries),
`runt-economy` (runts get upsized). **Always use non-degenerate terrain** — an
all-plain room produces zero nodes (degenerate peak detection) and the flow
economy can't plan; use the walled two-chamber layout.

**Avoid the mockup's 9-room `stubWorld` for colony sims.** It is degenerate in the
*other* direction: it exposes all nine rooms at once (~102 nodes), which a real bot
never sees at RCL1 (you start with vision of only your home room), and a
from-scratch colony **stalls** there — one jack, zero controller progress forever
(`scripts/diag-stub` reproduces it; `--paid` rules out free-economy; `diag-stubroom`
shows the *same* `W0N1` as a lone room bootstraps to RCL2 fine, with ~29 nodes). Use
a single real-terrain room. (This is why `sim:variance` was reading variance −1 for
every corp — the colony couldn't start; it now runs one room.) There is a latent
robustness question — should the bootstrap survive a many-node world (a mature
colony re-bootstrapping after a wipe)? — but it does not occur in normal play.

**Run integration tests one file at a time, not as a back-to-back suite.** The
mockup's storage subprocess does not always clean up between sequential
`ScreepsServer` instances, so a later test's colony can malfunction (e.g. the
flow-handoff probe fails *in the full suite* but passes run alone, where the
hand-off is clearly fine — mining 4/10, hauling 6/10 by tick 500). This is test
infrastructure flakiness, not a colony bug. If servers pile up, `rm -rf server/`
and `pkill -f '@screeps/(storage|engine)'` between runs.

### Two practices that keep these honest

- **Mutation verification.** A guard is only real if it bites. After writing a
  regression test, reintroduce the bug and confirm *exactly that* test fails (e.g.
  removing the `colonyHasMiner` fix, or the #59 gate, fails only its test).
- **Pin current behavior, even when imperfect.** Freeze what the code does today so
  a later fix shows up as a reviewable diff. The hauler runt-tail was pinned as
  `[3,1]`; when #63 even-split it, the test *updated* to `[2,2]` — the diff *is* the
  improvement. (The miner 2×2 over-split is still pinned as a known wart.)

## Measuring "is it better?" — the A/B harness

`scripts/ab-cold-start.ts` (`npm run sim:ab`) stands up the same cold-start colony
on the real engine (no free-economy mod, so growth is real) and reports cumulative
control points. The bot under test is whatever `dist/main.js` is, so the *same*
harness measures any commit: build at A → run; build at B → run; compare. The delta
is the bot's behavior change alone.

`scripts/effective-energy.ts` (`npm run sim:energy`) is the static model: net
e/tick after TTL-adjusted miner+hauler overhead, total body parts, spawn-time load,
the spawn-part energy penalty, and the reserve-or-not crossover.

### The headline measurement

Pre-batch baseline (`4c42e87`) vs the full current stack, same scenario, 3500 ticks:

| tick | OLD | NEW |
|------|-----|-----|
| 1500 | 3365 | 2237 |
| 2250 | 6597 | 6884 |
| 3500 | **10185** | **19164** |

**~2× the long-run output, and diverging** (final rate 9.8 vs 2.95 cp/tick).

## Key learnings

**Economic**
- The **hauler dominates** remote-mining cost, not the miner; cost grows ~linearly
  with distance while yield is flat.
- A spawn has **two budgets**: energy *and* build-time (1 part / 3 ticks = 500 parts
  per 1500-tick life). Build-time is often the *tighter* wall.
- **Travel TTL**: a static miner walks out and dies at the source, mining only
  `1500 − d` ticks — amortize its cost (and a reserver's) over the shortened life.
- **Reserver** is a per-room cost: CLAIM creeps live only 600 ticks, but reservation
  accumulates so a reserver runs at ~50% duty, and two sources share one reserver —
  so the toll is much smaller than it first looks.
- The "too far to mine" distance should **fall out of contention** (sources
  competing for a spawn's build-time budget), not a hard limit. An idle spawn
  reaches far; a saturated one pulls in.

**Behavioral / measurement**
- **Invest vs consume.** A heavier, better-balanced production base costs early-game
  speed (slower to first upgrade) but roughly doubles long-run output. For a 24/7
  colony, the one-time early tax is noise.
- **Stalls hide in delivery.** The old colony *plateaued* after ~tick 2000 because a
  hauling route collapsed (`hauling 1.33/10`) and mined energy stopped reaching the
  controller. Watch per-route hauling actuals, not just mining.
- The flow economy needs **non-degenerate terrain** to plan at all.
