# 23 — Movement at scale: cached routes, not creep pathing

**Status:** DOCTRINE + DESIGN (owner 2026-07-20). Not yet scheduled - CPU
does not bind at one room (~70/300). Becomes load-bearing with the
expansion phase; the INSTRUMENT ships first, per the never-guess rule.
**Priority:** the CPU term of the scaling equation (with spec 22's credits
and the room-portfolio e/t-per-CPU selection).
**Depends on:** spec 20 (CPU accounting - the pathing share must be a
measured number before and after).

## The thesis (owner)

"At higher room claims we basically can't have any creep pathing. They
should mostly just follow cached routes. If we do that and scale up creeps
we can hopefully scale up the colony."

The cost model it targets - Screeps charges two different things:

- **Intents** (move, harvest, transfer): flat ~0.2 CPU per intent per
  tick. Caching cannot reduce this; BIGGER CREEPS do (fewer creeps for
  the same throughput = fewer intents). This is also the existing
  bigger-bodies doctrine restated in CPU.
- **Path searches** (the engine behind moveTo): 0.5-5+ CPU each, worse
  cross-room, the dominant variable cost in most bots. CACHED ROUTES
  drive steady-state searches to ~zero.

`CPU/tick ~ overhead + creeps x (intents + logic) + searches x searchCost`
— the doctrine attacks the third term to ~0 and shrinks the second's
multiplier.

## Why this colony caches unusually well

Node stability (owner: "nodes should be stable because the world terrain
is stable"). Haul routes are STRUCTURAL: source -> hub, hub -> controller,
trunk legs. They change on EVENTS (a road completes, a structure lands, a
hostile appears, a paved receipt flips a lane), not on ticks. A route
computed once serves every creep on that assignment until an event
invalidates it.

## Design sketch

- **RouteCache**: keyed `(originKey, destKey, lane)` where lane is
  loaded|empty - today's empty-lane matrices become CACHE KEYS (two lanes
  per route: loaded-on-road, empty-geometric) instead of per-move search
  options. Paths serialized per room segment. Heap-resident; rebuilt lazily
  after resets (amortized cheap - the first walker per route pays once).
- **Followers**: assignment-based creeps (haulers, miners, feeders,
  tenders) walk `moveByPath` on the cached segments. travelTo becomes:
  on-route -> follow; off-route/stuck -> local step + (rate-limited)
  segment re-path; the existing swap/queue/bypass traffic rules operate on
  top unchanged.
- **Invalidation**: per-room event flags (construction complete, structure
  destroyed, hostile sighted, paved receipt) + a long TTL backstop. The
  road/trunk machinery already emits the natural invalidation points.
- **Explicit non-goal**: no per-tick validity checking. An occasionally
  stale route that self-heals via the stuck handler is the accepted cost.

## Sequencing (instrument first)

1. **P-CPU instrument** (ships whenever wanted, observability-only): wrap
   the search path to count searches/tick and attribute pathing CPU per
   corp into Memory.corpCpu; scoreboard line `PATH n searches ~x CPU`.
   This is the BEFORE number - and it names the top offender corps.
2. **RouteCache for the top route class** (likely source->hub haulers):
   measured before/after on the same capture cadence.
3. **Widen** by route class; grid cell ratchets searches/tick at a staged
   creep count (the scale pin: N creeps, steady state, ~0 searches).

## Acceptance sketch

- Steady-state searches/tick ~ 0 in a sim with the full fleet moving
  (events only: each invalidation causes a bounded re-path burst).
- CPU per creep-tick flat as creep count scales (the second term's slope
  is intents+logic only).
- No behavior regressions: the trio + traffic pins (swap/queue/bypass)
  green with followers on cached segments.
