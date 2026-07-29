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

  it("DE-PRICES (never suppresses) the miner while the buffer sits at the cap", () => {
    // OWNER REDESIGN 2026-07-29: the hard gate was the wrong class. Doctrine
    // (CLAUDE.md): "scarcity acts at the SPAWN (defund: no NEW bodies, via
    // priority), and the planner prices - it doesn't gate." Suppressing the
    // demand darkened two live sources (E6 FAIL t72658948) and blocked the
    // runt UPSIZE in bootstrap rooms (the flaky runt-economy cell, whose
    // whole signal is one 2->3 WORK transition). Now the demand always
    // stands; a full mouth costs it priority, so it loses scarce spawn parts
    // to sources that can actually move their energy.
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(SOURCE_BUFFER_DEFER_THRESHOLD, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    const demands = corp.getSpawnDemand(ctx);
    expect(demands.map(d => d.role), "never suppressed").to.include("miner");
    const d = demands.find(x => x.role === "miner")!;
    expect(d.blocking, "a staffed source is not critical-path").to.equal(false);
    expect(corp.lastSizing).to.include({ gate: "buffer-full", buffered: SOURCE_BUFFER_DEFER_THRESHOLD });
  });

  it("ranks a PILED source below a CLEAR one (the behavioural contract)", () => {
    const { spawnPriority } = require("../../../src/spawn/SpawnScheduler");
    const mk = (buffered: number) => {
      const corp = stagedCorp();
      stageStandingMiner(corp);
      const source = stageSource(buffered, 0);
      (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);
      (global as any).Game.time = ((global as any).Game.time ?? 0) + 1;
      delete (global as any).Memory.pileMeter;
      return corp.getSpawnDemand({ ...ctx, tick: (global as any).Game.time }).find(d => d.role === "miner")!;
    };
    const clear = mk(100);
    const piled = mk(4000);
    expect(piled.value, "de-priced within its tier").to.be.lessThan(clear.value);
    expect(spawnPriority(piled)).to.be.lessThan(spawnPriority(clear));
  });

  it("sums container AND ground pile into the gate's read (the one-lens rule)", () => {
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(1500, 500); // 2000 only as a SUM
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    corp.getSpawnDemand(ctx);
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

  it("does NOT de-price the RUNT UPSIZE out of existence (the runt-equilibrium trap)", () => {
    // A runt stuck at ~40% source output forever is the documented failure the
    // spawn-then-recycle path exists to prevent; the hard gate reintroduced it
    // whenever a bootstrap pile crossed the threshold. The upsize must survive
    // a full buffer - it replaces a body rather than adding one.
    const corp = stagedCorp();
    (global as any).Game.creeps = {
      runt: {
        name: "runt",
        spawning: false,
        ticksToLive: 1400,
        body: new Array(3).fill({ type: "work" }),
        memory: { corpId: corp.id, workType: "harvest" },
        getActiveBodyparts: () => 1, // a 1-WORK runt against a 20 e/t source
        pos: { x: 11, y: 10, roomName: "W2N2", getRangeTo: () => 1 }
      }
    };
    const source = stageSource(4000, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);
    const demands = corp.getSpawnDemand(ctx);
    expect(demands.map(d => d.role), "the runt must still be upgradeable").to.include("miner");
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
    // Haulers are the RELEASE - they drain the mouth - so they are never
    // de-priced by the pile. The miner is still offered (de-pricing, not
    // suppression) but yields priority to it.
    expect(demands.map(d => d.role)).to.include("hauler");
    const miner = demands.find(d => d.role === "miner")!;
    const hauler = demands.find(d => d.role === "hauler")!;
    expect(miner.value, "the pile shifts priority toward the release").to.be.lessThan(hauler.value);
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

describe("pile-gate delay meter (tallyPileGate - the spawning delay time of a pile)", () => {
  // Owner 2026-07-29: instrument HOW LONG piles delay spawning. Rolling
  // window (upgradeMeter pattern): heldFor = consecutive ticks the gate has
  // held (since survives window rolls), heldFrac = gated share of evaluated
  // ticks. Fog never tallies - unmeasurable must neither reset nor inflate.
  const { tallyPileGate, PILE_METER_WINDOW } = require("../../../src/corps/HarvestCorp");

  it("accumulates heldFor across consecutive held ticks and resets on release", () => {
    const meter: any = {};
    expect(tallyPileGate(meter, "aaaaaa", 100, true).heldFor).to.equal(1);
    expect(tallyPileGate(meter, "aaaaaa", 101, true).heldFor).to.equal(2);
    expect(tallyPileGate(meter, "aaaaaa", 102, true).heldFor).to.equal(3);
    expect(tallyPileGate(meter, "aaaaaa", 103, false).heldFor).to.equal(0);
    expect(tallyPileGate(meter, "aaaaaa", 104, true).heldFor).to.equal(1); // fresh hold
  });

  it("computes heldFrac as the gated share of EVALUATED ticks", () => {
    const meter: any = {};
    tallyPileGate(meter, "bbbbbb", 200, true);
    tallyPileGate(meter, "bbbbbb", 201, false);
    const r = tallyPileGate(meter, "bbbbbb", 202, true);
    expect(r.heldFrac).to.be.closeTo(2 / 3, 1e-9);
  });

  it("is idempotent within one tick (multiple demand collections sample once)", () => {
    const meter: any = {};
    tallyPileGate(meter, "cccccc", 300, true);
    const r = tallyPileGate(meter, "cccccc", 300, true);
    expect(r.heldFor).to.equal(1);
    expect(meter.cccccc.samples).to.equal(1);
  });

  it("rolls the window but PRESERVES the consecutive hold across the roll", () => {
    const meter: any = {};
    tallyPileGate(meter, "dddddd", 1000, true);
    const r = tallyPileGate(meter, "dddddd", 1000 + PILE_METER_WINDOW, true);
    expect(r.heldFor).to.equal(PILE_METER_WINDOW + 1); // since survives the roll
    expect(meter.dddddd.samples).to.equal(1); // window counters restarted
  });

  it("stamps the delay onto a HELD gate decision (heldFor/heldFrac in sizing)", () => {
    (global as any).Memory.pileMeter = {};
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(SOURCE_BUFFER_DEFER_THRESHOLD, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    corp.getSpawnDemand(ctx);
    expect(corp.lastSizing).to.include({ gate: "buffer-full", heldFor: 1, heldFrac: 1 });

    corp.getSpawnDemand({ ...ctx, tick: ctx.tick + 1 });
    expect(corp.lastSizing).to.include({ heldFor: 2 });
    delete (global as any).Memory.pileMeter;
  });

  it("never tallies on fog (buffered null): the meter neither resets nor inflates", () => {
    (global as any).Memory.pileMeter = { srcaaa: { t0: 50, last: 50, samples: 1, held: 1, since: 50 } };
    const corp = stagedCorp();
    stageStandingMiner(corp);
    (global as any).Game.getObjectById = () => null; // no vision

    corp.getSpawnDemand(ctx);
    expect((global as any).Memory.pileMeter.srcaaa).to.deep.equal({ t0: 50, last: 50, samples: 1, held: 1, since: 50 });
    delete (global as any).Memory.pileMeter;
  });
});

describe("pile gate NEVER darkens an unstaffed source (live FAIL t72658948)", () => {
  // The gate's job is to stop buying ANOTHER body into a saturated mouth.
  // It must never suppress the source's FIRST miner: with staffing 0 the
  // source produces nothing at all, so the pile is purely a hauling deficit
  // and blocking the replacement converts a haul problem into an INCOME
  // STOPPAGE. Measured live: cd8e (buffered 3016, staffing 0/1, held 214t)
  // and cd8d (2279, 0/1, 292t) both went dark behind their own piles - E6
  // caught it as a FAIL ("2 source(s) DARK behind a full pile - income
  // stopped"). colonyColdStart did NOT cover this: the SPAWN's room still
  // had miners, so only the remote posts starved.
  const ctx2 = { energyCapacity: 550, tick: 200 };

  beforeEach(() => {
    (global as any).Game.creeps = {};
    (global as any).Game.time = ((global as any).Game.time ?? 0) + 1;
    delete (global as any).Memory.pileMeter;
  });

  it("DEMANDS a miner at a full-buffer source with ZERO staffing (income first)", () => {
    const corp = stagedCorp();
    // No creeps for this corp anywhere: the post is dark.
    const source = stageSource(4000, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    const demands = corp.getSpawnDemand(ctx2);
    expect(demands.map(d => d.role), "a dark source must be re-staffed").to.include("miner");
    expect(corp.lastSizing).to.include({ gate: "clear-unstaffed" });
  });

  it("still defers when the post IS staffed (the gate's actual job is unchanged)", () => {
    const corp = stagedCorp();
    stageStandingMiner(corp);
    const source = stageSource(4000, 0);
    (global as any).Game.getObjectById = (id: string) => (id === "srcaaaa" ? source : null);

    const held = corp.getSpawnDemand(ctx2);
    expect(held.map(d => d.role), "still offered, just de-priced").to.include("miner");
    expect(corp.lastSizing).to.include({ gate: "buffer-full" });
  });
});
