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
4. **Fixed-circuit patrol is dominated** — REVISED 2026-07-22 (owner:
   "I don't see how circuit patrol could lose ... think of it like a
   little automaton"): the original loss was TWO experiment bugs, not
   the concept. (a) The drain order was decoupled from the circuit;
   aligning them (`drawOrder: "circuit"` — structures rank by the first
   circuit tile they touch) makes the drained frontier march along the
   circuit. (b) The patrol cursor never reset after reloading; since the
   drain is head-first, the frontier is contiguous from the circuit head
   and the sweep must restart there each load (stale cursor = the
   elevator problem, measured util 0.87). With both fixed (see
   `automaton.ts`): the automaton TIES greedy at RCL6, and WINS with
   heavy bodies on dense corridors — rcl7 spine 2:1 102t vs greedy
   116t; rcl7 spine 4:1 105t where greedy-4:1 collapses to 248t;
   rcl8 spine 4:1 123t vs 171t. Greedy still wins for 1:1 bodies and on
   sparse pack geometry.
5. **1:1 tender bodies are overkill in dense geometry** (owner-called):
   fatigue recovers while STANDING to transfer, and a corridor holds 2
   extensions per lane tile at 1 transfer/tick — so a 2:1 body's
   move-rest rhythm synchronizes with the geometry. Measured: rcl6
   spine greedy 2:1 refills in 71t vs 89t for 1:1, on a cheaper body.
   Under the 50-part cap, shed MOVE buys CARRY (25C25M=1250 but
   33C17M=1650, 40C10M=2000): 2:1 is the general sweet spot; 4:1 only
   pays on a dense corridor driven by the circuit automaton. Matching
   rule: the body's rest ticks must fit inside the geometry's standing
   ticks — flower packs 4 tiles apart cap out at 2:1.
6. **A second tender washes out everything** — util 1.000 and endFill
   1.000 across the board. Over-provisioning substitutes for cleverness;
   our live fleet of 3 at RCL6 is deep in the can't-lose regime, which
   matches live endFill 0.915 with zero energy-blocked spawns.
7. **Evolved layouts** (`evolve.ts`, (mu+lambda) hill-climb over
   extension AND spawn positions, refill-only fitness): dense blobs
   hugging the storage beat every hand seed — rcl6 73→65t, rcl7
   114→77t (16C16M) / →72t (25C25M), rcl8 110→72t (16C16M) / →63t
   (25C25M). Spawn positions barely matter under near-reload draw (far
   structures drain last, so they rarely empty) — real spawn placement
   should be decided by creep-delivery paths, not refill.

Caveats: no creep-collision traffic, single room, the sim's endFill is
room-total at build-finish (analogous, not identical, to the live
meter), and the organic arm's compactness is generator-specific.

Live implications: adopt `energyStructures` near-reload ordering when we
next touch the spawn path (free now, decisive at RCL7+); judge extension
placement by summed trip distance to the reload point; skip fixed patrol
circuits for tenders.
