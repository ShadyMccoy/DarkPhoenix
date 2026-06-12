# 01 — RCL5 cold-start stall

**Status:** OPEN. Blocks spec 02 (link logistics verification).
**Priority:** P0 — this is either a live regression or a latent scheduler bug.

## Symptom

An RCL5 test world (walled two-chamber room, 30 pre-filled extensions, container
depot pre-placed, free-economy mod) plateaus at **1 miner + 2 haulers** by tick
~200 and never spawns another creep for 1300+ ticks. No upgraders, builders, or
tenders; the storage construction site sits at progress 0 forever. No errors in
the console — planning runs every 50 ticks and the loop is healthy.

Reproduce: `npm run build && npx ts-node -P tsconfig.test.json scripts/diag-storage.ts --rcl5`

The identical world at RCL4 (20 extensions, capacity 1300) stands up a full
economy — miners, haulers, upgrader, builder + tankers — and builds its storage
by tick ~370. The stall is specific to something in the RCL5 configuration.

## Suspects, in order

1. **The miner CARRY change** (`buildMinerBody`, spec 02 groundwork): the RCL5
   probe was the *first run ever* with that change in the bundle; the green
   RCL4 run predates it. Bisect first: revert the `addCarry` block locally,
   rebuild, re-run the probe. If the stall clears, the CARRY change breaks
   something in the spawn path (likely a body-cost pin or the scheduler's
   affordability math seeing cost 700 where logic expects 650).
2. **Scheduler wait-for-blocking at high capacity.** At capacity 1800 a
   blocking demand's desired body can cost up to 1800 (haulers cap at
   `floor(capacity/100)` CARRY). If the scheduler holds for a blocking demand
   affordable only at full capacity, and the room can't refill to full (the
   drained extensions refill slowly with 1 hauler), everything behind it
   starves. The pinned behavior "waits for an unaffordable blocking demand
   when income is flowing" (test/unit/spawn/nextSpawn.test.ts) may simply not
   terminate at this scale.
3. **Pre-existing RCL5-config issue** (30 extensions / capacity 1800 itself).
   Test by running the *pre-groundwork* commit's bundle at RCL5.

Instrumentation that already exists: the diag probe can `player.console(...)`
arbitrary expressions (`energyAvailable`, `Memory.economyPlan.corps`,
`Memory.corpVariance`) — see the probe's `t === 100` block.

## Acceptance tests (write these FIRST; the fix is done when they pass)

### Integration: `test/integration/rcl5-economy.test.ts`

World: the storage-depot test's layout (two-chamber wall at x=25, gap y=23..27;
spawn 12,25; sources 10,10 and 40,40; controller 38,25; container depot 13,25)
at **level 5** with the full 30-extension set, `filled = true`, free-economy mod.

```
describe("RCL5 cold start stands up a full economy", () => {
  it("fields consumers and builds its storage", ...);
});
```

Tight pass criteria — ALL of the following, sampled from room objects + creep
memory (`workType`), within **1000 ticks**:

1. ≥ 2 creeps with `workType === "harvest"` alive at the same tick
   (both sources staffed).
2. ≥ 1 creep with `workType === "upgrade"` alive.
3. ≥ 1 creep with `workType === "build"` alive.
4. A `storage` room object exists (the site was placed AND built).
5. At every sampled tick after 300: the spawn is not deadlocked — assert that
   between consecutive samples (every 50 ticks) either a creep count changed
   or `energyAvailable` changed. (Guards against the silent
   nothing-spawns-for-1300-ticks failure mode specifically.)

### Unit: pin whatever root cause falls out

When the diagnosis lands, add a unit test at the decision seam that failed —
e.g. if it's the scheduler hold, a `nextSpawn.test.ts` case shaped like:
"does NOT hold forever for a blocking demand whose desired cost equals full
capacity while affordable smaller demands exist" with an exact expected spawn.
The unit pin is part of acceptance: the integration test alone is too slow to
guard this regression class.

### Regression gate

`npm run test-unit` (400), `flow-handoff`, `runt-economy`, `storage-depot` all
green with the fix in the bundle.

## Out of scope

Making RCL5 cold starts *fast* — only un-stalling them. Tuning belongs with
spec 02's measurements.
