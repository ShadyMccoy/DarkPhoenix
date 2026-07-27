# 32 — Graceful mining backoff on a standing pile

**Status:** BACKLOG (owner idea 2026-07-26). Not started. Design note only.

## The idea

When a source's pickup buffer is standing high (energy piling / spilling to the
ground and decaying), sometimes DEPRIORITIZE spawning the creeps that feed that
pile — the miner (harvest) and, for a remote, the reserver (claim). If we cannot
haul the energy we are already mining, mining more of it just to watch it decay
on the ground wastes the spawn time, the CPU, and the energy that went into the
miner/reserver bodies. Backing off is a **fail-gracefully** move: match
production to what logistics can actually move, and spend the freed spawn/CPU on
something that isn't rotting.

Mechanism must follow doctrine (CLAUDE.md): scarcity acts at the SPAWN via
PRIORITY (defund: no new bodies), never by revoking or stranding standing
assets. A live miner/reserver keeps working its route; only its *successor*
spawn is deprioritized while the pile is high. Priced, not gated.

## The catch (why this needs a guard, not just a knob)

A standing pile has TWO causes and they demand OPPOSITE responses:
- **Over-production** the logistics is right-sized for → backing off mining is
  correct (the pile is genuine surplus).
- **Under-delivery** — haulers can't move what's mined (the H < I execution
  loss localised t72595222: approach-lane congestion at the core; a missing or
  undersized hauler; a blocked delivery leg). Here, backing off mining SWEEPS
  THE LOGISTICS BUG UNDER THE RUG — the pile shrinks, the symptom clears, and
  the real defect (congestion / missing hauler) goes uninvestigated and
  unfixed.

So this feature cannot ship as a bare "pile high → mine less" rule. It must be
paired with instrumentation that keeps the underlying logistics deficit VISIBLE
even while the backoff hides the pile.

## Prerequisite instrumentation (ship BEFORE the backoff)

The H-vs-I / duty read already exists (spec 14/15, CarryCorp `staged` +
duty-split stamps, ledger H1). Extend it so a backoff cannot mask a logistics
leak:
1. **Attribute every backoff.** When mining/claim is deprioritized for a pile,
   stamp the REASON split — surplus (haulers at high duty, keeping up, pile is
   genuine over-production) vs. under-delivery (haulers duty-starved / idleSink
   en-route, the pile is a logistics failure). Backing off under-delivery is a
   RED flag, not a saving.
2. **A ledger line** (spec 15) that reports mining backoff separately from the
   waste it is meant to save, and FAILS when backoff is masking an
   under-delivery deficit above threshold (i.e. we throttled production instead
   of fixing haulage).
3. Only once the instrument can tell the two apart does the backoff earn its
   knob — and even then it fires ONLY on the surplus branch.

## Acceptance tests (the contract — write first)

The doctrine is "each spec IS its acceptance tests." This feature's whole risk
is that the backoff SWEEPS a haulage bug (§ the catch), so the tests are built
around DISCRIMINATING the two pile causes — a bare "pile high → mine less"
assertion would pass on the very bug we must not hide.

**Unit (`test/unit/...`, pure where possible):**
- `pileCause.classify` (new pure fn): given (groundPile, haulerDutyMean,
  idleSinkEnRoute, inflow, deliveredRate) it returns `"surplus"` vs
  `"under-delivery"`. Pin BOTH branches from the measured shapes:
  - SURPLUS: haulers at high duty (≥ ~0.8), idleSink en-route ≈ 0, delivered ≈
    inflow, pile still standing → `"surplus"` (delivery keeps up; the pile is
    genuine over-production).
  - UNDER-DELIVERY: haulers duty-starved OR idleSink en-route high (the
    t72595222 approach-lane congestion), delivered < inflow → `"under-delivery"`.
  - Boundary: a pile that is DECAYING toward equilibrium `inflow − H =
    ceil(pile/1000)` with H keeping up is surplus, not under-delivery (encodes
    the owner's "piles decay, so a stable pile is chronic under-delivery UNLESS
    delivery matches inflow" correction).
- `miningBackoff.priced` (the knob): the backoff drops only the SUCCESSOR
  spawn's PRIORITY (never revokes a standing miner/reserver, never gates) and
  ONLY on the `"surplus"` branch — assert the demand's `value` drops while the
  standing corp's creeps are untouched, and that on the `"under-delivery"`
  branch the priority is UNCHANGED (the leak stays fundable/visible).
- `ledger.miningBackoff` (spec 15 line): reports mined-then-decayed energy saved
  SEPARATELY from the backoff, and FAILS when backoff is masking an
  under-delivery deficit above threshold. Red-first: feed it an under-delivery
  pile with a firing backoff → FAIL; feed it a surplus pile with a firing
  backoff → PASS with the saved-energy number.

**Grid (`test/grid/cells/...`, stage the REAL topology, assert RECEIPTS — the
spec-26 blind-spot rule; a pile is not a proxy for its cause):**
- `backoff-surplus`: stage a source whose hauler fleet is RIGHT-SIZED and at
  high duty, with production genuinely exceeding all sink capacity (storage near
  full) so the pile is real over-production. Assert: the miner SUCCESSOR is
  deprioritized (its spawn demand `value` drops / it yields the slot), the freed
  spawn parts are measurably redirected (another corp fields sooner — a receipt,
  not a proxy), the standing miner keeps mining its route (never revoked), and
  the ledger emits the saved-energy number with NO FAIL.
- `backoff-underdelivery`: stage the SAME pile height but caused by congestion
  (a wall of parked creeps on the core approach lane / an undersized hauler) so
  delivered < inflow. Assert: the ledger FAILS (the deficit stays visible), the
  backoff does NOT fire (miner successor priority unchanged), and once a hauler
  is added delivery recovers and the pile drains — proving the pile was a
  logistics bug, not surplus. The OLD (knob-only, no guard) build must sweep
  this — pile shrinks, ledger silent — so the cell is a real anti-sweep gate.

**Regression gate:** unit + `flow-handoff`, `runt-economy`, `storage-depot`
green; no baseline grid cell regresses (the backoff must be a no-op wherever the
pile is not standing high).
