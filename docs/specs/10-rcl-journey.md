# Spec 10 — The RCL Journey as Core Moments

Owner directive (2026-07-09): list every step on the road to higher RCL; each
step is tested as a SHORT, STAGED core moment (the spec-08 grid style), not a
long organic sim. Spawn dependencies and priorities are driven by the
flow/economy planning stack, and expected-vs-actual is monitored continuously
(the plan-fidelity avenue). This doc is the map: step -> mechanism -> cell(s)
-> gaps. Keep it current when cells land or mechanisms move.

Legend: [cell-id] = existing grid cell. GAP = no cell yet (tracked at the
bottom). Windows are short by design; anything > ~400t needs a justification
in the cell comment.

## Phase 0 — Cold start (RCL1)

| # | Step | Mechanism | Cells |
|---|------|-----------|-------|
| 1 | Jacks spawn immediately, cap 2, no haulers yet | BootstrapCorp (direct spawn, ahead of scheduler) | churn-jack-immediate-no-haulers, churn-jack-cap-two, churn-jack-starvation-timer |
| 2 | Jack trickle reaches RCL2 on real terrain | bootstrap economy | boot-real-open-w11n5, boot-real-plain-w2n6, boot-real-maze-w1n6 |

## Phase 1 — Handover (the RCL2 gate opens)

| # | Step | Mechanism | Cells |
|---|------|-----------|-------|
| 3 | Solver publishes the first plan (mine + haul corps) | planColony -> Memory.economyPlan | plan-t0-single-source-commissioned |
| 4 | First flow miner outranks everything; right body at 300 | spawnPriority income+blocking tier; buildMinerBody | spawn-first-miner-outranks-all, spawnexec-first-miner-stamp-300 |
| 5 | DEPENDENCY: no hauler before its miner; hold the spawn for the blocking first hauler | withMinerPrecedence; holdStrict | spawn-no-hauler-before-miner, spawn-hold-strict-first-hauler, spawnexec-first-hauler-group-prefix |
| 6 | Jacks stand down once flow is established | BootstrapCorp standdown | churn-jack-standdown-flow-established, churn-jack-no-standdown-haulers-only |
| 7 | First delivery closes the loop | CarryCorp circuits | haul-t0-first-delivery, haul-t1-circuit-split |
| 8 | DEPENDENCY: upgraders gated on a live hauler (supply before demand) | UpgradingCorp.roomHasHauler | GAP G5 (implicit in plan-t1-single-source-loop only) |
| 9 | Replacements are DELIVERED, not reactive: successor starts spawnTime + walk early | staffsPost/deliveryLeadTime (primitives); Harvest/Carry/Upgrading staffing counts | churn-t3-gapless-replacement; unit: primitives.test.ts |

## Phase 2 — RCL2→3 build-out

| # | Step | Mechanism | Cells |
|---|------|-----------|-------|
| 10 | Extension sites: checkerboard, one at a time, before ctrl container | ConstructionCorp ladder | cons-ext-first-site-checkerboard, cons-one-site-at-a-time, cons-ext-before-ctrl-container |
| 11 | Source containers sited on the pile / pocket-exact | ConstructionCorp; sourceHarvestSpot | cons-src-container-on-pile, cons-depot-when-pile-thin, cons-pocket-container-exact-tile, arrive-miner-converges-to-container |
| 12 | Container sites get FINISHED (energy funded, builder staffed, swap to structure) | ConstructionCorp + tankers | GAP G1a |
| 13 | Controller container last | ladder ordering | cons-ctrl-container-last |
| 14 | Controller reserve floor survives build pressure | reserve pre-pass | plan-t2-antidowngrade-construction, churn-antidowngrade-dispatch, churn-antidowngrade-recover-recycle |
| 15 | Roads pay for themselves: paving rung, 2:1 bodies on receipt, fraction repair | roadEconomics | cons-road-route-paved, spawnexec-road-hauler-2to1, cons-repair-road-fraction, cons-repair-starts-below-60, cons-repair-stops-at-99 |

## Phase 3 — RCL3→4 (capacity rungs, storage)

