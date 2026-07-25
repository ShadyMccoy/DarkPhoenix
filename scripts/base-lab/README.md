# base-lab — iterate on base designs, measured

A read-only lab for exploring base layouts (highways + extension fill) on real
captured rooms, and pricing them in the extension refill sim. Nothing here
touches the live planner; it is a design sandbox.

## The three tools

| command | what it measures |
|---|---|
| `npm run lab -- <room> [--fill alveoli\|pockets] [--dead-bias N] [--commute N]` | PLACEMENT geometry — ASCII overlay + compactness / outskirts metrics |
| `npm run lab:sim -- <room> [--carry C --move M] [--roads ducts\|none] [--bias a,b,c] [--commute N]` | REFILL — feeds the geometry into the extension sim, latency in ticks |
| `scripts/extension-sim/*` | the underlying refill engine (see its own README) |

`--list` enumerates the 34 real fixtures; `--synthetic` uses a RoomBuilder room.

## The design model

- **Core pocket** — a 3×3 at the spawn spot: the 0-MOVE manager seat ringed by
  storage / terminal / link / towers / spawn. The hub the arteries radiate from.
- **Highways = the hauler routes** — a-priori A* paths core↔sources, ↔controller,
  ↔exits (remote hauling / defense). Terrain-shaped, kept clear. (Offline A*
  with plain 2 / swamp 10 stands in for the live PathFinder planner.)
- **Extensions = dead-end "suburbs"** — a checkerboard flood (even tiles hold
  extensions, odd tiles are walkable ducts) grown OUTWARD from the core, biased
  toward the dead-end outskirts off the arteries, bounded by a commute cap.
- **Building loadout** — RCL8's 3 spawns / 6 towers / 10-lab cluster, placed in
  dead-space so the extension field competes with them for the quiet space.

## Findings (2026-07-25 sweep)

Measured across 5 fixtures spanning 13%→74% wall, RCL8 loadout (3 spawns),
paved ducts, 1 tender, ~1000t.

1. **Extensions belong in the dead-end suburbs, grown from the core.** Not
   wall-seeking (that scatters); nearest-first from the core so trips stay short
   (compactness wins refill), running into walls and around arteries as it
   spreads. The wall-hugging shape is emergent.

2. **The dead-bias MUST be commute-capped.** Unbounded, it marches extensions
   into open-room wilderness — bias 2 on a 13%-wall room sprawled to 29 tiles
   from core, refill never-full, endFill 0.34, spawns gated. The cap (field ≤
   1.5× the tightest packing radius) makes it a safe monotonic knob everywhere:
   capped bias 1→2→3 clears the artery edge (23→14→7 extensions on it) at small
   cost (80→92t), all util 1.000.

3. **Congestion makes the bias free AND safe; open rooms need the cap.** On the
   74%-wall room bias is a literal no-op (walls already force the alveolar
   shape); at 40% it barely moves; below ~31% the cap is what keeps it sane.
   "Congested rooms are where this gets interesting" — confirmed and measured.

