import { expect } from "chai";
import { FlowGraph } from "../../../src/flow/FlowGraph";
import { NodeNavigator } from "../../../src/nodes/NodeNavigator";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";
import { solveWithCorpPlanner, controllerRoutingCapacity } from "../../../src/economy/flowAdapter";
import { netEnergy } from "../../../src/economy/primitives";
import { PlannerSource } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";

const ROOM = "W0N0";
const at = (x: number, y = 25): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function sourceNode(id: string, x: number): Node {
  const n = createNode(id, ROOM, at(x), 50, [ROOM], 0);
  const res: NodeResource = { type: "source", id, position: at(x), capacity: 3000 };
  n.resources = [res];
  return n;
}

function homeNode(spawnX: number): Node {
  const n = createNode("home", ROOM, at(spawnX), 100, [ROOM], 0);
  n.resources = [
    { type: "spawn", id: "spawn-0", position: at(spawnX) },
    { type: "controller", id: "ctrl-0", position: at(spawnX), isOwned: true } as NodeResource
  ];
  return n;
}

function homeNodeWithStorage(spawnX: number): Node {
  const n = homeNode(spawnX);
  n.resources.push({ type: "storage", id: "storage-0", position: at(spawnX) } as NodeResource);
  return n;
}

function graphOf(nodes: Node[]): FlowGraph {
  return new FlowGraph(nodes, new NodeNavigator(nodes, []));
}

