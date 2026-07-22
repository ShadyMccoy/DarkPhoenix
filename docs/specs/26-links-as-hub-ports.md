# 26 — Links as hub ports (deposit-side haulPos)

**Status:** DEFERRED (owner 2026-07-21: "if it overlaps [with spec 25], I'd
rather defer it and revisit it once we take a look at that"). Revisit when
spec 25 (emergent dedication — route economics over more real nodes) lands
or is scoped; both touch the same routing seams and the full version of this
idea (links as flow-graph edges) belongs to that planner-evolution track.

## The idea (owner 2026-07-21)

"Some of our remote mines' roads walk right past the link and then continue
to the hub. In theory they could just drop their energy off at the link —
links as sort of extensions of the hub."

## Design sketch (from the deferral discussion — good to build from)

Precedent in-tree: the SOURCE side already does this — a link-served
source's `haulPos` is redirected to the core link at problem assembly
(flowAdapter ~434), so the plan prices the short leg and the hauler fields
the small body. This spec is the symmetric DEPOSIT-side counterpart: the
hub = the storage PLUS its link constellation ("deposit ports"); a deposit
route prices to the nearest eligible port.

Two port classes, different semantics:

- **Source links**: forward to the core via their existing fire — energy
  logically lands in the bank. Regime-neutral. Costs to price: the 3%
  transfer toll, 800-capacity / cooldown throughput shared with the
  source's own mining flow.
- **Controller link**: terminal controller-ward — skips the whole relay
  chain (feeder shuttle + core→controller hop) at zero toll, but BYPASSES
  the warchest, so eligibility needs a regime lens (surplus-only, or
  capped at the save-regime relay target). OWNER DECISION PENDING.

Payoff estimate: 5–15 tiles trimmed off 35–50 tile remote routes = ~15–35%
of those routes' CARRY parts, compounding with 2:1 paved repricing; plus
feeder-work deletion for surplus-era controller-link flow.

Constraints (must be priced, not discovered at runtime):

- Port-full fallback (walk on to storage) with honest expected-distance
  pricing — no plan-vs-actual drift.
- ONE eligibility lens shared by pricing and CarryCorp delivery
  (staffsPost-symmetry class).
- The 3% toll in the route's net-energy math.
- Mockup blind spot: needs a grid cell with staged links (receipts-gated
  behavior class).

Two altitudes:

1. **Minimal**: sink-side `depositPos` analog of `haulPos` — shared port
   lens, min-distance pricing, commission carries the chosen port,
   CarryCorp delivers with storage fallback.
2. **Full**: links as flow-graph EDGES (teleport edges with capacity +
   toll); subsumes the source-link special cases and LinkRunner rules.
   This is the spec 18/25-track version and the reason for the deferral.

## Open owner questions (carried to the revisit)

1. Controller-link drops: surplus-only, or capped-always?
2. Minimal ports first vs one full graph-edges model?
3. Sequencing against spec 25.
