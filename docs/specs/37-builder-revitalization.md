# Spec 37 — Builder revitalization

**Status: BACKLOG (owner 2026-07-30). This spec is a PROBLEM INVENTORY, not a
design.** The owner's instruction for this document: *"Identify the current
status and problems more than the solutions."* Solutions are deliberately
sketched at the end and non-binding; the evidence is the contract. Slated for
a dedicated session — three construction changes already shipped 2026-07-30
and the measurement windows must not be muddied further (attribution
discipline, CLAUDE.md trap list).

## The owner's framing (verbatim, 2026-07-30)

> "I don't really understand why building is causing us so many problems. It
> seems like it's just the exact same thing as upgrading and hauling. Just
> spawn the right side creep and start sending the energy there and the
> construction sites get built."

> "Instead, we have tiny builders and they're not getting fed energy
> appropriately."

Both observations are measured facts (below), and both trace to the same
mechanism. The physics ARE identical to upgrading — a WORK part eats energy
and emits progress. What differs is that upgrading has its two hard questions
(*where is the sink? where is the fuel?*) answered structurally, before the
code runs, while construction re-answers both every tick:

| | UpgradingCorp + feeder | ConstructionCorp |
|---|---|---|
| lines | 807 + 542 | 2,963 |
| fuel-location decision sites | **0** | **22** |
| sink position | fixed forever (controller) | plural, transient, often cross-room |
| fuel position | structural (controller container/link) | computed per tick (`buildFuelPos`) |
| extra jobs | none (feeder is a separate corp) | placement policy, build, maintenance detail, own tanker vector |

Three of the four construction defects found on 2026-07-30 trace to the fuel
question alone; the fourth came from the maintenance moonlighting.

## Measured state (capture t72676360, committed as fixture)

```
building-W43N23-construction   6 creeps, 176 parts
    work: 2   carry: 146   move: 28          ← 83% CARRY, 2 WORK total
poolWork  "W41N23:3826"                       ← frozen across 269t
tankers 4, vectorFed true                     ← shuttle from home storage, 2 rooms
sourceBuffers d01f (IN W41N23) = 4263         ← CHRONIC, 100% of window (E6)
P8 build delivery: ~0 e/t vs plan alloc 20    ← the colony's build rate
```

Colony-wide theoretical build capacity: **10 e/t** (2 WORK × 5). The plan
allocates 20 e/t. Best measured delivery over a clean window: **0.37 e/t**
(t72675270→t72676091, dt 821).

## Problem inventory (each with its evidence)

### P-A. The fuel lens ignores geometry — THE ROOT PROBLEM, still open

`buildFuelPos` (ConstructionCorp.ts:~2836):

```ts
const surplusBanked = bank?.my && spendableBankSurplus(...) > 0;
return (surplusBanked ? bank!.pos : site.pos.findClosestByRange(FIND_SOURCES)?.pos) ?? null;
```

The home bank holds 351k, so `surplusBanked` is ALWAYS true and fuel is ALWAYS
home storage — **regardless of the site's position**. The `else` branch
(nearest source to the SITE) is the right answer for the live incident and is
never taken. Measured consequence: the pool builder stands dry in W41N23
beside its own road sites while 4,263 energy rots at source d01f *in that same
room*, and the colony funds a 4-tanker, ~100-tile shuttle to feed it from
home.

### P-B. One wrong distance poisons THREE consumers of it

`buildFuelDistance` prices the cross-room leg at `roomLinearDistance × 50 =
100`. That single number:

1. **Deletes the WORK.** `refuelIntervalTicks(100)` ≈ 101 →
   `bufferCarryParts` demands **81 CARRY** (4,050 energy) of onboard buffer
   for an 8-WORK builder; `buildBuilderBody` shrinks-to-fit and WORK is what
   gets crushed. Measured ladder: fuel at d=4 → 4 CARRY (200e); d=100 → 81
   CARRY (4,050e). This IS the owner's "tiny builders."
2. **Buys the wrong fleet.** `supplyMethod(rate, 100)` → "vector" → tankerPlan
   fields ≥2 (measured 4) tankers for the long shuttle.
3. **Slows the feedback loop.** The vector round trip exceeds short audit
   windows, so build progress reads 0 in any capture window < ~1 round trip
   (see Measurement traps).