// The adapter is the drop-in seam: CorpPlanner over a live FlowGraph, emitting the
// FlowSolution the materialiser consumes. These tests pin the integration-critical
// behaviors from first principles (deterministic manhattan distance, no sim).
describe("economy/flowAdapter - CorpPlanner as the FlowSolution authority", () => {
  const g = globalThis as unknown as { Game?: unknown };
  let savedGame: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  it("mines profitable sources and feeds the spawn its overhead, controller the rest", () => {
    // spawn+controller at x=5; sources at x=15 (d=10) and x=25 (d=20)
    const graph = graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    // both sources mined
    expect(sol.miners.map(m => m.sourceId).sort()).to.deep.equal(["source-s1", "source-s2"]);
    expect(sol.totalHarvest).to.be.closeTo(20, 1e-9);

    // spawn sink fed up to its demand (~10), NOT the whole 20 - controller gets the surplus
    const spawnAlloc = sol.sinkAllocations.find(a => a.sinkType === "spawn")!;
    const ctrlAlloc = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(spawnAlloc.allocated).to.be.closeTo(10, 1e-9);
    expect(ctrlAlloc.allocated).to.be.closeTo(10, 1e-9);

    // every mined source has at least one hauler carrying its energy somewhere
    expect(sol.haulers.filter(h => h.fromId === "source-s1").length).to.be.greaterThan(0);
    expect(sol.haulers.filter(h => h.fromId === "source-s2").length).to.be.greaterThan(0);
    expect(sol.isSustainable).to.equal(true);
  });

  it("hub-and-spoke: ALL mined banks to the storage hub, the controller draws the hub capped", () => {
    // 3 sources = 30 e/tick, a storage HUB exists. Hub-and-spoke (owner 2026-07-19):
    // ALL 30 mined banks to the hub (the warchest is the income buffer), and the
    // consumers draw the hub back out - the controller capped at
    // STORAGE_UPGRADE_TARGET (15), the spawn its ~10 overhead. Net storage change
    // is 30 in - 25 out = 5, but the sink DEPOSIT is the whole 30 (this is the
    // accounting shift from the hybrid, which banked only the 5 surplus).
    const graph = graphOf([
      homeNodeWithStorage(5),
      sourceNode("s1", 15),
      sourceNode("s2", 25),
      sourceNode("s3", 35)
    ]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage")!;
    expect(ctrl.allocated).to.be.closeTo(15, 1e-9); // capped at the upgrade target, drawn from the hub
    expect(store.allocated).to.be.closeTo(30, 1e-9); // ALL mined banks to the hub
    // real mined->storage haul-home legs exist (the deposit into the hub)
    expect(sol.haulers.some(h => h.toId.startsWith("storage-") && h.fromId.startsWith("source-"))).to.equal(true);
    // the controller is fed by the hub (bank), never mined directly
    expect(sol.haulers.some(h => h.fromId.startsWith("source-") && h.toId.startsWith("ctrl-"))).to.equal(false);
  });

  it("leaves the controller mopping up the surplus when there is no storage", () => {
    // Same 30 e/tick supply, no storage: the controller absorbs everything past the
    // spawn overhead exactly as before (nothing banked). Guards the storage gate.
    const graph = graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25), sourceNode("s3", 35)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(ctrl.allocated).to.be.closeTo(20, 1e-9); // 30 supply - 10 spawn overhead
    expect(sol.sinkAllocations.some(a => a.sinkType === "storage")).to.equal(false);
  });

  it("sizes the hub to FUNDED mined income, not all candidate graph sources (phantom guard, live stall t72437535)", () => {
    // 2 near sources are funded (~20 e/t); 3 FAR sources are unprofitable candidates
    // selectProducers rejects. The bank/hub the consumers draw from must reflect the
    // 20 FUNDED, never the 50 of all graph sources. Sizing the hub from all
    // candidates (which is all the pre-selection adapter can see) sent phantom
    // supply that construction over-drew, exhausting the parts ledger so real mined
    // never banked - P9->0, controller starved, live stall t72437535.
    const graph = graphOf([
      homeNodeWithStorage(5),
      sourceNode("near1", 15),
      sourceNode("near2", 25),
      sourceNode("far1", 325),
      sourceNode("far2", 335),
      sourceNode("far3", 345)
    ]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);
    // only the 2 near sources are funded (far ones are unprofitable)
    expect(sol.miners.map(m => m.sourceId).sort()).to.deep.equal(["source-near1", "source-near2"]);
    // the hub feeds consumers ONLY the funded mined (~20 e/t), never the all-graph 50:
    // total flow OUT of the bank/hub source must not exceed the funded income.
    const bankOut = sol.haulers.filter(h => h.fromId.startsWith("bank-")).reduce((s, h) => s + h.flowRate, 0);
    expect(bankOut, "hub outflow reflects funded mined, not the phantom all-graph sum").to.be.at.most(20 + 1e-6);
  });

  it("skips a source whose real distance makes it unprofitable", () => {
    expect(netEnergy(10, 320)).to.be.lessThan(0);
    // s_far at x=325 is manhattan 320 from the spawn at x=5
    const graph = graphOf([homeNode(5), sourceNode("s_near", 15), sourceNode("s_far", 325)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const mined = sol.miners.map(m => m.sourceId);
    expect(mined).to.include("source-s_near");
    expect(mined).to.not.include("source-s_far");
  });

  it("fields a scavenger (hauler, no miner) for an injected ground stock", () => {
    const graph = graphOf([homeNode(5), sourceNode("s1", 15)]);
    // a 1500-energy stock at x=30 (distance 25 from the spawn), as a transient source
    const stock: PlannerSource = {
      id: "scavenge-W0N0-30-25",
      nodeId: "W0N0-scavenge",
      pos: at(30),
      rate: 8,
      maxMiners: 0,
      transient: true
    };
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [stock]);

    // the real source is mined; the stock is scavenged with NO miner of its own
    expect(sol.miners.map(m => m.sourceId)).to.deep.equal(["source-s1"]);
    const scavHaulers = sol.haulers.filter(h => h.fromId === "scavenge-W0N0-30-25");
    expect(scavHaulers.length, "a scavenger hauls the stock").to.be.greaterThan(0);
    // the stock's energy reaches a sink
    expect(sol.totalHarvest).to.be.closeTo(10 + 8, 1e-9);
  });

  it("honors the controller's anti-downgrade reserve under scarce supply", () => {
    // one thin source: the spawn (value 100) would take it all, but the controller
    // keeps its reserve trickle.
    const thin = createNode("s1", ROOM, at(15), 50, [ROOM], 0);
    thin.resources = [{ type: "source", id: "s1", position: at(15), capacity: 3000 }];
    // shrink supply by overriding capacity via a low-rate source node
    const lowRate = createNode("s1", ROOM, at(15), 50, [ROOM], 0);
    lowRate.resources = [{ type: "source", id: "s1", position: at(15), capacity: 900 } as NodeResource]; // 3/tick
    const graph = graphOf([homeNode(5), lowRate]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const ctrlAlloc = sol.sinkAllocations.find(a => a.sinkType === "controller");
    expect(ctrlAlloc, "controller is present").to.not.be.undefined;
    expect(ctrlAlloc!.allocated).to.be.greaterThan(1.9); // reserve protected even vs the spawn
  });
});

// #21 (owner 2026-07-19): the surplus controller mops up the warchest, but
// bounded by the fleet's PHYSICAL upgrade rate (parking tiles x affordable
// WORK). Live t72429680: the uncapped controller planned 137 e/t against a
// fleet that could field ~4 upgraders - infeasible (P4), and it out-competed
// remote mined production for the bank. The cap makes the surplus that exceeds
// what upgraders can burn overflow into STORAGE instead.
describe("economy/flowAdapter - controllerRoutingCapacity physical cap (#21)", () => {
  const ctrlSink = { position: { x: 0, y: 0, roomName: "W0N0" } };
  const withStorage = new Set(["W0N0"]);
  const inSurplus = new Set(["W0N0"]);

  it("while the warchest FILLS (not surplus), the controller stays at the save target (15)", () => {
    expect(controllerRoutingCapacity(ctrlSink, 200, withStorage, new Set())).to.equal(15);
  });

  it("in SURPLUS with no cap given, it mops up totalSupply (unchanged default)", () => {
    expect(controllerRoutingCapacity(ctrlSink, 200, withStorage, inSurplus)).to.equal(200);
  });

  it("in SURPLUS, the PHYSICAL cap binds so the excess overflows to storage (#21)", () => {
    // a fleet that can burn only 40 e/t caps the sink at 40; the other 160 of a
    // 200 surplus lands in STORAGE, not an infeasible upgrade plan
    expect(controllerRoutingCapacity(ctrlSink, 200, withStorage, inSurplus, 40)).to.equal(40);
    // ...but never caps BELOW the real supply when the fleet can burn it all
    expect(controllerRoutingCapacity(ctrlSink, 30, withStorage, inSurplus, 40)).to.equal(30);
  });
});

// Spec 03 storage draw-down, the SURPLUS half: once a room's bank holds the
// expansion warchest, the surplus becomes SUPPLY (a miner-less bank source at
// the storage) and the controller reverts to mopping up - the save-regime
// STORAGE_UPGRADE_TARGET cap only applies while the warchest is filling.
// Anti-pump is STRUCTURAL (owner 2026-07-19): the storage sink STAYS open in a
// surplus room (consumers draw from storage, so it is a valid home for remote
// surplus), but bank sources are excluded from filling it - bank->storage
// circulation is impossible by construction because the bank IS the storage
// (these tests fail against a naive "just lower the storage value" tuning).
describe("economy/flowAdapter - storage draw-down: the surplus spend (spec 03)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
    g.Memory = {};
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  const bankSource = (rate: number): PlannerSource => ({
    id: "bank-W0N0",
    nodeId: "W0N0-bank",
    pos: at(6),
    rate,
    maxMiners: 0,
    transient: true
  });

  it("a surplus bank becomes supply and the controller mops up past the save cap", () => {
    // 2 sources = 20 e/t mined, plus a 10 e/t bank draw. The spawn takes its
    // ~10 overhead; the controller absorbs the remaining 20 - ABOVE the
    // save-regime STORAGE_UPGRADE_TARGET (15) that a filling warchest imposes.
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(10)]);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(ctrl.allocated).to.be.closeTo(20, 1e-9);
    // the bank flow is planned (it appears as a hauling flow toward a sink)...
    expect(sol.haulers.some(h => h.fromId === "bank-W0N0")).to.equal(true);
    // ...but the bank is never mined
    expect(sol.miners.map(m => m.sourceId)).to.not.include("bank-W0N0");
  });

  it("anti-pump is structural: mined banks to the hub but the bank never pumps into its own store", () => {
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(10)]);

    // the storage sink is present (the hub) and ALL mined banks into it
    // (hub-and-spoke: the warchest is the income buffer, owner 2026-07-19)...
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage");
    expect(store, "the storage hub sink is present").to.not.equal(undefined);
    expect(store!.allocated, "all mined deposits into the hub").to.be.closeTo(20, 1e-9);
    // ...but the bank/hub is stored IN it, so it never pumps back: no bank->storage
    // hauler is ever commissioned (the anti-pump is structural, from the roles).
    expect(
      sol.haulers.some(h => h.fromId === "bank-W0N0" && h.toId.startsWith("storage-")),
      "no bank->storage circulation"
    ).to.equal(false);
  });

  it("bank flows never materialize as CarryCorp commissions (the depot movers own those legs)", async () => {
    const { solveColony } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const { commissions } = solveColony(graph, 0, manhattan, [], [bankSource(10)]);

    // No transport commission for the bank: the extension tender (bank->spawn)
    // and the controller feeder (bank->controller input) already run those legs.
    expect(commissions.some(c => c.corpId === "carry-bank-W0N0")).to.equal(false);
    // The consumers still see the full flow: the upgrade commission is sized to
    // the opened controller allocation, bank draw included.
    const upgrade = commissions.find(c => c.kind === "upgrade")!;
    expect(upgrade.consumes.energyRate).to.be.closeTo(20, 1e-9);
    // and the published roster carries no phantom bank haulers either
    const roster = (g.Memory as { economyPlan?: { corps: Array<{ kind: string; fromId?: string }> } }).economyPlan!;
    expect(roster.corps.some(c => c.kind === "haul" && c.fromId === "bank-W0N0")).to.equal(false);
  });

  it("a filling warchest keeps today's save regime: controller capped at 15, ALL mined banks", () => {
    // No bank source injected (bank below the warchest target). Save regime: the
    // controller is capped at STORAGE_UPGRADE_TARGET (15) and draws it from the
    // hub; ALL 30 mined banks (hub-and-spoke), so the warchest fills at the full
    // mined rate minus the 15+10 the consumers draw back out.
    const graph = graphOf([
      homeNodeWithStorage(5),
      sourceNode("s1", 15),
      sourceNode("s2", 25),
      sourceNode("s3", 35)
    ]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], []);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage")!;
    expect(ctrl.allocated).to.be.closeTo(15, 1e-9);
    expect(store.allocated).to.be.closeTo(30, 1e-9);
  });

  it("detectBankSources reads live storages: surplus rooms emit, filling rooms don't", async () => {
    const { detectBankSources } = await import("../../../src/economy/flowAdapter");
    const { WARCHEST_TARGET, bankSurplusRate } = await import("../../../src/economy/bank");
    const storageAt = (roomName: string, energy: number) => ({
      controller: { my: true },
      storage: {
        my: true,
        pos: { x: 24, y: 24, roomName },
        store: { energy, getUsedCapacity: () => energy }
      }
    });
    g.Game.rooms = {
      W0N0: storageAt("W0N0", WARCHEST_TARGET + 3000), // surplus: draws
      W1N0: storageAt("W1N0", 9800) // still filling: saves
    };

    const banks = detectBankSources();
    expect(banks).to.have.length(1);
    expect(banks[0].id).to.equal("bank-W0N0");
    expect(banks[0].rate).to.be.closeTo(bankSurplusRate(WARCHEST_TARGET + 3000), 1e-9);
    expect(banks[0].transient).to.equal(true);
    expect(banks[0].maxMiners).to.equal(0);
  });
});

