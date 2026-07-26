/**
 * @fileoverview Market price sampler (spec 22): the WORLD-ADAPTER half of the
 * mineral EV estimate. Reads Game.market on a wide cadence and caches a price
 * snapshot into Memory.marketPrices, which economy/mineralValue reads (falling
 * back to a static snapshot when this has never run or gone stale).
 *
 * Kept OUT of economy/ deliberately: economy/ is Game-free by construction (the
 * purity ratchet), so the one place that touches the live order book is here.
 * The pricing convention matches the market chain the estimate models - SELL
 * the mineral, BUY the energy:
 *   - energy price = the cheapest SELL order (what we pay to buy energy in);
 *   - each mineral price = the best BUY order (what a buyer pays us to sell).
 *
 * @module execution/marketSampler
 */

import "../types/Memory";

/** Base extractable minerals (the only ones an extractor produces). */
const BASE_MINERALS = ["H", "O", "U", "K", "L", "Z", "X"] as const;

/** Ticks between live samples - the order book moves slowly and the call costs CPU. */
export const MARKET_SAMPLE_INTERVAL = 5_000;

/** Best (min or max) price among orders, or 0 when there are none. */
function bestPrice(orders: { price: number }[], pick: "min" | "max"): number {
  let best = 0;
  for (const o of orders) {
    if (typeof o.price !== "number" || o.price <= 0) continue;
    if (best === 0 || (pick === "min" ? o.price < best : o.price > best)) best = o.price;
  }
  return best;
}

/**
 * Sample the live market and cache the snapshot, at most once per
 * MARKET_SAMPLE_INTERVAL. No-op without a live Game.market (sims/grid), so the
 * estimate falls back to its static snapshot there - deterministic by design.
 * Defensive: any market hiccup leaves the previous cache (or fallback) intact.
 */
export function sampleMarketPrices(now: number): void {
  if (typeof Game === "undefined" || !Game.market || typeof Game.market.getAllOrders !== "function") return;
  const last = Memory.marketPrices?.updated ?? Number.NEGATIVE_INFINITY;
  if (now - last < MARKET_SAMPLE_INTERVAL) return;

  try {
    const energy = bestPrice(
      Game.market.getAllOrders({ type: ORDER_SELL, resourceType: RESOURCE_ENERGY }),
      "min"
    );
    if (energy <= 0) return; // no energy sell orders - keep the fallback

    const minerals: { [mineral: string]: number } = {};
    for (const m of BASE_MINERALS) {
      const price = bestPrice(Game.market.getAllOrders({ type: ORDER_BUY, resourceType: m as ResourceConstant }), "max");
      if (price > 0) minerals[m] = price;
    }
    if (Object.keys(minerals).length === 0) return; // no buyers - keep the fallback

    Memory.marketPrices = { energy, minerals, updated: now };
  } catch {
    // Market API unavailable this tick; the cached/fallback prices stand.
  }
}
