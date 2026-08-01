# 15 — Waste ledger: make every leak a measured number

**Status:** proposed 2026-07-18 (owner directive: "identify, measure,
eliminate or minimize any wastes of CPU, energy, or spawn time, either in
planning or execution — make the basic mechanics sing"). Phase 1 is
audit-side only (no bot changes); phases 2–4 add in-bot counters via the
spec 14 decision-symmetry pattern.

## Principle

A leak that isn't a number is an anecdote. Every waste class below gets a
NAME, a UNIT (energy/tick, parts/tick, CPU/tick), a MEASUREMENT SOURCE, and
a target (usually ~0; some have a floor by design). The audit loop
(`/production-audit`) ranks the ledger by size each cycle and attacks the
top line. "Eliminated" means the measured number went to target and a
regression test pins it.

Tonight's incidents, priced, seed the ledger: the reserver purchase loop
was E1+S1 (58 e/t + 53% of build time); the stranded remote haulers E2
(~2,800e of body, 45% of hauler fleet); the idle warchest E4 (594k, ~20×
target); the floored upgrader X1's mirror image (planned 30–44 e/t of
progress unconverted).

## The ledger

### Energy leaks (e/tick unless noted)

| id | leak | measurement |
|----|------|-------------|
| E1 | purchase-void: spawn energy on creeps that die before ~25% of expected life (loops, insta-recycles, doomed newborns) | phase 4 counter: per-corp life-fraction at death; until then, receipts × census diffing |
| E2 | stranded fleet: actual bodies serving routes absent from the current plan | EXISTS: flow plan carry/work vs segment-4 actual, per corp |
| E3 | ground decay: dropped energy rotting (1/1000/t), decaying containers | phase 2 counter in scavenge/room ledger: `decayLoss` |
| E4 | idle capital: `storageEnergy` above WARCHEST_TARGET with the spend path down | EXISTS: room ledger + feeder gate. **DAMPED-EQUILIBRIUM FRAME (owner 2026-07-29: "we would expect the surplus to maybe rise, until it reaches an equilibrium ... don't necessarily flag that as a red")**: spending is `surplus/SURPLUS_DRAIN_TICKS`, so the bank settles at `S* = reserve + SURPLUS_DRAIN_TICKS x netInflow`, NOT at the reserve. A bank RISING toward a finite absorbable `S*` (projected `excess + T x slope` below the draw knee `MAX_SURPLUS_DRAW x T`) with the spend path live is CONVERGENCE -> ok. FAIL is reserved for a projected equilibrium past the knee (income the spend path physically cannot absorb) or a big idle bank with `feederActive false`; flat/falling at a big surplus keeps a watch-level WARN (not convergence evidence, but never a deploy-blocking red) |
| E5 | runt purchases: bodies below the efficient floor bought from a drained spawn | EXISTS: agenda receipts (cost) + body floors |
| E6 | pile-gate masking: the miner buffer gate (`SOURCE_BUFFER_DEFER_THRESHOLD`, owner 2026-07-29) defers NEW miner bodies while a source mouth holds ≥2000 unhauled — a BACKSTOP against rot (E3) that frees spawn time, never a fix; left unwatched it would HIDE the haul deficit that built the pile (owner: "bad if it covers up hauling problems") | EXISTS: segment-4 harvest sizing stamps (v6: `gate` buffer-full/clear, `buffered`, `staffing`, `target`); ledger row E6 — CHRONIC gating (both captures) WARNs with the work item named as the HAUL side (drain term / route sizing / churn; the CarryCorp pickup stamps distinguish), a source DARK behind a full pile (gated, staffing 0 — income stopped) FAILs; pre-gate captures skip the row |

### Spawn-time leaks (parts/tick of the 1/3 ceiling)

| id | leak | measurement |
|----|------|-------------|
| S1 | loop/void purchases (S-side of E1) | same as E1; historically up to 0.18 parts/t (53%) |
| S2 | oscillation rebuilds: parts spawned for plans that flip within a creep lifetime | EXISTS: `candidates[]` verdict flips between captures × parts |
| S3 | scheduler stall: spawn idle while agenda queue is non-empty and affordable | EXISTS: meter `utilization` vs `queueDepth` + `fundingNeed` |
| S4 | replacement mistiming: double-orders or dark posts around handoffs | staffsPost cells pin the mechanism; phase 4 life-fraction exposes residuals |

