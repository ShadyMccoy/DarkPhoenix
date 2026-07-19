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

  it("banks the surplus in storage instead of the controller once a storage exists", () => {
    // 3 sources = 30 e/tick. spawn takes its ~10 overhead; the controller is now
    // capped at STORAGE_UPGRADE_TARGET (15) because the room has a storage bank, so
    // the remaining ~5 banks in storage rather than piling at the controller.
    const graph = graphOf([
      homeNodeWithStorage(5),
      sourceNode("s1", 15),
      sourceNode("s2", 25),
      sourceNode("s3", 35)
    ]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage")!;
    expect(ctrl.allocated).to.be.closeTo(15, 1e-9); // capped at the upgrade target
    expect(store.allocated).to.be.closeTo(5, 1e-9); // the surplus banks
    // a hauler actually carries energy into the storage bank
    expect(sol.haulers.some(h => h.toId.startsWith("storage-"))).to.equal(true);
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

  it("anti-pump is structural: the storage sink stays OPEN but the bank never pumps into it", () => {
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(10)]);

    // the sink is PRESENT now (owner 2026-07-19: remote surplus banks to storage)...
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage");
    expect(store, "the storage sink is no longer dropped in surplus").to.not.equal(undefined);
    // ...but the bank is stored IN it, so nothing pumps back: here all 20 mined +
    // 10 bank are consumed by the spawn and mopping controller, so storage nets zero
    // and no bank->storage hauler is ever commissioned.
    expect(store!.allocated).to.be.closeTo(0, 1e-9);
    expect(sol.haulers.some(h => h.toId.startsWith("storage-"))).to.equal(false);
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

  it("a filling warchest keeps today's save regime: cap 15, surplus banks", () => {
    // No bank source injected (bank below the warchest target): behavior is
    // EXACTLY the pinned deposit half - controller capped, storage soaks.
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
    expect(store.allocated).to.be.closeTo(5, 1e-9);
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

  it("marks sources paved from the receipt by GAME id (graph 'source-' prefix stripped)", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Set(["s1"]));
    expect(problem.sources.find(s => s.id === "source-s1")!.paved).to.equal(true);
    expect(problem.sources.find(s => s.id === "source-s2")!.paved).to.equal(undefined);
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

    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Set());
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

    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Set());
    const ctrl = problem.sinks.find(k => k.kind === "controller")!;
    expect(ctrl.value).to.be.closeTo(controllerValue(450), 1e-9);
    expect(ctrl.value).to.be.greaterThan(70); // 99%-done level outprices construction
  });

  it("falls back to the kind default without vision of the controller", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNode(5), sourceNode("s1", 15)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Set());
    expect(problem.sinks.find(k => k.kind === "controller")!.value).to.equal(50);
  });
});
