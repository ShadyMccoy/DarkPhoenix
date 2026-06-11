import { expect } from "chai";
import {
  scavengeRate,
  collectStocks,
  stockToTransientSource,
  EnergyFind,
  SCAVENGE_THRESHOLD,
  SCAVENGE_DRAIN_TICKS,
  MAX_SCAVENGE_RATE
} from "../../../src/economy/scavenge";

const ROOM = "W0N0";
const find = (id: string, energy: number, x = 10): EnergyFind => ({ id, energy, pos: { x, y: 25, roomName: ROOM } });

describe("economy/scavenge", () => {
  describe("scavengeRate", () => {
    it("drains a stock over the target horizon", () => {
      // 1500 energy over 150 ticks = 10/tick
      expect(scavengeRate(1500)).to.be.closeTo(1500 / SCAVENGE_DRAIN_TICKS, 1e-9);
    });
    it("caps the rate so a huge pile doesn't ask for an absurd fleet", () => {
      expect(scavengeRate(1_000_000)).to.equal(MAX_SCAVENGE_RATE);
    });
  });

  describe("collectStocks", () => {
    it("keeps stocks at or above the threshold and tags a stable scavenge id", () => {
      const stocks = collectStocks([find("aaa", SCAVENGE_THRESHOLD)]);
      expect(stocks).to.have.length(1);
      expect(stocks[0].id).to.equal("scavenge-aaa");
      expect(stocks[0].amount).to.equal(SCAVENGE_THRESHOLD);
    });
    it("ignores the trickle below the threshold (left to source-hauler pickup)", () => {
      expect(collectStocks([find("small", SCAVENGE_THRESHOLD - 1)])).to.have.length(0);
    });
    it("respects a custom threshold", () => {
      expect(collectStocks([find("x", 200)], 100)).to.have.length(1);
      expect(collectStocks([find("x", 50)], 100)).to.have.length(0);
    });
  });

  describe("stockToTransientSource", () => {
    it("produces a miner-less transient source at the stock's position", () => {
      const [s] = collectStocks([find("pile", 1500, 12)]);
      const src = stockToTransientSource(s, "node-home");
      expect(src.transient).to.equal(true);
      expect(src.maxMiners).to.equal(0);
      expect(src.nodeId).to.equal("node-home");
      expect(src.pos.x).to.equal(12);
      expect(src.rate).to.be.closeTo(scavengeRate(1500), 1e-9);
    });
  });
});
