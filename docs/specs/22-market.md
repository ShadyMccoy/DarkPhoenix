# 22 — Market: credits as the zero-mass resource

**Status:** DOCTRINE (owner 2026-07-20). The mineral-value ESTIMATE has
landed (ahead of the corp — see "The estimate" below); the market corp
(sizing, terminal deals, order management) is still sequenced after the
expansion phase. Terminal is buildable at RCL6 (the home room qualifies
today; ~100k build).
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

## The estimate (shipped ahead of the corp)

Before any market corp exists, the market's *value* is priced into
room/node selection so mineral-rich rooms (dense keeper X/H) rank up for
claiming. Pure and testable, it does not extract or trade anything.

- **Formulas** (`economy/primitives.ts`, the one formula home): a mineral
  is REGEN-limited, not miner-limited — a deposit drains then sits dead for
  `MINERAL_REGEN_TIME` (50k), so the long-run rate is
  `amount / (drainTicks + 50k)`, bounded by `amount/50k` however big the
  miner. `mineralNetEnergy` values that rate at the market EXCHANGE
  (`mineralPrice / energyPrice` — sell the mineral, buy energy) minus the
  tiny miner+hauler overhead, mirroring `netEnergy` for a source.
  `mineralEnergyPerSpawnPart` mirrors the source shadow price — minerals win
  it big because the miner recycles free through the regen dead-period.
- **Node EV** (`economy/mineralValue.ts`, pure): `mineralNodeValue` from
  intel alone (type + density/amount), GROSS of any securing cost — the
  claim/keeper decision nets that (spec 21). Unknown/unpriced/unscouted →
  0 (never guessed). Folds into `node.roi` alongside the source-side
  economic value, on the same energy axis, so it flows through the existing
  expansion-candidate ranking.
- **Prices are OBSERVED, cached** (`execution/marketSampler.ts`): a wide
  cadence samples `Game.market` (energy = cheapest sell order, each mineral
  = best buy order) into `Memory.marketPrices`. A static snapshot
  (2026-07-26 market page) is the fallback when stale/absent — so sims/grid
  resolve deterministically and a terminal-less early game still estimates.
- **What the numbers said** (energy ≈ 33cr, 20W miner, density-3, ~25-tile
  haul): X (~580cr) ≈ 18 e-equiv/t and H (~443cr) ≈ 14 — both beat *any*
  single remote source (max ~9). L (~225) ≈ 7 beats a d≥100 remote. O
  (~148)/K (~121) only beat far remotes. U (~55)/Z (~44) lose to remote
  mining. The verdict is price-sensitive by construction — hence observed,
  not assumed, prices.

## Non-goals (for now)

- No implementation this phase (expansion first - owner sequencing).
- No speculative pricing models: when built, the arbitrage corp trades on
  OBSERVED order books only, and every strategy ships with a paper-trading
  probe before real credits (the measured-not-vibes rule applied to money).