/**
 * The construction absorb cap - the SUM-OF-PROJECTS lens at the PLAN layer
 * (prod incident t72444684, E4 idle capital): the construction sink's
 * capacity was minedSupply+bankRate (455 e/t live) regardless of site work,
 * so ONE nearly-done extension (400 remaining, physically absorbing <10 e/t)
 * out-priced the controller (70 vs 43.9) and soaked 124 e/t of the plan's
 * bank draw. Execution's work-aware crew (builderPlan) delivered 0.45 e/t of
 * it; the other ~99.6% was never burned and the warchest climbed +7.66/t to
 * 8.3x its target while the controller got 2 e/t. The plan and the corp now
 * read the SAME primitives.projectAbsorbRate: remaining/100t, floor 5.
 */
describe("economy/flowAdapter - construction absorb cap (sum of projects, prod t72444684)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
    g.Memory = {};
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  const bankSource = (rate: number): PlannerSource => ({
    id: "bank-W0N0",
    nodeId: "W0N0-bank",
    pos: at(6),
    rate,
    maxMiners: 0,
    transient: true
  });

  it("PHANTOM GUARD: intel-only prospects never inflate the construction valve (t72444684 review)", () => {
    // 2 real sources (20 e/t) + 3 intel-only prospects (30 e/t of phantom)
    // + a 40 e/t bank draw, and a build-out big enough that the absorb cap
    // does not bind (15k at ~4 travel -> ~15 e/t... use a huge site so the
    // valve term is what shows). The construction sink's demand must be
    // real-mined + bank (60), never phantom-inflated (90).
    const graph = graphOf([
      homeNodeWithStorage(5),
      sourceNode("s1", 15),
      sourceNode("s2", 25),
      sourceNode("intel-W9N9-10-10", 30),
      sourceNode("intel-W9N9-20-20", 35),
      sourceNode("intel-W9N9-30-30", 40)
    ]);
    graph.addConstructionSite("bigbuild", "home", at(9), 200_000);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);
    const build = sol.sinkAllocations.find(a => a.sinkType === "construction")!;
    expect(build.demand, "valve = real mined (20) + bank (40), phantom excluded").to.be.closeTo(60, 1e-6);
  });

  it("a nearly-done site absorbs its work rate, NOT the whole bank draw - the controller mops up", () => {
    // 20 e/t mined + 40 e/t surplus draw; one extension with 455 build energy
    // remaining (the live incident's site). Absorbable: max(5, 455/100) = 5.
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    graph.addConstructionSite("ext", "home", at(9), 455);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);

    const build = sol.sinkAllocations.find(a => a.sinkType === "construction")!;
    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(build.allocated, "construction capped at the project's absorb rate").to.be.at.most(5 + 1e-9);
    // the surplus the fantasy build allocation used to soak flows to the score
    expect(ctrl.allocated, "controller mops up the freed draw").to.be.greaterThan(build.allocated);
  });

  it("a REAL build-out sizes to buffered-effective-life completion; the residual upgrades (owner 2026-07-20)", () => {
    // Horizon = 2/3 of effectiveLife(travel): the site sits 4 tiles from the
    // spawn, so 15k / ((2/3) * 1496) ~ 15 e/t - above the G6 flat-5 floor
    // (the build-out is never starved) but no burst: the surplus a burst
    // would have claimed flows to the controller instead of idling in
    // spawned WORK-ticks that outlive their work.
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    graph.addConstructionSite("bigbuild", "home", at(9), 15000);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);

    const build = sol.sinkAllocations.find(a => a.sinkType === "construction")!;
    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(build.allocated, "buffered-effective-life rate").to.be.closeTo(15000 / ((2 / 3) * 1496), 1e-6);
    expect(ctrl.allocated, "the un-claimed surplus scores at the controller").to.be.greaterThan(build.allocated);
  });
});

