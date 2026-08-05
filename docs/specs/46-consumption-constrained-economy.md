# Spec 46 — The consumption-constrained economy

**Status:** LANDED 2026-08-05 (owner-directed).

**Owner, 2026-08-05:** *"at RCL eight … upgrade is limited to 15 e/t and our
storage is full so it has a limit of zero for sink. At this point the economy
is CONSUMPTION constrained which we never faced before. … our haulers don't
have anywhere to deliver to so they should never be planned for (beyond the
15 e/t for the controller and the spawning etc) and so our miners don't have
anywhere [to] haul … so they should never get planned for. … It's not a flag
like 'storage full' or anything — I want the economy to be planned on
dependencies like that … make sure that haulers have a source (obviously) AND
a sink … We could say take the storage ullage divided / 1500 as the sink rate
cap it exposes for the planner."*

---

## 1. The regime

Every constraint the economy has hit so far was on the PRODUCTION side —
spawn build-time, source profitability, parts ledgers. A mature RCL8 room
inverts it:

- the controller accepts at most **15 e/t** (the game's
  `CONTROLLER_MAX_UPGRADE_PER_TICK`, level 8 only), no matter the fleet;
- a **full storage** can absorb nothing;
- construction is usually zero in a built-out room.

Total consumption ≈ 15 + spawn overhead. Any mining beyond it has no home:
haulers with nowhere to deliver, miners feeding containers that rot. The
colony must contract its fleet to consumption — and grow it back the moment
new consumption appears — **with no mode flag anywhere**.

## 2. The mechanism (two sink caps; the planner already had the rest)

The planner's dependency chain was already the right machine: `routeToSinks`
creates a hauler only for a flow a sink actually admitted; the storage-full
defund drops whole corps when mining exceeds total sink capacity; the
FUNDED⇒ROUTED demotion (`planColony`) strips any miner whose output routed
nowhere. What was missing was the two **inputs** that make the RCL8 regime
visible to it:

1. **The absorb law** (`primitives.storageAbsorbRate = ullage / 1500`,
   `CREEP_LIFETIME`): the storage sink's capacity is
   `min(totalSupply, storageAbsorbRate(freeCapacity))`
   (flowAdapter sink assembly). The old cap mixed units —
   `min(totalSupply e/t, freeCapacity energy)` — so the sink ran at FULL rate
   until the last ~joule of room, then cliffed to zero and defunded the whole
   fleet in one solve. The absorb law is the exact mirror of
   `sustainableConsumptionRate`'s stock/1500 drain (ONE law at every stock,
   both directions): the sink rate tapers linearly over the final
   ~1500×supply energy of room, so the dependency chain retires mining
   **source by source** until inflow matches what consumption drains.
   Far from full, absorb ≫ supply and behavior is byte-identical to before.
   No live storage to read (harness) ⇒ Infinity ⇒ unchanged.

2. **The RCL8 game cap** (`primitives.controllerMaxUpgradeRate(level)`:
   15 e/t at level ≥ 8, else Infinity): min'd into
   `flowAdapter.controllerUpgradeCap`, which already bounds the controller
   sink (and therefore, via ONE VALVE, the upgrader fleet and the feeder
   relay). It reads only `controller.level`, so it survives partial Game
   state that fails the parking lens. Unknown level ⇒ uncapped — never
   fabricate a cap from a read we don't have.

Nothing else changed. No planner edits, no flags, no regime branch: the
CorpPlanner scenario tests passed on the existing planner the moment the
inputs were staged correctly — which is the point.

## 3. The equilibrium (what "react appropriately" looks like)

With storage full: absorb 0 ⇒ mined deposits route nowhere ⇒ every mined
source demotes (`unrouted`/`no-sink`, stamped, never silent) ⇒ zero miners,
zero mined haulers. Consumers (controller 15, spawn overhead) keep running
off the **bank source** — a full storage is always above the warchest target,
so the drain engine exists by construction and the colony is never stranded.
Consumption opens ullage; ullage re-opens the sink rate; mining re-admits.
Steady state: the bank hovers ~1500×consumption below full and mined inflow ≈
consumption. The marginal source may route only part of its rate (partial
routing stays funded — income, not rot); the taper bounds that to ~one
source. New consumption (construction sites, a second colony's founding
spawn) raises sink capacity and the same chain re-expands the fleet — the
"realistically we will find places to do new consumption" exit needs no code.

Fidelity note (the F1 objective): under the old cliff, the plan priced
full-rate mining the runtime could not deliver the moment storage topped out.
The absorb law makes the plan stop promising routes the world cannot absorb —
plan and runtime agree by construction, which is worth more than the energy
(macro doctrine: the diagnosis is the cost).

## 4. Acceptance tests (landed green)

- `test/unit/economy/primitives.test.ts`
  - `storageAbsorbRate`: ullage/1500; 0 at full; mirrors
    `sustainableConsumptionRate` exactly; Infinity passes through; negative
    clamps to 0.
  - `controllerMaxUpgradeRate`: 15 at level 8; Infinity below; Infinity on
    unknown level.
- `test/unit/economy/flowAdapter.test.ts` — "consumption-constrained sinks
  (spec 46)": full storage ⇒ capacity-0 sink; near-full ⇒ ullage/1500 (the
  old code exposed full rate there); far-from-full unchanged;
  `controllerUpgradeCap` = 15 at RCL8 even on a partial mock; END-TO-END
  RCL8 + full storage assembles `{controller: 15, storage: 0}`.
- `test/unit/economy/CorpPlanner.test.ts` — "consumption-constrained economy
  (spec 46)": full storage ⇒ zero miners/zero mined haulers, consumers fed
  from the bank, everything ≤ 15 + spawn, every drop stamped; partial ullage
  (6 e/t) ⇒ exactly one surviving source shipping 6; the mined fleet is
  MONOTONE in the sink side (0/6/1000 ⇒ 0/1/4 miners); EVERY hauler has a
  live source AND a sink that admitted its flow.

## 5. Non-goals / open

- **Live soak.** No grid cell stages a near-full storage today (cells stage
  8k–120k of 1M — the taper is invisible there by design). A `cons-rcl8-*`
  cell staging a near-full bank + level-8 controller is the natural next pin
  if the live reaction wants a ratchet; the unit scenario is the contract
  meanwhile.
- **Miner-side throttling at partial routing.** The marginal source still
  mines its full rate while shipping its routed share; the un-shipped
  residual stands at the mouth (bounded to ~one source by the taper).
  Spec 32 (graceful mining backoff) is the existing home for that follow-on,
  and the L1 pile lines already measure it.
- **New consumption.** Labs/terminal/market (specs 22, 31) are the real exit
  from the regime; this spec only makes the colony behave until they exist.
