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

## 2b. The pair: the storage as a source AND a sink

**Owner, 2026-08-05:** *"An interesting idea might be to model the energy in
the storage as a source and the ullage as a sink (although obviously they
can't be applied to each other)."*

That model is what §2 completed, so it now has a name and one home:
`bank.bankPressure(stock, ullage, reserveTarget) → {source, sink}`. Both
halves already existed and are the same law over one creep generation — the
stock drains at `stock/1500` net of the liquidity reserve (`bankSurplusRate`),
the room fills at `ullage/1500` (`storageAbsorbRate`). They lived in different
modules with nothing tying them together, which is precisely how the sink half
stayed dimensionally wrong (an e/t rate min'd against absolute energy) until
this spec. `flowAdapter.storageBankPressure(room)` is its world lens: ONE
storage read yields both rates, so a room's give and take cannot be read a
tick or a formula apart.

Properties, pinned as scenarios (`test/unit/economy/bankPressure.test.ts`):

- **Complementarity** — at least one half is always open across the whole
  sweep. A bank that could neither give nor take would strand the colony with
  income it cannot bank and savings it cannot spend.
- **Monotone pressure** — the source rises and the sink falls with the stock;
  never both the same way. The vessel metaphor made exact.
- **The saturation map** — the source knee sits at `reserve + MAX_SURPLUS_DRAW
  × 1500`, the sink knee at `ullage = supply × 1500`. Between them BOTH halves
  are saturated, so the bank is a plain buffer through the middle of its range
  and a regulator only near the two ends. At a 1M storage, a ~30k target and
  ~40 e/t of supply that is roughly stock ∈ [180k, 940k] — about 75% of the
  range. **This is why nothing forced the sink half to be right until an RCL8
  room with a full storage turned up.**
- **Anti-drift** — `bankPressure` reproduces both halves exactly across a
  sweep; it is the pair's one home, never a third opinion.

**The caveat is structural, not arithmetic.** Nothing in `bankPressure` stops
the two halves being applied to each other, deliberately: that guard lives
where routing happens (`routeToSinks` gives the bank a non-deposit ROLE, so a
storage sink only ever draws deposit-class sources and bank→its own store is
unrepresentable). A rate pair is the wrong place for a routing rule, and the
role-based guard already holds for every source class rather than
special-casing the bank. The scenarios prove it across the WHOLE bank sweep —
including the mid-range where the bank simultaneously offers 100 e/t of source
and hundreds of e/t of sink, which is where a value-greedy router would most
want to circulate.

**The asymmetry is measured, not an oversight.** The source subtracts the
liquidity reserve; the sink has no mirror "fill target". Storage sits at the
BOTTOM of the value ladder (value 1) and so already receives only what nothing
else wants — that ladder position is the reserve's true mirror. The
rate-shaped alternative was built and retired: spec 38 phase C claimed a
refill through the storage sink's RESERVE and died the same day (M10:
unbudgeted burns ate the claim before the bank saw it, 76k → 27.5k straight
through the target). The bank holds its floor by being the residual claimant,
not by claiming a rate.

Correction landed with the pair: `bank.ts`'s header claimed the anti-pump
worked by *dropping the room's storage sink from the problem whenever a bank
source is emitted*. It never did — `buildColonyProblem` keeps every storage
sink in every regime on purpose (a hub must stay open to soak remote surplus,
#19), which the adapter's own comment states and the anti-pump test proves by
asserting the sink is present while a bank source stands.

## 2c. Cross-hub transfer: the pair's payoff (phases 1–2 landed, 3 open)

Once a hub's energy is a source and its ullage is a sink, moving energy
between colonies stops being a new planner subsystem and becomes an ordinary
route from one hub's source to another hub's sink. Landed in phases so nothing
is ever promised before it can be executed:

**Phase 1 — the price (landed).** `primitives.terminalSendCost(amount, d) =
amount × (1 − exp(−d/30))`, the engine's own `calcTransactionCost`, plus
`terminalSpendForDelivery` and `terminalDeliveredFraction`. The fee is charged
*on top* of the amount, so a transfer is a **priced edge**, not free routing.
Linear in the amount, so it prices exactly as a per-unit tax (the
`linkTransferTax` shape). The gradient is economically real — ~87% of spend
arrives at 5 rooms, ~78% at 10, ~61% at 30, ~54% at 60 — which is why the fee
belongs in the PLAN, where the value router can see it, rather than hidden in
a runner. The cooldown is pinned as *not* binding (even a minimum send is
10 e/t): what limits a transfer is restocking the terminal, a hauling problem.

**Phase 2 — the plan seam (landed, inert).** Three rules make the route
correct rather than merely expressible:

1. **The anti-pump becomes per-hub.** The old rule ("no bank fills any storage
   sink") was stricter than physics: a bank cannot fill its OWN store, but
   nothing forbids it filling another room's. Tightened to exactly the
   physical constraint.
2. **Terminal-gated.** `ColonyProblem.terminalRooms` + `roomDist`; the edge
   exists only between two rooms that both have a terminal and only when the
   fee can be priced. Empty/absent — every world until phase 3 — makes the
   whole block inert and routing byte-identical to the global rule.
3. **Lender → borrower only.** A hub in surplus is not hungry; letting two
   surplus hubs fill each other's stores at value 1 would burn the fee twice
   for zero net movement. The pressure pair states the test directly:
   `source > 0` means lending, and a lender is never a destination.

Accounting: a transfer buys **no bodies** (`carryParts`/`spawnParts` 0 — the
engine moves it) and **delivers less than it spends**, by exactly the fee, so
the plan's delivered totals never over-state a colony shipping energy uphill.
`CommissionedHauler.transfer` marks the route; `commissionPlan` already skips
bank sources, so it is never materialized as a CarryCorp — the same shape as
link-served routes, which the link network executes rather than a hauler.

Discovered while testing, and worth keeping straight: **mined energy already
cross-banks between hubs today**, with no terminal involved, because a
deposit-class source may fill any storage sink — A's mining walks to hub B
when A's own hub is full, as an ordinary priced CarryCorp. What phase 2 adds
is moving **banked** energy, which no hauler executes. Pinned as its own test
so the two are never conflated.

**Phase 3 — the executor (open, and it is bigger than it looks).** The obvious
parts are easy: adapter detection feeding `terminalRooms`/`roomDist` (the
`roomLinearDistance` lens already exists), publishing the plan's transfer
routes to Memory beside `controllerAllocations`, and a `runTerminals()` on the
LinkRunner precedent — `send` sized to the plan's rate over one cooldown,
bounded by `terminalDeliveredFraction × held` so the fee is always affordable.

**The blocker is that a transfer needs THREE legs, not one**, and only the
middle one is the engine's:

1. `storage → terminal` at the source. The tender is the natural owner (it is
   the depot mover and a terminal is a depot structure); this is a fill-target
   addition, gated on a planned outflow and ranked LAST so a transfer can
   never outrank keeping spawn and extensions fed.
2. `terminal → terminal`. `runTerminals()`. Free of creeps.
3. `terminal → storage` at the DESTINATION. **This one has no owner.** The
   tender FILLS structures from `coreDepot`; it does not drain a structure
   into the depot, and `coreDepot` is a shared lens many corps read, so
   widening it is not a local change. Without leg 3 the energy lands in B's
   terminal and stops — a new fidelity gap of exactly the kind the phasing
   exists to prevent, so detection stays UNWIRED until it has an answer.

Options for leg 3, none yet chosen: give the tender an explicit drain mode
(smallest code, touches a live corp's refill SLA — trap-list territory); make
the terminal a second withdraw source behind `coreDepot` (widest blast
radius); or count terminal stock as part of the hub's bank in
`storageBankPressure` and let the destination's consumers draw it directly
(cleanest economically — the transfer is complete on arrival — but the
withdrawers still resolve `coreDepot`, so it needs the same lens work).

Until leg 3 is settled the plan emits no transfers at all: phases 1–2 are a
strict no-op with `terminalRooms` empty, which is precisely what made them
safe to land first.

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