/**
 * Remote scavenge is SPILL-ONLY (refining the owner's 2026-07-19 ruling;
 * prod t72446738): the original siphon incident came from summing a remote
 * CONTAINER into the pile - scavengers stole the route's own supply. The
 * container stays structurally un-scavengeable in remote rooms, but DROPPED
 * piles there decay at ceil(amount/1000)/t with nobody coming (measured:
 * 25k standing at four remote mouths, ~19 e/t bleeding - the largest live
 * leak). Dropped-only + a 1000 threshold recovers the spill without ever
 * touching what the haul-home owns.
 */
describe("economy/flowAdapter - remote scavenge is spill-only (prod t72446738)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    (global as any).FIND_DROPPED_RESOURCES = 106;
    (global as any).FIND_TOMBSTONES = 118;
    (global as any).FIND_RUINS = 123;
    (global as any).FIND_STRUCTURES = 107;
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).__mockTiles = {};
    (global as any).RoomPosition = class {
      public constructor(public x: number, public y: number, public roomName: string) {}
      public findInRange(): any[] {
        return (global as any).__mockTiles[`${this.roomName}:${this.x},${this.y}`] ?? [];
      }
    };
    g.Memory = {};
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  const mkRoom = (name: string, owned: boolean, dropped: number, containerEnergy: number): any => {
    const pile = { resourceType: "energy", amount: dropped, pos: { x: 20, y: 20, roomName: name } };
    const container = {
      structureType: "container",
      store: { energy: containerEnergy },
      pos: { x: 20, y: 20, roomName: name }
    };
    // the pile sits ON the container tile: findInRange(0) from a minted
    // RoomPosition at (20,20) must find it - register in the tile registry
    (global as any).__mockTiles[`${name}:20,20`] = [container];
    return {
      name,
      controller: owned ? { my: true, pos: { x: 40, y: 40, roomName: name } } : { my: false },
      memory: {},
      find: (t: number) => (t === 106 && dropped > 0 ? [pile] : t === 107 ? [container] : [])
    };
  };

  it("a remote DROPPED spill becomes scavenge supply - the container's energy does NOT", async () => {
    const { detectTransientSources } = await import("../../../src/economy/flowAdapter");
    const { detectRoomStocks } = await import("../../../src/economy/scavenge");
    g.Game = { rooms: { W9N9: mkRoom("W9N9", false, 8000, 2000) }, creeps: {}, getObjectById: () => null };
    const out = detectTransientSources();
    expect(out, "one spill stock").to.have.length(1);
    // The stock AMOUNT is dropped-only (8000), never dropped+container
    // (10000) - the container is the haul-home's, structurally.
    const room = g.Game.rooms.W9N9;
    expect(detectRoomStocks(room, 1000, false)[0].amount, "spill-only lens").to.equal(8000);
    expect(detectRoomStocks(room, 1000, true)[0].amount, "the summed lens would have siphoned").to.equal(10000);
  });

  it("remote sub-threshold jitter fields nothing; owned rooms keep the summed-stock rule", async () => {
    const { detectTransientSources, REMOTE_SPILL_THRESHOLD } = await import("../../../src/economy/flowAdapter");
    expect(REMOTE_SPILL_THRESHOLD).to.equal(1000);
    g.Game = { rooms: { W9N9: mkRoom("W9N9", false, 500, 2000) }, creeps: {}, getObjectById: () => null };
    expect(detectTransientSources(), "500 dropped remote = jitter, no scavenger").to.have.length(0);
    // owned: container SUMS into the stock (the 2026-07-10 rule, unchanged)
    g.Game = { rooms: { W1N1: mkRoom("W1N1", true, 400, 1800) }, creeps: {}, getObjectById: () => null };
    const owned = detectTransientSources();
    expect(owned, "owned pile+container above threshold together").to.have.length(1);
  });
});

