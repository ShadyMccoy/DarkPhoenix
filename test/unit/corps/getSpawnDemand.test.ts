import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { MinerAssignment, HaulerAssignment, SinkAllocation } from "../../../src/flow/FlowTypes";

const ctx = { energyCapacity: 550, tick: 100 };

describe("corp getSpawnDemand()", () => {
  describe("HarvestCorp", () => {
    it("returns no demand without a miner assignment", () => {
      const corp = new HarvestCorp("W1N1-harvest-aaaa", "spawn1", "source-aaaa");
      expect(corp.getSpawnDemand(ctx)).to.deep.equal([]);
    });

    it("emits a blocking, income-producing miner demand with positive costs", () => {
      const corp = new HarvestCorp("W1N1-harvest-aaaa", "spawn1", "source-aaaa");
      corp.setMinerAssignment({
        sourceId: "source-aaaa", spawnId: "spawn-spawn1", harvestRate: 10,
        maxMiners: 1, efficiency: 80,
      } as MinerAssignment);

      const demands = corp.getSpawnDemand(ctx);
      expect(demands).to.have.length(1);
      const d = demands[0];
      expect(d.role).to.equal("miner");
      expect(d.blocking).to.equal(true); // no miners yet
      expect(d.producesIncome).to.equal(true);
      expect(d.minCost).to.be.greaterThan(0);
      expect(d.desiredCost).to.be.at.least(d.minCost);
      expect(d.value).to.be.greaterThan(100); // base + efficiency
    });
  });

  describe("CarryCorp", () => {
    it("returns no demand without a hauler assignment", () => {
      const corp = new CarryCorp("W1N1-hauling-aaaa", "spawn1");
      expect(corp.getSpawnDemand(ctx)).to.deep.equal([]);
    });

    it("emits a blocking, income-producing hauler demand sized to carry parts", () => {
      const corp = new CarryCorp("W1N1-hauling-aaaa", "spawn1");
      corp.setHaulerAssignments([{
        fromId: "source-aaaa", carryParts: 4, spawnId: "spawn-spawn1", haulerRatio: "1:1",
      } as HaulerAssignment]);

      const demands = corp.getSpawnDemand(ctx);
      expect(demands).to.have.length(1);
      const d = demands[0];
      expect(d.role).to.equal("hauler");
      expect(d.blocking).to.equal(true);
      expect(d.producesIncome).to.equal(true);
      expect(d.minCost).to.equal(100);
      expect(d.desiredCost).to.equal(400); // 4 CARRY+MOVE pairs
    });
  });

  describe("UpgradingCorp", () => {
    it("emits a blocking upgrader demand ranked alongside producers", () => {
      const corp = new UpgradingCorp("W1N1-upgrading", "spawn1");
      corp.setSinkAllocation({
        sinkId: "controller-x", sinkType: "controller", allocated: 5, demand: 5,
        unmet: 0, priority: 65,
      } as SinkAllocation);

      const demands = corp.getSpawnDemand(ctx);
      expect(demands).to.have.length(1);
      const d = demands[0];
      expect(d.role).to.equal("upgrader");
      expect(d.blocking).to.equal(true);
      expect(d.producesIncome).to.equal(false);
      // Spawn priority is decoupled from the controller's (low) routing priority:
      // consuming the budgeted energy ranks alongside the producers that supply it.
      expect(d.value).to.equal(90);
      expect(d.minCost).to.be.greaterThan(0);
    });

    it("still emits a default-sized upgrader demand without an allocation", () => {
      const corp = new UpgradingCorp("W1N1-upgrading", "spawn1");
      const demands = corp.getSpawnDemand(ctx);
      expect(demands).to.have.length(1);
      expect(demands[0].value).to.equal(90);
    });
  });
});
