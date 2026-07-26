# 31 — Base layout: highways + a serpentine extension string, one lane tender

**Status:** PROPOSED 2026-07-25 (owner session). The DESIGN TOOLING is landed
(`scripts/base-lab/*` + the extension-sim); the measured design below holds
across a 13→74% wall fixture spread. What remains — and what this spec is — is
GRADUATING the layers to the live planner. Nothing here touches live behavior
yet; base-lab is an offline sandbox (real terrain in, ASCII + refill numbers
out), so treat every number as design evidence, not a live-readiness claim.

**Relation to spec 27 (extension relocation):** 27 moves the legacy field one
structure at a time; 31 defines the TARGET SHAPE it moves toward. 27's doctrine
("diagonal stripe where terrain allows, compact fallback, summed-trip-distance
scoring, keep the field permeable") is exactly what base-lab now generates and
measures. Land 31's generator and 27 has a concrete target to score against.

## Why

Live placement is per-structure greedy heuristics (`ConstructionCorp`
`findGridPosition` — a checkerboard blob around the spawn). base-lab designs the
WHOLE field terrain-adaptively and prices it in the refill sim. This is a
scale-out investment (compounds at RCL7+ per spec 27), not a leak fix.

## Doctrine (measured in base-lab; full trail in `scripts/base-lab/README.md`)

1. **Highways = the hauler routes**, kept clear. Arteries are the a-priori
   routes core↔sources, ↔controller, ↔exits — WALKABLE but UNBUILDABLE (a creep
   crosses an artery, it just can't build on it). Reserving them costs little
   refill on open rooms and nothing on congested ones (walls self-limit).
2. **Extensions = dead-end "suburbs"** grown OUTWARD from the core into the
   dead-space, biased toward the low-traffic outskirts but **commute-capped** —
   an unbounded dead-space bias sprawls into open-room wilderness (measured: bias
   2 on a 13%-wall room → field 29 tiles out, refill never-full, endFill 0.34).
3. **RCL8's 200-cap extensions make refill EASIER**: a legal 50-part creep
   (~2500e) only partially drains the ~12,900e grid, so ~27 of 60 extensions
   never drain (reservoirs). The refill problem is a tight near-core WORKING SET;
   the outskirts are free permanent storage. (RCL6/7 are tighter — RCL7 is the
   least-headroom tier: near-full drain + 2 spawns.)
4. **The winning shape is a DENSE diagonal serpentine STRING, not a 2D blob.**
   On a string the tender's world is 1D — in toward the tail, out to the mouth
   (core) to reload; the far end is the reservoir tail. Measured: on the diagonal
   stripe a lane tender refills FASTER than greedy (72t vs 80t, RCL8). A 2D blob
   forced greedy behavior; the string makes a cached circuit win.
5. **One lane tender services it**, in/out along the contiguous spine — no
   pathfinding, no second creep (the CPU win; each extra tender ~0.4 CPU/tick +
   its own pathing). Across the fixture spread it holds util 1.000 on a single
   2:1 tender. Body is sized to the RCL grid (a 50-part tender is unspawnable at
   RCL6's 2300e); roads (paved ducts) only pay for a CARRY-heavy body.
6. **Tender-aware core placement** is the biggest lever for string quality: score
   candidate cores by `tenderReach` (BFS radius to fit the field = compactness
   the tender pays) + anchor distance, not centroid-nearest. Fixed the W7N3
   corner spawn (0.935 → 1.000).
6a. **REMOTE-FLOW-AWARE core placement (owner 2026-07-26).** Today `pickCore`
   scores IN-ROOM cost only — `tenderReach` + `anchorDist` over the in-room
   sources and controller — and reserves a highway to EVERY exit uniformly. It
   is blind to the remote economy that actually feeds the core: for W43N23, four
   remote rooms (W42N22/W42N23/W43N24/W44N23) converge here, yet the generator
   would center storage on in-room refill and make every remote hauler walk
   farther through a longer in-room approach — a plausible contributor to the
   measured en-route convergence congestion (idleSink en-route 0.14–0.32,
   t72595222). Requirement: fold the REMOTE haul into the core score and the
   highway priority —
   - add a term weighting `anchorDist` by the **volume-weighted exit directions**
     of the planned remote mining (each remote source's rate projected to the
     room edge it enters through), so the core is pulled toward where the bulk of
     remote energy arrives, not just toward the local sources;
   - **prioritize the highway to the heaviest-flow exit** (widen / straighten it
     first) instead of treating all exits equally;
   - keep it a TERM in the founding valuation (like tenderReach), never a swap of
     the economics — co-optimize the base for the remote economy AND in-room
     refill, don't trade one for the other.
   This is the placement lever the iterative remodeler (above) should exercise:
   re-placing the core with remote flow in mind is exactly the kind of target
   update a remodel exists to apply.
7. Real terrain breaks a pure diagonal, so the generator **WRAPS** (turns to stay
   contiguous) and **SPLITS** with BFS bridges (crossing highways/swamp as
   traverse) — emitting ONE ordered contiguous lane; a split is just a
   low-density stretch. Split/bridge count is the per-room "how much did we
   cheat" quality gauge (a runaway count flags a poorly-sited or ill-fitting
   room). Confine the walk to the largest bridge-connected lane component so a
   structure-boxed pocket can't strand the start.

## Tools (landed)

- `scripts/base-lab/` — `index.ts` (ASCII overlay + metrics), `plan.ts`
  (`planBase`: core placement, highways, `alveoli`/`pockets`/`serpentine` fills),
  `geometry.ts` (distance-transform, A* highways, traffic-proximity field, exits),
  `stamps.ts` (core/ring/lab stamps), `highways.ts`, `sim-bridge.ts` (feeds a
  base-lab geometry into the extension-sim: walls, spawns, extensions,
  highways-as-reserved → refill in ticks). `npm run lab` / `npm run lab:sim`.
- `scripts/extension-sim/` — the refill engine (walls, reserved, drain-depth
  reservoirs, tender policies incl. `lane-patrol`/`circuit-loop`).

## Phases

1. **Design tooling — LANDED.** Offline layout + refill sim across the fixture
   spread; all 5 maps (13–74% wall) place 60/60 with one lane tender at util
   1.000.
2. **Graduate the layers to live** (the work):
   a. **Tender-aware core placement** — fold `tenderReach` into the founding
      spawn choice. CAUTION (per `spatial/spawnPlacement.ts` header): the live
      founding tile is the econ-optimal `spawnSiteValue`, NOT a geometry pick;
      add `tenderReach` as a TERM in that valuation, don't swap economics for
      geometry. Add the **remote-flow term (6a)** here too — the founding/
      re-placement valuation weights the volume-weighted remote-exit directions
      alongside `tenderReach` and the in-room anchors.
   b. **Serpentine placement** in `ConstructionCorp` — replace/augment
      `findGridPosition` with the string generator; highways from the existing
      `planTrunkPath` routes (reserve, don't build on).
   c. **Lane tender** — a corp kind (or `ExtensionTenderCorp` variant) running
      the cached spine in/out (`lane-patrol`), body RCL-sized, one per field.
3. **Verify on the grid (spec 08).**

## Acceptance tests (the contract — write first)

- **Unit (`test/unit/...`):**
  - `pickCore` on staged terrain whose anchors pull toward a corner returns a
    core with clearance ≥ 3 (not the corner), and beats `pickSpawnSpot`'s
    `tenderReach` on that layout.
  - The serpentine generator on three staged rooms (open / walled / highway-
    carved) places the target extension count, emits a CONTIGUOUS lane (every
    consecutive tile 8-adjacent), never builds on a wall/swamp/highway/anchor,
    and reports splits/bridge tiles.
  - Component-confinement: a room with a structure-boxed near-core pocket still
    yields a full-length spine (not the 1-tile regression).
- **Integration / grid (`test/grid/cells/...`):** stage an open AND a congested
  room with a serpentine field + one RCL-sized lane tender; assert util 1.000
  and endFill ≥ 0.95 over the window, extensions all placed. Stage the
  `roadRoutes` receipts (sim blind spot — paved-duct/highway gates never fire
  otherwise). Regression trio (`flow-handoff`, `runt-economy`, `storage-depot`)
  green.

## Honest limits / open

- Validated OFFLINE (base-lab) + in the refill sim, NOT live. Sim blind spots
  apply (no spawn-id churn, vision loss, NPC raids, and no `roadRoutes` receipts
  unless staged) — grid cells must stage receipts for any receipts-gated path.
- W7N3-class rooms still bridge more than an ideal contiguous spiral would
  (16 splits / ~470 bridge tiles even after the core fix); a true adjacent-step
  spiral construction would cut the wasted traverse. Split count is the signal.
- RCL7 is the tight tier (least reservoir headroom); if a single tender ever
  breaches there live, the lever is a 2:1→bigger body or (last resort) a 2nd
  tender, not a layout change.

## Remodeling must be ITERATIVE and re-runnable (owner 2026-07-26)

"It could happen in the future that we update our base layout logic and may need
to do some remodeling. We won't always get it right on the first try."

So the graduation-to-live work is not a one-shot "stamp the target and build it."
The layout GENERATOR will keep improving, so the remodeler must be a CONVERGENCE
loop: given the current live base and the CURRENT target shape (whatever the
generator now emits), compute the diff and move the base one safe step toward it
— re-runnable every time the target changes, from any partially-built state.
Requirements this implies:
- **Idempotent + resumable:** re-running against an already-on-target base is a
  no-op; re-running after the target CHANGES resumes from wherever the base is,
  never assumes a greenfield.
- **Safe, reversible steps** (spec 27's one-structure-at-a-time relocation is the
  unit): never tear down load-bearing infrastructure (storage/spawn/tower/link)
  without its replacement already placed and staffed; a remodel in progress must
  leave the colony functional every tick (no "demolish the field then rebuild"
  window).
- **Instrumented:** each remodel step stamps before/after (refill duty, haul
  congestion, energy spent on the move) so a layout-logic change that makes
  things WORSE is caught and can be rolled back — we will get it wrong sometimes,
  so the remodeler must make "wrong" cheap and visible, not catastrophic.
- **Bounded cost:** capex per window is capped so a re-plan can't stall the
  economy churning structures.

The measure of a good remodeler is that a BAD target update costs a little
wasted capex and a rollback, not a bricked base.

## Relation

- **27 (extension relocation):** 31 is the target-shape engine 27 scores against;
  27's one-at-a-time safe-move mechanism is the unit step of the iterative
  remodeler above.
- **32 (graceful mining backoff):** a fail-graceful production knob; unrelated to
  layout but the same "match to reality, keep the leak visible" discipline.
- **16 (construction as projects):** serpentine placement rides the project path.
- **26 (links as hub ports):** an outskirt/field link kills the tender's central-
  reload deadhead — the one change that would let CARRY-heavy bodies win outright.
- **24 (controller geometry), 29 (CPU):** the single-tender in/out design is the
  CPU-minimal service model; controller-area geometry is the same string idea for
  upgraders.
