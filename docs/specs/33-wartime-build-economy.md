# 33 — Wartime (build) economy: relegate upgrading, size construction to eat the surplus

**Status:** BACKLOG (owner idea 2026-07-26). Design note. Directly enables the
base remodel (spec 31): a remodel is a large construction campaign that must
finish ASAP, and today upgrading competes with it for the surplus.

## The idea (owner)

"I really want to see how our economy shifts from upgrading to building. I want
a 'war time economy' — a build economy. Get the construction projects finished
ASAP; upgrading competes with that and should be essentially completely
relegated. The construction projects should be sized to eat the surplus just
like the upgraders normally would, including sizing the fleet in regard to
hauling — often the bigger body requirement."

## DOWN-PAYMENT LANDED 2026-07-27 (owner "speed the builder up a bit")

A first, bounded slice shipped — NOT the full mode, but the acceleration lever:
- **Accelerated build horizon** (`primitives.WARTIME_COMPLETION_FRACTION = 1/3`,
  vs the 2/3 lifetime pace): while a room holds a spendable warchest surplus,
  `projectBuildHorizon(travel, accelerate=true)` shortens, so
  `projectAbsorbRate` ~doubles. Read by BOTH the crew (`ConstructionCorp.
  buildPoolAbsorbRate`) and the plan's construction sink (`flowAdapter`
  `poolAbsorb`) off the SAME `bankSurplusRate` lens the feeder/upgrader use — so
  the sink allocation and the crew grow together (no isolated nudge). Bounded
  DOWNSTREAM by `min(minedSupply + bankRate, absorb-share)`, so it only draws
  ALREADY-available energy; the controller keeps more than construction
  (guardrail pinned in flowAdapter.test); the anti-downgrade reserve holds the
  floor; a FILLING warchest (no surplus) keeps the lifetime pace (no flap).