/**
 * Feeder priced at the REALIZED draw (prod t72447444, the starvation loop):
 * pricing the relay at the full surplus (115 e/t) charged 64p of infra for
 * consumers that - starved by that very charge - drew 2 e/t. With history,
 * the relay prices at the previous solve's bank draw (floored at the upgrade
 * target), freeing the phantom infra so consumers actually grow; without
 * history the old full-surplus pricing holds (first solve / golden master).
 */
describe("economy/flowAdapter - feeder priced at realized draw (prod t72447444)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {}, spawns: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  const bank = (rate: number): PlannerSource => ({
    id: "bank-W0N0",
    nodeId: "W0N0-bank",
    pos: at(6),
    rate,
    maxMiners: 0,
    transient: true
  });

  it("a starved-history solve frees the phantom feeder infra and the consumers GROW", async () => {
    const { buildColonyProblem, solveColony } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const noHistory = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), [bank(100)]);
    const starvedHistory = buildColonyProblem(
      graph, manhattan, [], new Map(), new Map(), [bank(100)], undefined, undefined, 2
    );
    expect(starvedHistory.infraPartsPerTick!, "the relay re-prices to the floor, not the full surplus").to.be.lessThan(
      noHistory.infraPartsPerTick!
    );
    // and the freed parts reach the consumers in the actual solve
    const without = solveColony(graph, 0, manhattan, [], [bank(100)]).solution;
    const withHist = solveColony(graph, 0, manhattan, [], [bank(100)], undefined, 2).solution;
    const ctrl = (s: any): number => s.sinkAllocations.find((a: any) => a.sinkType === "controller")?.allocated ?? 0;
    expect(ctrl(withHist), "consumers grow when the feeder stops charging phantom relay").to.be.at.least(ctrl(without));
  });
});

