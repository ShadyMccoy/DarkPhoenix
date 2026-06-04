import { expect } from "chai";
import { SpawningCorp } from "../../../src/corps/SpawningCorp";

describe("SpawningCorp", () => {
  let corp: SpawningCorp;

  beforeEach(() => {
    corp = new SpawningCorp("W1N1-spawn", "spawn123", 300);
  });

  describe("countPendingOrdersFrom()", () => {
    it("returns 0 when there are no pending orders", () => {
      expect(corp.countPendingOrdersFrom("any")).to.equal(0);
    });

    it("counts only the orders queued by the given buyer corp", () => {
      corp.queueSpawnOrder({ buyerCorpId: "scout-A", creepType: "scout", workTicksRequested: 0, queuedAt: 1 });
      corp.queueSpawnOrder({ buyerCorpId: "scout-A", creepType: "scout", workTicksRequested: 0, queuedAt: 2 });
      corp.queueSpawnOrder({ buyerCorpId: "miner-B", creepType: "miner", workTicksRequested: 5, queuedAt: 3 });

      expect(corp.countPendingOrdersFrom("scout-A")).to.equal(2);
      expect(corp.countPendingOrdersFrom("miner-B")).to.equal(1);
      expect(corp.countPendingOrdersFrom("missing")).to.equal(0);
    });

    it("supports the scout cap: live + pending should not exceed the limit", () => {
      // Simulate a scout corp with 0 live creeps that has already queued 1 order.
      corp.queueSpawnOrder({ buyerCorpId: "scout-W1N1", creepType: "scout", workTicksRequested: 0, queuedAt: 1 });

      const liveScouts = 0;
      const MAX_SCOUTS = 1;
      const effective = liveScouts + corp.countPendingOrdersFrom("scout-W1N1");

      // With the pending order counted, the corp is already at the cap and must
      // not queue another scout (this is what prevents spawn-queue flooding).
      expect(effective).to.equal(MAX_SCOUTS);
      expect(effective >= MAX_SCOUTS).to.equal(true);
    });
  });
});
