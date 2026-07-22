# 27 — Extension relocation: migrate the legacy layout, one structure at a time

**Status:** PROPOSED 2026-07-22 (owner: "I think we should consider moving
(rebuilding) some of the extensions as they were placed under an older
regime as well. We continue squeezing more performance out of our same
resources which will compound during the scale out"). Phase 1 (scoring +
telemetry, NO destroy logic) may ship under the audit loop; any phase that
destroys a structure ships only after the owner reviews the scored plan.

## Why

The live extension field grew under older placement regimes. The refill
mini-game (scripts/extension-sim, 2026-07-22) measured what placement is
worth: compactness around the reload point dominates (evolved dense blobs
beat every hand design at RCL8), and at RCL7+ the gains compound — 100/200
capacity extensions, partial drains, multi-spawn demand. At RCL6 today the
misplacement costs ~nothing (endFill 0.915, zero energy-blocked spawns),
so this is a scale-out investment, not a leak fix: capital is cheap now
(E4 surplus above target), and every structure moved before RCL7 is moved
at 50-capacity prices.

## Doctrine (from the measured mini-game)

- Score a tile by SUMMED TRIP DISTANCE to the reload point (storage), not
  by pattern membership. Dense-near-reload beats elegant-far.
- Passability constraints the fitness cannot see: keep the field permeable
  to guests, keep spawn-egress tiles free, keep one crossing route.
- The diagonal stripe is the target shape where terrain allows; the
  bottom-up scatter is the fallback everywhere else (owner: adaptability
  over stamp-optimality — settle any room, not just open ones).

## Safety rails (non-negotiable — destruction is unrecoverable)

1. ONE structure in flight at a time, colony-wide: destroy #2 only after
   #1's replacement is BUILT and energized.
2. Surplus-gated: no move while storage is below the warchest target, and
   no move while any higher-value construction stands (trunks first).
3. Only extensions whose relocation GAIN clears a floor (scored delta in
   summed trip distance, converted via the mini-game's latency model) are
   candidates — never churn for marginal tiles.
4. Kill switch: `Memory.relocation = "off"` halts the pipeline; absence of
   the flag means ON only for phase 1 (scoring), never for destruction.
5. The destroy step re-verifies at execution tick: target still an
   extension, replacement site placed, count under the RCL limit.

## Phases

1. **Scoring + telemetry** (audit-loop shippable): a pure scorer ranks the
   live field's extensions by relocation gain (current trip distance vs
   best free tile's), exports the top candidates + total gain estimate in
   the corps segment. Acceptance: a unit test on a staged legacy layout
   ranks the obvious outlier first; the capture shows the scored list.
2. **Owner review**: the scored plan (which extensions, where to, cost =
   3000e + build labor each, modeled gain) goes to the owner with numbers.
3. **Migration executor**: the one-at-a-time pipeline under the rails
   above, feeding placement to the ordinary construction path (the pool
   crew builds it like any site — no special-case building).
4. **Verify live**: endFill/duty hold through each move; the scored gain
   materializes at RCL7 (re-measure then).

## Tomorrow's execution plan (owner 2026-07-22: "plan out the next steps
## (extensions remodeling?) for tmrw")

1. **Phase-1 scorer** (first thing): rank live extensions by summed trip
   distance to the reload point vs the best free tile; export the scored
   list, total modeled gain, and — per the owner's per-cluster note ("our
   clusters are different sizes and different distances from storage, so
   you can estimate the tender size each one needs") — a PER-CLUSTER
   table: size, distance, and the tender body it implies. The current
   equal-share fleet is the deliberate interim ("leave it as is for now,
   take care of it when we do the extension remodeling").
2. **Owner reviews the scored plan** (cost 3000e + labor per move, modeled
   gain, target shape: diagonal where terrain allows, compact blob
   fallback, passability + spawn-egress constraints held out).
3. **Migration executor** under the spec's rails (one in flight,
   surplus-gated, trunks-first, kill switch) — only after the review.
4. Post-remodel: re-derive tender fleet (count AND bodies) from the new
   cluster geometry; retire the interim equal-share if the remodel
   collapses the field to one compact group.

## Relation

- Spec 15 (waste ledger): phase 1's export is an X-class line (standing
  misplacement priced in future ticks, not current leak).
- The tender ratchet (2026-07-22) is the same doctrine on the fleet side:
  measured duty + endFill verify each squeeze; a breach reverts it.
