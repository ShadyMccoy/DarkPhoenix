# Spec 43 — Hauler relay (bucket brigade on long routes)

**Status: BACKLOG 2026-08-03 (owner design, measurement-gated).** Sized by
v29's `recycled why:` eol-tail share + the post-port deposit-queue residual;
the owner's own gate: *"may be worth it if we see this is in fact a
significant energy and spawn parts cost."*

## The owner's design (verbatim, 2026-08-03)

> "Instead of each creep running the full route they run it until they
> encounter an outward traveling empty (and older) hauler. This would shrink
> the round trip for each creep although the total pass through is unchanged.
> New creeps would travel to the most out and work from there intrinsically
> bumping all the other haulers in the route 'in'. Creeps still recycle at
> the core but with less ttl corresponding to the shorter round trips. (Haul
> distance in ticks divided by N haul creeps.) A bit more complicated in the
> code but overall abstractly the haul corp is unchanged."

## Why it is sound

- **The commission is untouched** (spec 34 doctrine: "simple interface up,
  sophistication inside"): same vector `(from, to, rate)`; total CARRY is
  invariant under segmentation (rate x total round trip / capacity).
- **eol-tail elimination**: per-creep round trip falls from `2d+2` to
  `(2d+2)/N`, so the unusable tail (ttl < one trip -> recycle) shrinks
  proportionally. d01f (d=85, trip 172t) is the measured worst (X4:
  "remaining 107t of 164t trips").
- **Hub congestion: SECOND-ORDER only (owner correction 2026-08-03: the
  innermost hauler "visits N more times so that kind of washes out")**.
  Throughput fixes total deposit events, so the tile's service demand is
  CONSERVED under segmentation. What survives: arrival regularity (N short
  deterministic loops beat bursty long-loop returns - queue wait scales with
  arrival variance at fixed utilization) and instantaneous approach-ring
  crowding (one inner creep per route instead of whole fleets converging;
  cd8d's en-route lane blockage, not the tile). AGAINST it: backpressure - a
  stalled inner hauler stalls the whole chain unless segments carry slack,
  so the relay is MORE sensitive to hub service time. The deposit queue's
  first-order fix remains SERVICE CAPACITY (ports/pad/spread), independent
  of who visits.
- **Raid exposure concentrates on the newest bodies** (outermost segment) -
  least sunk cost at risk.

## Costs, honestly

- Meet-and-swap movement coordination: two moving creeps pairing on adjacent
  tiles without corridor deadlocks (the move-bypass/congestion cell family
  is the proving ground). Handoff friction must stay ~0-2 ticks/leg or the
  throughput invariance is theoretical only.
- Partial-load fragmentation across mismatched bodies (transfer moves
  min(load, free)); mitigation: segment fleets of uniform bodies, or
  drop-swap at fixed relay tiles.

## Sequencing (measurement-gated)

1. **v29 eol-tail share** (live next deploy) + X4 (~0.43 e/t today) price
   the tail half; the DEP gauge + duty stamps price the congestion half.
2. **Deposit-port expansion FIRST** (task #15 fix 1): same two wins, zero
   coordination complexity, links already standing - DEP prices 6 routes at
   ~60 e/t of shortened haul.
3. Relay lands only where ports cannot reach AND the measured residual
   still pays for the complexity. Gate: unit + trio + a dedicated grid cell
   (relay handoff on a long staged route) + the fid pair unchanged.

## Acceptance (when built)

- eol-tail recycles on relayed routes -> ~0 (v29 byReason, per window).
- At-sink idle on relayed routes: no regression (the backpressure risk is
  the thing to disprove); any improvement is variance relief, a bonus not a
  pillar - the justification rests on the eol-tail line.
- Route throughput (produced vs delivered per commission, F3) unchanged or
  better - the handoff friction stays invisible at the commission grain.
