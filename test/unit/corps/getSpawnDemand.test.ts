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
      // Floored at min(desiredCarry, 3) CARRY+MOVE pairs - never a 1-CARRY runt.
      expect(d.minCost).to.equal(300);
      expect(d.desiredCost).to.equal(400); // 4 CARRY+MOVE pairs
    });

    it("floors a small far-route hauler at its desired size, not the 3-CARRY floor", () => {
      // A route needing only 2 CARRY should not be inflated to the 3-CARRY floor.
      const corp = new CarryCorp("W1N1-hauling-bbbb", "spawn1");
      corp.setHaulerAssignments([{
        fromId: "source-bbbb", carryParts: 2, spawnId: "spawn-spawn1", haulerRatio: "1:1",
      } as HaulerAssignment]);
      const d = corp.getSpawnDemand(ctx)[0];
      expect(d.minCost).to.equal(200); // min(desiredCarry=2, 3) = 2 pairs
      expect(d.desiredCost).to.equal(200);
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

  /**
   * holdToFund wiring (incident t72503018): a SCALING upgrader under a bank
   * surplus is an indivisible full-capacity body (min == desired == cap, the
   * runt policy) that the walk's partial-fill buys otherwise starve forever -
   * the fleet froze at 2 of targetCount 6 for 2600+ ticks while 191k (6.9x
   * the warchest target) idled and controller delivery ran 0.39x plan. The
   * corp declares holdToFund from the SAME surplus verdict its sizing scaled
   * the fleet up with (upgraderSizing().surplus - one lens, two readers), so
   * the demand it emits is one the scheduler can actually finance.
   */
  describe("UpgradingCorp holdToFund under a bank surplus (incident t72503018)", () => {
    const ROOM = "W43N23";
    const SPAWN_ID = "spawn1";
    let savedGame: any;
    let savedMemory: any;

    beforeEach(() => {
      savedGame = (global as any).Game;
      savedMemory = (global as any).Memory;
      (global as any).FIND_DROPPED_RESOURCES = 106.5; // distinct sentinel for the type switch below
      (global as any).FIND_STRUCTURES = 107;
      (global as any).RESOURCE_ENERGY = "energy";
      (global as any).STRUCTURE_LINK = "link";
      (global as any).STRUCTURE_STORAGE = "storage";
      (global as any).STRUCTURE_ROAD = "road";
      (global as any).TERRAIN_MASK_WALL = 1;
      (global as any).WORK = "work";
      (global as any).CARRY = "carry";
      (global as any).MOVE = "move";
      (global as any).RoomPosition =
        (global as any).RoomPosition ??
        class {
          public constructor(public x: number, public y: number, public roomName: string) {}
          public findInRange(): any[] {
            return [];
          }
        };
    });

    afterEach(() => {
      (global as any).Game = savedGame;
      (global as any).Memory = savedMemory;
    });

    /** Stage the incident's room: controller container stocked, storage banked. */
    function stageRoom(bankedEnergy: number, upgraderCorpId: string | null) {
      const container: any = {
        structureType: (global as any).STRUCTURE_CONTAINER ?? "container",
        pos: { x: 25, y: 12, roomName: ROOM, findInRange: () => [] },
        store: { energy: 1607 }
      };
      (global as any).STRUCTURE_CONTAINER = container.structureType;
      const room: any = {
        name: ROOM,
        memory: { controllerFeederActive: true },
        storage: { my: true, store: { energy: bankedEnergy } },
        getTerrain: () => ({ get: () => 0 }),
        lookForAt: () => [],
        // roomHasHauler: the delivery loop is closed (a real flow hauler exists).
        find: () => [{ memory: { workType: "haul", corpId: "hauling-W43N23-x" } }]
      };
      const controller: any = {
        id: "ctrl-1",
        level: 6,
        room,
        pos: {
          x: 25,
          y: 10,
          roomName: ROOM,
          findInRange: (type: number) => (type === (global as any).FIND_STRUCTURES ? [container] : [])
        }
      };
      room.controller = controller;
      const spawn: any = {
        id: SPAWN_ID,
        spawning: false,
        room,
        pos: {
          x: 30,
          y: 20,
          roomName: ROOM,
          getRangeTo: (t: any) => Math.max(Math.abs(30 - t.x), Math.abs(20 - t.y))
        }
      };
      (global as any).Memory = { creeps: {}, rooms: {} };
      (global as any).Game = {
        time: 100,
        rooms: {},
        creeps: upgraderCorpId
          ? {
              u1: {
                spawning: false,
                ticksToLive: 1400,
                body: new Array(26),
                memory: { corpId: upgraderCorpId, workType: "upgrade" }
              }
            }
          : {},
        getObjectById: (id: string) => (id === SPAWN_ID ? spawn : null)
      };
    }

    it("a scaling upgrader under surplus declares holdToFund on its indivisible body", () => {
      const corp = new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID);
      stageRoom(191_613, corp.id); // the incident's bank, one incumbent -> scaling demand
      const demands = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(demands).to.have.length(1);
      const d = demands[0];
      expect(d.blocking, "an incumbent exists - this is fleet growth").to.equal(false);
      expect(d.minCost, "runt policy: scaling bodies are indivisible").to.equal(d.desiredCost);
      expect(d.holdToFund, "surplus capital: the walk must be able to bank toward it").to.equal(true);
      expect(corp.lastSizing?.hold, "the stamp records the verdict").to.equal(true);
    });

    it("below the warchest target the demand carries no hold (save regime untouched)", () => {
      const corp = new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID);
      stageRoom(10_000, null); // bank still filling, no incumbent -> blocking first upgrader
      const demands = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(demands).to.have.length(1);
      expect(demands[0].holdToFund, "cold start / save regime never consumer-walls").to.equal(undefined);
      expect(corp.lastSizing?.hold).to.equal(undefined);
    });
  });
});
