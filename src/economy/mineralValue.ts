/**
 * @fileoverview Mineral node value (spec 22 estimate) - the market-chain energy
 * value of a mineral deposit, computed from intel alone so the room-selection
 * framework can run it over ANY node (owned, keeper, or claim candidate) and
 * fold it into that node's economic value.
 *
 * The estimate ships AHEAD of the mineral corp (spec 22 is doctrine, no
 * execution yet): it does not size or run miners, it only prices what a mineral
 * WOULD be worth in energy terms if extracted and market-converted. The corp
 * that eventually executes it (sizing, hauling, terminal deals) is future work;
 * this module is the pure valuation half, like economy/siteValue for sources.
 *
 * The value is GROSS - before any cost of SECURING the room (a claim campaign,
 * or clearing an SK room's keepers). The caller that decides to work the room
 * nets that separately (spec 21/22): a keeper mineral's squad is priced by the
 * income it unlocks, exactly this number.
 *
 * Prices are OBSERVED, never assumed (spec 22): Game.market sampled on a cadence
 * into Memory.marketPrices, with a static snapshot fallback so sims/grid stay
 * deterministic and a terminal-less early game still gets a defensible estimate.
 *
 * @module economy/mineralValue
 */

import { DEFAULT_MINERAL_MINER_WORK, MINERAL_DENSITY_AMOUNT, marketEnergyPerMineral, mineralNetEnergy } from "./primitives";

/**
 * A market price snapshot: credits to BUY one energy (the sell orders we deal
 * against) and credits to SELL one of each mineral (the buy orders paying us).
 * `updated` is the Game.time it was sampled; absent on the static fallback.
 */
export interface MarketPrices {
  energy: number;
  minerals: { [mineral: string]: number };
  updated?: number;
}

/**
 * Static fallback prices - the market-page snapshot (2026-07-26), used when no
 * live sample is cached or the cache is stale. Base extractable minerals only
 * (H/O/U/K/L/Z/X); non-extractable commodities are out of scope for the
 * extractor estimate. Clearly an OBSERVED interim, not an assumed model: it is
 * overwritten by the first live Game.market sample.
 */
export const DEFAULT_MARKET_PRICES: MarketPrices = {
  energy: 32.941,
  minerals: {
    H: 442.8,
    O: 148.38,
    U: 54.6,
    K: 120.724,
    L: 224.686,
    Z: 44.226,
    X: 579.56
  }
};

/** How long a cached market sample stays fresh before falling back (ticks). */
export const MARKET_PRICE_MAX_AGE = 20_000;

/**
 * The prices the estimate should use: the cached live sample when fresh and
 * well-formed, else the static fallback. Pure - the caller passes the cache and
 * the current tick, so sims/grid resolve deterministically to the fallback.
 */
export function resolveMarketPrices(
  cache: MarketPrices | undefined,
  now: number,
  maxAgeTicks: number = MARKET_PRICE_MAX_AGE
): MarketPrices {
  if (cache && cache.energy > 0 && cache.updated !== undefined && now - cache.updated <= maxAgeTicks) {
    return cache;
  }
  return DEFAULT_MARKET_PRICES;
}

/** The facts the mineral EV needs, gathered from intel / node resources. */
export interface MineralNodeFacts {
  /** Mineral type (a RESOURCE_* symbol, e.g. "X"); null/undefined -> no value. */
  mineralType?: string | null;
  /** Ore remaining, preferred when known (mineral.mineralAmount). */
  amount?: number;
  /** Density level 1-4; used when `amount` is absent (mineral.density). */
  density?: number;
  /** Tiles from the extractor miner's spawn to the mineral (its haul leg). */
  distance: number;
  /** WORK parts of the assumed extractor miner (defaults to the mature miner). */
  workParts?: number;
}

/**
 * GROSS energy-equivalent/tick a mineral deposit yields via the market chain.
 * Zero when the mineral type is unknown, has no market price, or its deposit
 * size is unknown (unscouted density) - an unknown mineral is credited nothing,
 * not guessed. This is the term that folds into a node's economic value so
 * mineral-rich rooms (especially dense keeper X / H) rank up for claiming.
 */
export function mineralNodeValue(facts: MineralNodeFacts, prices: MarketPrices): number {
  const type = facts.mineralType;
  if (!type) return 0;
  const price = prices.minerals[type];
  if (!price || price <= 0) return 0;
  const exchange = marketEnergyPerMineral(price, prices.energy);
  if (exchange <= 0) return 0;

  // Deposit size: exact amount when scouted, else the density band, else
  // unknown -> 0 (mineralNetEnergy of a 0 deposit is 0; we do not guess).
  const amount = facts.amount ?? (facts.density !== undefined ? MINERAL_DENSITY_AMOUNT[facts.density] ?? 0 : 0);
  if (amount <= 0) return 0;

  const work = facts.workParts ?? DEFAULT_MINERAL_MINER_WORK;
  return mineralNetEnergy(amount, work, exchange, facts.distance);
}
