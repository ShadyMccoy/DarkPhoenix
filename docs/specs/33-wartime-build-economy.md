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

## Acceptance (when it graduates)

- Red-first: a world with a standing construction backlog + a fat warchest →
  construction fleet sizes to eat the surplus (matches what the upgrader would
  have taken), upgrader drops to the controller-floor sip, sites finish within
  the project horizon, and the haul fleet grows to the build rate (bigger
  bodies) — with NO source/storage pile blowup (the haulage kept up).
- Plan-vs-actual: build delivery (ledger P8) tracks the planned absorb rate;
  controller delivery (P7) drops to floor; storage slope turns negative (surplus
  spent) without the income fleet shrinking.
- Regression: exit restores the upgrader surplus-eater with no oscillation.
