/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { harvestKind } from "../../../src/corps/kinds/harvestKind";
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { Commission } from "../../../src/economy/Commission";
import { buildRatioHaulerBody } from "../../../src/spawn/BodyBuilder";

/**
 * The MINER OPERATION at the kind/corp layer (spec 34 D5 second half): the
 * harvest kind fields the whole operation - miner node plus the evacuation
 * vector's haulers - from ONE commission. The carry squad is an internal
 * CarryCorp engine sharing the harvest corp's id (creeps stamp {corpId,
 * workType}; workType separates the squads, exactly the construction
 * builder/tanker pattern). Scavenge stocks keep the standalone carry path.
 */
describe("miner operation (spec 34 D5: haulers are the harvest kind's internal squad)", () => {
  beforeEach(() => {
    setupGlobals();
    const g = global as any;
    g.FIND_SOURCES = 105;
    g.RESOURCE_ENERGY = "energy";
    Game.creeps = {};
    Game.getObjectById = () => null;
    (Memory as any).creeps = {};
    (Memory as any).rooms = {};
  });

  const at = (x: number, y = 25, room = "W1N1") => ({ x, y, roomName: room });

  const operationCommission = (routes: any[]): Commission => ({
    corpId: "harvest-source-abcd",
    kind: "harvest",
    shape: "produce",
    consumes: { spawnPartsPerTick: 0.05 },
    produces: { energyRate: 10, at: at(15) },
    assignment: {
      miner: {
        sourceId: "source-abcd",
        nodeId: "n-a",
        spawnId: "spawn-sp1",
        distance: 10,
        rate: 10,
        spawnParts: 0.1,
        netEnergy: 10,
        efficiency: 1,
        maxMiners: 1
      },
      routes
    }
  });

  const route = (sinkId = "spawn-sp1") => ({
    sourceId: "source-abcd",
    sinkId,
    spawnId: "spawn-sp1",
    distance: 10,
    flowRate: 5,
    carryParts: 4,
    spawnParts: 0.04
  });

  it("roles declare the hauler (income-delivering) alongside the miner", () => {
    expect(harvestKind.roles.miner.workType).to.equal("harvest");
    expect(harvestKind.roles.hauler?.workType).to.equal("haul");
    expect(harvestKind.roles.hauler?.deliversEnergy).to.equal(true);
  });

  it("body dispatch: role hauler builds the ratio hauler body", () => {
    const body = harvestKind.body("hauler", 4, 800, { haulerRatio: "2:1" });
    expect(body).to.deep.equal(buildRatioHaulerBody(4, 800, "2:1").body);
  });

  it("materialize wires the routes into the corp's internal haul squad", () => {
    const corp = harvestKind.materialize(operationCommission([route()]), undefined);
    expect(corp.getHaulAssignmentForSource("abcd"), "route bound by real game source id").to.not.equal(undefined);
    // Re-materialize refreshes routes on the existing corp (commission-owned).
    const again = harvestKind.materialize(operationCommission([]), corp);
    expect(again.id).to.equal(corp.id);
    expect(again.getHaulAssignmentForSource("abcd"), "haul-of-zero refresh clears the vector").to.equal(undefined);
  });

  it("getSpawnDemand includes the vector's hauler demand under the operation's own id", () => {
    const corp = harvestKind.materialize(operationCommission([route()]), undefined);
    const demands = corp.getSpawnDemand({ energyCapacity: 550, energyAvailable: 550 } as any);
    const hauler = demands.find(d => d.role === "hauler");
    expect(hauler, "the vector demands its carriers").to.not.equal(undefined);
    expect(hauler!.buyerCorpId, "one operation, one buyer id").to.equal(corp.id);
  });

  it("the miner squad never counts the operation's haulers (workType separates the cohabitants)", () => {
    const corp = harvestKind.materialize(operationCommission([route()]), undefined);
    (Game.creeps as any).h1 = {
      name: "h1",
      memory: { corpId: corp.id, workType: "haul" },
      spawning: false,
      body: [],
      ticksToLive: 900
    };
    (Game.creeps as any).m1 = {
      name: "m1",
      memory: { corpId: corp.id, workType: "harvest" },
      spawning: false,
      body: [],
      ticksToLive: 900
    };
    expect((corp as any).getActiveCreeps().map((c: any) => c.name), "miner scan excludes haulers").to.deep.equal([
      "m1"
    ]);
    expect(corp.getTotalCreepCount(), "miner planning count excludes haulers").to.equal(1);
  });

  it("serialize -> deserialize round-trips the haul routes (fixpoint)", () => {
    const corp = harvestKind.materialize(operationCommission([route()]), undefined);
    const once = harvestKind.serializeCorp(corp);
    const twice = harvestKind.serializeCorp(harvestKind.deserializeCorp(once, operationCommission([route()])));
    expect(twice).to.deep.equal(once);
    const revived = harvestKind.deserializeCorp(once, operationCommission([route()])) as HarvestCorp;
    expect(revived.getHaulAssignmentForSource("abcd"), "routes survive a reset").to.not.equal(undefined);
  });

  it("claimsOrphan routes a HAUL orphan to the operation serving its assigned source", () => {
    const corp = harvestKind.materialize(operationCommission([route()]), undefined);
    const corps = { [corp.id]: corp } as any;
    const haulOrphan: any = {
      pos: { roomName: "W1N1", findInRange: () => [] },
      memory: { workType: "haul", assignedSourceId: "abcd" }
    };
    expect(harvestKind.claimsOrphan!(haulOrphan, corps)).to.equal(corp.id);
    const strangerHaul: any = {
      pos: { roomName: "W1N1", findInRange: () => [] },
      memory: { workType: "haul", assignedSourceId: "zzzz" }
    };
    expect(harvestKind.claimsOrphan!(strangerHaul, corps), "unserved source: fall through").to.equal(null);
  });
});