Self-reinforcing: more distance → bigger buffer → less WORK → slower burn →
the vector matters more.

### P-C. The fill-toggle deadlock class (partially neutralized, still latent)

`runBuilder`'s fetch path: `memory.working` flips to true only at **100%
fill**; `doBuild` is the ONLY setter of `buildTargetId` and runs only when
`working`. So a builder that never reaches a full store never latches and
never builds — indistinguishable in the old stamp from one mid-walk. The
vectorFed path bypasses the toggle (builds whenever `store.energy > 0`), so
this class is dormant WHILE a vector exists — it returns whenever supplyMethod
says "direct" (now bounded, see P-E) or the tanker fleet dies.

Known stamp defect (recorded t72676091): the vectorFed path never sets
`memory.working`, so a correctly-parked, fed builder stamps **"F"** (reads as
"stuck fetching"). Encode parked-dry vs parked-fed distinctly.

### P-D. Construction moonlights as maintenance (fixed for the last-builder case)

`assignRepairDetail` conscripted `members[0]` — an arbitrary body, measured
88 parts — whenever anything wanted maintenance. With a crew of one, the
ENTIRE build force became the road-repair detail (owner report: "there's a big
builder, but he's going around repairing roads instead"; stamp t72674879:
crew 1, buildTargets "R", 15 sites standing, 20 e/t allocated, P8 FAIL).
Fixed 2026-07-30 (`repairDetailRecruit` + smallest-body pick, commit 7ab1dfc)
— but the structural fact remains: the build corp owns a second job with its
own demand policy, and the two compete inside one crew.

Related, same day: the tower's 500/500 refill/repair dead point meant the
tower did NOT absorb near-spawn road decay, pushing more maintenance onto
builders (fixed, `towerRefillBelow`, commit 4d068da).

### P-E. The plan priced behaviors the runtime never performs (fixed, guard in place)

`supplyMethod`'s two part-curves RECROSS at long range, handing the verdict
back to "direct" (self-fetch) at distance ~100 — where `doPickup` scavenges
range 4 and never travels. Result: no tanker fielded, builder starved in F
state beside 15 sites (P8 FAIL t72675271, 3.6% margin at rate 20: 241.5 vs
250.4 parts). Fixed 2026-07-30: `DIRECT_DRAW_REACH` bounds the verdict and
`doPickup` reads the same constant (commit 6045353; verified live: tankers
0→3, P8 0→0.37 e/t). The bound is a GUARD — the lens still produces the
absurd distance the guard defends against (P-A/P-B are the disease).

### P-F. Too many notions of "where"

Four distinct location concepts flow through one work() pass: `workRoom` (the
corp's nodeId room), `buildRoom` (pool head's room), `poolHead.roomName`
(possibly blind/receipt-only), and each creep's actual `creep.room`. The v10
stamp had to export `crewAt`/`crewHome`/`buildRoom` separately because no two
of them agree in general (measured: `crewAt "W41N23,W43N23"` — the crew
straddles rooms as newborns march). Every pairwise disagreement is a place a
targeting/fueling decision can read the wrong room.

### P-G. Falsified hypotheses (recorded so nobody re-chases them)

- **Blind-receipt-head oscillation** (pool ranks home-first-then-distance, a
  distance-1 blind room outranking the distance-2 real-site room): FALSIFIED
  t72675271 — `poolHeadBlind 0, poolRooms 1`; the pool was one visible room.
- **Non-detail builders divert to road repair**: falsified by code read —
  `pickCriticalRepairTarget` was an unused import (removed).
- **The pile gate caused the runt-economy flake**: unverified→withdrawn; the
  working diagnostic showed `buffered: 0` in that world.

## P-H. The last-builder invariant is only HALF implemented (measured t72687812)

`repairDetailRecruit` (shipped 2026-07-30 for P-D) prevents *recruiting* the
last builder onto the repair detail while build work stands. It does not
*release* one when the crew SHRINKS to one by attrition — the detail flag is
sticky and the clear path keys only on "nothing wants maintenance". So the
forbidden state is still reachable, just by a different road:

