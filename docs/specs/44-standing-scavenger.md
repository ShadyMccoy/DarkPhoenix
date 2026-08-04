# Spec 44 — The standing scavenger (persistent recovery fleet + ceil-decay focus fire)

**Status: DESIGN 2026-08-04 (owner direction; explicitly not to be rushed).**
Owner: *"Sizing it is a bit tricky because the different piles are different
sizes. Don't rush it."* Measurement legs first; the redesign ships only after
they land.

## The owner's direction (verbatim, 2026-08-04)

> "If scavenger is worth it we keep it around not recycle at some average
> size. Just spawn or plan it at the size of the ground piles. But only
> recall this every 1500 or something. Sizing it is a bit tricky because the
> different piles are different sizes. Don't rush it."

> "Also something I don't think we really consider that energy piles lose a
> minimum of 1 e/t not always 1/1000. So better to focus one down so it
> stops decaying than lots of small piles."

## What this replaces (the current shape and its measured costs)

Today recovery is PER-PILE TRANSIENT corps: `detectRoomStocks` finds a pile
over `REMOTE_SPILL_THRESHOLD` (1000) / home threshold, a dedicated
`hauling-ROOM-X-Y` corp forms on it, buys a body sized to that stock
(`scavengeRate = amount/2 / effectiveLife`, the temporal-midpoint model),
drains it, and retires. Measured consequences (M07–M09):

- `retiring-demob` is 13–31% of all recycle losses — every drained pile
  throws away a working body and buys the next pile a fresh one.
- The pounce-churn incident (M08, fixed): pile-sized "full size" is tiny, so
  the runt pounce fired trivially; four 100e bodies in 370t on one pile.
  Fixed by scoping the pounce to standing routes — this spec is the
  completion of that thought: the owner keeps a WORTH-IT scavenger for its
  whole life instead of recycling per pile.
- Sub-threshold piles get NO corp and rot at the decay FLOOR (below).

## The ceil-decay floor (the mechanic the model under-weights)

Engine rule (already exact in MEASUREMENT: `primitives.pileDecayRate =
ceil(amount/1000)`, integrated by the loss meter): a pile loses
`ceil(amount/1000)` per tick, so **every pile pays at least 1 e/t no matter
how small**. A 100e pile loses 1%/t; a 999e pile 0.1%/t. N piles cost >= N
e/t standing, while one pile of the same total costs ~total/1000.

The PLANNING model does not know this: `scavengeRate`'s docstring models
decay as "~an exponential at 1/1000" (proportional), which:

1. **Understates small-pile urgency** — a 300e pile modeled at 0.3 e/t decay
   actually pays 1 e/t; it self-destructs in ~300t, not ~1000t. Admission
   thresholds tuned on the proportional model leave exactly these piles to
   rot (each one a permanent -1 e/t until gone).
2. **Misses the focus-fire dividend** — draining a pile TO ZERO retires its
   whole 1 e/t floor immediately; skimming three piles in parallel retires
   nothing until the last tick. Focus one down, then the next (owner's
   directive, and the ceil rule is exactly why it is right).

Live scale: M09 measured pile decay 13.52 e/t against a 0 budget — the
single biggest loss line. How much of it is FLOOR-bound (many smalls) vs
proportional-bound (few bigs) is not yet answerable from captures, which is
measurement leg 1.

## Target shape (direction, not final design)

- **A standing recovery fleet, not per-pile corps**: scavengers that are
  worth having are KEPT — they finish a pile and move to the next, and die
  of old age (eol/retiring only when the whole recovery job is gone). The
  corp abstraction stays (one recovery corp per room or colony; assignment
  rotates over piles) — same "abstractly unchanged" doctrine as spec 43.
- **Sized from total ground stock, recalled slowly**: the fleet's size
  derives from the standing ground-pile census, recomputed on a ~1500-tick
  (CREEP_LIFETIME) cadence — one sizing decision per body generation, so
  pile flicker can never churn bodies again (the M08 lesson, made
  structural). Between recalls the size HOLDS.
- **Focus-fire dispatch**: within the fleet, drain order is one-pile-down
  (retire its floor) before spreading — plausibly nearest-first or
  smallest-first-per-floor-retired; the right rule is part of the design
  work, priced by the ceil model.
- **Sizing across heterogeneous piles is the hard part** (owner: tricky,
  don't rush): candidate inputs — total stock / CREEP_LIFETIME (the ONE
  drain law), per-pile floors retired per tick, travel between piles. NOT
  decided here.

## Measurement legs (do these first; they gate the design)

1. **Pile census instrument**: per-pile size distribution over time (count,
   size buckets, floor-bound share of measured decay). The loss meter knows
   total decay; it cannot yet say how many piles pay the floor. Without this
   the focus-fire dividend and the standing-fleet size are guesses.
2. **Recovery P&L trend** (methodology #10, first complete close = M10): the
   standing fleet must beat the transient fleet's net (recovered − bodies).
   The transient baseline is now measurable; capture 2–3 clean windows of it
   before switching, so the redesign has a before/after.
3. **retiring-demob share** (v29 recycled-why): the line the persistence
   change should collapse; its clean baseline lands with M10.

## Open questions (deliberately unanswered)

- One recovery corp per ROOM or per COLONY? (Travel between rooms vs fleet
  fragmentation.)
- Does the standing fleet absorb the loot-grab and tombstone-pad flows, or
  stay pile-only?
- Threshold inversion: with the ceil model, does a 300e pile ADMIT (its 1
  e/t floor makes rescue worth ~300e over its self-destruct window) where
  the proportional model rejected it? Where is the new break-even?
- Interaction with spec 43 (relay): a standing scavenger pool is naturally
  relay-shaped on long circuits.

## Acceptance shape (when the design does ship)

1. Body churn on recovery corps ~0 outside natural death (recycled-why:
   retiring-demob + runt-upsize both ~0 for recovery fleet).
2. RECOVERY P&L net improves over the transient baseline across >= 2 fiscal
   windows (multi-draw rule).
3. Measured pile decay falls with the floor-bound share specifically (the
   census instrument proves the focus-fire effect, not just less spillage).
4. Sizing recall cadence visible in stamps (one sizing decision per
   generation, holds between).