### CPU leaks (CPU/tick of the 300 limit)

| id | leak | measurement |
|----|------|-------------|
| C1 | per-phase cost unknown: main-loop phases (plan, execute, telemetry, pathing) are unmetered in telemetry | phase 3: export bulkhead phase timings (main.ts already brackets phases) to core segment |
| C2 | recompute churn: replanning/pathing redone without input change | after C1: phase timings vs plan-input hash stability |

### Planning leaks

| id | leak | measurement |
|----|------|-------------|
| P1 | plan flap: sources/routes flipping funded↔excluded between solves | EXISTS: `candidates[]` diff between captures (flap rate, parts wasted → S2) |
| P2 | micro-routes: planned flows below the 3-CARRY body floor, each forcing an over-built body | EXISTS: flow `haulers[].carryParts < 3` (measured: 7/10 routes, 6.5 planned carry → ≥21 fielded) |
| P3 | budget-model divergence: planner `spawnPartsUsed` vs measured `partsPerTick` | EXISTS: both sides exported (plan spawnPartsUsed vs meter) |
| P4 | plan spawn-infeasibility: the WHOLE plan's amortized maintenance (parts/tick, ALL fleet classes — transient routes, consumers, infra, budgeted or not) vs the physical `spawnCount × 1/3` ceiling. Above 1.0 actuals converge to the ceiling, never the plan (measured 2026-07-18: 1.68×; the queue-priority incidents were the symptom). **Amendments (owner 2026-07-21, from the duty-gap finding — measured delivery 0.207–0.316 vs plan 0.307 vs ideal 0.333):** (a) the verdict must ALSO compare plan-implied vs the spawn meter's MEASURED partsPerTick (the ideal ceiling assumes 100% duty reality never delivers — the ~15-20% standing overdraft IS the perpetual queue); (b) GUARDS stay OFF-plan by doctrine ("guards are intermittent and should not be part of the plan") but their measured load appears as a labeled off-plan deduction — never a silent omission; (c) CONSTRUCTION-CREW TANKERS "definitely should be part of the plan" — home-site haulage already prices (bank→construction routes); the gap is REMOTE sites, which the solver does not admit — filed as a spec 25 acceptance criterion (no crew or its logistics outside the parts ledger) | EXISTS: ledger `planSpawnLoad` from flow plan + measured body ratios; duty-adjusted verdict + off-plan lines QUEUED |
| P5 | price/behavior drift: a pricing constant encodes a behavioral assumption the executor doesn't implement (found: `RESERVER_DUTY = 0.5` priced while the corp gate re-staffs continuously, never reading the reservation bank — 2× the priced spawn+energy cost). Every such constant gets a ledger check | ledger: structural check + staffing proxy; exact once phase 2 exports `reservation.ticksToEnd` |
| P6 | reservation under-pump: fielded CLAIM parts adding less bank than they should (walking between posts, blocked, dead — "reservers not reserving", owner 2026-07-19) | EXISTS: per-room `pump = bank2 − (bank1 − stampDt)` from the P5 sizing stamps; FAIL all-rooms-zero with parts fielded, WARN ≥half (first live read: W42N22 +20 W42N23 +66 W43N24 0 W44N23 0 over 156t — the one-way-violation churn as a number) |
| P7 | controller under-delivery: actual `ΔrclProgress/dt` vs the LOWER endpoint plan's controller allocation ("upgraders not upgrading") | EXISTS: ledger from rooms[] + flow sinks; FAIL <0.5× with stock >500 standing at both endpoints (the energy was there); the lower-endpoint comparator never false-fails a doctrine shift (construction preempt measured 86.3→2.0) |
| P8 | build under-delivery: sites standing, construction funded at both endpoints, summed site progress FLAT ("builders not building") | EXISTS (v6): rooms[] `siteProgress/siteTotal/siteCount` PLUS the `remoteSites` census in standing/completion and the `roadReceipts.built` ratchet as a remote-progress floor (gaps measured 2026-07-22: home-only P8 read "0 e/t / no sites" while cee0's trunk built 35→45, and again while W43N24 held 3 standing sites 2,171t with receipts frozen — the remote-only stall class); completions (count/total/remote drop) read ambiguous and are skipped; pre-v6 captures skip the row |
| P9 | mined-production rot: a funded miner whose output the plan never routes — the self-consistency invariant that had NO ledger line and scattered across E2/E4/P7 until the owner asked ("miner + complete container, no haulers", #19, 2026-07-19) | EXISTS: flow `sources[].harvestRate` (funded mining) vs `haulers[]` whose `sourceId` starts `source-` (mined-source routed); `ratio = routed/produced`; FAIL <0.5×, WARN <0.8× when >5 e/t is mined; measured live t72425058: 7 src / 70 e/t produced, 0 routed, ratio 0.00 — the 555k bank surplus out-competed real production at the nearest-first fill (fixed by production-first routing + storage-as-hub sink) |

### Execution leaks

| id | leak | measurement |
|----|------|-------------|
| X1 | dry WORK ticks: upgraders/builders in position with no energy to burn — the standing-but-idle waste class (owner doctrine 2026-07-21: "we always want the hauling and the working to grow in concert ... spawned as a package. Having body parts standing around, unable to do their job is one form of waste"; measured t72482220: 100 WORK standing at both endpoints, stock endpoint full, burn 48.7 of ~100 e/t — the missing half invisible to every endpoint read) | EXISTS (upgrader half): `Memory.upgradeMeter` tallied at the upgradeController call site (fired/dry per creep-tick, rolling 1500t), stamped as `workUtil`/`dryShare` in the sizing record; ledger row = standing WORK × (1 − workUtil), FAIL workUtil <0.7, WARN <0.85. `dryShare` names the supply-starved share — the half the **package-spawn remedy** targets: a consumer's bodies and its supply line (feeder/hauler capacity) priced and ordered as ONE transition, so neither half stands idle waiting for the other. Builder half still phase-2 |
| X2 | deadhead hauling: hauler ticks moving empty beyond the unavoidable return leg | phase 2 counter: loaded vs empty move ticks |
| X3 | idle creeps: alive, assigned nothing | phase 2 counter, plus census `untracked` (EXISTS) |
| X4 | lifetime quantization: a hauler's trip-tail remainder ticks that cannot fit another round trip | EXISTS: priced from the plan's routes, remainder/life × standing body cost; EOL recycle converts tails to refunds |
| X5 | rebuild churn: spawn energy spent replacing a creep that never reached EOL — pure waste under a saturated spawn (owner 2026-07-23: "continue investigating these types of churns ... the bot is so constrained that they all add up"; discovered live t72509177 — remote haulers spawned small then replaced full a few hundred ticks later, a reserver re-ordered 25t after itself, below a claim body's ~78t spawn time) | EXISTS: reads the blackbox spawn log (segment 5). Per corp, spawns BEYOND current staffing died-and-were-replaced (census cross-check excludes fleet GROWTH, e.g. the upgrader ramp); each weighted by unlived life-fraction (gap/lifetime) so natural EOL scores ~0, where the lifetime is the SAME-slot gap `ss[i+staffing] − ss[i]` — a staffing-N corp runs N interleaved slots, so consecutive spawns are DIFFERENT slots ~life/N apart and a cohort wave serialises N through one spawn; reading the consecutive gap booked phantom churn on any multi-room corp (fixed 2026-07-26: the 4-room reservation corp read 11828e "churn"@12t though every reserver lived ~656t; for staffing 1 the same-slot gap IS the consecutive gap, unchanged). HOME-role churn (bot signal) vs REMOTE-exposed churn (invader/revocation noise) split by role; verdict WARN on home >12% OR any same-slot respawn gap <60t (a re-order/loop, never a sequential death). A global reset inflates BOTH for ~1 window — read against the deploy log |

## Phases

1. **Ledger report (audit-side, no bot changes)** — a `scripts/waste-ledger.ts`
   that takes two captures and prints the ledger: every EXISTS row computed,
   ranked by magnitude, with deltas vs the previous run. **DONE 2026-07-18**
   (`npm run audit:ledger`, wired into /production-audit §1 as the mandatory
   first read). Acceptance retargeted to the v5 fixture pair
   (t72404213/t72411542) in `test/unit/audit/wasteLedger.test.ts`: P4 FAIL
   >1.2× with the unbudgeted transient line named, P5 FAIL until the corp
   reads the reservation bank, E4 FAIL at 601k idle, E2 catches 48 parts of
   stranded scavenge haulers, S3 discriminates a funding hold from a stall.
   (The originally named t72402541 numbers predate the v5 schema; that
   incident's mechanism is pinned by its own regression tests.) Origin of P4/
   P5: the owner had to ask "is planning weighting effective ttl" and walk the
   reserver arithmetic by hand — the audit must catch accounting invariants,
   not only symptoms.
2. **Execution counters in-bot** — X1/X2/X3 + E3 accumulated per corp
   (decision-symmetry: counted where the work happens), exported in sizing
   records / room ledger. Corps segment bump.
3. **CPU phase export** — C1 via existing main.ts bulkhead brackets into the
   core segment.
4. **Purchase-outcome tracking** — E1/S1: per-corp life-fraction-at-death
   histogram (died <25% / <50% / full), exported; the definitive
   loop-purchase detector.

Each phase red-first; live-behavior changes none (all observability) except
any fixes the ledger motivates, which follow the /production-audit fix
protocol.

## Non-goals

- No optimization without a ledger line first (no "this feels wasteful").
- No CPU micro-tuning while C1 is unmeasured.
- The ledger reports; it never throttles or decides in-bot.

### G1 — sustained progress (score net of bank drawdown)

**Added 2026-08-01 (owner: "add rate-at-bank-slope as a ledger row").** THE
GOAL METRIC. Raw pts/t is not it: the same colony scored **68.29 while burning
the bank at −45.52 e/t** and **47.59 while burning it at −5.74**. The first is a
stockpile liquidation that ends; the second is income.

**What the sum means** (derived, not asserted — the P10 lesson):

```
bankSlope = income − controller − spawn − construction
⇒ score + bankSlope = income − spawn − construction
```

i.e. the RESIDUAL the economy can sustainably route to the controller at its
current spawn and construction burn. Both terms are energy/tick (one GCL point
IS one energy delivered), so the addition is meaningful.

**Three regimes, not one axis** — the shape validation forced this:

| regime | reading | verdict |
|---|---|---|
| `score >> funded` | LIQUIDATION — the saw-tooth down-stroke | **FAIL** below 50% |
| `score ≈ funded` | matched — the healthy state | ok (measured 76–88%) |
| `score << funded` | UNDER-SPENDING — capacity banked, not delivered | WARN |

The third arm exists because validation caught the first draft calling the
t72703512 trough **"232% income-funded, ok"** — a compliment on the wasteful
quadrant (delivered 19.63 while banking +25.88). A share above 1 is not more
health; it is unconverted capacity, and it now reports as
`delivering X of Y sustainable`. Under-spending never outranks a liquidation:
it is real waste (OSC names the same quadrant from the fleet side) but it burns
no capital.

**Validated against every phase in the fixture set:** t72714129 88% ok,
t72701842 33% **FAIL**, t72703512 arc 76% ok, t72706408 trough **WARN
under-spending**.

**Stated limitation, carried in the detail line:** the bank slope also absorbs
construction spend and decay, so `funded` is "not drawn from storage", NOT
"converted to progress". It is a sustainability FLOOR, not an energy audit.
Shares an input with E4 but asks a different question — E4 asks whether capital
is idle, G1 asks what is paying for the score. Windows below 6,000 ticks are
labelled SHORT: they sample a phase of the ~9,000-tick limit cycle (see OSC).

### The ENERGY ACCOUNT (chart of accounts) — printed above the ledger

**Added 2026-08-01** (owner: *"we at one point had a sort of standardized chart
of accounts like an income statement on the audits ... the exact chart or
report will evolve over time"*). The precedent is the grid's `[overhead]` line
(`test/grid/cells/fidelity.ts`: mined / sinks / Δstock / decay / Δtransit /
**residual**) — a balanced energy account with a named residual. This is its
live counterpart.

```
ENERGY ACCOUNT  e/tick  (window 6686t; spawn ring 2710t)
  REVENUE
    gross mining (plan capacity)         100.00
    + pile drawdown / (build-up)           0.54
    = delivered into the economy         100.54
  OPERATING COST (measured at the spawn)
    producers  (miner, hauler)            24.69
    infra      (reserver, tender, feeder) 12.55
    defense    (guard)                     1.44
    consumers  (upgrader, builder)         5.54
    = total spawn                         44.21
  APPROPRIATIONS
    controller (score)                    47.59
    construction (site progress)           0.00
    to/(from) bank                        -5.74
    = total                               41.85
  ----------------------------------------------
  RESIDUAL (decay, rot, raids, error)     14.47   (14% of gross)
```

**It balances by construction, and the residual is the point.** It bounds
ground decay, rot above the container cap, raid losses, tower burn and
measurement error. It inherits spec 20's reconciliation discipline: a named
residual that cannot silently grow, because both sides are published. **A
residual that grows between cycles is a work item even when every leak row is
green.** First baseline: **14% of gross mining**.

**Honesty limits, carried in the printed footer:**
- REVENUE is the plan's mining CAPACITY less the measured pile change
  (`core.sourceBuffers`) — *not* a delivery meter. Income is deliberately NOT
  derived as the balancing figure; that would make the residual circular and
  meaningless.
- OPERATING COST *is* measured — the blackbox spawn ring, bucketed by role.
- APPROPRIATIONS are measured: controller from the GCL delta (one point IS one
  energy), construction reuses **P8's lens** (not a second implementation),
  bank from the storage delta.
- The ring and capture windows differ in length; each figure is normalised over
  its own and both appear in the header.

**RESERVING IS COST OF GOODS, not overhead** (owner 2026-08-01: *"reserving is
an overhead applied to the gross mining"*). The dependency is verifiable, not a
judgement call: the plan prices EVERY source at rate 10 =
`SOURCE_ENERGY_CAPACITY(3000) / SOURCE_REGEN_TIME(300)` — the **reserved**
yield. An unreserved remote regenerates 1500 per 300t, i.e. 5 e/t. So the
revenue line *assumes* reservation on all 8 remotes, and the reservation fleet
is buying **~40 e/t of the 100 e/t revenue** for **~10.6 e/t of bodies — a 3.8×
return**. Burying it in `infra` hid both the cost and the return.

The statement therefore splits DIRECT COST OF MINING (extraction / evacuation /
reservation) from OVERHEAD (infra / defense / consumers), yielding a **NET
MINING MARGIN** subtotal — first live reading **65.29 e/t on 100.54 delivered**.

**OPERATING vs CAPITAL** (owner-caught 2026-08-01, *"what about claim corp"* —
four roles were landing in an unnamed `other` bucket):

- `claimer` is **EXPANSION CAPEX**, not operating cost. `BASE_RESERVE =
  EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE` exists to fund it, and a
  600e/CLAIM-part body buys a permanent new room. Charging it to opex would
  make the operating margin look worst in exactly the cycle where expanding is
  right — the classic reason capex is its own account.
- `buster`/`striker` are the same shape; coreBusterKind's own comment says
  *"off-budget: the mission restores a zeroed income stream"*. Capital repair of
  an income asset.
- `scout` IS operating cost — intel is continuous and the bodies are ~50e.

The CAPITAL section prints only when such spend exists, so a quiet colony's
statement stays short.

**RATCHETED**, same discipline as F1's kind map: `ALL_SPAWN_ROLES` is derived
from the kinds' own `roles` declarations and a test asserts every role has an
account and that no account maps a role no kind buys. **It earned its keep on
its first run** — it caught `tender` as a ghost key (the real role is `tanker`).
Any role that still slips through prints as `UNCLASSIFIED [names]`, never as
anonymous "other".

Known limitation, stated rather than inferred: `tanker` is bought by BOTH
extensionTender (infra) and construction (crew haulage), so the infra line
slightly over-states during a build campaign. A corp→kind join would separate
them but cannot resolve a corp that died inside the window.

**BUDGET vs ACTUAL vs VARIANCE** (owner 2026-08-01). Every line the plan
states in ENERGY carries a budget and a signed variance; lines it does not
state print `-` rather than a fabricated parts→energy conversion (biased across
classes — a CLAIM part is 600e against 50e for CARRY, the exact error F1
documents).

Budgets are computed with the **planner's own primitives**, never a second
formula: `minerOverhead(spawnDistance)` per source and
`haulerOverhead(carryParts, distance)` per route — the same functions
`flowAdapter` sums into `totalOverhead`. The footer prints that reconciliation
as a check rather than assuming it (**first run: 18.11 vs 18.11, reconciles**).
Appropriation budgets come straight from the sink allocations; the bank budget
is the plan's own net position (storage inflow less bank-sourced outflow).

Variance convention: **U/F is nature-dependent**, which the first draft got
backwards — costs print NEGATIVE, so overspending makes the variance *more*
negative and that is Unfavourable. The bank line is **neutral** (no marker):
retained energy is neither earned nor spent, and it is read together with the
controller line, not on its own.

First live reading — the plan is faithful on production and badly unmet on
consumption:

| line | budget | actual | variance |
|---|---|---|---|
| gross mining | 100.00 | 100.00 | +0.00 |
| extraction | −4.47 | −5.11 | −0.64 **U** |
| evacuation | −13.64 | −19.58 | −5.94 **U** |
| **net mining margin** | 81.89 | 65.29 | −16.60 **U** |
| controller (score) | 108.87 | 47.59 | **−61.29 U** |
| to/(from) bank | −28.87 | −5.74 | +23.14 |

The controller variance IS the P7 gap, now shown against its own budget line
rather than inferred, and the bank line shows the other half of it: the plan
intended to draw 28.87 e/t out of storage and drew 5.74.

### The CONTROLLER VARIANCE BRIDGE — and the spawn budget P10 was missing

Digging the variances (owner 2026-08-01: *"in some cases it could be an
accounting or instrumentation error or gap that we can improve"*) produced the
comparator P10 was **retracted for lacking**. At retraction I wrote: *"A VALID
successor would ask 'does the spawn sink allocation cover actual spawn spend',
but the sink's demand is a REFILL-CAPACITY figure, not a rate."* The **allocated**
figure IS a rate — energy the plan routes INTO the spawn structures per tick —
and it is directly comparable to energy those structures convert OUT into
bodies. Same structure, same unit, same direction; at steady state refill must
equal spend because the network's stock is bounded at its capacity.

**The plan routes 20.00 e/t to the spawns. The spawns burn 44.21.** And the
decomposition is sharp: the plan prices miners+haulers at 18.11 (its own
`totalOverhead`), so its 20.00 spawn budget leaves **1.89 e/t** for reservation
+ infra + defense + consumers — classes that actually cost **19.52 e/t**.

That closes the top-line variance **arithmetically**:

```
CONTROLLER VARIANCE BRIDGE  (plan 108.87 -> actual 47.59)
  spawn cost the plan under-budgets         -24.21
  losses the plan does not model (residual) -14.47
  bank draw budgeted but not performed      -23.14
  = explains                                -61.82
    actual controller variance              -61.29
    unexplained (window mismatch)            +0.54
```

**The shortfall is not one thing.** Two of the three terms are the PLAN's
accounting — it under-budgets the spawn and models no losses at all — and only
the third is runtime behaviour (a bank draw the valve did not perform). Roughly
**63% accounting, 37% behaviour**, which reverses the working assumption that
P7 was primarily an execution failure.

The 0.54 unexplained is the window mismatch: spawn spend is measured over the
blackbox ring (2,710t) and everything else over the capture window (6,686t).
Closing that needs a ring as long as the window, not a code change.

**Known instrument gap, named not hidden:** the `gross mining` variance is
**structurally +0.00** — budget and actual both derive from the plan's capacity
figure, because there is no independent meter of energy actually delivered into
storage. That row cannot detect an income shortfall today; the pile-delta term
is the only real measurement in it.

**Expected to evolve.** Split the residual as decay/rot/raid meters land; add a
balance-sheet section (reserved / committed / free) once the commitment
accounting exists. **The invariants are the balancing identity and the named
residual — not the specific line items.**

### P11 — link/haul representation (notional hauler parts)

**Added 2026-08-01.** The plan models bank→controller flow as HAULER edges with
`carryParts`, but in a link-served room the LINK performs that work (hub link →
controller link → feeder relays the last tile). No hauler is ever built for
those parts, so they inflate every plan-vs-actual hauler comparison.

Found while reading plan-vs-actual bodies at t72714129: planned hauler CARRY
198.1 vs 210 fielded read as a comfortable **1.06×** — but 26.1 of those planned
parts are link work. Against source routes alone (172.0) the same fleet is
**1.24×**: still in tolerance, but a quarter over rather than a rounding error.

**Not a leak** — nothing is wasted, the link is the cheaper carrier. It is a
REPRESENTATION mismatch that biases a reading, so it WARNs rather than FAILs,
and only fires when a controller link is actually live; without one those haul
edges are real work and the plan is right.