```
building-W43N23-construction  crew 1  onRepairDetail 1  buildTargets "R"
  buildWork true   poolWork "W43N23:7200,W43N22:3300,W44N22:9300"  (19,800e)
```

I wrote an INVARIANT as a one-time DECISION. "A lone builder is never on the
detail while build work stands" must hold every tick, not only at recruit
time.

**Cost is bounded, which is why this is filed and not hot-patched**: colony
build capacity is 7 WORK across six corps (home 2 + five remotes × 1) against
38.3 e/t allocated, and P8 measured 10.51 e/t in the same window — the remote
corps carry the campaign. The lone home detail is ~2 of 7 WORK, not a stall.

**And the obvious fix is a trap.** A naive "release the lone detail" re-opens
cons-repair-stops-at-99: that incident's container sat at **55%** — below the
0.6 spawn gate but ABOVE the 0.3 critical gate — so a crew-1 release would
strand it exactly as before. The `+1` detail demand is supposed to field a
second body, but the live stamp shows `wantsMaintenance: true` with crew 1,
i.e. the second builder is NOT arriving (construction loses the saturated
spawn queue on priority). So the real question is which of build-vs-repair
that single body is worth more on — a PRICING question, which is this spec's
whole thesis, not a third patch to `assignRepairDetail`. Trap list: the second
patch on one mechanism means the mechanism is the bug.

## Measurement traps (cost this session real verdicts)

- **P8 windows shorter than one supply round trip read 0.** dt=269 at a
  ~100-tile-each-way shuttle produced a false "CREW IDLE" FAIL; `poolWork`
  identical-to-the-digit across a short window is the tell. Read build
  delivery over ≥1 full round trip of the CURRENT fuel geometry.
- **Global resets inside the window** (each deploy) reset meters and inflate
  churn lines for ~1 window.
- **runt-economy is flaky** (documented; exits 0 while reporting failures in
  one mode, and fails ~1-in-N on the 2→3 WORK transition). N=1 vs N=1 cannot
  attribute a red; re-run before blaming a change (2026-07-30: pre-change
  PASS + post-change re-run PASS acquitted the tower commit).

## What already works (do not break while fixing)

- The build-side LATCH (`nextBuildTarget` — finish a site, then nearest next,
  ladder-ranked by `buildRank`); no ping-pong observed since.
- Batch placement + surplus-gated widening (`placementGateOpen`), storage-depot
  bootstrap protected by the empty-board rule.
- The repair detail with the last-builder rule + critical pierce.
- Remote-room corps (container-from-pile rung) — the pile IS the fuel there,
  which is exactly the pattern P-A should generalize.
- The v10 pool/crew stamp — the observability that produced this inventory.

## Acceptance shape (what DONE means, phrased as measurements)

1. P8 ≈ plan allocation over a ≥1-round-trip window (target: within the
   multi-draw ±30% band of 20 e/t at current allocation).
2. Builder bodies WORK-majority at steady state in a surplus room (the 2/146
   inversion gone); buffer sized to the ACTUAL fuel distance.
3. No standing supply shuttle past adequate same-room fuel: if the site room
   holds a pile/container ≥ the crew's burn over its refuel interval, the
   crew feeds locally (E6's chronic d01f-class piles drain instead of rot).
4. `buildTargets` stamp distinguishes parked-fed / parked-dry / fetching /
   building; no state reads as another.
5. The fill-toggle class (P-C) is structurally unreachable, not just dormant.
6. Full trio green + the grid cells nearest construction unchanged-or-better;
   every fix lands red-first per the audit protocol.

## Direction (non-binding, one paragraph)

The remote rung already shows the shape: fuel is *the nearest adequate energy
to the site* — pile, container, source, or bank — chosen by distance-adjusted
adequacy, not by a global "is the bank in surplus" flag. With that one lens
fixed, `buildFuelDistance` collapses to a small number in the common case,
the buffer term stops eating bodies (P-B), supplyMethod's verdict becomes
boring (P-E's guard rarely binds), and most of the tanker fleet becomes
unnecessary. The deeper simplification — construction as "park a consumer,
point the standing feeder apparatus at it," with placement and maintenance as
separate concerns — is the upgrading symmetry the owner named; it should be
evaluated AFTER the fuel lens lands and is measured, not bundled with it.
