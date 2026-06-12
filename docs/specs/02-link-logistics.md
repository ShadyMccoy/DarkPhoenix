# 02 — Link logistics (RCL5)

**Status:** groundwork committed (commit "Link logistics groundwork"), unit-
tested, **not** verified end-to-end. Blocked by spec 01.
**Priority:** P0 after 01.

## Goal

At RCL5, replace the longest in-room haul with a link pair: the far source's
miner feeds a SOURCE link; it fires to a CORE link beside the storage; haulers
pick up at the core. The planner prices that source's hauling from the core, so
its commissioned hauler fleet shrinks to a stub — that build-time and energy go
to the controller instead.

## What is already implemented (the groundwork commit)

| Piece | Where |
|-------|-------|
| Miner body gains 1 CARRY from 600 capacity | `spawn/BodyBuilder.ts` (`MINER_CARRY_MIN_CAPACITY`) |
| Full-store miner transfers to adjacent link | `corps/HarvestCorp.ts` (runHarvester) |
| Source links fire to the core link | `execution/LinkRunner.ts`, called from `main.ts` |
| Placement: core link, then farthest source > 8 from storage, RCL-capped | `corps/ConstructionCorp.ts` (`findMissingLink`, `LINK_LIMITS`) |
| `coreLink` / `sourceLink` resolvers; hauler pickup redirect that follows where energy actually is | `corps/nodeEnergy.ts` (`sourcePickupSpot`) |
| Planner `haulPos`: hauling priced from the core, miner keeps real distance | `economy/CorpPlanner.ts`, detection in `economy/flowAdapter.ts` (`detectLinkHaulPositions`, injectable) |

Design invariants to preserve:

- **Degrade gracefully.** A link pair with an old CARRY-less miner (turnover
  hasn't replaced it yet) must not strand energy: a loaded source-side
  container/pile beats the core redirect in `sourcePickupSpot`. Never make the
  redirect unconditional.
- **The planner stays pure.** Link detection happens only in the adapter
  (`detectLinkHaulPositions`), injected as data (`haulPos`). No Game calls in
  CorpPlanner.
- Phase-1 profitability still uses the miner's real distance (conservative:
  a link makes a source strictly more profitable than the planner assumes).

## Remaining work

1. Resolve spec 01 (the RCL5 world must stand up an economy at all).
2. End-to-end verification (tests below).
3. Re-run the regression gate (the miner CARRY change is live at RCL3+
   capacities, so `flow-handoff` and `runt-economy` must be re-run against the
   final bundle).
4. Update `docs/ONTOLOGY.md` § 1–2 if `haulPos` deserves a primitives-level
   mention, and the README roadmap line ("Mineral/boost flow" stays planned;
   links move to Implemented).

## Acceptance tests

### Unit (exists): planner haulPos pin — `test/unit/economy/CorpPlanner.test.ts`

Already merged and green: a source at distance 200 with `haulPos` at distance 2
commissions a miner with `distance === 200` and a hauler with `distance === 2`
and `carryParts === carryPartsFor(10, 2)` (±1e-9).

### Unit (new): miner body CARRY — `test/unit/spawn/BodyBuilder.test.ts`

1. `buildMinerBody(5, 599).body` contains **no** CARRY; cost unchanged from
   the pre-groundwork pin at that capacity.
2. `buildMinerBody(5, 800).body` contains **exactly one** CARRY;
   `workParts === 5`; `cost === 700`.
3. For every capacity in {300, 550, 600, 800, 1800}:
   `cost <= capacity` (the CARRY reservation can never overdraw the budget).

### Unit (new): pickup redirect — `test/unit/corps/sourcePickupSpot` cases

Mocked room (pattern: `test/unit/corps/coreDepot.test.ts`). Exact expectations:

1. Storage + core link (energy 400) + source link near the source, empty source
   tile → spot.structure **is the core link** (`structureType === "link"`).
2. Same but core link energy 0 and a source-side container holding 200 →
   spot.structure **is the container** (the degrade-gracefully invariant).
3. Same but core link energy 0 and nothing at the source → spot is the core
   link (wait where the next volley lands), NOT `waitClear` at the source.
4. No source link → behavior byte-identical to pre-groundwork (container →
   pile → waitClear).

### Integration (new): `test/integration/link-economy.test.ts`

World: spec 01's RCL5 layout. Far source = (40,40) (cross-wall, the only
source > 8 from storage). Run ≤ 1500 ticks, sample every 25. Pass requires ALL:

1. **Placement:** a link exists within range 2 of the storage AND a link exists
   within range 2 of source (40,40). No link within range 2 of the near source
   (10,10) while the RCL5 limit is 2.
2. **Flow:** the core link's `store.energy` is observed > 0 on at least one
   sample (the network actually fired).
3. **Throughput:** cumulative energy arriving at the core link ≥ 1000 over the
   run (sum of positive deltas of core link energy across samples; transfer
   fee already netted out).
4. **Fleet shrinks:** after the link pair exists for 300 ticks, the number of
   live haulers assigned to the far source's CarryCorp (creep memory `corpId`
   prefix match) is ≤ 1, while the far source's miner is still alive (its
   energy must still be leaving via the link, not stranded).
5. **No starvation:** controller progress at end > controller progress at
   link-completion tick (the freed budget actually reaches the controller).

### Regression gate

Unit suite + `flow-handoff` + `runt-economy` + `storage-depot` green against
the final bundle.

## Risks / open questions

- The miner CARRY change is the prime suspect for spec 01 — if confirmed, the
  fix may reshape this groundwork (e.g. CARRY only via an explicit body
  variant threaded through SpawnDemand instead of capacity-gated).
- `LINK_MIN_SOURCE_RANGE = 8` and `LINK_FIRE_THRESHOLD = 100` are guesses;
  acceptable to tune, but only with the integration test green before/after.
