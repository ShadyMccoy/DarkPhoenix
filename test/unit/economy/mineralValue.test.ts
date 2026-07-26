import { expect } from "chai";
import {
  DEFAULT_MARKET_PRICES,
  MarketPrices,
  mineralNodeValue,
  resolveMarketPrices,
  MARKET_PRICE_MAX_AGE
} from "../../../src/economy/mineralValue";
import { mineralNetEnergy, marketEnergyPerMineral, MINERAL_DENSITY_AMOUNT } from "../../../src/economy/primitives";

/**
 * Spec 22 estimate acceptance: the mineral node value is the market-chain
 * energy value of a deposit, GROSS of securing cost, computed from intel alone.
 * Expected numbers derive from economy/primitives (the one formula home).
 */
describe("economy/mineralValue", () => {
  describe("resolveMarketPrices (cache-or-fallback, deterministic offline)", () => {
    it("falls back to the static snapshot when no cache is present", () => {
      expect(resolveMarketPrices(undefined, 1000)).to.equal(DEFAULT_MARKET_PRICES);
    });
    it("falls back when the cache is stale", () => {
      const stale: MarketPrices = { energy: 40, minerals: { X: 700 }, updated: 0 };
      expect(resolveMarketPrices(stale, MARKET_PRICE_MAX_AGE + 1)).to.equal(DEFAULT_MARKET_PRICES);
    });
    it("uses a fresh, well-formed cache", () => {
      const fresh: MarketPrices = { energy: 40, minerals: { X: 700 }, updated: 5000 };
      expect(resolveMarketPrices(fresh, 5000 + MARKET_PRICE_MAX_AGE)).to.equal(fresh);
    });
    it("rejects a malformed cache (zero energy would divide-by-zero the exchange)", () => {
      const bad: MarketPrices = { energy: 0, minerals: { X: 700 }, updated: 5000 };
      expect(resolveMarketPrices(bad, 5000)).to.equal(DEFAULT_MARKET_PRICES);
    });
  });

  describe("mineralNodeValue (gross energy-equivalent/tick)", () => {
    const prices = DEFAULT_MARKET_PRICES;

    it("prices a mineral via the primitives' market chain (density-3 X, hauled 25)", () => {
      const exchange = marketEnergyPerMineral(prices.minerals.X, prices.energy);
      const expected = mineralNetEnergy(MINERAL_DENSITY_AMOUNT[3], 20, exchange, 25);
      expect(mineralNodeValue({ mineralType: "X", density: 3, distance: 25 }, prices)).to.be.closeTo(expected, 1e-9);
    });

    it("prefers exact ore amount over the density band when both are known", () => {
      const exchange = marketEnergyPerMineral(prices.minerals.O, prices.energy);
      const expected = mineralNetEnergy(42_000, 20, exchange, 20);
      const v = mineralNodeValue({ mineralType: "O", amount: 42_000, density: 3, distance: 20 }, prices);
      expect(v).to.be.closeTo(expected, 1e-9);
    });

    it("ranks a dense keeper mineral (X) far above a cheap one (Z) - the claim signal", () => {
      const x = mineralNodeValue({ mineralType: "X", density: 3, distance: 25 }, prices);
      const z = mineralNodeValue({ mineralType: "Z", density: 3, distance: 25 }, prices);
      expect(x).to.be.greaterThan(z);
      expect(x).to.be.greaterThan(10); // X pencils out as a real energy source
      expect(z).to.be.lessThan(2); // Z does not - loses to remote mining
    });

    it("credits nothing for an unknown mineral type", () => {
      expect(mineralNodeValue({ mineralType: null, density: 3, distance: 25 }, prices)).to.equal(0);
      expect(mineralNodeValue({ mineralType: undefined, density: 3, distance: 25 }, prices)).to.equal(0);
    });

    it("credits nothing for a mineral with no market price", () => {
      expect(mineralNodeValue({ mineralType: "ZZ_unpriced", density: 3, distance: 25 }, prices)).to.equal(0);
    });

    it("credits nothing when the deposit size is unknown (unscouted density)", () => {
      expect(mineralNodeValue({ mineralType: "X", distance: 25 }, prices)).to.equal(0);
    });

    it("credits nothing when there is no energy market to buy into (exchange 0)", () => {
      const noEnergy: MarketPrices = { energy: 0, minerals: { X: 600 } };
      expect(mineralNodeValue({ mineralType: "X", density: 3, distance: 25 }, noEnergy)).to.equal(0);
    });

    it("scales with density", () => {
      const d2 = mineralNodeValue({ mineralType: "X", density: 2, distance: 25 }, prices);
      const d4 = mineralNodeValue({ mineralType: "X", density: 4, distance: 25 }, prices);
      expect(d4).to.be.greaterThan(mineralNodeValue({ mineralType: "X", density: 3, distance: 25 }, prices));
      expect(mineralNodeValue({ mineralType: "X", density: 3, distance: 25 }, prices)).to.be.greaterThan(d2);
    });
  });
});
