import { expect } from "chai";
import "../../../src/types/Memory";
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { MinerAssignment } from "../../../src/flow/FlowTypes";
import { buildMinerBody } from "../../../src/spawn/BodyBuilder";
import { Game as MockGame } from "../mock";

/**
 * Mining-corp planning under the real constraints: a source produces a fixed
 * energy/tick (≈10) but has only a handful of walkable tiles around it (1-4
 * "spots"), and the room can only build a body as large as its energy capacity
 * allows. The optimal plan trades miner SIZE against miner COUNT: a big room
 * with one spot fields a single large miner; a small room with several spots
 * splits the work across small ones; a one-spot source in a small room is
 * genuinely capacity-bound and cannot be fully harvested at all.
 *
 * We mock the node (a MinerAssignment carrying the source's harvest rate and its
 * spot count) and drive HarvestCorp.getSpawnDemand through its whole spawn
 * sequence, building each miner at the size it asks for, and read off the fleet.
 */

/** WORK parts a single miner can be built with at this capacity (full energy). */
function maxWorkPerMiner(capacity: number): number {
  return buildMinerBody(99, capacity).workParts;
}

/**
 * Drive the corp from an empty fleet, accepting each miner it asks for (built at
 * the FULL desired size, i.e. assuming the room can afford its desiredCost), and
 * return the fielded miners' WORK plus the demand's runt floor.
 */
function fieldFleet(spots: number, capacity: number, harvestRate = 10): { work: number[]; minWorkFloor: number } {
  const nodeId = "W1N1-harvest-s";
  const corp = new HarvestCorp(nodeId, "spawn1", "source-s");
  const corpId = corp.id; // getTotalCreepCount matches creep.memory.corpId === corp.id
  corp.setMinerAssignment({
    sourceId: "source-s", nodeId, spawnId: "spawn-spawn1", spawnDistance: 2,
    harvestRate, spawnCostPerTick: 0, maxMiners: spots, efficiency: 80,
  } as MinerAssignment);

  const work: number[] = [];
  let minWorkFloor = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const creeps: Record<string, unknown> = {};
    work.forEach((w, i) => {
      creeps[`m${i}`] = {
        memory: { corpId, workType: "harvest" },
        spawning: false,
        getActiveBodyparts: () => w,
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = { creeps, time: 100, getObjectById: () => null };
    const demands = corp.getSpawnDemand({ energyCapacity: capacity, tick: 100 });
    if (demands.length === 0) break;
    // Recover the runt floor from minCost: WORK parts a minCost body buys.
    minWorkFloor = bodyWorkForCost(demands[0].minCost, capacity);
    work.push(buildMinerBody(demands[0].bodyParam as number, capacity).workParts);
  }
  return { work, minWorkFloor };
}

/** WORK parts in the largest miner body that costs at most `cost`. */
function bodyWorkForCost(cost: number, capacity: number): number {
  return buildMinerBody(99, Math.min(cost, capacity)).workParts;
}

const harvestOf = (work: number[]): number => Math.min(10, work.reduce((s, w) => s + w, 0) * 2);

describe("HarvestCorp mining planning (spots x capacity)", () => {
  afterEach(() => {
    // Restore a full, empty-fleet mock Game rather than deleting it: other
    // unit-test files rely on a defined global.Game complete with its methods.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = { ...MockGame, creeps: {}, time: 100 };
  });

  // The optimal harvest each cell can reach, given maxWorkPerMiner(cap) and that
  // a full 10/tick source needs 5 WORK. Constrained cells stay below 10/tick.
  const cases: { cap: number; spots: number; harvest: number }[] = [
    { cap: 300, spots: 1, harvest: 4 },  // one 2-WORK miner: capacity-bound
    { cap: 300, spots: 2, harvest: 8 },  // two 2-WORK miners
    { cap: 300, spots: 3, harvest: 10 }, // three 2-WORK miners saturate it
    { cap: 300, spots: 4, harvest: 10 },
    { cap: 550, spots: 1, harvest: 8 },  // one 4-WORK miner: still capacity-bound
    { cap: 550, spots: 2, harvest: 10 }, // two 3-WORK miners saturate it
    { cap: 550, spots: 3, harvest: 10 },
    { cap: 800, spots: 1, harvest: 10 }, // one 5-WORK miner saturates it
    { cap: 800, spots: 2, harvest: 10 },
  ];

  for (const { cap, spots, harvest } of cases) {
    it(`cap=${cap}, ${spots} spot(s) -> ${harvest}/tick (optimal constrained)`, () => {
      const { work } = fieldFleet(spots, cap);
      expect(harvestOf(work)).to.equal(harvest);
      // Never field more miners than the source has spots.
      expect(work.length).to.be.at.most(spots);
      // Each miner fits the room's capacity.
      expect(Math.max(...work)).to.be.at.most(maxWorkPerMiner(cap));
    });
  }

  it("never floors the bootstrap miner to a 1-WORK runt (it would starve the spawn)", () => {
    // A 1-WORK miner harvests 2/tick against a 10/tick source. Even at a bare
    // spawn the first miner's floor must be a functional 2-WORK body.
    for (const cap of [300, 550, 800]) {
      const { minWorkFloor } = fieldFleet(1, cap);
      expect(minWorkFloor).to.be.at.least(2, `cap=${cap}: bootstrap miner floor must be >= 2 WORK`);
    }
  });

  it("uses extra spots to reach full harvest a single miner could not", () => {
    // At 300 a miner caps at 2 WORK (4/tick). One spot is capacity-bound at
    // 4/tick; three spots reach the full 10/tick by splitting the work.
    expect(harvestOf(fieldFleet(1, 300).work)).to.equal(4);
    expect(harvestOf(fieldFleet(3, 300).work)).to.equal(10);
  });
});
