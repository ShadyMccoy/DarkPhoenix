import { expect } from "chai";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";
import { FlowGraph, solveWithCorpPlanner, controllerRoutingCapacity } from "../../../src/economy/flowAdapter";
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
  return new FlowGraph(nodes);
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

  it("hub-and-spoke: ALL mined banks to the storage hub, the controller mops up what the refill claim leaves", () => {
    // 3 sources = 30 e/tick, a storage HUB exists. Hub-and-spoke (owner 2026-07-19):
    // ALL 30 mined banks to the hub (the warchest is the income buffer), and the
    // consumers draw the hub back out. The controller is NOT regime-capped
    // (owner 2026-08-03: asymptotic, not a switch) - it mops up past the spawn's
    // ~10 overhead, less the storage's refill RESERVE claim; the harness stages
    // no live storage stock, so that claim is 0 here and the controller takes 20.
    const graph = graphOf([
      homeNodeWithStorage(5),
      sourceNode("s1", 15),
      sourceNode("s2", 25),
      sourceNode("s3", 35)
    ]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage")!;
    expect(ctrl.allocated).to.be.closeTo(20, 1e-9); // mop-up: 30 mined - 10 spawn overhead
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

  it("the anti-downgrade reserve is DANGER-GATED under scarce supply (owner 2026-08-04: not the constant trickle)", () => {
    // One thin source (3 e/t): the spawn (value 100) takes it all while the
    // downgrade timer is comfortable - the old standing sip was the constant
    // trickle the owner retired. When the timer actually runs low, the
    // PLAN's floor arms and the pre-pass protects the sip even against the
    // spawn.
    const lowRate = createNode("s1", ROOM, at(15), 50, [ROOM], 0);
    lowRate.resources = [{ type: "source", id: "s1", position: at(15), capacity: 900 } as NodeResource]; // 3/tick
    const graph = graphOf([homeNode(5), lowRate]);

    const calm = solveWithCorpPlanner(graph, 0, manhattan);
    const calmCtrl = calm.sinkAllocations.find(a => a.sinkType === "controller");
    expect(calmCtrl, "controller is present").to.not.be.undefined;
    expect(calmCtrl!.allocated, "comfortable timer: the spawn outranks, no trickle").to.equal(0);

    (g.Game as { rooms: Record<string, unknown> }).rooms = {
      [ROOM]: { controller: { my: true, ticksToDowngrade: 3000 }, find: () => [], memory: {} }
    };
    const danger = solveWithCorpPlanner(graph, 0, manhattan);
    const dangerCtrl = danger.sinkAllocations.find(a => a.sinkType === "controller");
    expect(dangerCtrl!.allocated, "danger: the sip is protected even vs the spawn").to.be.greaterThan(1.9);
  });
});

// #21 (owner 2026-07-19): the surplus controller mops up the warchest, but
// bounded by the fleet's PHYSICAL upgrade rate (parking tiles x affordable
// WORK). Live t72429680: the uncapped controller planned 137 e/t against a
// fleet that could field ~4 upgraders - infeasible (P4), and it out-competed
// remote mined production for the bank. The cap makes the surplus that exceeds
// what upgraders can burn overflow into STORAGE instead.
describe("economy/flowAdapter - controllerRoutingCapacity (#21 + the bank-fed inversion)", () => {
  const ctrlSink = { position: { x: 0, y: 0, roomName: "W0N0" } };

  it("WITHOUT a bank the controller mops up (pre-storage behavior, unchanged forever)", () => {
    expect(controllerRoutingCapacity(ctrlSink, 200)).to.equal(200);
  });

  it("WITH a bank the allocation IS the bank-fed rate: floor + surplus draw, never the income mop-up (owner 2026-08-04)", () => {
    // "The bank should be the income mop up not the upgrade": the call site
    // passes bankFedControllerRate(stock, target); income above it banks by
    // construction. Continuous in the bank level - the 2026-08-03 asymptotic
    // ruling holds because the bank level moves slowly.
    expect(controllerRoutingCapacity(ctrlSink, 200, Infinity, new Set(), 37.5)).to.equal(37.5);
    // ...still bounded by the fleet's physical burn rate (#21)
    expect(controllerRoutingCapacity(ctrlSink, 200, 30, new Set(), 37.5)).to.equal(30);
  });

  it("the PHYSICAL cap binds so the excess overflows to storage (#21)", () => {
    // a fleet that can burn only 40 e/t caps the sink at 40; the other 160 of a
    // 200 surplus lands in STORAGE, not an infeasible upgrade plan
    expect(controllerRoutingCapacity(ctrlSink, 200, 40)).to.equal(40);
    // ...but never caps BELOW the real supply when the fleet can burn it all
    expect(controllerRoutingCapacity(ctrlSink, 30, 40)).to.equal(30);
  });

  it("WARTIME: a construction backlog in the room RELEGATES the controller to its floor (spec 33)", () => {
    // Owner 2026-07-27: "surplus ... normally for upgrading, but now for
    // building." A room with a standing build backlog caps the controller at
    // its floor (the sip, 2 - the 15 preference dropped 2026-08-04) so the
    // surplus flows to construction - even over the
    // bank-fed rate. Doctrine keyed to a real backlog, not a bank level.
    const wartime = new Set(["W0N0"]);
    // The floor wartime relegates TO is itself danger-gated now: 0 with a
    // comfortable timer (build gets everything), the sip when danger is
    // passed in from the live lens.
    expect(controllerRoutingCapacity(ctrlSink, 200, Infinity, wartime)).to.equal(0);
    expect(controllerRoutingCapacity(ctrlSink, 200, Infinity, wartime, 80)).to.equal(0);
    expect(controllerRoutingCapacity(ctrlSink, 200, Infinity, wartime, 80, 2)).to.equal(2);
    // A room NOT in the wartime set still mops up (relegation is per-room).
    expect(controllerRoutingCapacity(ctrlSink, 200, Infinity, new Set())).to.equal(200);
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

  it("a filling warchest is NOT a regime: the controller mops up and the refill is the storage's reserve claim", () => {
    // No bank source injected (bank below the warchest target). The old save
    // regime capped the controller at 15 here - the hard half of the 85 -> 15
    // swing (owner 2026-08-03). Now the controller mops up identically to the
    // surplus side (30 mined - 10 spawn = 20) and saving happens only through
    // the storage sink's refill RESERVE - which this harness stages at 0 (no
    // live storage stock to read), so the hub keeps only its gross deposits.
    const graph = graphOf([
      homeNodeWithStorage(5),
      sourceNode("s1", 15),
      sourceNode("s2", 25),
      sourceNode("s3", 35)
    ]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], []);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage")!;
    expect(ctrl.allocated).to.be.closeTo(20, 1e-9);
    expect(store.allocated).to.be.closeTo(30, 1e-9);
  });

  it("detectBankSources reads live storages against the plan-persisted reserve: surplus rooms emit, filling rooms don't", async () => {
    const { detectBankSources } = await import("../../../src/economy/flowAdapter");
    const { bankSurplusRate } = await import("../../../src/economy/bank");
    // The plan published this reserve target last solve; detectBankSources
    // reads it (resolveReserveTarget) so emission and consumer sizing agree.
    const reserveTarget = 30_000;
    g.Memory.warchestTarget = reserveTarget;
    const storageAt = (roomName: string, energy: number) => ({
      controller: { my: true },
      storage: {
        my: true,
        pos: { x: 24, y: 24, roomName },
        store: { energy, getUsedCapacity: () => energy }
      }
    });
    g.Game.rooms = {
      W0N0: storageAt("W0N0", reserveTarget + 3000), // surplus: draws
      W1N0: storageAt("W1N0", reserveTarget - 200) // still filling: saves
    };

    const banks = detectBankSources();
    expect(banks).to.have.length(1);
    expect(banks[0].id).to.equal("bank-W0N0");
    expect(banks[0].rate).to.be.closeTo(bankSurplusRate(reserveTarget + 3000, reserveTarget), 1e-9);
    expect(banks[0].transient).to.equal(true);
    expect(banks[0].maxMiners).to.equal(0);
  });

  // THE INVERSION (owner 2026-08-04: "The bank should be the income mop up
  // not the upgrade"): in a storage-backed room the controller's CAPACITY is
  // floor + surplus/SURPLUS_DRAIN_TICKS - one formula, no regime branch -
  // and the BANK absorbs the income residual by construction. Continuous
  // through the target (the 2026-08-03 asymptotic ruling holds: the
  // allocation follows the slow-moving bank level, never instantaneous
  // income), and phase C's refill claim is retired same-day: a bounded
  // controller leaves the residual to storage without claiming anything.
  // Rooms WITHOUT a storage keep the mop-up (there is no bank to absorb).
  describe("the bank is the income mop-up (bank-fed controller allocation)", () => {
    const stagedStorage = (roomName: string, energy: number) => ({
      // pos stubs findInRange for the deposit-port/link detectors that
      // buildColonyProblem's live defaults walk over Game.rooms.
      controller: { my: true, pos: { x: 40, y: 40, roomName, findInRange: () => [] } },
      storage: {
        my: true,
        pos: { x: 24, y: 24, roomName, findInRange: () => [] },
        store: {
          energy,
          [`${"energy"}`]: energy,
          getUsedCapacity: () => energy,
          getFreeCapacity: () => 1_000_000 - energy
        }
      },
      find: () => []
    });

    it("buildColonyProblem caps the controller at floor + drain in a storage-backed room; the storage carries NO claim", async () => {
      const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
      const { bankFedControllerRate } = await import("../../../src/economy/bank");
      const reserveTarget = 30_000;
      g.Memory.warchestTarget = reserveTarget;
      g.Game.rooms = { W0N0: stagedStorage("W0N0", reserveTarget - 15_000) };

      const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
      const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
      const ctrl = problem.sinks.find(s => s.kind === "controller")!;
      const store = problem.sinks.find(s => s.kind === "storage")!;
      expect(ctrl.capacity).to.be.closeTo(bankFedControllerRate(reserveTarget - 15_000, reserveTarget), 1e-9);
      expect(store.reserve ?? 0, "phase C's refill claim is retired").to.equal(0);
    });

    it("above the target the cap is floor + the surplus draw (one formula, both sides)", async () => {
      const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
      const { bankFedControllerRate } = await import("../../../src/economy/bank");
      const reserveTarget = 30_000;
      g.Memory.warchestTarget = reserveTarget;
      g.Game.rooms = { W0N0: stagedStorage("W0N0", reserveTarget + 15_000) };

      const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
      const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
      const ctrl = problem.sinks.find(s => s.kind === "controller")!;
      expect(ctrl.capacity).to.be.closeTo(bankFedControllerRate(reserveTarget + 15_000, reserveTarget), 1e-9);
    });

    it("without a live storage to read (harness), the mop-up is unchanged - unit paths keep old behavior", async () => {
      const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
      const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
      const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
      const ctrl = problem.sinks.find(s => s.kind === "controller")!;
      expect(ctrl.capacity).to.be.greaterThan(15); // mop-up, not the floor
    });

    it("END-TO-END: below target the controller takes its FLOOR and the residual BANKS", async () => {
      // 4 sources = 40 e/t, bank 15k under a 30k target. Upgrade is
      // proportional to surplus (zero here) plus its floor; the spawn takes
      // ~10; everything else is the bank's - the income mop-up inverted.
      const reserveTarget = 30_000;
      g.Memory.warchestTarget = reserveTarget;
      g.Game.rooms = { W0N0: stagedStorage("W0N0", reserveTarget - 15_000) };
      const graph = graphOf([
        homeNodeWithStorage(5),
        sourceNode("s1", 15),
        sourceNode("s2", 25),
        sourceNode("s3", 35),
        sourceNode("s4", 45)
      ]);
      const { bankFedControllerRate } = await import("../../../src/economy/bank");
      const floorOnly = bankFedControllerRate(reserveTarget - 15_000, reserveTarget);
      const sol = solveWithCorpPlanner(graph, 0, manhattan, [], []);
      const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
      const store = sol.sinkAllocations.find(a => a.sinkType === "storage")!;
      expect(ctrl.allocated).to.be.closeTo(floorOnly, 1e-9);
      expect(store.allocated, "ALL mined still banks to the hub (gross)").to.be.closeTo(40, 1e-9);
    });
  });

  it("detectLinkDepositPorts emits a source-link port with a staffed core drain, excludes core & controller links", async () => {
    const { detectLinkDepositPorts } = await import("../../../src/economy/flowAdapter");
    const { LINK_CAPACITY, SOURCE_RATE } = await import("../../../src/economy/primitives");
    (global as any).FIND_MY_STRUCTURES = 108;
    (global as any).FIND_SOURCES = 105;
    (global as any).STRUCTURE_LINK = "link";
    const cheb = (a: any, b: any) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const linkPos = (x: number, y: number, links: any[]) => ({
      x,
      y,
      roomName: "W0N0",
      inRangeTo: (o: any, range: number) => cheb({ x, y }, o) <= range,
      // Range to the core is what SETS the headroom since the flat cap was
      // retired (2026-08-06) - a mock without it silently exercises the
      // unknown-geometry fallback instead of the physics.
      getRangeTo: (o: any) => cheb({ x, y }, o.pos ?? o),
      findInRange: (_t: number, range: number, o?: any) => {
        const near = links.filter(l => cheb(l.pos, { x, y }) <= range);
        return o?.filter ? near.filter(o.filter) : near;
      }
    });
    // storage(10,10) + core-link(11,10); controller(40,40) + controller-link(41,40);
    // source(25,25) + source-link(26,26). Only the source-link is a shortcut port.
    const links: any[] = [];
    const core = { id: "core", structureType: "link", pos: linkPos(11, 10, links) };
    const ctrl = { id: "ctrl", structureType: "link", pos: linkPos(41, 40, links) };
    const srcLink = { id: "srcLink", structureType: "link", pos: linkPos(26, 26, links) };
    links.push(core, ctrl, srcLink);
    const source = { id: "SRC1", pos: linkPos(25, 25, links) };
    const room: any = {
      controller: { my: true, pos: linkPos(40, 40, links) },
      storage: { my: true, pos: linkPos(10, 10, links) },
      find: (t: number, o?: any) => {
        if (t === (global as any).FIND_SOURCES) return [source];
        return o?.filter ? links.filter(o.filter) : links;
      }
    };
    g.Game.rooms = { W0N0: room };

    const ports = detectLinkDepositPorts();
    expect(ports, "exactly one shortcut port (core & controller excluded)").to.have.length(1);
    const p = ports[0];
    expect(p.pos, "port sits on the source link").to.deep.equal({ x: 26, y: 26, roomName: "W0N0" });
    expect(p.drainSourceId, "drained by the owning source's hauler").to.equal("source-SRC1");
    expect(p.drainFrom, "drain emerges at the core link").to.deep.equal({ x: 11, y: 10, roomName: "W0N0" });
    // HEADROOM IS THE PHYSICS, NOT A CONSTANT. core(11,10) -> port(26,26) is
    // chebyshev 16, so the link fires 800/16 = 50 e/t; its own adjacent source
    // lands in the same link and comes off first, leaving 40 for deposits. The
    // retired flat cap would have answered 30 here.
    expect(p.headroom, "fire rate less the port's own source").to.be.closeTo(LINK_CAPACITY / 16 - SOURCE_RATE, 1e-9);
    expect(p.headroom, "and that is strictly more than the cap it replaced").to.be.greaterThan(30);
  });

  it("detectBankSources falls back to BASE_RESERVE before the first solve publishes a target", async () => {
    const { detectBankSources } = await import("../../../src/economy/flowAdapter");
    const { BASE_RESERVE, bankSurplusRate } = await import("../../../src/economy/bank");
    delete g.Memory.warchestTarget; // no solve yet
    g.Game.rooms = {
      W0N0: {
        controller: { my: true },
        storage: {
          my: true,
          pos: { x: 24, y: 24, roomName: "W0N0" },
          store: { energy: BASE_RESERVE + 3000, getUsedCapacity: () => BASE_RESERVE + 3000 }
        }
      }
    };
    const banks = detectBankSources();
    expect(banks).to.have.length(1);
    expect(banks[0].rate).to.be.closeTo(bankSurplusRate(BASE_RESERVE + 3000, BASE_RESERVE), 1e-9);
  });
});

// SPEC 46 - the CONSUMPTION-CONSTRAINED sinks. Two game facts the plan was
// blind to: the storage sink used to absorb at FULL rate until the last joule
// of room then cliff to zero (min(totalSupply, physical-room) mixed e/t with
// absolute energy), and at RCL8 the game hard-caps upgrading at 15 e/t no
// matter the fleet. The storage now exposes the absorb HALF of the ONE drain
// law (ullage/1500 - primitives.storageAbsorbRate, the exact mirror of
// sustainableConsumptionRate's stock/1500), so as the bank tops out the sink
// rate tapers smoothly and the planner's dependency chain (hauler needs a
// source AND a sink; miner needs a routed hauler) contracts mining to match
// consumption - no "storage full" flag anywhere. The planner-side reaction is
// pinned in CorpPlanner.test.ts ("consumption-constrained economy").
describe("economy/flowAdapter - consumption-constrained sinks (spec 47)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
    g.Memory = {};
    // The live default detectors (deposit ports) walk rooms with the FIND_*
    // constants; stage them so this suite doesn't depend on an earlier test
    // having leaked them (same values the port test stages).
    (global as any).FIND_MY_STRUCTURES = 108;
    (global as any).FIND_SOURCES = 105;
    (global as any).STRUCTURE_LINK = "link";
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  // Same staging shape as the mop-up suite: pos stubs findInRange for the
  // deposit-port/link detectors buildColonyProblem's live defaults walk.
  const stagedRoom = (roomName: string, energy: number, freeCapacity: number, level?: number) => ({
    controller: {
      my: true,
      ...(level !== undefined ? { level } : {}),
      pos: { x: 40, y: 40, roomName, findInRange: () => [] }
    },
    storage: {
      my: true,
      pos: { x: 24, y: 24, roomName, findInRange: () => [] },
      store: {
        energy,
        getUsedCapacity: () => energy,
        getFreeCapacity: () => freeCapacity
      }
    },
    find: () => []
  });

  it("a FULL storage exposes a ZERO-rate sink (the consumption-constrained trigger)", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    g.Game.rooms = { W0N0: stagedRoom("W0N0", 1_000_000, 0) };
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
    const store = problem.sinks.find(s => s.kind === "storage")!;
    expect(store.capacity, "no room, no absorb - mining beyond the consumers is defunded").to.equal(0);
  });

  it("a NEARLY-full storage tapers: the sink rate is ullage/1500, not full-rate-until-the-cliff", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const { storageAbsorbRate } = await import("../../../src/economy/primitives");
    g.Game.rooms = { W0N0: stagedRoom("W0N0", 991_000, 9_000) };
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
    const store = problem.sinks.find(s => s.kind === "storage")!;
    // 9000 free / 1500 = 6 e/t - the old code exposed the FULL 20 e/t here
    expect(store.capacity).to.be.closeTo(storageAbsorbRate(9_000), 1e-9);
    expect(store.capacity).to.be.closeTo(6, 1e-9);
  });

  it("far from full the soak is unchanged: the absorb rate clears total supply", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    g.Game.rooms = { W0N0: stagedRoom("W0N0", 400_000, 600_000) };
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
    const store = problem.sinks.find(s => s.kind === "storage")!;
    expect(store.capacity, "absorb 400 e/t >= supply 20: min() keeps the old soak").to.be.closeTo(20, 1e-9);
  });

  it("controllerUpgradeCap carries the RCL8 game rule (15 e/t) even on a partial mock", async () => {
    const { controllerUpgradeCap } = await import("../../../src/economy/flowAdapter");
    g.Game.rooms = { W0N0: { controller: { my: true, level: 8 } } };
    expect(controllerUpgradeCap("W0N0"), "RCL8: the game caps upgrading at 15 e/t").to.equal(15);
    g.Game.rooms = { W0N0: { controller: { my: true, level: 7 } } };
    expect(controllerUpgradeCap("W0N0"), "below 8 the physical estimate (or Infinity) rules").to.equal(Infinity);
  });

  it("storageBankPressure gives a room's SOURCE and SINK halves off ONE read - they cannot drift", async () => {
    // The owner's model wired: the emitted bank source's rate IS the
    // pressure's source half, and the storage sink's capacity IS its sink
    // half, for the same room at the same instant. Read separately (as they
    // were before) nothing forced them to agree - which is how the sink half
    // stayed dimensionally wrong until spec 47.
    const { storageBankPressure, detectBankSources, buildColonyProblem } = await import(
      "../../../src/economy/flowAdapter"
    );
    const reserveTarget = 30_000;
    g.Memory.warchestTarget = reserveTarget;
    // 970k banked of 1M: BOTH halves live and non-saturated on the sink side
    // (30k of room -> 20 e/t) while the source sits at its guard.
    g.Game.rooms = { W0N0: stagedRoom("W0N0", 970_000, 30_000, 8) };

    const pressure = storageBankPressure("W0N0")!;
    expect(pressure.sink, "30k of room over one generation").to.be.closeTo(20, 1e-9);
    expect(pressure.source, "970k against a 30k target, guarded").to.be.greaterThan(0);

    // the emitted source carries the pressure's source half...
    const emitted = detectBankSources().find(s => s.id === "bank-W0N0")!;
    expect(emitted.rate).to.be.closeTo(pressure.source, 1e-9);
    // ...and the assembled sink carries its sink half (min'd with supply,
    // which is 20 e/t of mining here, so the absorb binds at neither)
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
    const store = problem.sinks.find(s => s.kind === "storage")!;
    expect(store.capacity).to.be.closeTo(Math.min(20, pressure.sink), 1e-9);
  });

  it("END-TO-END: RCL8 + full storage assembles the consumption-constrained problem", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    // Full storage, brimming warchest (way above the 30k target -> fat bank
    // draw), RCL8 controller: the controller sink must cap at the game's 15
    // even though the bank could feed 100, and the storage must admit 0.
    g.Memory.warchestTarget = 30_000;
    g.Game.rooms = { W0N0: stagedRoom("W0N0", 1_000_000, 0, 8) };
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const problem = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
    const ctrl = problem.sinks.find(s => s.kind === "controller")!;
    const store = problem.sinks.find(s => s.kind === "storage")!;
    expect(ctrl.capacity, "the RCL8 cap binds under a fat bank surplus").to.equal(15);
    expect(store.capacity, "the full hub admits nothing").to.equal(0);
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

  it("SOURCE-LOCAL sites price at the SOURCE'S RATE, not the completion horizon (owner: no residual - a bigger builder eats it)", () => {
    // A road cluster beside a mined source is that source's whole economy
    // during its build window: local building is ~5x spawn-cheaper per e/t
    // than hauling the unpaved route home, so the sound plan consumes the
    // full 10 e/t at-site (a ~2-WORK crew) and ships nothing. The horizon
    // cap would price the cluster at ~5 e/t and force a residual hauler -
    // the exact body class roads exist to eliminate.
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    // two ROAD sites adjacent to s2 (at 25), in a REMOTE room (hub-room sites
    // stay bank-funded - the clustering rule is for road-building remotes):
    // dist(s2,site) ~ 1-2 << dist(s2,hub at 6) ~ 19
    graph.addConstructionSite("roadA", "home", { x: 24, y: 25, roomName: "W1N0" }, 1500);
    graph.addConstructionSite("roadB", "home", { x: 27, y: 25, roomName: "W1N0" }, 1500);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);
    const builds = sol.sinkAllocations.filter(a => a.sinkType === "construction");
    const total = builds.reduce((s, a) => s + a.demand, 0);
    expect(total, "cluster demand = the local source's full rate").to.be.closeTo(10, 0.2);
    // and the fill delivers it FROM s2 - no residual deposit from s2:
    const s2Flows = sol.haulers.filter(h => h.fromId === "source-s2");
    expect(
      s2Flows.filter(h => h.toId.startsWith("construction")).reduce((s, h) => s + h.flowRate, 0),
      "s2's whole output builds at-site"
    ).to.be.closeTo(10, 0.2);
    expect(s2Flows.some(h => h.toId.startsWith("storage")), "no residual leg home").to.equal(false);
  });

  it("PER-SITE FLOORS SHARE ONE POOL BUDGET: ten road sites sum to the pool absorb, not ten floors (spec 25 / t72480337)", () => {
    // The boolean-era incident: 10 sites x the max(5,...) floor = 50 e/t of
    // priority-70 plan demand against a pool absorbing ~5 - the demotion-
    // freed ledger parts inflated the consumer plan around exactly this.
    // The crew is ONE fleet sized against the whole pool; per-site demands
    // are pro-rata shares of projectAbsorbRate(total remaining, farthest
    // travel) and their SUM equals it.
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    for (let i = 0; i < 10; i++) graph.addConstructionSite(`road${i}`, "home", at(9 + i), 300);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);
    const builds = sol.sinkAllocations.filter(a => a.sinkType === "construction");
    expect(builds.length).to.equal(10);
    const totalDemand = builds.reduce((s, a) => s + a.demand, 0);
    // pool: 3000 remaining, farthest travel 18. A bank surplus stands
    // (bankSource(40)), so the WARTIME horizon (1/3 life, spec 33) applies:
    // max(5, 3000/((1/3)*1482)) ~ 6.07. The SUM is still ONE pool absorb, not
    // ten floors - the pin's point (pre-wartime this was the flat-5 floor).
    expect(totalDemand, "sum = ONE pool absorb (wartime pace), not 10 floors").to.be.closeTo(
      3000 / ((1 / 3) * 1482),
      0.1
    );
  });

  it("WARTIME IS COLONY-WIDE: REMOTE road sites relegate the home controller (owner 2026-08-05: construction is the primary consumer wherever the project stands; the residual BANKS)", () => {
    // The live gap this pins (t72799968): 24 remote road sites stood while
    // the home room held zero sites - the per-room wartime lens never armed,
    // and the controller took the bank-fed allocation while the roads that
    // would fix the haul economics sat unbuilt. Owner 2026-08-05: "I WANT
    // construction to be the primary consumer over controller if we have a
    // construction project. Banking excess it can't consume is fine." The
    // wartime backlog is now summed COLONY-WIDE; when it stands, every
    // owned controller relegates to its danger-gated floor, construction
    // absorbs at its own caps, and the residual banks (storage) - never the
    // controller.
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    // Two REMOTE road sites, far from every source and hub (un-clustered:
    // farther from each source than that source's hub), summing 4000 >= the
    // 3000 anti-flap threshold. Home room stages NO sites - the exact live
    // shape.
    graph.addConstructionSite("remoteRoadA", "home", { x: 48, y: 25, roomName: "W1N0" }, 2000);
    graph.addConstructionSite("remoteRoadB", "home", { x: 48, y: 27, roomName: "W1N0" }, 2000);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);

    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    const builds = sol.sinkAllocations.filter(a => a.sinkType === "construction");
    const store = sol.sinkAllocations.find(a => a.sinkType === "storage")!;
    expect(ctrl.allocated, "home controller relegated by the REMOTE backlog (comfortable timer: floor 0)").to.equal(0);
    expect(builds.reduce((s, a) => s + a.allocated, 0), "construction absorbs at its own caps").to.be.greaterThan(0);
    expect(store.allocated, "the residual BANKS - excess construction can't consume goes to storage").to.be.greaterThan(0);
  });

  it("colony-wide wartime keeps the anti-flap threshold: a lone sub-3000 remote site never relegates", () => {
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    graph.addConstructionSite("loneTile", "home", { x: 48, y: 25, roomName: "W1N0" }, 300);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);
    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(ctrl.allocated, "trivial paving never relegates upgrading (threshold preserved)").to.be.greaterThan(0);
  });

  it("WARTIME: a real build-out RELEGATES the controller - the surplus goes to building, not upgrading (owner 2026-07-27)", () => {
    // The site sits 4 tiles from the spawn; a bank surplus stands and the 15k
    // backlog is >= the wartime threshold (3000). So (spec 33): construction
    // bursts at the 1/3-life horizon (~30 e/t) AND the controller RELEGATES to
    // its floor - the surplus goes to BUILDING, not the controller mop-up
    // ("normally for upgrading, but now for building"). Pre-wartime the residual
    // upgraded and the controller kept more than construction; now the mode
    // inverts that while the backlog stands. The anti-downgrade FLOOR still
    // holds (relegated != off), and upgrading resumes mop-up once it drains.
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    graph.addConstructionSite("bigbuild", "home", at(9), 15000);
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [], [bankSource(40)]);

    const build = sol.sinkAllocations.find(a => a.sinkType === "construction")!;
    const ctrl = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(build.allocated, "wartime-completion rate (1/3 life)").to.be.closeTo(15000 / ((1 / 3) * 1496), 1e-6);
    expect(build.allocated, "construction now WINS the surplus over upgrading").to.be.greaterThan(ctrl.allocated);
    expect(ctrl.allocated, "controller relegated to ~its floor, not mopping up").to.be.at.most(20);
    // 2026-08-04: the floor wartime relegates TO is danger-gated - with a
    // comfortable downgrade timer (no staged danger here) it is ZERO, so
    // building takes everything. The sip returns only when the timer runs
    // low (pinned in the scarce-supply danger test above).
    expect(ctrl.allocated, "comfortable timer: relegation goes to zero, no trickle").to.equal(0);
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


});

