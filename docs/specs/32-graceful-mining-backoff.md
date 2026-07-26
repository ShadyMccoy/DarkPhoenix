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

## Acceptance (when this graduates off the backlog)

- Red-first: a synthetic world with a pile from OVER-PRODUCTION → miner
  successor deprioritized, freed spawn parts measurably redirected, no ledger
  FAIL.
- Red-first: a synthetic world with a pile from UNDER-DELIVERY (congested /
  missing hauler) → the ledger FAILS (the leak stays visible); the backoff does
  NOT fire, or fires only after the logistics deficit is named.
- A leak number (energy saved from not-mined-then-decayed) that reaches target
  AND a regression test pinning that the anti-sweep guard holds.