describe("economy/flowAdapter - paved-source detection", () => {
  const g = globalThis as unknown as { Game?: unknown };
  let savedGame: unknown;
  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  it("carries the paved verdict onto the SOLUTION's haulers (audit t72469936: seg 6 dropped it and nearly called the repricing dead)", async () => {
    const { solveWithCorpPlanner } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15)]);
    (g.Game as any).rooms = {
      [ROOM]: { name: ROOM, find: () => [], memory: { roadRoutes: { s1: { tiles: [], paved: true } } } }
    };
    const sol = solveWithCorpPlanner(graph, 0, manhattan);
    const s1Haulers = sol.haulers.filter(h => h.fromId === "source-s1");
    expect(s1Haulers.length).to.be.greaterThan(0);
    expect(s1Haulers.every(h => h.haulerRatio === "2:1"), "the road body reaches telemetry and the materialiser").to.equal(true);
  });

  it("marks sources paved from the receipt by GAME id (graph 'source-' prefix stripped)", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map([["s1", 1]]));
    expect(problem.sources.find(s => s.id === "source-s1")!.paved).to.equal(true);
    expect(problem.sources.find(s => s.id === "source-s1")!.pavedFraction).to.equal(1);
    expect(problem.sources.find(s => s.id === "source-s2")!.paved).to.equal(undefined);
  });

  it("a HALF-BUILT trunk already reprices: fraction >= 1/2 stamps paved + pavedFraction", async () => {
    // Owner 2026-07-20: "even if the road is 32 out of 38 we could probably
    // still optimize the body parts" - the binary receipt made every future
    // trunk wait for the last tile; the fraction collects from the 1/2 mark.
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map([["s1", 32 / 38], ["s2", 10 / 38]]));
    const s1 = problem.sources.find(s => s.id === "source-s1")!;
    expect(s1.paved).to.equal(true);
    expect(s1.pavedFraction).to.be.closeTo(32 / 38, 1e-9);
    // below the repricing threshold the 1:1 body stays - no stamp at all
    const s2 = problem.sources.find(s => s.id === "source-s2")!;
    expect(s2.paved).to.equal(undefined);
    expect(s2.pavedFraction).to.equal(undefined);
  });

  it("detectPavedSources reads BOTH receipt shapes: binary paved -> 1, survey built/total -> fraction", async () => {
    const { detectPavedSources } = await import("../../../src/economy/flowAdapter");
    (g.Game as any).rooms = {
      W1N1: {
        memory: {
          roadRoutes: {
            a: { tiles: [], paved: true },
            b: { tiles: [], built: 32, total: 38 },
            c: { tiles: [], built: 0, total: 38 },
            d: { tiles: [], declined: true }
          }
        }
      }
    };
    const m = detectPavedSources();
    expect(m.get("a")).to.equal(1);
    expect(m.get("b")).to.be.closeTo(32 / 38, 1e-9);
    expect(m.get("c")).to.equal(0);
    expect(m.has("d"), "a declined route has no pave state").to.equal(false);
  });
});