/**
 * THE LIQUIDITY RESERVE IS SIZED FROM *FUNDED* MINING INCOME (the 11->12
 * remote regression, measured t72788704). warchestTarget's income read
 * summed every graph source that passes isMinedIncomeId - i.e. every scouted
 * source whose REAL game id intel has recorded, funded or not. Working the
 * 12th remote gave vision to unworked neighbor rooms; five of their sources
 * gained real ids, the income read jumped 110 -> 170 e/t against 120 funded,
 * and the reserve leapt 77k -> 119k (+42k). bankFedControllerRate (the ONE
 * VALVE's law: floor + (banked - reserve)/SURPLUS_DRAIN_TICKS) collapsed
 * 48.9 -> 31.0 with 165k banked, and controller delivery fell 56 -> 34.6 e/t
 * - scouting was punished as if it were payroll. The reserve covers the
 * payroll of fleets the plan actually fields; candidates fund nothing, so
 * only FUNDED verdict rates may size it (same doctrine as the hub-sizing pin
 * above: t72437535).
 */
describe("economy/flowAdapter - warchestTarget publishes from FUNDED income only (t72788704)", () => {
  const g = globalThis as unknown as { Game?: unknown; Memory?: any };
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

  it("unfunded real-id prospects never inflate the published reserve target", async () => {
    const { FlowEconomy } = await import("../../../src/economy/flowAdapter");
    const { warchestTarget } = await import("../../../src/economy/bank");
    // 2 near sources fund (20 e/t); 3 FAR real-id sources (x>=325, d=320,
    // netEnergy < 0) stay unprofitable candidates - the exact shape of the
    // live incident's scouted-but-never-worked neighbor sources.
    const economy = new FlowEconomy([
      homeNode(5),
      sourceNode("near1", 15),
      sourceNode("near2", 25),
      sourceNode("far1", 325),
      sourceNode("far2", 335),
      sourceNode("far3", 345)
    ]);
    economy.update(0);

    const sol = economy.getSolution()!;
    const funded = (sol.sourceVerdicts ?? []).filter(v => v.verdict === "funded");
    expect(funded.map(v => v.sourceId).sort(), "staging check: exactly the near pair funds").to.deep.equal([
      "source-near1",
      "source-near2"
    ]);
    const fundedRate = funded.reduce((s, v) => s + v.rate, 0);
    expect(fundedRate).to.be.closeTo(20, 1e-9);

    // The published reserve covers FUNDED income (20 e/t -> the BASE_RESERVE
    // floor binds), never the 50 e/t candidate pool (which would publish
    // 700 x 50 = 35,000 and throttle the controller valve for nothing).
    expect(g.Memory.warchestTarget, "reserve sized from funded income only").to.equal(warchestTarget(fundedRate));
  });
});

