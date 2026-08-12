import { expect } from "chai";
import "../../../src/types/Memory"; // load the RoomMemory type augmentation
import {
  scavengeRate,
  collectStocks,
  stockToTransientSource,
  excludeControllerBucket,
  CONTROLLER_BUCKET_RANGE,
  EnergyFind,
  SCAVENGE_THRESHOLD,
  MAX_SCAVENGE_RATE,
  SCAVENGE_DECAY_DOMINANCE
} from "../../../src/economy/scavenge";

const ROOM = "W0N0";
const find = (_id: string, energy: number, x = 10): EnergyFind => ({ energy, pos: { x, y: 25, roomName: ROOM } });

describe("economy/scavenge", () => {
  describe("scavengeRate", () => {
    // DECAY DOMINANCE (audit t72950630). The half-life law (amount/2 over
    // effectiveLife) drains at rate/decay = 1000/(2*effectiveLife) ~ 0.36-0.42
    // at EVERY pile size - it can never beat the engine's ceil(amount/1000)
    // decay, and four consecutive windows measured exactly that: we collected
    // 18/20/24/24% while paying scavenger bodies to lose the race (recovery
    // net +0.31 e/t against 8.06 e/t of pile decay). The rate now dominates
    // decay by SCAVENGE_DECAY_DOMINANCE so ~2/3 of a funded stock is
    // recovered; the half-life term remains as the large-pile ramp and
    // MAX_SCAVENGE_RATE still caps the absurd (the retired 150-tick burst's
    // displacement, t72447104, came from 20 e/t asks - dominance asks 2-10).
    it("MATURE: the rate DOMINATES the stock's decay (never pay bodies to lose the race)", () => {
      for (const amount of [800, 1500, 1694, 5000]) {
        const decay = Math.ceil(amount / 1000);
        expect(scavengeRate(amount, 30, true), `amount=${amount}`).to.be.at.least(
          SCAVENGE_DECAY_DOMINANCE * decay - 1e-9
        );
      }
    });
    it("BOOTSTRAP keeps the waste-tolerant half-life law (the runt-economy canary: dominance displaced the miner upsize)", () => {
      // A 1901e mouth pile in a 300-cap cold-start world asked 4 e/t under
      // dominance and the upsize was "never afforded" (t72950630 gate run,
      // red). The ramp spends every spare unit on the escape; piles may rot.
      expect(scavengeRate(1500)).to.be.closeTo(1500 / 2 / 1500, 1e-9);
      expect(scavengeRate(1901, 10)).to.be.lessThan(1);
      expect(scavengeRate(1500, 100), "travel shortens the working life").to.be.greaterThan(scavengeRate(1500));
    });
    it("caps the rate so a huge pile doesn't ask for an absurd fleet, mature or not", () => {
      expect(scavengeRate(1_000_000)).to.equal(MAX_SCAVENGE_RATE);
      expect(scavengeRate(1_000_000, 0, true)).to.equal(MAX_SCAVENGE_RATE);
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

/**
 * The micro-route floor (owner 2026-07-20: "we should look into those micro
 * routes"): stocks whose sized rate lands under SCAVENGE_RATE_FLOOR plan
 * sub-1-CARRY routes and feed the E2/E5 churn loop (runt spawned, pile
 * decays away, corp strands). They stay with opportunistic pickup instead.
 */
describe("scavenge micro-route floor", () => {
  it("BOOTSTRAP: a threshold-hugging pile sizes under the floor; a real overflow pile clears it", async () => {
    const { scavengeRate, SCAVENGE_RATE_FLOOR } = await import("../../../src/economy/scavenge");
    // 750 at the spawn's doorstep: 375/1500 = 0.25 - churn, not recovery
    expect(scavengeRate(750, 10)).to.be.lessThan(SCAVENGE_RATE_FLOOR);
    // the fid-t4 recapture class (2k+ overflow near the controller) stays in
    expect(scavengeRate(2000, 20)).to.be.greaterThan(SCAVENGE_RATE_FLOOR);
  });
  it("MATURE: decay dominance subsumes the floor - every funded stock clears it by construction (audit t72950630)", async () => {
    const { scavengeRate, SCAVENGE_RATE_FLOOR, SCAVENGE_THRESHOLD } = await import("../../../src/economy/scavenge");
    // Under dominance the smallest fundable stock rates >= 2 e/t: a fast
    // clear recovering ~2/3 instead of a trickle recovering a quarter. The
    // floor holds vacuously and the trickle class cannot re-enter.
    expect(scavengeRate(SCAVENGE_THRESHOLD, 10, true)).to.be.at.least(2 - 1e-9);
    expect(scavengeRate(SCAVENGE_THRESHOLD, 10, true)).to.be.greaterThan(SCAVENGE_RATE_FLOOR);
  });
});