4. **Tender body ratio is regime- and geometry-dependent — 2:1 is the robust
   default, not universal.**
   - spread field + comfortable (1 spawn): 1:1 wins (latency = raw loaded speed).
   - spread field + stressed (3 spawns): 2:1 wins (bigger tank = fewer reload
     trips once reload-bottlenecked); 4:1 over-sheds MOVE and collapses.
   - tight corridor (sim finding #5): 2:1–3:1+ (barely moves loaded).

5. **Roads (pave the duct lattice) make MOVE-shed competitive, not dominant.**
   On a spread field, paving closes most of the gap (3:1 31t→23t) but 1:1 still
   edges it — the field's travel is the cost, and roads only halve it.

6. **The realistic loadout makes refill a real problem.** 3 spawns (3× drain) +
   labs/towers pushing extensions outward take refill from a toy 17t (1 spawn,
   no buildings) to 80–200t. Below that it is the "cannot lose" regime and
   nothing discriminates.

7. **Same-tick intent order is pinned** (`scripts/diag-feeder-ordering.ts`):
   transfer/withdraw resolve before the movement phase, so a creep that empties
   out on a tick steps FREE (fatigue 0). The basis for the whole low-MOVE
   feeder idea.

8. **Non-greedy feeders (`--policy`) rescue, they don't win.** `outbound-sweep`
   (head for the outermost hole, dribble en route, lighten-as-you-go, free empty
   return) recovers a pathological CARRY-heavy body under full-drain (40C10M
   224t greedy -> 136t swept) - but it only TIES a well-chosen greedy+2:1 (116t),
   and there is a MOVE floor (45C5M never-fulls even swept). `outbound-ration`
   (thin coat to reserve carry for the frontier) FAILS on full-size creeps
   (util 0.50): every extension must reach full or the next max body can't
   start, so spreading thin starves the spawn - rationing is a partial-drain
   idea. The dominant lever is TENDER COUNT: demand (~17 e/t/spawn, ~50 for 3)
   sits at one tender's ceiling, so a 2nd tender halves refill (65t) and washes
   out all body/policy cleverness. And every viable row is util 1.000 - refill
   65-136t is under a 50-part creep's 150t window, so full spawn capacity is
   always guaranteed; the latency is margin, not pass/fail.

9. **RCL8's 200-cap extensions make refill EASIER and turn the outskirts into
   reservoirs.** A legal creep is ≤50 parts (~2500e), but the RCL8 grid holds
   ~12,900e, so a spawn is a PARTIAL drain — measured on shard3-W1N6: of 60
   extensions, only **33 ever drain (working set); 27 stay ≥90% full all run**
   (outskirt reservoirs a legal creep never reaches), util 1.000. Contrast RCL6
   (50-cap): the whole grid fits inside one max body, so all 60 drain and one
   tender can't keep up (util 0.73). So the design point matters: RCL8 capacity
   is what LETS the dead-end-suburb layout work — the far extensions are free
   permanent storage; only the near working set needs fast refill. (`--rcl` on
   the bridge; `drained`/`reservoir` columns.)

10. **The RCL progression: buffer grows with tier; RCL7 is the tightest.** With
    the REAL per-tier loadout (`--rcl` sets ext count AND spawn count: 40/1,
    50/2, 60/3), all three tiers hold util 1.000 on a single 2:1 tender on
    shard3-W1N6:
    - RCL6 (40 ext, 1 spawn): full drain, **0 reservoir**, ~84t (24C12M paved) —
      the lone spawn (~17 e/t demand) + full window offset the full drain. Not
      tricky. NB the RCL6 grid holds only 2300e, so the tender must be <=46
      parts: a 50-part 33C17M (2500e) is NOT spawnable here (the bridge now
      warns). Roads only help a 2:1 tender (95->78t for 30C15M); a 1:1 is 86t
      either way, so the pave-the-ducts win is contingent on a CARRY-heavy body.
    - RCL7 (50 ext, 2 spawn): near-full drain, **6 reservoir**, 108t — tightest
      on both axes; where a 2nd tender first earns margin (108t -> 64t). Holds
      across open (82t) and congested (84t) maps.
    - RCL8 (60 ext, 3 spawn): 58% drain, **27 reservoir**, 115t — most headroom.

    Headroom ranking: RCL8 > RCL6 > RCL7. None fail with a sane 1-tender/2:1
    setup; RCL7 is the one to watch. (Earlier "RCL6 struggles" was an artifact
    of forcing the RCL8 count of 60 ext + 3 spawns at RCL6 caps.)

11. **A well-ordered circuit DOES match greedy — the earlier failure was a bad
    route, not a fundamental limit.** (owner was right to be skeptical.)
    Swapping the DFS Euler-tour circuit for a RADIAL single-visit order took
    circuit-loop from util 0.09-0.17 to **0.95 / 0.99 / 0.99** at RCL6/7/8,
    essentially matching greedy's 1.000. The Euler tour was ~2.8x too long
    (backtracked every corridor) and non-radial (its head dived into a deep
    branch, so reset-after-reload missed the near empties). A radial order
    services the near ring first and reloads on short trips - greedy's behaviour
    baked into a fixed route. Remaining: a ~0.006 util gap (fixed order isn't
    perfectly adaptive) and the route is radial-order-with-short-hops, not yet
    fully contiguous - a true adjacent-step spiral would make it pure move(dir)
    with zero pathfinding (the full CPU win). Prior write-up (kept for the
    record) wrongly called this fundamental:

    One greedy tender is a fine CPU-minimal baseline; a circuit can't beat it on a
    CENTER-FED spread field with a BAD route — but a radial route matches it.
    Avoiding extra tenders is the CPU win that matters (each creep ~0.4 CPU/tick
    + its own pathing), and one greedy tender already holds util 1.000 at every
    RCL. A serious `circuit-loop` policy was built to try to cut the lone
    tender's pathfinding — contiguous DFS Euler-tour, confined to the working
    set, no head-reset, circuit-aligned draw, storage/spawn tiles excluded (an
    early version froze because the storage tile leaked into the lane as a
    range-0 target). Even fully fixed it loses: RCL7 reaches util 0.99 but
    RCL6/8 collapse to 0.09-0.17. The trace shows why — the tender fills OUTWARD
    along the circuit, empties deep in the field, then must deadhead back to the
    CENTRAL storage to reload (O(radius) per load; the working set needs ~5
    loads at RCL8 since 38x200 >> any legal tender). Greedy wins by staying
    LOCAL (fill nearest, reload nearby). Draw order and head-reset don't change
    it: the policy x draw matrix (lane-patrol/circuit-loop x circuit/near-reload)
    all converge — RCL7 ~0.99 (nearly works; small active region under partial
    drain), RCL8 0.168 (3-spawn drain outpaces a route-follower). The wall: at
    RCL8 the working set holds 7600e but a legal tender holds 1650e, so any pass
    needs ~5 reloads; greedy makes each LOCAL, a fixed route can't. Deeper point:
    in a sim that doesn't charge CPU a smart circuit can at best TIE greedy
    (greedy already picks the nearest empty every tick); its only real edge is
    CPU, and greedy's is already low (moveTo caches paths). So one greedy tender
    is the design; the only version that could pay is a loop-skipping circuit
    that JUMPS between active loops without pathing (a hierarchical loop
    structure) — unbuilt. circuit-loop is kept as a working RCL6/7 option.

12. **The endpoint: a dense serpentine STRING, serviced by one lane tender,
    beats greedy-on-a-blob.** (owner's insight - "extensions in a long string,
    only in/out".) A 1D string collapses the tender's movement to in/out (one
    index, reload = all the way out, far end = reservoir tail), so it's contiguous
    and CPU-trivial. Measured on the sim's string layouts (RCL8, 1 tender,
    util 1.000): on the DIAGONAL stripe, lane-patrol refills in **72t vs greedy's
    80t** - faster AND cheaper. Two qualifiers: density matters (diagonal ~5.5
    ext/lane-tile beats the thin spine ~1.9, where the circuit slows), and use
    head-reset `lane-patrol` (reset-to-mouth) not `circuit-loop` for a 1D string
    (spine circuit-loop tanked to 218t). This resolves finding #11: the circuit
    isn't the problem, the alveolar BLOB is - a string layout makes the circuit
    win. Next build: base-lab should generate a real-terrain diagonal serpentine
    (thread the stripe through dead-space around walls/highways) and feed its
    spine as the lane, instead of the alveolar blob.

