# extension-sim — the refill mini-game

Owner-directed sandbox (2026-07-22): a table-top mockup of the Screeps
spawn/extension/tender loop, engine-faithful on the rules the refill
question hinges on (each verified against the vendored `@screeps/engine`
before the sim encoded it — see `test/unit/sim/extensionSim.test.ts`):
3t/part spawning charged at start, extension caps {6:50, 7:100, 8:200},
default draw order = distance-from-the-spawn, `energyStructures` drains
verbatim, transfer+withdraw+move stack in one tick, fatigue =
weight×terrain vs 2/MOVE.

Run: `npx ts-node -P tsconfig.test.json scripts/extension-sim/run.ts`

Synthetic load: a max-size body the moment any spawn is free, forever.
Arms: layouts (organic scatter / spine corridors / 6-pack flowers) ×
draw orders (engine-default / near-reload-first / far-first) × tender
policy (greedy-nearest / lane-patrol) × fleet (1–2 × 16C16M), at
RCL 6/7/8 presets (1/2/3 spawns), 5000t.

## Findings (2026-07-22 sweep)

1. **RCL6 cannot lose.** Every layout × strategy × 1 tender holds spawn
   utilization 1.000, wait 0t. The full-drain body (2300 = whole room)
   gives a 138t rebuild window against a 73–101t refill — the owner's
   "bigger creeps take longer to spawn, so refill always keeps up" holds
   everywhere at this tier. Draw order is a NO-OP at RCL6: every charge
   drains everything, so ordering has nothing to order.
2. **Draw order becomes the decisive cheap lever at RCL7+, dominant at
   RCL8 with a small fleet.** Partial drains give ordering meaning:
   near-reload-first cut mean refill latency ~30–46% at RCL7 (spine
   501t → 272t), and at RCL8 ×1-tender it flipped rooms from
   never-fully-refilled (endFill 0.64–0.90, engine-default) to always
   topped (endFill 1.000). Mechanism: 200-cap extensions mean a tender
   load covers only 4 of them — default order drains the far-from-reload
   set (long trips), near-reload keeps the drained set a short loop.
3. **Compactness beats lane elegance.** Organic scatter (a tight blob by
   the spawn+storage) beat the long spine corridor on refill latency at
   every tier — total trip length is what matters, not drive-by
   geometry. The layout goal is "dense and near the reload point", not
   "a beautiful lane".
4. **Fixed-circuit patrol is dominated.** lane-patrol lost to
   greedy-nearest in every arm and collapses at RCL8 ×1 (util 0.65,
   5331 wait-ticks) — demand-driven targeting wins outright.
5. **A second tender washes out everything** — util 1.000 and endFill
   1.000 across the board. Over-provisioning substitutes for cleverness;
   our live fleet of 3 at RCL6 is deep in the can't-lose regime, which
   matches live endFill 0.915 with zero energy-blocked spawns.

Caveats: no creep-collision traffic, single room, the sim's endFill is
room-total at build-finish (analogous, not identical, to the live
meter), and the organic arm's compactness is generator-specific.

Live implications: adopt `energyStructures` near-reload ordering when we
next touch the spawn path (free now, decisive at RCL7+); judge extension
placement by summed trip distance to the reload point; skip fixed patrol
circuits for tenders.
