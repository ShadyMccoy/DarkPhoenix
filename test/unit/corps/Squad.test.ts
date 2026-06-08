import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { Squad, SquadConfig, SquadPlan, splitIntoMembers, wormOrder } from "../../../src/corps/Squad";
import { Game as MockGame } from "../mock";

/**
 * Squad is the "abstract away the exact creep count" layer: an operation declares
 * how many members it wants and the body to use, and the squad handles membership
 * discovery, spawn-demand gating, behavior dispatch, and runt recycling. These
 * scenarios pin down that observable contract without standing up the engine - we
 * stub Game.creeps to control the apparent fleet and read back what the squad does.
 */

const CORP = "W1N1-construction";

/** A fake member with `parts` of the squad's useful body part. */
function fakeMember(corpId: string, workType: string, parts: number, opts: { spawning?: boolean; recycling?: boolean } = {}): unknown {
  return {
    memory: { corpId, workType, recycling: opts.recycling },
    spawning: opts.spawning ?? false,
    getActiveBodyparts: () => parts,
  };
}

/** Point a stubbed Game at an explicit set of fake creeps, preserving the shared
 * mock's other methods so later test files still have a complete global.Game. */
function setCreeps(creeps: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).Game = { ...MockGame, creeps, time: 100 };
}

function builderSquad(): Squad {
  const config: SquadConfig = {
    corpId: CORP,
    workType: "build",
    role: "builder",
    value: 95,
    producesIncome: false,
    blockingWhenEmpty: false,
    usefulPart: WORK,
  };
  return new Squad(config);
}

/** A maxed-out room with an idle spawn - the only state in which recycling fires. */
const maxedRoom = { energyAvailable: 800, energyCapacityAvailable: 800 } as unknown as Room;
const idleSpawn = { spawning: null } as unknown as StructureSpawn;

