# 21 — Conquest: peace as strategy, harassment as the exception

**Status:** PROPOSED (owner doctrine 2026-07-20). Doctrine capture — no
implementation scheduled; operators land through the spec 18 searcher when
the preconditions below first hold in practice.
**Priority:** P3 — behind the strategy layer (18), delivery (19), accounting
(20). **Lineage:** spec 13's guard/buster/striker kit is the proto-machinery.

## The doctrine (owner, 2026-07-20)

> We don't really want to spend energy fighting people — there are lots of
> peaceful places in the world. Rooms that don't get attacked are the ones
> that survive. But sometimes a very desirable room is owned by a WEAK bot,
> and if we've used up our available claims, we fight for that room: harass
> with skirmishers, swarm them and the surrounding rooms, their code breaks
> down or they run out of energy, and we take the room fairly easily.

- **Peace is the default strategy**, not a gap in the military program:
  expansion targets quiet neighborhoods, and the defense budget we don't
  spend is spent as position. Our own survival doctrine is the same insight
  mirrored: be the room nobody profits from attacking.
- **Conquest is a narrow economic exception** with hard preconditions, not a
  posture. It exists because a developed/desirable room owned by a weak
  defender can be cheaper to TAKE than the next-best founding is to BUILD —
  but only when claims are the binding constraint.

## Preconditions (all must hold before the first skirmisher)

1. **Claims scarce:** GCL headroom exhausted or every remaining free
   candidate scores far below the target (the spec 18 goal/search decides -
   conquest competes against founding as an operator, priced by the same
   counterfactual solves).
2. **Target desirability:** the room's solve-value (sources, position,
   inherited layout) beats the best free alternative by more than the
   campaign's expected three-currency cost (energy, spawn time, CPU -
   spec 20 meters the actuals).
3. **Measured weakness:** never judged, always probed (below).
4. **RCL-weighted feasibility:** controller downgrade/strike clocks grow
   steeply with RCL - target desirability is discounted by siege length
   (prefer weak LOW-RCL owners; an RCL-6 siege is a different commitment).

## The campaign ladder (each rung gated on the previous rung's measurements)

1. **PROBE** — one MOVE-only skirmisher: measures response latency, tower
   trigger-happiness (shots wasted on a harmless creep), repair reflexes,
   activity cadence. Cost ~50 energy; information is the product.
2. **ASSESS** — the attrition arithmetic on observed data: can we force
   their burn rate (tower fire ~10 e/shot, repairs, defense spawns) above
   their income (~20-30 e/t/room)? Their code thrashing under multi-room
   pressure is ACCELERATION, never the load-bearing assumption - plan on
   arithmetic, collect the chaos as upside.
3. **HARASS** — a sustained cheap-skirmisher stream across the target and
   surrounding rooms: max-range tower dancing (worst energy-per-damage for
   them), remote-mining interdiction, forced defense spawning. Sized so OUR
   spend stays a small fraction of home income; theirs exceeds theirs.
4. **SIEGE** — once starved: kill spawn capability, grind the controller
   (CLAIM strikes - the spec 13 striker, pointed at a player controller).
5. **CLAIM + FOUND** — the standard expansion machinery takes over
   (spec 06); we inherit the neutral infrastructure (roads, containers,
   cleared layout), not their owned structures.

## The abort rule (pre-committed, non-negotiable)

The campaign carries its kill-switch from rung 1: if measured response
exceeds threshold (competent defense, third-party reinforcement, active
human adaptation), STAND DOWN and re-target - sunk skirmishers are already
spent; the doctrine is "we don't want to fight", and an abort that needs a
fresh decision under escalation momentum is how cheap harassment becomes an
expensive war. Abort thresholds are set at ASSESS time, before rung 3.

## Acceptance sketch (when this is ever built)

- Pure operator tests: conquest is proposed ONLY with all preconditions
  measured-true, and loses to founding whenever a comparable free room
  exists; the abort operator fires on threshold breach in a fixture
  campaign.
- The probe/assess lenses are intel-derived (durable signals - the trap
  list applies doubly against a reactive opponent).
- Campaign accounting lands in the spec 20 ledger: a conquest's full
  three-currency cost vs the counterfactual founding is the postmortem
  every campaign publishes.
