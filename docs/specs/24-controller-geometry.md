# 24 — Controller geometry: the focus-upgrade pillar

**Status:** DESIGN (owner 2026-07-20). Sequenced after the feeder-ramp
verification closes; placement fix is the near rung, circulation and the
input SET are the pillar rungs.
**Priority:** "focusing a room to upgrade it is a strategic pillar" (owner) —
the replication loop pumps claimed rooms to RCL3+ fast, and GCL is score.
**Depends on:** spec 03 (surplus draw), the feederRelayTarget surplus fix,
spec 23 (bigger bodies / fewer intents alignment).

## The constraint, named (owner)

"Where the container sits there's not a lot of room for upgraders." The
upgrade fleet is capped by PARK TILES: tiles simultaneously within
withdraw reach (range 1 of the input buffer) and upgrade reach (range 3 of
the controller). Live t72455711: parking 6, so burn ceiling 6 x 15W =
90 e/t — BELOW the 115 e/t relay. Geometry binds before supply.

Owner's refinement: "We don't just want adjacent container spots. We want
adjacent spots in range of the controller." Both lenses already compute
the intersection (nodeEnergy.controllerInputSpot scoring, and
controllerParkingTiles' range<=3 filter). The deficiencies are elsewhere:

1. **Legacy-buffer short-circuit**: controllerInputSpot accepts ANY
   existing container/link within range 3 unconditionally — quality never
   re-examined. The fresh-placement path already searches only range<=2
   candidates scored by park-ring size; an old container placed before
   that logic (or placed at range 3) keeps its bad ring forever.
2. **The 1-CARRY body** pins upgraders to the ring even though upgrade
   range is 3.

## Measured geometry (W43N23, real-rooms fixture)

Controller (40,32): ALL 48 range-3 tiles walkable; EVERY range-2 input
candidate scores the full 8-tile park ring. The live parking=6 therefore
means the legacy container wastes 2 park tiles (= 30 e/t of ceiling at
15W bodies) purely by position. Open terrain also means the burn ring
(range-3, beyond the park ring) is huge: rotation capacity is effectively
unbounded here; SUPPLY (relay rate) is the real wall once geometry is
fixed.

## The three mechanisms (owner: non-exclusive, do all three)

### A. Placement (near rung — smallest change, immediate ceiling lift)

Rule: the input buffer belongs at Chebyshev RANGE 2 from the controller —
the unique distance where every neighbor tile is inside upgrade range and
none is the controller's own tile. Among range-2 candidates, prefer (1)
max walkable park ring (existing score), (2) nearest the storage (shorter
feeder leg = fewer CARRY per e/t of relay). Fix the short-circuit: accept
an existing buffer only if its park ring is within 1 tile of the best
candidate's; otherwise place the container at the best tile and let the
old one retire by decay (precedent: the link-superseded container lens).
Expected: parking 6 -> 8, ceiling 90 -> 120 e/t >= today's 115 relay.

### B. Circulation (the tile-multiplexing rung)

Owner: "Even with 1 carry the upgraders can circulate... even if they
switched each tick we could support 16." Validated against intent
mechanics: withdraw+upgrade fire the same tick, and move+upgrade fire the
same tick (different intent groups) — so a 1C/15W unit can withdraw 50 &
burn 15 on its ring tick, then burn its remaining ~35 over ~2-3 off-ring
ticks while a sibling takes the tile. Each park tile time-shares 3-4
units: the 8-ring supports ~24-32 bodies (~360-480 e/t of WORK) before
tiles bind again. A couple of CARRY per body ("wasting a few CARRY won't
be that bad" — owner) loosens the choreography: 5C = ~17 burn ticks per
visit, tolerant of queue jams. Movement already has the swap/queue/yield
machinery; the new behavior is upgrader-side: full -> vacate to a burn
tile, empty -> rejoin the ring.

### C. Input SET: second container, and the controller link

"Simply build another feeder container for another cluster" (owner). Two
range-2 inputs on opposite sides (here e.g. (38,32) + (42,32), disjoint
rings) double continuous parking to 16 with NO rotation choreography.
Requires generalizing the singleton controllerInputSpot to an input SET
that haulers, feeders, upgraders, and construction all read (one lens —
staffsPost discipline).

The CONTROLLER LINK is the same rung done better where link slots allow
(RCL6 = 3 links; we field 2): a link in the controller's range-2 ring
retires the feeder corp entirely — 64p of plan pricing (13% of the spawn
ceiling) plus its bodies replaced by an instant hub->controller transfer.
The link is itself an input-set member with its own 8-ring.

## Consumption reallocation (owner's "neat trick", filed here)

Upgrader bodies are builder bodies. Two sanctioned modes:
- **Attrition (default, zero code)**: plan shifts allocation ->
  upgraderTargetCount drops -> replacements stop; standing upgraders work
  until age-out. Defund-by-priority applied to consumers — the correct
  class per the bandaid-rules trap entry.
- **Adoption (burst mode, expansion groundwork)**: OrphanRescue routes any
  corpless creep to a kind that claimsOrphan; today only harvest/carry
  claim. Add claimsOrphan to the construction kind (accept W/C bodies
  while sites stand), then a deliberate release = same-tick adoption,
  staffsPost symmetry preserved because corpId is the census key on both
  sides. Body math: building burns 5 e/t per WORK (vs 1 upgrading), so
  the circulation body (5C) is also what makes adopted upgraders good
  burst-builders (1C = ferry-bound). The flagship use is FOUNDING — a new
  spawn site adopting the home upgrader fleet for one build burst. The
  reverse flow (spent builders adopted into upgrading) uses the same seam.

## Sequencing

1. Placement fix + legacy-buffer quality check (small, live gate): 6 -> 8
   park tiles, ceiling >= relay. Red-first pins on controllerInputSpot's
   accept/migrate rule.
2. Circulation behavior + a few CARRY in the containerFed body: removes
   the tile cap for focus pushes; grid cell ratchets burn at a staged
   relay.
3. Input SET + controller link (retires the feeder corp); claimsOrphan on
   construction as expansion groundwork.

## Acceptance sketch

- Parking lens reports 8 at a range-2 input in open terrain; a legacy
  range-3 container migrates (old decays, new ring adopted by all lenses).
- Circulation: staged relay N, fleet > park tiles, measured burn ~= N with
  ring-tile occupancy < 100% (no deadlock, no starved units).
- Link rung: feeder corp retires with zero stranded creeps (attrition,
  not revocation); plan spawn-load drops by the feeder's 64p pricing.