describe("Squad", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = { ...MockGame, creeps: {}, time: 100 };
  });

  describe("splitIntoMembers (fewest creeps for a fixed total)", () => {
    it("fields a single big creep when the room can build the whole total", () => {
      // 4 WORK wanted, capacity affords 10 per creep -> one creep holding all 4.
      expect(splitIntoMembers(4, 10, 5)).to.deep.equal({ count: 1, partsPerMember: 4 });
    });

    it("splits into smaller creeps only when capacity forces it, same total", () => {
      // 4 WORK wanted but a creep can be at most 2 -> two creeps of 2 (total 4).
      expect(splitIntoMembers(4, 2, 5)).to.deep.equal({ count: 2, partsPerMember: 2 });
      // 5 WORK, max 2 per creep -> 3 creeps, near-equal (ceil(5/3) = 2 each).
      expect(splitIntoMembers(5, 2, 5)).to.deep.equal({ count: 3, partsPerMember: 2 });
    });

    it("is capacity-limited past the member cap (fields less than the ideal total)", () => {
      // 8 WORK, max 2 per creep would want 4 creeps, but cap is 2 -> 2 creeps of 2.
      expect(splitIntoMembers(8, 2, 2)).to.deep.equal({ count: 2, partsPerMember: 2 });
    });

    it("asks for a single creep when the room cannot build even one part", () => {
      expect(splitIntoMembers(3, 0, 5)).to.deep.equal({ count: 1, partsPerMember: 3 });
    });

    it("fields nothing when there is no work or no member budget", () => {
      expect(splitIntoMembers(0, 10, 5)).to.deep.equal({ count: 0, partsPerMember: 0 });
      expect(splitIntoMembers(4, 10, 0)).to.deep.equal({ count: 0, partsPerMember: 0 });
    });
  });

  describe("membership discovery", () => {
    it("counts only this corp's members of this workType", () => {
      setCreeps({
        a: fakeMember(CORP, "build", 2),
        b: fakeMember(CORP, "build", 2),
        c: fakeMember(CORP, "tank", 4), // same corp, different job
        d: fakeMember("other-corp", "build", 2), // different corp
      });
      expect(builderSquad().count()).to.equal(2);
      expect(builderSquad().members()).to.have.length(2);
    });

    it("counts a spawning member for demand gating but excludes it from run()", () => {
      setCreeps({
        a: fakeMember(CORP, "build", 2),
        b: fakeMember(CORP, "build", 2, { spawning: true }),
      });
      const squad = builderSquad();
      expect(squad.count()).to.equal(2); // gating sees the queued creep
      expect(squad.members()).to.have.length(1); // only the ready one acts
    });
  });

  describe("spawn demand (growing toward target, one at a time)", () => {
    const plan: SquadPlan = { target: 2, desiredCost: 300, minCost: 200, bodyParam: 2 };

    it("requests a member while under target, then stops", () => {
      setCreeps({ a: fakeMember(CORP, "build", 2) });
      const demand = builderSquad().spawnDemand(plan);
      expect(demand).to.have.length(1);
      expect(demand[0]).to.include({ buyerCorpId: CORP, role: "builder", desiredCost: 300, minCost: 200, bodyParam: 2 });

      setCreeps({ a: fakeMember(CORP, "build", 2), b: fakeMember(CORP, "build", 2) });
      expect(builderSquad().spawnDemand(plan)).to.have.length(0); // at target
    });

    it("does not order when the room cannot afford even the floor body", () => {
      setCreeps({});
      expect(builderSquad().spawnDemand({ ...plan, minCost: 0 })).to.have.length(0);
    });

    it("never orders against a zero target", () => {
      setCreeps({});
      expect(builderSquad().spawnDemand({ ...plan, target: 0 })).to.have.length(0);
    });
  });

  describe("recycling runts (only when maxed and spawn idle)", () => {
    // partsNeeded 4 across two members, each maxes at 2: a 2+2 fleet is at plan.
    const recyclePlan: SquadPlan = { target: 2, desiredCost: 300, minCost: 200, bodyParam: 2, partsNeeded: 4, maxPartsPerMember: 2 };

    it("flags the smallest sub-max member when the room is maxed and the spawn idle", () => {
      const runt = fakeMember(CORP, "build", 1) as { memory: { recycling?: boolean } };
      setCreeps({ a: runt, b: fakeMember(CORP, "build", 2) }); // 1+2 = 3 < 4 needed
      builderSquad().flagRuntForRecycling(maxedRoom, idleSpawn, recyclePlan);
      expect(runt.memory.recycling).to.equal(true);
    });

    it("does nothing while the room is not maxed (never disrupt a working creep)", () => {
      const runt = fakeMember(CORP, "build", 1) as { memory: { recycling?: boolean } };
      setCreeps({ a: runt });
      const constrainedRoom = { energyAvailable: 200, energyCapacityAvailable: 800 } as unknown as Room;
      builderSquad().flagRuntForRecycling(constrainedRoom, idleSpawn, recyclePlan);
      expect(runt.memory.recycling).to.be.undefined;
    });

    it("does nothing when the plan supplies no recycling bounds", () => {
      const runt = fakeMember(CORP, "build", 1) as { memory: { recycling?: boolean } };
      setCreeps({ a: runt });
      const noBounds: SquadPlan = { target: 2, desiredCost: 300, minCost: 200, bodyParam: 2 };
      builderSquad().flagRuntForRecycling(maxedRoom, idleSpawn, noBounds);
      expect(runt.memory.recycling).to.be.undefined;
    });

    it("recycles only one member at a time", () => {
      const r1 = fakeMember(CORP, "build", 1, { recycling: true }) as { memory: { recycling?: boolean } };
      const r2 = fakeMember(CORP, "build", 1) as { memory: { recycling?: boolean } };
      setCreeps({ a: r1, b: r2 });
      builderSquad().flagRuntForRecycling(maxedRoom, idleSpawn, recyclePlan);
      expect(r2.memory.recycling).to.be.undefined; // one already recycling, leave the rest
    });
  });
});

describe("wormOrder (stable squad chain)", () => {
  it("orders members deterministically regardless of input order", () => {
    const a = { name: "c-a" };
    const b = { name: "c-b" };
    const c = { name: "c-c" };
    // Same members in any order must yield the same chain, so the worm never
    // reshuffles tick to tick.
    expect(wormOrder([c, a, b]).map((m) => m.name)).to.deep.equal(["c-a", "c-b", "c-c"]);
    expect(wormOrder([b, c, a]).map((m) => m.name)).to.deep.equal(["c-a", "c-b", "c-c"]);
  });

  it("does not mutate the input array", () => {
    const input = [{ name: "z" }, { name: "a" }];
    wormOrder(input);
    expect(input.map((m) => m.name)).to.deep.equal(["z", "a"]);
  });

  it("handles the trivial cases", () => {
    expect(wormOrder([])).to.deep.equal([]);
    expect(wormOrder([{ name: "solo" }]).map((m) => m.name)).to.deep.equal(["solo"]);
  });
});
