import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { ControllerFeederCorp } from "../../../src/corps/ControllerFeederCorp";
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

    it("the hostile-defund exit STAMPS its gate (no silent demand exits, cycle t72793209)", () => {
      // Three dark corps read as "no stamp at all" while their rooms sat
      // invader-occupied, and E6 quoted their frozen pre-defund stamps.
      const savedMemory = (global as any).Memory;
      const savedGame = (global as any).Game;
      try {
        (global as any).Game = { time: 5000, rooms: {}, getObjectById: () => null };
        (global as any).Memory = { roomIntel: { W1N1: { lastVisit: 1, invaderReservedUntil: 9000 } } };
        const corp = new HarvestCorp("W1N1-harvest-aaaa", "spawn1", "source-aaaa");
        corp.setMinerAssignment({
          sourceId: "source-aaaa", spawnId: "spawn-spawn1", harvestRate: 10,
          maxMiners: 1, efficiency: 80,
        } as MinerAssignment);
        expect(corp.getSpawnDemand({ ...ctx, tick: 5000 })).to.deep.equal([]);
        expect(corp.lastSizing?.gate, "the defund names itself").to.equal("hostile-defund");
      } finally {
        (global as any).Memory = savedMemory;
        (global as any).Game = savedGame;
      }
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
                // A containerFed 26-part body is 24 WORK + 1 CARRY + 1 MOVE.
                // The fleet's WORK is read by the count-AND-capacity exit
                // (upgraderFleetSatisfied), so the stub must carry it like a
                // real creep does.
                getActiveBodyparts: (part: string) => (part === (global as any).WORK ? 24 : 1),
                memory: { corpId: upgraderCorpId, workType: "upgrade" }
              }
            }
          : {},
        getObjectById: (id: string) => (id === SPAWN_ID ? spawn : null)
      };
    }

    it("a scaling upgrader under surplus declares holdToFund on its indivisible body", () => {
      const corp = new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID);
      stageRoom(191_613, corp.id); // the incident's bank, one incumbent
      // THE PLAN is what asks for growth now (owner 2026-08-02: the plan
      // allocation IS the valve). A fat bank alone must NOT conjure an
      // upgrader - that was the removed second valve. The bank's remaining job
      // here is FINANCING: whether the walk can bank toward an indivisible
      // full-size body, which is what incident t72503018 is about.
      corp.setSinkAllocation({
        sinkId: "controller-1",
        sinkType: "controller",
        allocated: 120,
        demand: 120,
        unmet: 0,
        priority: 65
      } as any);
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

  /**
   * The feeder is the LINCHPIN of the spend path (owner 2026-07-24: "unless we
   * have basically no energy, we always want the feeder; everything else is
   * optimized to rely on it"). At value 95 it lost the ranked spawn slot to
   * miners (100), the tender (96), and high-demand haulers, so it oscillated -
   * and when it was dark the upgraders went surplus-blind (bankedBehindFeeder
   * null) and the bank rotted (E4 idle-capital coupling, audit t72553726). The
   * FIRST feeder now outranks the marginal producer; additional feeders (surplus
   * drawdown) stay infra-tier. It never WALLS (blocking false), so no spiral.
   */
  describe("ControllerFeederCorp priority (the linchpin, owner 2026-07-24)", () => {
    const ROOM = "W1N1";
    const SPAWN_ID = "spawn1";
    let savedGame: any;
    let savedMemory: any;

    beforeEach(() => {
      savedGame = (global as any).Game;
      savedMemory = (global as any).Memory;
      (global as any).FIND_MY_STRUCTURES = 108;
      (global as any).FIND_STRUCTURES = 107;
      (global as any).STRUCTURE_LINK = "link";
      (global as any).STRUCTURE_CONTAINER = "container";
      (global as any).RESOURCE_ENERGY = "energy";
      (global as any).WORK = "work";
      (global as any).CARRY = "carry";
      (global as any).MOVE = "move";
    });
    afterEach(() => {
      (global as any).Game = savedGame;
      (global as any).Memory = savedMemory;
    });

    /** Stage a link-less (walking) room past every feeder gate: storage banked,
     * a live miner (income), and `feederCount` feeders already fielded. */
    function stageRoom(banked: number, controllerAt: { x: number; y: number }, feederCount: number, corpId: string) {
      const noStructs = { findInRange: () => [] };
      const room: any = { name: ROOM, memory: {} };
      room.storage = { my: true, store: { energy: banked }, pos: noStructs };
      room.controller = {
        my: true,
        pos: { x: controllerAt.x, y: controllerAt.y, roomName: ROOM, findInRange: () => [] }
      };
      const spawn: any = {
        id: SPAWN_ID,
        room,
        pos: {
          x: 30,
          y: 20,
          roomName: ROOM,
          getRangeTo: (t: any) => Math.max(Math.abs(30 - t.x), Math.abs(20 - t.y))
        }
      };
      const creeps: any = {
        miner1: { room: { name: ROOM }, spawning: false, memory: { workType: "harvest", corpId: "mining-x" } }
      };
      for (let i = 0; i < feederCount; i++) {
        creeps[`f${i}`] = { room: { name: ROOM }, spawning: false, memory: { workType: "feed", corpId } };
      }
      (global as any).Memory = { creeps: {}, rooms: {} };
      (global as any).Game = {
        time: 100,
        rooms: {},
        creeps,
        getObjectById: (id: string) => (id === SPAWN_ID ? spawn : null)
      };
    }

    it("WITH ENERGY the first feeder outranks the miner band (value 150), never walls", () => {
      const corp = new ControllerFeederCorp(`${ROOM}-controllerFeeder`, SPAWN_ID);
      stageRoom(60_000, { x: 25, y: 10 }, 0, corp.id); // banked surplus, ZERO feeders
      const demands = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(demands).to.have.length(1);
      const d = demands[0];
      expect(d.role).to.equal("feeder");
      // Above the miner band (100 + efficiency*0.5 < 150) so the linchpin wins.
      expect(d.value, "the linchpin outranks miners when energy is present").to.equal(150);
      expect(d.blocking, "but never walls the bank").to.equal(false);
      expect(d.infrastructure, "and pierces holds while its post is dark with a real bank").to.equal(true);
    });

    it("DRAINED (NO energy, the rare case) the feeder yields to income (value 90, below miners)", () => {
      const corp = new ControllerFeederCorp(`${ROOM}-controllerFeeder`, SPAWN_ID);
      stageRoom(1_000, { x: 25, y: 10 }, 0, corp.id); // banked < FEEDER_INCOME_FIRST_FLOOR
      const demands = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(demands).to.have.length(1);
      expect(demands[0].value, "miners rebuild income first when there is no energy").to.equal(90);
      expect(demands[0].infrastructure, "drained: no pierce (banked < 10k)").to.equal(false);
    });

    it("ADDITIONAL feeders (surplus drawdown) stay infra-tier (value 95)", () => {
      const corp = new ControllerFeederCorp(`${ROOM}-controllerFeeder`, SPAWN_ID);
      // A far controller inflates neededCarry past one body, so with ONE feeder
      // fielded the corp still demands a second - which must NOT front-run income.
      stageRoom(60_000, { x: 48, y: 48 }, 1, corp.id);
      const demands = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(demands, "a second feeder is still wanted for the far relay").to.have.length(1);
      expect(demands[0].value, "additional feeders never outrank producers").to.equal(95);
      expect(demands[0].infrastructure, "and only the first feeder pierces").to.equal(false);
    });
  });

  /**
   * Spec 45 volley-service floor (owner sizing doctrine 2026-08-05): the
   * feeder is a SERVICE creep - it must clear a FULL 800e link volley from
   * the core in ONE parked withdraw+transfer cycle whenever inbound senders
   * (deposit ports / source links) exist, or it is itself the network's
   * clamp (measured: 4C body vs volleys every ~7t -> coreEmptyShare 0.26,
   * hubClampShare 0.50). Idle feeder ticks between volleys are the PRICE of
   * hauler duty; idle hauler ticks are the waste.
   */
  describe("ControllerFeederCorp volley-service floor (spec 45)", () => {
    const ROOM = "W1N1";
    const SPAWN_ID = "spawn1";
    let savedGame: any;
    let savedMemory: any;

    beforeEach(() => {
      savedGame = (global as any).Game;
      savedMemory = (global as any).Memory;
      (global as any).FIND_MY_STRUCTURES = 108;
      (global as any).FIND_STRUCTURES = 107;
      (global as any).FIND_SOURCES = 105;
      (global as any).STRUCTURE_LINK = "link";
      (global as any).RESOURCE_ENERGY = "energy";
    });
    afterEach(() => {
      (global as any).Game = savedGame;
      (global as any).Memory = savedMemory;
    });

    /** Stage a LINK-FED room: core link beside storage, controller link, and
     * `senderCount` additional links (the inbound senders). */
    function stageLinkRoom(senderCount: number, corpId: string) {
      const core = { id: "core-link", structureType: "link", pos: { x: 31, y: 21, roomName: ROOM } };
      const ctrl = { id: "ctrl-link", structureType: "link", pos: { x: 25, y: 11, roomName: ROOM } };
      const senders = Array.from({ length: senderCount }, (_, i) => ({
        id: `sender-${i}`,
        structureType: "link",
        pos: { x: 40 + i, y: 5, roomName: ROOM }
      }));
      const allLinks = [core, ctrl, ...senders];
      const room: any = {
        name: ROOM,
        memory: {},
        find: (type: number, opts?: { filter?: (s: any) => boolean }) => {
          if (type === (global as any).FIND_SOURCES) return [];
          const list = allLinks;
          return opts?.filter ? list.filter(opts.filter) : list;
        }
      };
      room.storage = {
        my: true,
        store: { energy: 60_000 },
        pos: { x: 30, y: 20, roomName: ROOM, findInRange: () => [core] }
      };
      room.controller = {
        my: true,
        pos: { x: 25, y: 10, roomName: ROOM, findInRange: () => [ctrl] }
      };
      const spawn: any = {
        id: SPAWN_ID,
        room,
        pos: { x: 30, y: 20, roomName: ROOM, getRangeTo: () => 10 }
      };
      (global as any).Memory = { creeps: {}, rooms: {} };
      (global as any).Game = {
        time: 100,
        rooms: {},
        creeps: {
          miner1: { room: { name: ROOM }, spawning: false, memory: { workType: "harvest", corpId: "mining-x" } }
        },
        getObjectById: (id: string) => (id === SPAWN_ID ? spawn : null)
      };
    }

    // UPDATED t72819265: the floor is PER SENDER, not one total. The live A/B
    // aged the pair back to one feeder and the core clamped 0.268 (predicted
    // 0.28) against 0.091, while the SINGLE feeder moved MORE per tick (187.33
    // vs 131.28): latency, not rate. One creep cannot cover two senders
    // arriving at once - it serves them serially.
    //
    // RESIZED 2026-08-07 (owner): the per-sender coefficient drops 16 -> 4, so
    // two senders floor at 8. The A/B's finding is KEPT - it was about creeps
    // per sender, and the corp still fields one feeder per sender - but its
    // per-creep body was sized to swallow a whole 800e volley in one cycle,
    // which is insurance against a latency the arrival rate cannot produce
    // (a source link can only fire every LINK_COOLDOWN x range). Measured at
    // the old floor, t72851251: hubClampShare 0.000, coreEmptyShare 0.474,
    // hubVolleyAvg 592 - never clamped, drained half the time, volleys not
    // even arriving full, for 100 spawn parts on the colony's dearest corp.
    it("with TWO inbound senders the body floors at two senders' service carry", () => {
      const corp = new ControllerFeederCorp(`${ROOM}-controllerFeeder`, SPAWN_ID);
      stageLinkRoom(2, corp.id); // two deposit ports, the live shape
      const demands = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(demands).to.have.length(1);
      expect(corp.lastSizing?.volleyFloor, "two senders x 4 CARRY - the owner's 8").to.equal(8);
      expect(corp.lastSizing?.inboundSenders).to.equal(2);
      // The BODY is still bounded by what the room can afford in one go -
      // maxCarryPairs(2300) = 23. The floor states the requirement; the budget
      // states what is buyable this tick, and the demand may not exceed it.
      // The floor no longer binds against a 2300-energy room: the body is now
      // sized by the THROUGHPUT law it always had, which is the point - the
      // floor is a latency backstop, not the sizing input.
      expect(demands[0].bodyParam, "no longer floor-bound at this capacity").to.be.at.most(23);
    });

    it("ONE inbound sender floors at one sender's service carry (lower-RCL shape)", () => {
      const corp = new ControllerFeederCorp(`${ROOM}-controllerFeeder`, SPAWN_ID);
      stageLinkRoom(1, corp.id);
      corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(corp.lastSizing?.volleyFloor, "the owner's 4 at lower RCL").to.equal(4);
      expect(corp.lastSizing?.inboundSenders).to.equal(1);
    });

    it("a pure-relay link room (core + ctrl only) keeps the throughput law untouched", () => {
      const corp = new ControllerFeederCorp(`${ROOM}-controllerFeeder`, SPAWN_ID);
      stageLinkRoom(0, corp.id);
      const demands = corp.getSpawnDemand({ energyCapacity: 2300, tick: 100 });
      expect(demands).to.have.length(1);
      expect(demands[0].bodyParam, "no volleys to service - parkedRelayCarry law stands").to.be.lessThan(16);
      expect(corp.lastSizing?.volleyFloor).to.equal(undefined);
    });
  });
});
