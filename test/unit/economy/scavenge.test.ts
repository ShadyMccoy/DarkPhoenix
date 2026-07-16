import { expect } from "chai";
import {
  scavengeRate,
  collectStocks,
  stockToTransientSource,
  excludeControllerBucket,
  CONTROLLER_BUCKET_RANGE,
  EnergyFind,
  SCAVENGE_THRESHOLD,
  SCAVENGE_DRAIN_TICKS,
  MAX_SCAVENGE_RATE
} from "../../../src/economy/scavenge";

const ROOM = "W0N0";
const find = (_id: string, energy: number, x = 10): EnergyFind => ({ energy, pos: { x, y: 25, roomName: ROOM } });

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
    it("keeps stocks at or above the threshold and tags a position-encoded id", () => {
      const stocks = collectStocks([find("aaa", SCAVENGE_THRESHOLD, 12)]);
      expect(stocks).to.have.length(1);
      expect(stocks[0].id).to.equal("scavenge-W0N0-12-25");
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

  describe("excludeControllerBucket", () => {
    const ctrl = { x: 25, y: 8, roomName: ROOM };

    it("drops finds inside the controller bucket (the upgraders' working buffer)", () => {
      // The FEEDER-MANAGED drop-off is DELIVERED energy waiting to be
      // upgraded - planning it as scavenge supply commissions haulers to carry
      // the upgraders' own buffer home while the feeder refills it (a circle).
      // The caller (detectRoomStocks) passes the controller pos only while
      // room.memory.controllerFeederActive - pre-feeder, the drop-off is the
      // colony's overflow buffer and its recapture is load-bearing.
      const inBucket = { energy: 2000, pos: { x: 25 + CONTROLLER_BUCKET_RANGE, y: 8, roomName: ROOM } };
      const outside = { energy: 2000, pos: { x: 25 + CONTROLLER_BUCKET_RANGE + 1, y: 8, roomName: ROOM } };
      const kept = excludeControllerBucket([inBucket, outside], ctrl);
      expect(kept).to.deep.equal([outside]);
    });

    it("keeps everything when no feeder-managed controller pos is given", () => {
      const finds = [find("pile", 2000, 26)];
      expect(excludeControllerBucket(finds, null)).to.deep.equal(finds);
    });

    it("covers upgrade range: matches the input-spot buffer scan", () => {
      // controllerInputSpot resolves buffers within range 3; the exclusion must
      // cover at least that zone or a pile can be both counted as upgrader
      // stock AND hauled away as scavenge.
      expect(CONTROLLER_BUCKET_RANGE).to.be.at.least(3);
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
