# 22 — Market: credits as the zero-mass resource

**Status:** DOCTRINE (owner 2026-07-20). No implementation yet — sequenced
after the expansion phase. Terminal is buildable at RCL6 (the home room
qualifies today; ~100k build).
**Priority:** roadmap domain (with minerals/labs, military, scaling).
**Depends on:** spec 20 (corp accounting — credits join as a currency),
spec 17 (registration-only kinds — the market corp is a kind).

## The thesis (owner, verbatim where quoted)

"Something that's a cheat code is the market. You can escape a lot of the
dynamics there. So a room mining minerals in SK and selling them and just
doing market arbitrage could be really valuable. And credits have no move
cost. It can travel to my room on another shard even and I buy from the
market there. So the room can 'send' resources, indirectly by utilizing
the market."

The structural fact underneath: **matter pays distance fees, credits do
not.** A terminal deal's energy fee is `amount x (1 - e^(-dist/30))` -
long-range physical transfer costs approach the cargo itself - while
credits are account-global and cross-shard, instantly. The market
therefore converts "send resources to room X" into "sell near the mine,
buy near the need": two short-fee legs replacing one long haul, with the
market spread as the toll. Whenever spread < transfer fee, the market IS
the logistics layer.

## Strategic uses, in expected value order

1. **The credits engine**: an SK-adjacent room mining keeper minerals
   (dense: SK sources are 4000-capacity, minerals ungated by RCL) and
   selling at the local best order. Keeper clearing is warfare-as-economics
   (spec 21): the squad is priced by the mineral income it unlocks.
2. **Logistics bypass**: inter-room and inter-shard resource movement via
   sell-here/buy-there whenever the spread beats the transfer fee. This is
   how a mature east funds a founding west without a single hauler
   crossing the map - the market-mediated form of the organism thesis.
3. **Arbitrage proper**: standing spreads between buy and sell orders on
   the same good. Pure credits income for CPU + order-management cost;
   no creeps, no rooms. (Order placement costs 5% of order value in
   credits; dealing against existing orders costs only the energy fee.)
4. **Disaster/founding relief**: a besieged or founding room with a
   terminal buys energy locally at any price rather than starving - the
   market as insurance, priced per incident.

## Fit with the existing doctrine

- **Credits are the FOURTH currency** in corp accounting (energy, spawn
  build-time, CPU, credits). Every market corp's P&L is credits-native
  with an exchange rate into energy-equivalents so the planner can compare
  a credits-earning corp against an energy-earning one on one axis. The
  exchange rate is MEASURED from our own fills, never assumed.
- **The market corp is a kind** (registration-only, spec 17): terminal
  operations, order management, and the arbitrage scanner are corp
  behaviors with commissions; their CPU is metered like everyone's
  (spec 20) - arbitrage income per CPU is the whole question for use 3.
- **GCL -> CPU -> credits closes the loop** with room selection (owner,
  same session): efficient rooms stretch CPU; CPU runs market corps;
  credits move value where matter cannot. Room-portfolio valuation
  eventually prices SK adjacency and terminal logistics position.

## Non-goals (for now)

- No implementation this phase (expansion first - owner sequencing).
- No speculative pricing models: when built, the arbitrage corp trades on
  OBSERVED order books only, and every strategy ships with a paper-trading
  probe before real credits (the measured-not-vibes rule applied to money).