| # | Step | Mechanism | Cells |
|---|------|-----------|-------|
| 16 | Bodies scale at capacity rungs; runts healed by pounce-recycle | BodyBuilder; flagRunt* | spawnexec-miner-body-550, spawnexec-miner-carry-700-boundary, spawnexec-bodies-at-1300-rcl4, spawnexec-miner-runt-recycle-affordable, spawnexec-hauler-runt-recycle-pounce, spawnexec-miner-runt-immortal-at-cap |
| 17 | Storage sited at RCL4 when extensions cap (the container's successor) | ladder cap guard | cons-capguard-storage-rcl4 |
| 18 | Storage COMPLETED and adopted as the core buffer | ConstructionCorp; storage bank/spill | GAP G1b (completion); haul-t4-storage-bank-and-spill (adoption) |
| 19 | Extension tenders bus the core | ExtensionTenderCorp | haul-t4-tender-bus-regime, haul-t4-tender-death-failsafe |

## Phase 4 — RCL5+ (links, second spawn)

| # | Step | Mechanism | Cells |
|---|------|-----------|-------|
| 20 | Core link first, then farthest >8-range source; RCL cap honored | ladder link rungs | cons-link-core-first, cons-link-farthest-source |
| 21 | Link sites COMPLETED (the container's higher-RCL replacement, delivered) | ConstructionCorp | GAP G1c |
| 22 | Miner feeds the source link; pump reaches core; hauls re-priced from core | LinkRunner; flowAdapter link pricing | arrive-miner-feeds-source-link, plan-t4-link-haul-pricing |
| 23 | Second spawn (RCL7): sources assigned to NEAREST spawn | planner spawn assignment | plan-t4-two-spawn-nearest |

## Phase 5 — Remotes / expansion

| # | Step | Mechanism | Cells |
|---|------|-----------|-------|
| 24 | Scout crosses borders; remote sources planned within budget | ScoutCorp; netEnergy/budget gates | move-scout-border-crossing, plan-t3-netzero-maze-excluded, plan-t3-budget-subset |
| 25 | Reserver spawns AFTER income, yields to blocking miners, CLAIM body indivisible | reservationKind; holdToFund | spawn-reserver-started-income, spawn-reserver-yields-to-blocking-miner, spawnexec-reserver-body-multiroom |
| 26 | Remote pipeline end to end; SK rooms never mined | multiroom planning | plan-t5-remote-pipeline, plan-t5-sk-never-mined, churn-remote-orphan-walks-home |

## Cross-cutting — plan fidelity (expected vs actual)

The planner's budgets (Memory.economyPlan) vs physically delivered sinks
(controller progress, spawn-body energy, build progress, fielded CARRY),
measured over a trailing steady-state window; on a friendly synthetic world a
shortfall is a bug by construction.

- Long organic ramp (kept as the ramp-shape reference): fid-t4-synthetic-steady-state, fid-t5-real-maze-steady-state
- Short pre-ramped core moments (fleet staged, primary ratchets): GAP G2
- One-command measurement on any fixture: `npm run sim:real -- --metrics`
- Known finding (2026-07-09, synthetic steady state): gross 99% but the
  controller receives ~20% of its published budget while spawn/build soak the
  rest — GAP G3 (allocation infidelity investigation).

## The snapshot loop (organic sims as scenario factories)

Long organic runs are paid ONCE, at capture time: `npm run journey:capture`
runs a real cold start (synthetic starter room or a captured live fixture),
watches every trip point in test/journey/tripPoints.ts, and on each first
firing writes the world from ~5 ticks earlier to test/fixtures/journey/.
The grid's `rcl-journey` avenue (test/grid/cells/journey.ts) replays each
snapshot verbatim - same room name (pinned), same object ids (Memory keeps
resolving), Memory byte-for-byte, absolute times shifted - in a private solo
world, and asserts the SAME check fires within a short replay window. Add a
trip point and re-capture; the grid only ever pays the core moment.

## Open gaps / findings

- **G1 CLOSED (2026-07-09):** completion cells landed - cons-t2-container-completes,
  cons-t4-storage-completes, cons-t4-link-completes (site staged at ~90% + staffed
  builder; the structure must stand). All pass.
- **G2 CLOSED (2026-07-09):** `fid-t4-preramped-steady-state` landed, replaying
  the organically-captured `synthetic-2src--extensions-rcl2-cap` journey
  snapshot with tight fidelity floors (gross 0.55 / controller 0.15 / carry 0.6).
- **G3 CLOSED with G6** (2026-07-09): the controller shortfall and the
  runt-fleet plateau shared one root: G6.
- **G6 FIXED (2026-07-09):** construction sink capacity uncapped in
  `flowAdapter` (bounded by MINED supply, was a flat 5 e/t), value 70 >
  controller 50, plus the reserve pre-pass = "pause upgrading at the 2 e/t
  floor while sites exist" (owner directive). A/B: extension trips fire at
  1371/2869 organic ticks — they never fired when capped.
- **G4: tower defense** (spec 07) — no cells; out of economy scope for now.
- **G5: upgrader supply-before-demand core moment** — currently only implicit
  in a 900t organic cell (or capture the `first-upgrader` trip point).
- **G7 RESOLVED (2026-07-10):** the "successor holds off at distance" was
  actually the runt-recycle churn below it; with the staffing-lens fix
  (flagMinerRuntForRecycling counts via staffsPost) the successor walks
  straight to post — measured post gap 2 ticks. Remaining nicety: ratchet the
  gapless cell's 45-tick allowance downward.