13. **Real-terrain serpentine generator (`--fill serpentine`) built and works.**
    Lays a diagonal-stripe string (every 3rd diagonal is the tender lane,
    extensions on the two stripes between) through the dead-space, WRAPPING at
    boundaries (the walk turns) and SPLITTING with BFS bridges when a run ends
    (bridges may cross highways/swamp - the tender can traverse them, it just
    can't build there). Emits the contiguous spine as `plan.lane`; reports splits
    / bridge tiles. Two bugs found and fixed during the build: bridges wrongly
    excluded highways (isolated the start on highway-heavy rooms), and the start
    could land in a structure-boxed pocket (fixed by walking the LARGEST
    bridge-connected lane component, not the core-nearest tile - the core's own
    neighbours are all pocket structures). Result across 5 maps (13-74% wall,
    RCL8): all place 60/60; a single lane-patrol tender matches greedy util
    1.000 on 4/5 (W7N3 31% trails at 0.935, its string is more fragmented).
    Splits 8-20 track per-room fragmentation (not monotonic in wall% - a small
    congested region can need fewer bridges than a big open one). This delivers
    the owner's "long string, in/out" design on real terrain with one CPU-cheap
    tender.

14. **Tender-aware core placement fixes the W7N3 corner (0.935 -> 1.000).**
    `pickSpawnSpot` (centroid-nearest open tile) landed the core in a corner
    (5,23) clearance 2, forcing a stretched high-bridge string. `pickCore`
    scores each candidate by TENDER cost - `tenderReach` (BFS radius at which
    enough checkerboard slots are within reach to hold `target`, i.e. field
    compactness the tender pays) + w*anchorDist (hauler-route length) - and
    minimises. Core moved to (11,12) clearance 3; serpentine lane-patrol util
    0.935 -> 1.000, and all 5 maps (13-74% wall) now hold util 1.000 for both
    serpentine and alveoli (no regression). Incorporating the tender/extension
    score into spawn placement, as the owner suggested, is the single biggest
    lever for string quality.

## Caveats

- Policies tested: greedy-nearest, outbound-sweep, outbound-ration (see finding
  #8). A duct-circuit `lane-patrol` for the alveolar lattice and multiple
  stationary fillers (one per pocket) are still untested.
- Highways use an a-priori A*, not the live empirical `roadHeatmap`.
- Sim is deterministic (no RNG), single room, no creep-collision traffic; labs
  occupy tiles but don't react. Lab cluster geometry is plausible, not verified
  for every reaction pair.
- These are DESIGN measurements, not live-readiness claims.

## Open opportunities

- Distributed fillers (tenderCount per pocket) vs one roaming tender.
- A duct-circuit draw order for the alveolar lattice.
- Evolve extension positions on real terrain (point `extension-sim/evolve.ts`
  at a base-lab room — the walls+size work unblocked this).
- Auto-tune dead-bias / commute from measured refill per room.
