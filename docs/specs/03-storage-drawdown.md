# 03 — Storage draw-down (spend the bank when income dips)

**Status:** withdrawal not started; the deposit half now works. As of the
storage-hauler-routing change the planner caps the controller at
`STORAGE_UPGRADE_TARGET` once a room has a storage (`flowAdapter.ts`) and routes
the surplus to the storage sink, which CarryCorp delivers as a first-class `storage`
circuit (`deliverToStorage`) with no spill ceiling — so the bank actually
accumulates the expansion CAPEX instead of stalling at `STORAGE_BANK = 10000`.
Withdrawal is still only implicit (the tender refills extensions from the depot);
nothing feeds the *controller or builders* from the bank when income collapses.
**Priority:** P1.

## Goal

When steady income can't cover demand (miner died, remote lost, downgrade
approaching), the colony spends its banked storage energy instead of stalling.
When income is healthy, the bank must NOT leak — and above all the economy must
never pump energy in a circle (storage → sinks → back to storage).

## Design

Ride the existing **transient source** mechanism (scavenging,
`economy/scavenge.ts` + `PlannerSource.transient`): a storage holding energy is
a ground-stock-shaped supply at the storage position — no miner, just hauling.

New pure function in `economy/scavenge.ts` (or a sibling `bank.ts`):

```ts
/** Energy/tick the colony may draw from the bank this plan cycle. */
export function bankDrawRate(
  banked: number,        // storage.store[RESOURCE_ENERGY]
  steadySupply: number,  // sum of staffed-source rates (planner phase 1 output)
  reserveDemand: number  // sum of sink reserves + spawn sink capacity
): number;
```

Rules (these ARE the unit tests below):

- Draw only the **shortfall**: `max(0, reserveDemand - steadySupply)`, capped
  at `scavengeRate(banked)` (reuse the bounded-drain shape) and at
  `MAX_BANK_DRAW = 10` e/tick.
- Keep a floor: never draw the bank below `BANK_FLOOR = 1000` (downgrade
  insurance of last resort) — i.e. treat `banked - BANK_FLOOR` as the
  available stock.
- **Anti-pump:** the bank source must be excluded from filling the `storage`
  sink. Implement structurally: when a bank source is emitted for a room, that
  room's storage sink is dropped from the problem for that solve. Simultaneous
  deposit-and-withdraw must be impossible by construction, not by tuning.

Adapter wiring (`economy/flowAdapter.ts`): a `detectBankSources()` injectable
(like `detectTransientSources`) that needs phase-1 supply — so it runs inside
`buildColonyProblem` after sources are listed, or the shortfall test moves into
the planner. Prefer keeping the planner pure: compute `steadySupply` as the sum
of non-transient source rates (pre-budget; conservative) in the adapter.

Runtime needs no new creep logic: the bank source's haulers resolve their
pickup through `scavengeSpot`/`sourcePickupSpot` machinery — add a branch that
resolves a `bank-<roomName>` source id to `{ pos: storage.pos, structure:
storage }` (withdraw). CarryCorp already handles withdraw-spots.

## Acceptance tests

### Unit: `test/unit/economy/bankDrawRate.test.ts` — exact values

1. `bankDrawRate(10000, 20, 12) === 0` (healthy income: no draw).
2. `bankDrawRate(10000, 4, 12) === 8` (shortfall 8, under all caps).
3. `bankDrawRate(10000, 0, 30) === 10` (shortfall 30 capped at MAX_BANK_DRAW).
4. `bankDrawRate(1600, 0, 30)` `=== min(10, scavengeRate(600))` `=== 4`
   (floor: only 600 of 1600 is spendable; 600/150 = 4).
5. `bankDrawRate(900, 0, 30) === 0` (at/below the floor: never draw).

### Unit: planner integration — `test/unit/economy/CorpPlanner.test.ts`

1. **Draws on shortfall:** spawns/sinks where steady supply (one 4 e/tick
   source) < spawn reserve (10); add a transient bank source (rate 6) at the
   storage position → the spawn sink's `allocated` is `closeTo(10, 1e-9)` and a
   hauler exists with `sourceId === "bank-W0N0"`.
2. **Anti-pump:** a problem containing BOTH a bank source and that room's
   storage sink must allocate **0** to the storage sink and commission **no**
   hauler with `sourceId === "bank-W0N0" && sinkId === <storage sink id>`.
   (If implemented structurally — sink dropped — assert the sink is absent
   from `plan.sinks`.) This test is the spec's contract; it must be written
   to fail against a naive implementation that just sets storage value low.
3. **No miner:** the bank source never appears in `plan.miners` (reuses the
   transient-source pin shape).

### Integration: extend `test/integration/storage-depot.test.ts` or new
`storage-drawdown.test.ts`

World: RCL4 storage world; pre-fill the built storage with 5000 energy via a
db update; then **remove all source energy** (set both sources'
`energy: 0, ticksToRegeneration: 10000` in the db) to simulate income collapse.
Pass criteria over ≤ 600 ticks:

1. Controller progress strictly increases by ≥ 200 after the cut (the bank is
   actually reaching the controller).
2. `storage.store.energy` decreases but ends ≥ 1000 (the floor holds).
3. No tick is observed where storage energy *increases* by more than the
   tender's capacity (cheap anti-pump smoke check at the world level).

### Regression gate

Unit suite + `storage-depot` + `flow-handoff` green.

## Out of scope

Terminal/market selling of surplus; cross-room bank transfers.
