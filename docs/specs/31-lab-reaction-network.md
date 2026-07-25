# 31 — Lab reaction network: the circular layout that reads across cooldown

**Status:** design note / owner idea — NOT started, NOT scheduled, and further
out than most specs because **labs are not modeled anywhere in the code today**
(no `StructureLab`, no reaction/boost economy, no mineral producer class — see
spec 28's "minerals out of scope"). This note exists to pin ONE mechanic and one
layout idea so the insight isn't lost. Treat every throughput number here as a
placeholder pending an `@screeps/engine` pass — the repo culture is
measured-not-vibes (CLAUDE.md epistemics), and lab cooldown/range constants are
exactly the kind of "surprising, so verify" rule GRAND_STRATEGY flags.

**Priority:** unranked — downstream of a mineral/extractor producer class, which
is itself the "natural follow-up" tail of spec 28 (SK mining). Reactions have
nothing to consume until we harvest minerals, and boosts have nothing to spend
themselves on until the intent budget binds (GRAND_STRATEGY §2). This is a
late-game income/intent multiplier, named now only because the layout insight is
non-obvious and worth writing down while it's fresh.

---

## The mechanic (VERIFY against `@screeps/engine` master before building)

A lab reaction needs **two source labs (reactants)** within range 2 of the lab
that produces the output. Only the lab that **calls `runReaction`** — the
*output* lab — takes the cooldown. The two source labs are merely *read*: 1 unit
of each reactant is consumed per reaction, and **being read as a reactant never
puts a lab on cooldown, nor does being on cooldown stop a lab from being read as
a reactant.** Cooldown gates one thing only: how often a given lab may itself
*produce*.

That asymmetry is the whole idea. Standard-consensus behavior, but flag it for
engine re-derivation at build time (reaction range, the per-reaction batch size,
and the cooldown formula per compound tier) — do not commit a scheduler off
these words.

## Why the common layout leaves throughput on the floor

Most bots run a **2 dedicated feeder labs + N reactor labs** layout: the two
feeders hold the shared base reactants, every reactor sits within range 2 of
both feeders and runs `reactor.runReaction(feederA, feederB)`. Colony reaction
throughput is then bounded by the **reactor** count and their cooldowns — and
the **two feeders produce nothing.** They are permanently-idle reservoirs.

The insight combines two facts:

1. A lab on cooldown can *still be read as a reactant* — cooldown gates only
   *producing*, never being-read (the mechanic above).
2. A **lab tender** (the hauler that services labs, analogous to
   `ExtensionTenderCorp`) can load **any reactant into any lab**. The
   feeder/reactor roles are not physical properties of a lab; they are just
   *what the tender put in it this cycle*.

Together they make the feeder role **fungible**. A lab that just produced is on
cooldown and cannot produce anyway — so during that otherwise-dead window the
tender empties it and reloads a **base reactant**, and it serves as a *feeder*
for a neighbour's reaction. No lab is a permanently-idle feeder; the feeding duty
**rotates through the cooldown dead-time** that every lab has regardless. Lay the
labs out so the tender can reach every one of them and so each lab has two others
in range 2 to read (see Layout below), and the average pushes toward *all N labs
producing* instead of `N − 2`.

**This does NOT depend on chained / multi-tier reactions.** Feeding one lab's
output straight into the next tier would demand a *fatter base-reactant supply*
(more mineral throughput and turnover than the reservoirs can sustain) and isn't
quite feasible — so that is *not* the mechanism. The win is on ordinary
**single-tier** reactions, purely from the tender's freedom to put any reactant
in any lab plus cooldown-≠-read-lockout.

## Layout — 10 labs, two feeder *spots* (owner design)

The concrete layout (RCL8, 10 labs). `F` are **feeder spots**: walkable tiles the
tender stands on, NOT feeder labs. Every physical lab produces; feeding is a
*position/role*, not a dedicated lab.

```
        c0    c1    c2    c3
   r0 │ L  │ L  │ L  │ ·  │      L = lab (10 total)
   r1 │ L  │ F  │ L  │ L  │      F = feeder spot (tender standing tile) at (1,1),(2,2)
   r2 │ L  │ L  │ F  │ L  │      · = open/road (base access)
   r3 │ ·  │ L  │ ·  │ ·  │
```

Lab coords: `(0,0)(1,0)(2,0) (0,1)(2,1)(3,1) (0,2)(1,2)(3,2) (1,3)`.
Feeder spots: `(1,1)(2,2)`.

Why it works (geometry facts — **verify vs engine**):

- **The two spots reach all 10 labs at range 1.** F1 `(1,1)` is adjacent to 7
  labs, F2 `(2,2)` to the other 5 (overlap on `(2,1)`,`(1,2)`); union = all 10.
  The spots are **diagonally adjacent**, so the tender services the whole cluster
  by shuttling one step between two tiles.
- **The tender can get in.** F2 opens onto `(2,3)`/`(3,3)` → base road; F1 is
  reached through F2. No enclosed tile (the earlier 3×3-ring sketch was wrong:
  its center was walled in by 8 labs, unreachable — this layout fixes that).
- **Reactions form two overlapping range-2 cells.** The F1 cluster and F2 cluster
  are each mutually within range 2, sharing `(2,1)`,`(1,2)` as the bridge. Each
  producer always has two read-sources in range within its cell; roles rotate,
  the tender re-charges from the two spots. A reaction spanning the full
  footprint (`(0,0)`↔`(1,3)`, range 4) is *not* possible and not needed — it's a
  two-cell network sharing one tender, not one giant cell.

There is flexibility here (the owner notes the exact lab/spot placement can
vary); the invariants that must hold are the three bullets above.

## Simulator — `scripts/sim-labs.ts` (conservation-verified)

A standalone sim (`npx ts-node -P tsconfig.test.json scripts/sim-labs.ts`) models
this layout, the terminal as raw-reactant + compound warehouse, the full reaction
tree with per-compound cooldowns, and the tender as a **2-stroke forklift**
(withdraw one tick, deposit the next — the owner's "one withdraw *or* deposit per
tick" model). It is a design aid, **not** an acceptance test: every game constant
is standard-Screeps but UNVERIFIED (engine not vendored).

**Sustainable is defined as conservation** (owner): over the measured window the
labs and every intermediate buffer must return to their starting fill, so the
only net changes are bases in and top compound out. A drifting intermediate means
the output rate is *borrowed from a bleeding buffer*, not earned — the sim reports
per-intermediate drift and fails the verdict if any buffer drifts past tolerance.
(This caught a false "sustainable" from an early coarse-batch scheduler.)

Measured (XGH2O, top boost, cooldown 80; bases assumed supplied to the terminal):

- **~140 XGH2O / 1000 ticks, conservation-closed** — max intermediate drift
  ≤ 0.13 units/1000 ticks, lab-fill drift ≤ 0.2; genuinely steady state.
- **A single small tender suffices** — carry 25, 50, and 2000 give the *identical*
  rate: with small per-load amounts the carry size never binds, only the stroke
  count does, and one tender runs at ~59% of its strokes with headroom. This
  confirms the tender-bandwidth worry below is smaller than feared.
- The heuristic scheduler leaves throughput on the floor: the lab-limited ceiling
  for XGH2O in 10 labs is ~`10/26 ≈ 0.38`/tick (**~385/1000**, the cd-80 top
  reaction alone wanting ~16 labs per unit/tick). ~140 is sustainable but not
  optimal — a balanced allocator is the real scheduler work.

**CPU cost (every tender intent is 0.2 CPU — GRAND_STRATEGY §1).** The dominant
cost is round-tripping intermediates through the terminal, so it amortises with
the scheduler's batch granularity (units made per tender trip):

| batch | CPU / 1000 ticks | CPU per XGH2O | conserves? |
|------:|-----------------:|--------------:|:----------:|
| 10 | 117.8 | 0.85 | yes |
| **30** (default) | **36.4** | **0.29** | yes |
| 60 | 17.2 | 0.15 | no (GH drifts) |
| 120 | 8.8 | 0.08 | no |

Bigger batches are far cheaper but this terminal-buffered scheduler goes lumpy
past ~60 and breaks conservation; **batch 30 is the shipped default — the
CPU-cheapest point that still holds every buffer flat (~3× cheaper than batch 10).**

**Phasing — you do NOT need all 7 bases held at once** (owner correction; an
earlier draft wrongly claimed a "14 concurrent roles > 10 labs" wall). The tree
has 7 producible compounds, but you never run them all at once — you **phase**:
make one compound at a time and let the tender **swap** a small pool of
base-holder labs between phases, so only the 2 bases the current reaction needs
are held. ~7 producer/buffer labs + a few swappable base holders fit in 10. Both
schedulers phase; the only question is *how*.

**Measured: three schedulers, and the terminal wins here.**

| scheduler | idea | rate | CPU/unit |
|---|---|---:|---:|
| **terminal-buffered** (`sim-labs.ts`) | intermediates round-trip through the terminal | **~128/1k** | **0.29** |
| phased in-lab (`sim-labs-phased.ts`) | one lab per compound; swap a few base holders | ~62/1k | 0.73 |
| fungible mix (`sim-labs-mix.ts`) | any lab fires any goal-tree reaction, bottom-up | ~69/1k | 0.87 |

Both in-lab schedulers conserve and **prove the owner's point** — they run the
whole tree without holding all 7 bases (a few swapped base-holder labs) — but
both measured *worse*. **Root cause (the load-bearing fact): a lab holds exactly
ONE mineral type.** So each of the tree's 6 intermediates + up to 7 bases + a
target slot needs its **own** lab, and that working set barely fits 10 labs with
~zero slack — the two naive in-lab versions actually **deadlocked** (all labs
full of intermediates + bases, none free for the final reaction) until a reserved
target-lab + base eviction unblocked the mix one. The tender then spends its
intents juggling the scarce base-holder slots.

The counterintuitive takeaway: the **terminal is a 300k-capacity buffer that
holds the intermediates the labs physically cannot** — routing through it is not
waste, it is *renting capacity the 10 labs don't have*, and the round-trip
intents are the price. "Leave it in the lab" is real but bounded by one-mineral-
per-lab; for a 7-deep, 7-base tree the terminal earns its keep. (A shallower tree,
or more labs, shifts the balance back toward in-lab.)

What the sim deliberately does NOT yet model (and why it matters): the terminal's
base minerals are assumed supplied. A room mines exactly **one** mineral; the top
boosts need all seven (`U L K Z O H` + `X`), so true colony-scale sustainability
is bounded by **terminal import throughput**, not the lab layout — a
bounded-mineral-income model is the other open iteration.

## The honest open question (this is the real work)

Whether the ring actually beats `2 feeders + 8 reactors` is **not yet proven
here** and is the substance of this spec when picked up. The real constraints:

- **Tender bandwidth.** The rotating-feeder trick spends *hauler* work: every
  cooldown window means emptying output + reloading a reactant. Measured in the
  sim, this is **cheap** — a single small tender (even carry 25) sustains full
  throughput at ~59% of its strokes, because one lab-load serves many reads
  before it drains. So the bandwidth cost is real but not the binding constraint;
  the ceiling is **lab count × cooldown**, not the tender. Still priced like any
  consumer overhead (CLAUDE.md macro doctrine, sized from ACTUAL lab stock) when
  built for real.
- **Range-2 packing.** The geometry that keeps "every lab within range 2 of a
  valid feeder pair" for as many labs as possible per tick is the layout problem
  the word *circular* points at. It must be worked out against real lab count per
  RCL (3 at RCL6, 6 at RCL7, 10 at RCL8) and real terrain, then measured — not
  asserted.
- **Scheduling.** Per tick, assign each lab producer-or-feeder so the maximum
  number of valid triples fire, subject to what the tender can physically refill
  that tick. This is the actual algorithm to write.

So the deliverable when this is picked up is a **scheduler + placement** that,
given a target compound (or boost chain) and a room's lab positions, assigns
producer/reactant roles per tick to maximise delivered compound/tick, and a
**measurement** that shows it beating the naive 2-feeder layout by a stated
margin — not just that it runs.

## What would have to exist first (rough dependency order)

1. A **mineral/extractor producer class** (the SK-mining follow-up, spec 28
   tail) — reactions have no inputs without it.
2. **Lab placement** in the spatial planner (`src/spatial/`, `src/planning/`) —
   labs don't appear in any layout today.
3. A **reaction/boost demand model** — what compound, for what (upgrade boost,
   build boost, combat boost per GRAND_STRATEGY §2), sized from actual stock at
   the work site (macro doctrine: consumers sized from ACTUAL stock, never the
   goal plan).
4. Only then the **reaction scheduler** this note is about, as a corp kind if it
   fits the framework (registration-only, spec 17) or a free runner like
   `LinkRunner` if it's pure execution.

## Acceptance tests (write first when picked up — these ARE the contract)

Sketch, to be filled in at build time:

- **Unit — the mechanic model**: a table-driven test that a lab on cooldown is
  still a valid reactant source, and that only the producing lab takes cooldown
  (guards the whole premise; re-derive constants from the engine here).
- **Unit — scheduler throughput**: given a fixed lab set and a target compound,
  the ring scheduler's assignment yields **strictly more compound/tick** than the
  2-feeder+reactor baseline, by a stated margin — the non-vacuity twin asserts
  the baseline itself is computed, not hand-waved.
- **Grid cell** (tier TBD): stage a room with labs + staged mineral stock (db
  insert — the mockup runs no reaction cron, spec 08 live-only blind-spot class),
  assert delivered compound over a window and that no lab is a permanently-idle
  reservoir.

Update `test/grid/baseline.json` in the same commit as the bot change that earns
the cell (the workflow rule).

## Non-goals

- Everything upstream (mineral harvest, extractor, lab placement, boost demand)
  — each is its own producer/consumer class; this note is the *reaction
  scheduling + layout* piece only.
- Factory / commodity chains, power processing — different weight classes.
- Committing any cooldown/range/batch constant from memory: all pending the
  engine-verification pass.
