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

The insight: because a lab on cooldown can *still be read as a reactant*, the
"reservoir" role does not have to be paid for with two idle labs. Arrange labs so
that each lab is both a **producer** (on its own cooldown clock) **and** a
readable **reactant** for its neighbours — a **circular / ring layout** where
every lab is within range 2 of the shared reactant pair *and* is itself tappable
— and you recover the throughput those two dedicated feeders were sacrificing.
More reactions squeezed out of the same lab count, per tick.

## The honest open question (this is the real work)

Whether the ring actually beats `2 feeders + 8 reactors` is **not yet proven
here** and is the substance of this spec when picked up. The tension:

- To *produce* compound Z, a reactor must read two labs that hold Z's clean
  input reactants (X and Y). A lab that just produced its own output holds *that
  output*, not a clean base reactant — so "read across cooldown" pays off most
  in **chained / multi-tier reactions**, where one lab's output *is* the next
  tier's input, and can be consumed downstream immediately without waiting out
  the producer's cooldown.
- The range-2 packing constraint bounds how many labs can share a reactant pair,
  and the geometry that maximises "every lab within range 2 of the labs it needs
  to read" is the layout problem the word *circular* is pointing at. It must be
  worked out against real lab count per RCL (3 at RCL6, 6 at RCL7, 10 at RCL8)
  and real terrain, then measured — not asserted.

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