describe("economy/flowAdapter - per-instance sink values (spec 06 expansion)", () => {
  const g = globalThis as unknown as { Game?: any };
  let savedGame: unknown;
  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  it("controllerValue: log curve through the spec anchors, clamped", async () => {
    const { controllerValue } = await import("../../../src/economy/flowAdapter");
    expect(controllerValue(200)).to.be.closeTo(80, 1e-9); // fresh L1 - top of the band
    expect(controllerValue(10_400_000)).to.be.closeTo(40, 1e-9); // L8-scale grind
    expect(controllerValue(1)).to.equal(80); // clamp above
    expect(controllerValue(1e9)).to.equal(40); // clamp below
    // RCL2 (45k remaining) prices BELOW ordinary construction (70): build
    // supersedes upgrade until a level is nearly done...
    expect(controllerValue(45_000)).to.be.lessThan(70);
    expect(controllerValue(45_000)).to.be.greaterThan(55);
    // ...the whole band sits BELOW the new-spawn site: a freshly claimed L1
    // controller must never outbid its own founding (measured: at max=90 it
    // zeroed construction colony-wide).
    expect(controllerValue(1)).to.be.lessThan(85);
    // ...and a 99%-done level (450 left) crosses ABOVE construction: the
    // cheap hop to the next rung outprices ordinary building.
    expect(controllerValue(450)).to.be.greaterThan(70);
  });

  it("a new-spawn construction site prices at 85, ordinary sites at 70", async () => {
    const { buildColonyProblem, NEW_SPAWN_SITE_VALUE } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15)]);
    graph.addConstructionSite("founding", "home", at(8), 15000);
    graph.addConstructionSite("ext", "home", at(9), 3000);
    g.Game.getObjectById = (id: string) =>
      id === "founding" ? { structureType: "spawn" } : id === "ext" ? { structureType: "extension" } : null;

    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map());
    const founding = problem.sinks.find(k => k.id === "construction-founding")!;
    const ext = problem.sinks.find(k => k.id === "construction-ext")!;
    expect(founding.value).to.equal(NEW_SPAWN_SITE_VALUE);
    expect(ext.value).to.equal(70);
    // ordering the founding design rides on: live spawn network > new-spawn
    // site > ordinary construction
    const spawnSink = problem.sinks.find(k => k.kind === "spawn")!;
    expect(spawnSink.value).to.be.greaterThan(founding.value);
    expect(founding.value).to.be.greaterThan(ext.value);
  });

  it("controller sinks price by the live controller's remaining progress", async () => {
    const { buildColonyProblem, controllerValue } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15)]);
    g.Game.rooms = { [ROOM]: { controller: { progress: 44_550, progressTotal: 45_000 } } };

    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map());
    const ctrl = problem.sinks.find(k => k.kind === "controller")!;
    expect(ctrl.value).to.be.closeTo(controllerValue(450), 1e-9);
    expect(ctrl.value).to.be.greaterThan(70); // 99%-done level outprices construction
  });

  it("falls back to the kind default without vision of the controller", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map());
    expect(problem.sinks.find(k => k.kind === "controller")!.value).to.equal(50);
  });
});

