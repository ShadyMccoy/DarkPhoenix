# Spec 11 — Two Plans: the Goal and the Now

Owner directive (2026-07-09): "do we need to distinguish two plans? One is
the goal of what we ultimately want. The other is what we are planning to do
right now, with the resources available."

Yes. Most of the day's measured failures were the same category error:
treating the solver's EQUILIBRIUM output as if it were an executable schedule.

## The two objects

**GOAL plan** (exists today: `Memory.economyPlan`): the steady state the
CorpPlanner solves for - every profitable source mined at full rate,
full-size bodies at rated capacity, sinks filled in value order. Timeless; a
claim about where the colony converges, not about tomorrow.

**NOW plan** (missing; exists only implicitly as the spawn scheduler's
per-tick greedy ranking): the transition. Given the ACTUAL fleet, bank,
capacity and income: the ordered next acquisitions, their transitional
bodies, and the budgets that hold DURING the ramp. Because it is implicit,
transition failures are invisible until a long sim exposes them - measured
three times today:
- fantasy plans (goal sized to transient stocks; spec 10 / mined-supply bound)
- the tanker stream draining a held miner's bank (spawn-hold seal)
- W2N6: initial fielding fine, REPLACEMENT sequencing lost in the
  construction era (open, task #19)

## Design

1. **`Memory.spawnAgenda`** (observability first, zero behavior change):
   each solve, publish the ordered next-N spawn acquisitions derived from
   goal-minus-fielded through the existing demand ranking: `[{role,
   buyerCorpId, cost, precondition: "bank>=250" | "after:<id>"}...]`. The
   scheduler keeps making its own decisions; the agenda is what it EXPECTS
   to do.
2. **Agenda fidelity** (the new tight ratchet): a grid cell asserts spawns
   match the agenda head - "agenda says minerB(250), spawn built
   tanker(100)" is a one-line violation catchable in a 60-tick cell, not
   3000-tick archaeology. Plan-vs-actual splits into:
   - actual vs NOW plan: any gap is a bug, floors can be tight;
   - NOW plan vs GOAL: the ramp metric (convergence rate), a health gauge,
     not a pass/fail.
3. **Migrate transitions into the agenda** one at a time, each with its
   cell: replacement lead times (delivery contract), spawn-then-recycle
   upsizing at capacity rungs, build-out phases (the funneling pause),
   expansion campaigns (spec 06 - a campaign IS a now-plan fragment).

   **Phase 3 landed (2026-07-12):** every agenda entry now carries its
   TRANSITION label (`why`: replacement / upsize / campaign / new-unit /
   scale / infra / consume - `buildAgendaQueue` in spawn/SpawnScheduler,
   pure + unit-tested) and a precondition (`bank>=N` on an unaffordable
   head, `after:<corpId>` behind it), and the director appends EXECUTION
   RECEIPTS (`Memory.spawnAgenda[spawn].executed`, last 8 buys) beside the
   published queue - the actual-vs-NOW observable. Cells:
   `agenda-t2-receipts-match-head` (every receipt matches its predicting
   queue's top-2) and `agenda-t3-replacement-labeled` (a dying miner
   surfaces as why:"replacement" ~75 ticks before death and its successor's
   purchase is receipted). Remaining phase-3 candidates: build-out phase
   fragments and expansion campaigns as multi-entry agenda sequences.

## Non-goals

- No second solver. The NOW plan is derived (goal + fleet state + ranking),
  not independently optimized - one source of truth for value.
- No lockstep execution. The scheduler may deviate (deaths, hostiles); the
  agenda is re-derived each solve and deviations are SIGNAL (logged /
  asserted), not faults to force.

## Relation to today's fidelity work

fid-* cells keep the goal-denominator assertions with loose floors (ramp
variance is real). The tight assertions move to agenda fidelity once the
agenda exists. The journey snapshot library replays transitions - exactly
NOW-plan territory - so journey cells become the natural home for agenda
assertions.