/**
 * TWO-PASS SOLVE (owner-chosen 2026-08-01, option 2 of three).
 *
 * `discoverSinks` priced the spawn sink at a hardcoded 10 e/t "base spawn
 * overhead demand". That was the plan's ENTIRE model of what running the spawn
 * costs, against a fleet costing ~42 e/t (measured t72714129). Because the
 * spawn tops the value ladder, the shortfall was freed DOWN the ladder and the
 * controller absorbed it - the plan allocated 108.87 to a controller the
 * runtime delivered 47.6 to.
 *
 * Pass 1 discovers the fleet; pass 2 charges the spawn what maintaining it
 * costs. Scope is PRODUCTION + INFRA only - both are sized by sources and
 * rooms, independent of the controller allocation, so pass 2 is a fixed point.
 * Charging consumer bodies would be circular and could oscillate.
 */
describe("economy/flowAdapter - two-pass solve charges the spawn its fleet cost", () => {
  const g = globalThis as unknown as { Game?: unknown };
  let savedGame: unknown;
  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  it("raises the spawn sink's capacity above the hardcoded base when a fleet is priced", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const pass1 = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
    const spawn1 = pass1.sinks.find(k => k.kind === "spawn")!;

    // pass 2 supplies a real maintenance figure
    const MAINT = 25;
    const pass2 = buildColonyProblem(
      graph, manhattan, [], new Map(), new Map(), [], undefined, undefined, undefined, undefined, MAINT
    );
    const spawn2 = pass2.sinks.find(k => k.kind === "spawn")!;

    expect(spawn1.capacity, "pass 1 keeps the legacy base - behaviour unchanged").to.be.lessThan(MAINT);
    expect(spawn2.capacity, "pass 2 demands the fleet's real standing cost").to.be.at.least(MAINT);
  });

  it("carries the infra ENERGY twin on the problem, matching the parts twin's shape", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15)]);
    const p = buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []);
    expect(p.infraEnergyPerTick, "the energy twin rides beside the parts term").to.be.a("number");
    // both terms describe the same details, so they vanish together
    if ((p.infraPartsPerTick ?? 0) === 0) expect(p.infraEnergyPerTick).to.equal(0);
    else expect(p.infraEnergyPerTick!).to.be.greaterThan(0);
  });

  it("the CONTROLLER allocation falls once the spawn is charged (the whole point)", async () => {
    const { buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const { planColony } = await import("../../../src/economy/CorpPlanner");
    const graph = graphOf([homeNodeWithStorage(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const ctrlOf = (problem: any): number =>
      planColony(problem).sinks.filter((k: any) => k.kind === "controller").reduce((n: number, k: any) => n + k.allocated, 0);

    const base = ctrlOf(buildColonyProblem(graph, manhattan, [], new Map(), new Map(), []));
    const charged = ctrlOf(
      buildColonyProblem(graph, manhattan, [], new Map(), new Map(), [], undefined, undefined, undefined, undefined, 25)
    );
    expect(charged, "energy the spawn needs stops being handed down the ladder").to.be.lessThan(base);
  });
});