- **Tanker relay right-sized** (`ConstructionCorp.tankerPlan`): the haul detail
  sizes each body to its SHARE of the real `carryNeeded`, not the max body — so
  as the accelerated build rate rises, the haul scales WITH it (the "size the
  haul to the build absorb rate" half), and a small build no longer over-provisions
  (the measured 34-CARRY-for-a-2-WORK-site waste, t72596906).

**CONTROLLER RELEGATION LANDED 2026-07-27** (owner "surplus ... normally for
upgrading, but now for building"): while a room holds a MEANINGFUL construction
backlog (summed site work >= one structure ~3000) AND the warchest is in surplus,
`controllerRoutingCapacity` caps the controller at its floor
(`STORAGE_UPGRADE_TARGET`, >= the anti-downgrade reserve) instead of mopping up -
so the surplus flows to construction (value 70) rather than the controller. This
is the OTHER half of the down-payment: acceleration sizes construction to eat
faster; relegation stops the controller out-competing it for the surplus
(measured need: post-accel the controller ran P7 9x while the build inched).
Per-room, threshold-gated (a lone road never relegates), floor inviolable, exits
to mop-up when the backlog drains. Coherent ladder shift (both sinks move
together), not an isolated nudge.

**FALSIFIED 2026-07-27 (t72598913): the plan-side relegation is a NO-OP for the
PHYSICAL flow.** Post-deploy the controller still ran P7 9x (actual ~18.8 e/t vs
the relegated plan ~2). The surplus reaches the controller PHYSICALLY - source
links fire to the controller link (direct or via the core->controller relay),
and the upgraders (sized from ACTUAL controller-side stock, which the link keeps
fed) burn it - INDEPENDENT of the plan's controller sink allocation. So capping
`controllerRoutingCapacity` lowers the plan number but moves no energy. The
relegation is kept (correct plan-side half, harmless - it only fires in surplus
and is a plan no-op otherwise), but "surplus to building" needs the PHYSICAL
levers:
- **Throttle the core->controller link relay in wartime** (LinkRunner): keep the
  core's energy for the feeder to drain to STORAGE (building's fuel via the
  tanker fallback) instead of relaying it to the controller link. Link economy =
  collapse history (spec 26), so red-first + grid + careful.
- **Relegate the upgrader FLEET**: size it from the relegated allocation (a floor
  WORK), not `sustainableConsumptionRate(actual stock)` - else it stays big and
  burns whatever the link delivers.
- The feeder already drains core->storage (spec 02); in wartime it should PREFER
  draining over relaying so the surplus lands in storage for the tankers.
These are the real "surplus -> building" change; the acceleration + relegation +
tanker fuel shipped are necessary but not sufficient without them.

**UPGRADER-FLEET RELEGATION LANDED 2026-07-27** (the first physical lever, owner
"sure"): `upgraderSizing` gains a `wartime` flag - while the colony holds a
MEANINGFUL build backlog (`buildPoolBacklog >= WARTIME_BACKLOG_THRESHOLD`, the
SAME lens the plan's controller sink relegates on, now shared from
`primitives`), the fleet is relegated to the anti-downgrade sip
(`ANTI_DOWNGRADE_RESERVE = 2`, also shared from `primitives`) instead of the
stock-grounded surplus-eater. This is the PHYSICAL half the falsification named:
capping the plan sink moved no energy because the fleet sized from the actual
link-fed stock; shrinking the FLEET is what stops it eating the surplus, so the
energy the link delivers lands in building instead. Fires OFF THE BACKLOG (not
`surplus`) because the falsified drain ran with the bank BELOW reserve (E4
-4067) while the link-kept stock still fed a stock-grounded fleet - a
surplus-only gate would leave that drain running. Floor inviolable (never
zeroed); `surplus` reported FALSE in the relegated return so the sip funds as an
ordinary must-keep-alive demand, not a held surplus-eater; reverts the tick the
backlog drains (clean exit). Red-first: `test/unit/corps/upgraderRelegation.
test.ts`. Stamp: `sizing.wartime` (spec 14). STILL AHEAD: the link-relay
throttle (lever 1 - core->controller relay in wartime) and the feeder
drain-preference (lever 3); measure the fleet relegation live before deciding
whether they are needed (the fleet shrink may backpressure the controller link
enough on its own).

Still OPEN for the full mode: entry/exit HYSTERESIS as a named posture (the bare
3000 threshold can flap as the last structure finishes - a build-out stays well
above it so no flap mid-rebuild, but a lone finishing structure hovers); a
dedicated grid cell (`wartime-build-*`) staging the backlog+warchest and asserting
the faster build RATE + controller-at-floor + clean exit; and the explicit haul
sizing to the build absorb (partially covered by the tanker right-size).

## The model

A MODE, entered while meaningful construction work stands (a remodel, an RCL
build-out, a defensive push). In wartime:

1. **Construction is the primary surplus-consumer.** Today the upgrader is sized
   from ACTUAL stock at its work site (`sustainableConsumptionRate(stock,
   inflow)` — eat the storage surplus over a creep generation). In wartime,
   CONSTRUCTION takes that role: the builder/tanker fleet is sized to eat the
   same surplus (`inflow + surplus/lifetime`), so the warchest above reserve is
   spent into structures, not the controller. This is the existing consumer
   doctrine, re-pointed from controller to sites.
2. **Upgrading is relegated to a floor.** Not zeroed (the controller-downgrade
   floor must hold — never let the controller tick toward downgrade), but
   dropped to a sip: the minimum WORK that keeps the controller alive, no
   surplus-eating upgrader fleet. Upgrading resumes its surplus-eater role only
   when the construction backlog drains.
3. **Haul the build rate, not the mine rate.** Construction's absorb rate can far
   exceed a source's inflow (it draws the storage surplus too), so the haul
   fleet feeding the sites must be sized to the CONSTRUCTION throughput, which
   often means BIGGER bodies than steady mining haul — size CARRY to the build
   absorb rate over the leg (`carryPartsFor(buildRate, dist)`), not just the
   source rate. A build economy that out-plans its haulage just moves the pile
   from the source to the storage.
4. **Finish ASAP, but waste-free.** Reuse the project-completion horizon
   (`projectBuildHorizon`, spec 16 / `PROJECT_COMPLETION_FRACTION`): size the
   crew to finish the outstanding site work within its buffered effective life —
   big enough to burn the surplus fast, not so big it strands 99%-done WORK.

## Where it plugs into the existing machinery

- **Sink ladder (CLAUDE.md / CorpPlanner):** construction already ranks 70, above
  controller (≤80 campaign / 50 normal) — but "relegate upgrading" means wartime
  drops the controller sink toward its floor (40) so the surplus valve opens to
  construction. NEVER nudge one sink value in isolation (the 90-vs-85 founding
  incident) — this is a MODE that shifts the ladder coherently, red-first.
- **Macro doctrine (CLAUDE.md):** "production over consumption; consumers burn the
  residual and are sized from ACTUAL stock." Wartime keeps that intact — it only
  swaps WHICH consumer (construction, not upgrader) eats the residual.
- **Two plans (spec 11):** wartime is a NOW-plan posture; the GOAL equilibrium is
  unchanged. Entry/exit is a transition, gauged on actual-vs-NOW.
- **Spec 16 (construction projects), spec 31 (remodel target), spec 27
  (relocation):** the remodel emits the projects wartime economy funds.

## Guardrails (learned traps)

- **Do not starve income.** Wartime relegates CONSUMPTION (upgrade), never
  PRODUCTION (mining/haul). The spec-26 collapse (a `mustFund` campaign upgrader
  held the spawn ahead of a depleted income fleet, death spiral) is the anti-
  pattern: a wartime BUILDER must sit BELOW blocking income demands in the spawn
  ladder, same as the upgrader it replaces.
- **Controller floor is inviolable.** Relegated ≠ off; the downgrade floor keeps
  a minimum feed.
- **Exit cleanly.** When the backlog drains, upgrading re-expands to eat the
  surplus with no flap (hysteresis on entry/exit).

## Acceptance tests (the contract — write first)

**Unit (`test/unit/...`, pure where possible — reuse the existing sizing
primitives so wartime is a re-POINTING, not a new formula):**
- `wartimeMode.entry/exit` (pure, hysteresis): given (outstandingBuildWork,
  bankSurplus, controllerRemaining) it returns whether wartime is ON, with
  SEPARATE enter/exit thresholds (no flap around the boundary). Pin: sites
  standing + surplus → ON; backlog drained → OFF; a backlog hovering at the
  threshold does NOT oscillate across a re-solve.
- `constructionConsumerSizing`: in wartime the construction crew is sized from
  `sustainableConsumptionRate(stock, inflow)` — the SAME surplus-eater formula
  the upgrader uses today — so it eats exactly what the upgrader would have.
  Assert the wartime build absorb == the peacetime upgrader absorb for the same
  (stock, inflow), and that it is bounded by `projectBuildHorizon` (no crew that
  strands 99%-done work — the spec-16 completion-fraction lens).
- `upgraderRelegation`: in wartime the upgrader drops to the controller-floor
  sip (`ANTI_DOWNGRADE_RESERVE`, never zero) — assert its allocation == the
  floor while sites stand, and reverts to the surplus-eater the moment the
  backlog drains.
- `wartimeHaulSizing`: the site-feeding fleet is sized to the BUILD absorb rate
  over the leg (`carryPartsFor(buildRate, dist)`), not the source rate — assert
  a bigger CARRY body than steady mining haul when buildRate > inflow.
- Guardrail units: (a) the wartime BUILDER demand sits BELOW blocking income
  demands in the spawn ladder (never front-runs a depleted income fleet — the
  spec-26 death-spiral anti-pattern); (b) the controller floor allocation is
  inviolable in every wartime branch; (c) the sink ladder shifts COHERENTLY
  (controller sink → floor as construction opens), never one value nudged in
  isolation (the 90-vs-85 founding incident).

**Grid (`test/grid/cells/...`, stage real topology, assert delivery RECEIPTS):**
- `wartime-build-eats-surplus`: stage a standing construction backlog (several
  sites, summed work large) + a FAT warchest (bank ≫ reserve) + live income.
  Assert over the window: build delivery (ledger P8 / `lastDeliver.to ===
  "construction"`) tracks the planned absorb rate; the upgrader drops to the
  controller-floor sip (P7 → floor); the storage slope turns NEGATIVE (surplus
  actually spent into structures) WITHOUT the income (miner/hauler) fleet
  shrinking; and NO source/storage pile blowup (the enlarged haul fleet kept up
  — the "a build economy that out-plans its haulage just moves the pile" check).
- `wartime-clean-exit`: same world, then drain the backlog mid-window. Assert
  the upgrader surplus-eater RE-EXPANDS with no oscillation (hysteresis holds)
  and controller progress resumes — a clean regime exit, not a flap.
- The OLD (no-wartime) build must FAIL `wartime-build-eats-surplus` cell (the
  surplus banks / upgrader keeps eating instead of construction) so the cell is
  a real regime gate.

**Regression gate:** unit + `flow-handoff`, `runt-economy`, `storage-depot`
green; income (production) is NEVER relegated — only consumption (upgrade)
shifts to construction, so the income-side cells stay green unchanged.