describe("trunk-building sources (owner 2026-07-21: no hauling home until the road is done)", () => {
  const g = globalThis as unknown as { Game?: any };
  let savedGame: unknown;
  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  it("detectTrunkBuildingSources: in-progress trunks only (not paved, not declined, not fresh in-room)", async () => {
    const { detectTrunkBuildingSources } = await import("../../../src/economy/flowAdapter");
    g.Game.rooms = {
      W1N1: {
        memory: {
          roadRoutes: {
            a: { tiles: [], tiles3: [1, 1, 0], rooms: ["W2N1"], built: 0, total: 1 }, // surveyed: sites STAND
            b: { tiles: [], tiles3: [1, 1, 0], rooms: ["W2N1"], paved: true }, // done
            c: { tiles: [], tiles3: [1, 1, 0], rooms: ["W2N1"], declined: true }, // not worth it
            d: { tiles: [1, 1] }, // in-room legacy route, no trunk
            e: { tiles: [], tiles3: [1, 1, 0], rooms: ["W2N1"] } // PLANNED only - no sites placed yet (t72474584: dedicating these cut 30 e/t for zero build progress)
          }
        }
      }
    };
    const set = detectTrunkBuildingSources();
    expect([...set]).to.deep.equal(["a"]);
  });

  it("a dedicated source keeps its MINER but ships NOTHING home (the pile is the road's fuel)", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const { planColony } = await import("../../../src/economy/CorpPlanner");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(
      graph, manhattan, [], new Map(), new Map(), [], 0, undefined, undefined, new Set(["s1"])
    );
    expect(problem.sources.find(s => s.id === "source-s1")!.dedicatedToBuild).to.equal(true);
    const plan = planColony(problem);
    expect(plan.miners.some(m => m.sourceId === "source-s1"), "the miner stands - the pile feeds the crew").to.equal(true);
    expect(plan.haulers.some(h => h.sourceId === "source-s1"), "no haul route home while the trunk builds").to.equal(false);
    expect(plan.haulers.some(h => h.sourceId === "source-s2"), "other sources haul normally").to.equal(true);
  });
});
