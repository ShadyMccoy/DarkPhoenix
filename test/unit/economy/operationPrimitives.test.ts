import { expect } from "chai";
import {
  bufferCarryParts,
  refuelIntervalTicks,
  parkedRelayCarry,
  PARKED_RELAY_CYCLE_TICKS,
  roundTripTicks,
  carryPartsFor,
  supplyMethod,
  DIRECT_DRAW_REACH,
  directFetchParts,
  vectorSupplyParts,
  operationSpawnLoad,
  constructionWorkSpawnLoad,
  effectiveLife
} from "../../../src/economy/primitives";

/**
 * Spec 34 (operation corps): the consumer-buffer and supply-method primitives.
 * A consumer's onboard CARRY is a BUFFER bridging its refuel interval (owner:
 * "the carry is designed to carry it over in between refuelings ... depending
 * on the number of work parts, the distance back to the energy source and how
 * many haulers are working the route"); the supply method (dedicated vector vs
 * self-fetch vs adjacent direct-draw) is a computed crossover in spawn-parts,
 * never a category baked into a corp.
 */
describe("economy/primitives - operation corps (spec 34)", () => {
  describe("bufferCarryParts (D2: one buffer law for every consumer)", () => {
    it("rate x interval / 50: a 25 e/t burner bridging 10 ticks needs 5 CARRY", () => {
      expect(bufferCarryParts(25, 10)).to.be.closeTo(5, 1e-9);
    });

    it("parkedRelayCarry IS the degenerate case (interval = the 2-tick parked cycle)", () => {
      for (const rate of [3, 17.5, 115]) {
        expect(bufferCarryParts(rate, PARKED_RELAY_CYCLE_TICKS)).to.be.closeTo(parkedRelayCarry(rate), 1e-9);
      }
    });

    it("burn-density (C1): the same 5-WORK body buffers 5x more CARRY as a builder than an upgrader", () => {
      const interval = 12;
      const builderBurn = 5 * 5; // BUILD_POWER
      const upgraderBurn = 5 * 1; // UPGRADE_CONTROLLER_POWER
      expect(bufferCarryParts(builderBurn, interval)).to.be.closeTo(5 * bufferCarryParts(upgraderBurn, interval), 1e-9);
    });
  });

  describe("refuelIntervalTicks (the delivery cadence the buffer bridges)", () => {
    it("n haulers on the vector: deliveries every roundTrip/n", () => {
      expect(refuelIntervalTicks(8, 2)).to.be.closeTo(roundTripTicks(8) / 2, 1e-9);
    });

    it("no haulers: the consumer's own round trip is the cadence (self-fetch)", () => {
      expect(refuelIntervalTicks(8, 0)).to.be.closeTo(roundTripTicks(8), 1e-9);
    });

    it("monotone: more haulers -> shorter interval; more distance -> longer", () => {
      expect(refuelIntervalTicks(8, 3)).to.be.lessThan(refuelIntervalTicks(8, 2));
      expect(refuelIntervalTicks(12, 2)).to.be.greaterThan(refuelIntervalTicks(8, 2));
    });
  });

  describe("supplyMethod (D1: the crossover is computed, and it sits at adjacency)", () => {
    it("fuel within withdraw range (d<=1): direct draw - the route of length 0", () => {
      expect(supplyMethod(10, 0).method).to.equal("direct");
      expect(supplyMethod(10, 1).method).to.equal("direct");
    });

    it("beyond adjacency the vector wins: measured example points (rate 10)", () => {
      // d=8: vector ~12 standing parts vs self-fetch ~22 at its OPTIMAL cycle.
      const at8 = supplyMethod(10, 8);
      expect(at8.method).to.equal("vector");
      expect(vectorSupplyParts(10, 8)).to.be.lessThan(directFetchParts(10, 8));
      // Even at d=2 dedicated logistics beats WORK idling (100e parts idle).
      const at2 = supplyMethod(10, 2);
      expect(at2.method).to.equal("vector");
      expect(vectorSupplyParts(10, 2)).to.be.lessThan(directFetchParts(10, 2));
    });

    /**
     * REACH BOUND (live P8, t72675271). The parts comparison alone flips back
     * to "direct" at long range - directFetchParts grows linearly while
     * vectorSupplyParts carries a fixed overhead, so the two curves recross.
     * MEASURED at the cross-room distance the code actually prices
     * (roomLinearDistance * 50 = 100): direct 241.5 parts vs vector 250.4 at
     * rate 20 - a 3.6% margin that handed the verdict to a branch the RUNTIME
     * CANNOT PERFORM. doPickup scavenges range 4 and never travels for energy
     * ("Haulers are responsible for delivering energy to builders"), so a
     * "direct" verdict 100 tiles from the fuel fields no tanker and the
     * builder simply never eats:
     *
     *   building-W43N23-construction crew 2 buildTargets "FR"
     *     crewAt "W41N23,W43N23" poolHead "W41N23" poolWork "W41N23:4251"
     *     tankers 0 vectorFed false latchedToSite 0
     *
     * 15 sites standing, 20 e/t allocated, 0 built - P8 "CREW IDLE". A plan
     * that prices a behavior the runtime never performs is a fidelity bug by
     * construction, so the verdict is bounded by REACH, not just by parts.
     */
    it("never returns direct beyond the parked builder's reach (the P8 recross)", () => {
      // The cross-room distance that produced the live deadlock.
      expect(supplyMethod(20, 100).method).to.equal("vector");
      expect(supplyMethod(5, 100).method).to.equal("vector");
      expect(supplyMethod(60, 100).method).to.equal("vector");
    });

    it("the bound is the stationary draw reach, and adjacency still draws direct", () => {
      expect(DIRECT_DRAW_REACH).to.be.at.least(1);
      expect(supplyMethod(10, 1).method).to.equal("direct");
      // Just past the reach the vector is the ONLY implementable supply.
      expect(supplyMethod(10, DIRECT_DRAW_REACH + 1).method).to.equal("vector");
    });

    it("keeps the parts comparison INSIDE the reach (the bound adds, never overrides)", () => {
      // Within reach the economics still decide - at d=2 the vector already
      // wins on parts, and that verdict must be unchanged by the bound.
      const at2 = supplyMethod(10, 2);
      expect(at2.method).to.equal("vector");
      expect(at2.directParts).to.be.greaterThan(at2.vectorParts);
    });

    it("still reports BOTH part counts when the reach bound decides", () => {
      // The bound changes the verdict, not the accounting - P4 reads these.
      const far = supplyMethod(20, 100);
      expect(far.directParts).to.be.greaterThan(0);
      expect(far.vectorParts).to.be.greaterThan(0);
    });

    it("vector parts = 2x carryPartsFor (CARRY+MOVE at 1:1) - no third formula", () => {
      expect(vectorSupplyParts(10, 8)).to.be.closeTo(2 * carryPartsFor(10, 8), 1e-9);
    });

    it("directFetchParts charges the WORK idle (1/u scaling) AND the laden-return MOVE", () => {
      // At the optimal cycle T* = sqrt(10*RT) the total is still dominated by
      // the idle-WORK compensation - pin the d=8 example from the spec (~22).
      expect(directFetchParts(10, 8)).to.be.closeTo(21.9, 0.5);
    });
  });

  describe("operationSpawnLoad (D4: the ALL-IN commission price)", () => {
    it("node load + vector loads, amortized over effectiveLife - derives from existing primitives only", () => {
      const rate = 10;
      const siteDistance = 5;
      const fuelDistance = 8;
      const expected =
        constructionWorkSpawnLoad(rate, siteDistance) + vectorSupplyParts(rate, fuelDistance) / effectiveLife(fuelDistance);
      expect(
        operationSpawnLoad(constructionWorkSpawnLoad(rate, siteDistance), [{ rate, distance: fuelDistance }])
      ).to.be.closeTo(expected, 1e-9);
    });

    it("no vectors: the node load alone (adjacent fuel adds nothing)", () => {
      const node = constructionWorkSpawnLoad(10, 5);
      expect(operationSpawnLoad(node, [])).to.be.closeTo(node, 1e-9);
    });
  });
});
