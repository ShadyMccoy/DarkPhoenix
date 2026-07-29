import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { MinerAssignment } from "../../../src/flow/FlowTypes";
import { SOURCE_BUFFER_DEFER_THRESHOLD } from "../../../src/economy/primitives";
import { sourceBufferStock } from "../../../src/corps/nodeEnergy";

/**
 * The miner PILE GATE (owner directive 2026-07-29): while the unhauled buffer
 * at a source's mouth sits at/above the container cap, buying ANOTHER miner
 * body only adds rot (the sourceBuffers diagnostic, owner 2026-07-20; ~8.5k
 * measured rotting above the cap, t72588289). The gate is the sanctioned
 * scarcity class - it acts at the SPAWN (no NEW bodies), strands nobody:
 * standing miners keep mining and the haul vector stays ungated (haulers are
 * the release). Vision-scoped and FAIL-OPEN: an unmeasurable buffer (no
 * vision) never defers, and a colony cold start is exempt entirely.
 */

const ctx = { energyCapacity: 550, tick: 100 };

/** A visible source staging `container` energy in a range-1 container and
 *  `pile` energy on the ground - the two stocks sourceBufferStock sums. */
function stageSource(container: number, pile: number): any {
  return {
    id: "srcaaaa",
    room: { name: "W2N2", find: () => [], controller: undefined },
    pos: {
      x: 10,
      y: 10,
      roomName: "W2N2",
      findInRange: (type: number) => {
        if (type === (global as any).FIND_STRUCTURES) {
          return [{ structureType: "container", store: { energy: container } }];
        }
        if (type === (global as any).FIND_DROPPED_RESOURCES) {
          return [{ resourceType: "energy", amount: pile }];
        }
        return [];
      }
    }
  };
}

/** A corp over a 20 e/t source (target 2 miners at 550 cap) so ONE standing
 *  miner leaves live under-target demand for the gate to defer. */
function stagedCorp(): HarvestCorp {
  const corp = new HarvestCorp("W2N2-harvest-aaaa", "spawn1", "srcaaaa");
  corp.setMinerAssignment({
    sourceId: "source-srcaaaa",
    spawnId: "spawn-spawn1",
    harvestRate: 20,
    maxMiners: 2,
    efficiency: 80
  } as MinerAssignment);
  return corp;
}

/** One standing miner for the corp: current=1 (not a colony cold start),
 *  under the target of 2, so the demand path is live. */
function stageStandingMiner(corp: HarvestCorp): void {
  (global as any).Game.creeps = {
    m1: {
      name: "m1",
      spawning: false,
      ticksToLive: 1400,
      body: new Array(8).fill({ type: "work" }),
      memory: { corpId: corp.id, workType: "harvest" },
      getActiveBodyparts: () => 2,
      pos: { x: 11, y: 10, roomName: "W2N2", getRangeTo: () => 1 }
    }
  };
}

describe("HarvestCorp miner pile gate (unhauled-buffer spawn deferral)", () => {
  let realGetObjectById: (id: string) => any;

  beforeEach(() => {
    realGetObjectById = (global as any).Game.getObjectById;
    (global as any).Game.creeps = {};
    (global as any).Game.time = ((global as any).Game.time ?? 0) + 1; // fresh hostileRooms memo
  });

  afterEach(() => {
    (global as any).Game.getObjectById = realGetObjectById;
    (global as any).Game.creeps = {};
  });

  it("defers the miner purchase while the buffer sits at the container cap", () => {
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(SOURCE_BUFFER_DEFER_THRESHOLD, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    expect(corp.getSpawnDemand(ctx)).to.deep.equal([]);
    expect(corp.lastSizing).to.include({ gate: "buffer-full", buffered: SOURCE_BUFFER_DEFER_THRESHOLD });
  });

  it("sums container AND ground pile into the gate's read (the one-lens rule)", () => {
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(1500, 500); // 2000 only as a SUM
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    expect(corp.getSpawnDemand(ctx)).to.deep.equal([]);
    expect(corp.lastSizing).to.include({ gate: "buffer-full", buffered: 2000 });
  });

  it("demands normally just below the threshold (and stamps the clear read)", () => {
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(SOURCE_BUFFER_DEFER_THRESHOLD - 1, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    const demands = corp.getSpawnDemand(ctx);
    expect(demands.map(d => d.role)).to.include("miner");
    expect(corp.lastSizing).to.include({ gate: "clear", buffered: SOURCE_BUFFER_DEFER_THRESHOLD - 1 });
  });

  it("FAILS OPEN when the buffer is unmeasurable (no vision): demands normally", () => {
    const corp = stagedCorp();
    stageStandingMiner(corp);
    (global as any).Game.getObjectById = () => null; // no vision anywhere

    const demands = corp.getSpawnDemand(ctx);
    expect(demands.map(d => d.role)).to.include("miner");
    expect(corp.lastSizing).to.include({ gate: "clear", buffered: null });
  });

  it("never gates a colony cold start, even over a full buffer", () => {
    const corp = stagedCorp();
    // No creeps anywhere and no resolvable spawn: the engine is dead - the
    // restart must not be blocked by a full container left behind.
    const source = stageSource(SOURCE_BUFFER_DEFER_THRESHOLD, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    const demands = corp.getSpawnDemand(ctx);
    expect(demands.map(d => d.role)).to.include("miner");
  });

  it("leaves the haul vector UNGATED at a full buffer (haulers are the release)", () => {
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(SOURCE_BUFFER_DEFER_THRESHOLD, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);
    corp.setHaulRoutes(
      [
        {
          fromId: "source-srcaaaa",
          toId: "storage-x",
          carryParts: 4,
          spawnId: "spawn-spawn1",
          haulerRatio: "1:1"
        } as any
      ],
      { x: 10, y: 10, roomName: "W2N2" } as any
    );

    const demands = corp.getSpawnDemand(ctx);
    expect(demands.map(d => d.role)).to.not.include("miner");
    expect(demands.map(d => d.role)).to.include("hauler");
  });
});

describe("sourceBufferStock lens", () => {
  it("sums range-1 container energy and range-1 ground piles", () => {
    expect(sourceBufferStock(stageSource(1200, 340) as Source)).to.equal(1540);
  });

  it("returns null (unmeasurable, not zero) when the finds are not wired", () => {
    const broken = { pos: {} } as unknown as Source;
    expect(sourceBufferStock(broken)).to.equal(null);
  });
});
