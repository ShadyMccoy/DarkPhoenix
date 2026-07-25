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
