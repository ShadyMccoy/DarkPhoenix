import { expect } from "chai";
import {
  planColony,
  ColonyProblem,
  PlannerSource,
  PlannerSink,
  PlannerSpawn
} from "../../../src/economy/CorpPlanner";
import {
  netEnergy,
  carryPartsFor,
  miningBudgetPerSpawn,
  spawnPartsFor,
  constructionWorkSpawnLoad,
  controllerWorkSpawnLoad,
  effectiveLife,
  MINER_PARTS,
  SPAWN_PARTS_PER_TICK
} from "../../../src/economy/primitives";
import { effectiveOneWayTiles } from "../../../src/economy/roadEconomics";
import { Position } from "../../../src/types/Position";

// 1-D world: everything in one room, distance = |dx| + |dy|, so we can place a
// source at any exact distance from a spawn/sink and hand-derive the economics.
const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const spawn = (id: string, x: number): PlannerSpawn => ({ id, pos: at(x) });
const source = (id: string, x: number, rate = 10, maxMiners = 1): PlannerSource => ({
  id,
  nodeId: `node-${id}`,
  pos: at(x),
  rate,
  maxMiners
});
const sink = (id: string, kind: PlannerSink["kind"], x: number, value: number, capacity: number, reserve?: number): PlannerSink => ({
  id,
  kind,
  pos: at(x),
  value,
  capacity,
  reserve
});

function problem(p: Partial<ColonyProblem> & Pick<ColonyProblem, "spawns" | "sources" | "sinks">): ColonyProblem {
  return { dist: manhattan, ...p };
}

const stock = (id: string, x: number, rate: number): PlannerSource => ({
  id,
  nodeId: `node-${id}`,
  pos: at(x),
  rate,
  maxMiners: 0,
  transient: true
});

describe("economy/CorpPlanner", () => {
  describe("spawn-feasibility (spec 15 P4: the plan is an equilibrium, not a wish)", () => {
    // Energy-abundant, spawn-scarce world: the energy side would happily
    // allocate ~230 e/t to the controller, but the bodies to haul and burn it
    // cost more parts/tick than one spawn can build. The plan must stop
    // filling when the spawn's parts are spent - measured live 2026-07-18:
    // an unconstrained plan implied 0.56 parts/t against the 0.333 physical
    // ceiling and the colony self-limited via starvation queues instead.
    const world = () =>
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("a", 10), source("b", 14), source("c", 18), stock("pile", 5, 200)],
        sinks: [sink("sp", "spawn", 0, 100, 20), sink("ctrl", "controller", 8, 50, 500)],
        infraPartsPerTick: 0.12
      });

    function impliedPartsPerTick(plan: ReturnType<typeof planColony>): number {
      // Miner BODIES only - m.spawnParts is the budget-gate estimate that
      // presumes a haul leg, and the plan's real haul is in plan.haulers.
      const miners = plan.miners.reduce((s, m) => s + MINER_PARTS / effectiveLife(m.distance), 0);
      const haulers = plan.haulers.reduce((s, h) => s + h.spawnParts, 0);
      const ctrl = plan.sinks.find(s => s.kind === "controller");
      const work = ctrl ? controllerWorkSpawnLoad(ctrl.allocated, 8) : 0;
      return miners + haulers + work + 0.12;
    }

    it("never commissions more body maintenance than the spawn can build", () => {
      const plan = planColony(world());
      expect(impliedPartsPerTick(plan)).to.be.at.most(SPAWN_PARTS_PER_TICK + 1e-9);
    });

    it("the parts cap BINDS here (energy alone would allocate far more) and value order decides who gets parts", () => {
      const plan = planColony(world());
      const ctrl = plan.sinks.find(s => s.kind === "controller")!;
      const sp = plan.sinks.find(s => s.kind === "spawn")!;
      expect(sp.allocated).to.be.closeTo(20, 1e-9); // value 100 funds first, in full
      expect(ctrl.allocated).to.be.greaterThan(0); // residual parts still upgrade
      expect(ctrl.allocated).to.be.lessThan(210); // energy alone would give ~230 - the cap must bind
    });

    it("stamps partsLeft on the DRY exit too (live t72420516: a stale pre-pass stamp read 0.105 of a spent budget)", () => {
      // The ledger-dry early return skipped the partsLeft stamp, so a sink
      // whose value fill ran dry kept its pre-pass remainder (or none at
      // all) - the v4 trace then showed a near-full budget on a sink that
      // actually drained it. The stamp must tell the fill's truth at EVERY
      // exit, and remain monotone with fill order.
      const plan = planColony(world());
      const ctrl = plan.sinks.find(s => s.kind === "controller")!;
      const sp = plan.sinks.find(s => s.kind === "spawn")!;
      expect(ctrl.partsLeft, "dry-exit fill must stamp its remainder").to.not.equal(undefined);
      expect(ctrl.partsLeft!).to.be.at.most((sp.partsLeft ?? Infinity) + 1e-9);
      expect(ctrl.partsLeft!).to.be.closeTo(0, 1e-6); // it ran DRY - that is the story
    });

    it("construction outranks the controller for the surplus and is charged in the ledger (5x cheaper per e/t)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10), stock("pile", 5, 150)],
          sinks: [sink("build", "construction", 6, 70, 200), sink("ctrl", "controller", 8, 50, 500)],
          infraPartsPerTick: 0.2
        })
      );
      const build = plan.sinks.find(s => s.kind === "construction")!;
      const ctrl = plan.sinks.find(s => s.kind === "controller")!;
      expect(build.allocated).to.be.greaterThan(ctrl.allocated); // sites first - the ladder unchanged
      const miners = plan.miners.reduce((s, m) => s + MINER_PARTS / effectiveLife(m.distance), 0);
      const haul = plan.haulers.reduce((s, h) => s + h.spawnParts, 0);
      const work = controllerWorkSpawnLoad(ctrl.allocated, 8) + constructionWorkSpawnLoad(build.allocated, 6);
      expect(miners + haul + work + 0.2).to.be.at.most(SPAWN_PARTS_PER_TICK + 1e-9);
    });

    it("with no infra load and light flows the cap is slack and allocations are untouched", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 100)]
        })
      );
      expect(plan.sinks.find(s => s.kind === "controller")!.allocated).to.be.closeTo(10, 1e-6);
    });
  });

  describe("Phase 1 - producer selection", () => {
    it("N=1: mines a single profitable source and sizes its hauler to the controller", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 100)]
        })
      );
      expect(plan.miners).to.have.length(1);
      const m = plan.miners[0];
      expect(m.sourceId).to.equal("a");
      expect(m.spawnId).to.equal("S");
      expect(m.distance).to.equal(10);
      expect(m.rate).to.equal(10);
      expect(m.netEnergy).to.be.closeTo(netEnergy(10, 10), 1e-9);
      // one hauler source->controller, both at distance 10, carrying the full rate
      expect(plan.haulers).to.have.length(1);
      expect(plan.haulers[0].flowRate).to.be.closeTo(10, 1e-9);
      expect(plan.haulers[0].carryParts).to.be.closeTo(carryPartsFor(10, 10), 1e-9);
    });

    it("never mines a source that costs more to staff than it yields", () => {
      // at distance 320 the round-trip hauler cost drives netEnergy negative
      expect(netEnergy(10, 320)).to.be.lessThan(0);
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("far", 320)],
          sinks: [sink("ctrl", "controller", 0, 50, 100)]
        })
      );
      expect(plan.miners).to.have.length(0);
      expect(plan.haulers).to.have.length(0);
    });

    it("under spawn-budget contention, keeps the best source and drops the rest", () => {
      // two far sources sharing one spawn each cost ~0.13 parts/tick; the budget
      // (~0.2) only affords one, so the second falls out.
      const d = 200;
      expect(2 * spawnPartsFor(10, d)).to.be.greaterThan(miningBudgetPerSpawn());
      expect(netEnergy(10, d)).to.be.greaterThan(0); // both are individually profitable
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", d), source("b", -d)], // both 200 from spawn
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
      expect((plan.spawnPartsUsed.get("S") ?? 0)).to.be.greaterThan(0);
    });

    it("always staffs a spawn's single source even if it alone exceeds the budget", () => {
      // A rich source (15/tick, e.g. a high-capacity/keeper source) far enough out
      // that its miner+haulers alone exceed the mining budget but it is still
      // net-positive. For a standard 10/tick source this is impossible - it turns
      // unprofitable (~d=286) before it exceeds the budget (~d=291) - so the
      // "always staff the best" guarantee only bites for rich sources.
      const d = 210;
      expect(spawnPartsFor(15, d)).to.be.greaterThan(miningBudgetPerSpawn());
      expect(netEnergy(15, d)).to.be.greaterThan(0);
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("lonely", d, 15)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
    });

    it("with spare build-time, mines a far source - distance alone never disqualifies", () => {
      // d=120 is well past "local" but profitable and within the mining budget;
      // the spawn-time wall is contention, not a fixed range cutoff.
      const d = 120;
      expect(netEnergy(10, d)).to.be.greaterThan(0);
      expect(spawnPartsFor(10, d)).to.be.lessThan(miningBudgetPerSpawn());
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("far", d)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
      expect(plan.miners[0].sourceId).to.equal("far");
    });

    it("assigns each source to its NEAREST spawn (N spawns)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("A", 0), spawn("B", 100)],
          sources: [source("near-b", 90)], // d=90 to A, d=10 to B
          sinks: [sink("ctrl", "controller", 50, 50, 1000)]
        })
      );
      expect(plan.miners[0].spawnId).to.equal("B");
      expect(plan.miners[0].distance).to.equal(10);
    });
  });

  describe("Phase 2 - value routing", () => {
    it("fills the higher-value sink (spawn) before a lower-value one (controller)", () => {
      const base = {
        spawns: [spawn("S", 0)],
        sinks: [sink("spawn", "spawn", 0, 100, 10), sink("ctrl", "controller", 0, 50, 1000)]
      };
      // one source (10/tick): spawn (cap 10) takes it all, controller gets nothing
      const p1 = planColony(problem({ ...base, sources: [source("a", 10)] }));
      expect(allocOf(p1, "spawn")).to.be.closeTo(10, 1e-9);
      expect(allocOf(p1, "ctrl")).to.be.closeTo(0, 1e-9);
      // two sources (20/tick): spawn capped at 10, controller takes the rest
      const p2 = planColony(problem({ ...base, sources: [source("a", 10), source("b", 12)] }));
      expect(allocOf(p2, "spawn")).to.be.closeTo(10, 1e-9);
      expect(allocOf(p2, "ctrl")).to.be.closeTo(10, 1e-9);
    });

    it("respects a sink's capacity (excess is left unrouted)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 5)] // capacity 5 < produced 10
        })
      );
      expect(allocOf(plan, "ctrl")).to.be.closeTo(5, 1e-9);
      expect(plan.totalProduced).to.be.closeTo(10, 1e-9);
      expect(plan.totalDelivered).to.be.closeTo(5, 1e-9);
    });

    it("honors a reserve floor before higher-value sinks drain the pool", () => {
      // scarce energy (6/tick): construction (value 70) would take it all, but the
      // controller's reserve of 2 is filled first.
      const base = {
        spawns: [spawn("S", 0)],
        sources: [source("a", 10, 6)] // a thin 6/tick source at distance 10
      };
      const withReserve = planColony(
        problem({ ...base, sinks: [sink("build", "construction", 0, 70, 5), sink("ctrl", "controller", 0, 50, 100, 2)] })
      );
      expect(allocOf(withReserve, "ctrl")).to.be.greaterThan(1.9); // reserve protected
      const noReserve = planColony(
        problem({ ...base, sinks: [sink("build", "construction", 0, 70, 5), sink("ctrl", "controller", 0, 50, 100)] })
      );
      expect(allocOf(noReserve, "ctrl")).to.be.lessThan(allocOf(withReserve, "ctrl"));
    });

    it("pulls from the NEAREST source first when filling a sink", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("near", 5), source("far", 50)],
          sinks: [sink("ctrl", "controller", 0, 50, 10)] // wants 10, the near source covers it
        })
      );
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      expect(ctrl.sources).to.have.length(1);
      expect(ctrl.sources[0].sourceId).to.equal("near");
      expect(ctrl.sources[0].amount).to.be.closeTo(10, 1e-9);
    });
  });

  describe("link-served sources (haulPos)", () => {
    it("prices a link-served source's hauling from its haulPos while the miner keeps the real distance", () => {
      // The source sits 200 out, but its output emerges at the core link 2 from
      // the sink - so the hauler is tiny while the miner still walks 200.
      const linked: PlannerSource = { ...source("linked", 200), haulPos: at(2) };
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [linked],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners).to.have.length(1);
      expect(plan.miners[0].distance, "miner walks the real distance").to.equal(200);
      expect(plan.haulers).to.have.length(1);
      expect(plan.haulers[0].distance, "hauling is priced from the core").to.equal(2);
      expect(plan.haulers[0].carryParts).to.be.closeTo(carryPartsFor(10, 2), 1e-9);
    });
  });

  describe("deposit ports (depositPos) - spec 26 (deposit-side haulPos)", () => {
    // The symmetric mirror of haulPos: a link CLOSER to a mined deposit than its
    // storage hub lets the hauler TURN AROUND early and drop there (the link
    // consumes/forwards the energy on to the hub). The energy still belongs to
    // the storage sink - the port only shortens the delivery leg, exactly as
    // haulPos shortens the pickup leg. depositPorts is problem data (the flow
    // adapter's detectLinkDepositPorts lens); the planner prices min(hub, port).
    const hubWorld = (
      sources: PlannerSource[],
      ports: { pos: Position; headroom: number }[]
    ): ColonyProblem =>
      problem({
        spawns: [spawn("S", 0)],
        sources: [...sources, stock("bank-home", 50, 100)],
        sinks: [sink("spawn-S", "spawn", 0, 100, 5), sink("store", "storage", 50, 1, 1000)],
        depositPorts: ports
      });

    it("prices a deposit's haul-home to a NEARER port (turn around early), not the full hub leg", () => {
      // mined at 30, hub at 50 (dHub 20), a port at 42 (dPort 12) between them.
      const port = at(42);
      const plan = planColony(hubWorld([source("m", 30, 10)], [{ pos: port, headroom: 15 }]));
      const h = plan.haulers.find(x => x.sourceId === "m" && x.sinkId === "store")!;
      expect(h, "mined still hauls home to the hub").to.not.equal(undefined);
      expect(h.distance, "priced at the port leg (30->42), not the hub leg (30->50)").to.equal(12);
      expect(h.carryParts, "CARRY sized to the short port leg").to.be.closeTo(carryPartsFor(10, 12), 1e-9);
      expect(h.depositPos, "carries the chosen port").to.deep.equal(port);
      expect(plan.miners.find(m => m.sourceId === "m")!.distance, "miner keeps the real distance").to.equal(30);
    });

    it("ignores a port FARTHER than the hub (no shortcut = no port)", () => {
      const plan = planColony(hubWorld([source("m", 30, 10)], [{ pos: at(60), headroom: 15 }]));
      const h = plan.haulers.find(x => x.sourceId === "m" && x.sinkId === "store")!;
      expect(h.distance, "full hub leg").to.equal(20);
      expect(h.depositPos).to.equal(undefined);
    });

    it("shares a port's throughput headroom across deposits; the residual prices at the hub leg", () => {
      // Two deposits (10 e/t each) through one port of headroom 12: the first
      // (nearest the hub) takes its full 10 via the port, the second gets the
      // remaining 2 there and hauls its other 8 the long way (blended leg).
      const port = at(42);
      const plan = planColony(
        hubWorld([source("m1", 30, 10), source("m2", 31, 10)], [{ pos: port, headroom: 12 }])
      );
      const h1 = plan.haulers.find(x => x.sourceId === "m1" && x.sinkId === "store")!;
      const h2 = plan.haulers.find(x => x.sourceId === "m2" && x.sinkId === "store")!;
      // m2 (dHub 19) sorts first, takes the full port leg (31->42 = 11).
      expect(h2.distance, "first deposit turns around fully at the port").to.equal(11);
      // m1 (dHub 20) gets the residual 2 e/t via the port, 8 the long way:
      // blend = (2/10)*12 + (8/10)*20 = 18.4.
      expect(h1.distance, "residual deposit blends port + hub legs").to.be.closeTo(18.4, 1e-6);
      expect(h1.depositPos).to.deep.equal(port);
      expect(h2.depositPos).to.deep.equal(port);
    });

    it("ignores ports with no storage hub (pre-storage: mined feeds consumers directly)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("m", 30, 10)],
          sinks: [sink("ctrl", "controller", 50, 50, 100)],
          depositPorts: [{ pos: at(42), headroom: 15 }]
        })
      );
      const h = plan.haulers.find(x => x.sourceId === "m")!;
      expect(h.depositPos, "no hub -> ports never apply").to.equal(undefined);
    });
  });

  describe("hub-and-spoke: mined DEPOSITS to storage, the hub SPENDS to consumers (owner 2026-07-19)", () => {
    // Owner's model, replacing the production-first/nearest-first regime gates:
    // when a storage HUB exists, mined (and scavenge) is a DEPOSIT source - its
    // only home is the storage, so every funded source gets its haul-home (the
    // miner+hauler package deal), and the warchest becomes the true income
    // buffer. The bank/hub is the SPEND source - consumers draw the warchest,
    // sized to it. No source ever routes both ways; the physical anti-pump
    // (bank never deposits to its own store) falls out of the roles. Live
    // motivation (t72434228->t72435669): the hybrid hauled mined DIRECTLY to
    // the controller, so storage saw ~0 income and bled feeding the spawn -
    // "we're spending our savings" even though remotes now deliver. Routing
    // income THROUGH the hub stops the bleed without changing the total balance
    // (owner: "the routing doesn't change the overall energy flow balance").
    it("routes mined to the STORAGE hub, never directly to a consumer", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          // 2 mined sources (20 e/t) + the hub carrying mined-throughput+surplus (the
          // adapter bumps the bank rate to minedSupply+surplus; here 100 stands in)
          sources: [source("m1", 20), source("m2", 25), stock("bank-home", 2, 100)],
          sinks: [
            sink("spawn-S", "spawn", 0, 100, 8),
            sink("ctrl", "controller", 5, 50, 30),
            sink("store", "storage", 2, 1, 1000) // the hub: mined's only home
          ]
        })
      );
      const spawnSink = plan.sinks.find(s => s.sinkId === "spawn-S")!;
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      const store = plan.sinks.find(s => s.sinkId === "store")!;
      // ALL mined banks to the hub (both sources, 10+10), not just an overflow
      const minedToStore = store.sources.filter(s => s.sourceId.startsWith("m")).reduce((a, s) => a + s.amount, 0);
      expect(minedToStore, "all mined production banks to the storage hub").to.be.closeTo(20, 1e-6);
      // consumers draw the HUB (bank), never mined directly
      expect(ctrl.sources.every(s => s.sourceId === "bank-home"), "controller drawn only from the hub").to.equal(true);
      expect(ctrl.allocated, "controller filled to its capacity from the hub").to.be.closeTo(30, 1e-6);
      expect(spawnSink.sources.every(s => s.sourceId === "bank-home"), "spawn drawn only from the hub").to.equal(true);
      expect(spawnSink.allocated, "spawn fully funded from the hub").to.be.closeTo(8, 1e-6);
      // no mined->consumer hauler is ever commissioned (hub-and-spoke)
      expect(
        plan.haulers.some(h => h.sourceId.startsWith("m") && (h.sinkId === "ctrl" || h.sinkId === "spawn-S")),
        "no mined->consumer hauler (mined only hauls home to the hub)"
      ).to.equal(false);
      // each mined source DOES get its dedicated haul-home to the hub (package deal)
      expect(plan.haulers.some(h => h.sourceId === "m1" && h.sinkId === "store"), "m1 hauls home to the hub").to.equal(true);
      expect(plan.haulers.some(h => h.sourceId === "m2" && h.sinkId === "store"), "m2 hauls home to the hub").to.equal(true);
    });

    it("a FAR remote gets its dedicated haul HOME to the hub (miner+hauler package, owner)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          // a FAR remote source + the hub; the controller sits in the home room
          sources: [source("remote", 40, 10), stock("bank-home", 5, 300)],
          sinks: [
            sink("spawn-S", "spawn", 0, 100, 5),
            sink("ctrl", "controller", 6, 50, 100),
            sink("store", "storage", 5, 1, 1000) // the hub, beside the controller (home)
          ]
        })
      );
      // the remote hauls HOME to the hub (not to the controller directly)
      expect(plan.haulers.some(h => h.sourceId === "remote" && h.sinkId === "store"), "remote hauls home to the hub").to.equal(true);
      expect(plan.haulers.some(h => h.sourceId === "remote" && h.sinkId === "ctrl"), "no direct remote->controller hauler").to.equal(false);
      const store = plan.sinks.find(s => s.sinkId === "store")!;
      expect(store.sources.find(s => s.sourceId === "remote")?.amount ?? 0, "the remote's full output banks").to.be.closeTo(10, 1e-6);
      // the controller and spawn draw the hub (the warchest income)
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      expect(ctrl.sources.every(s => s.sourceId === "bank-home") && ctrl.allocated > 0, "controller drawn from the hub").to.equal(true);
    });

    it("the hub never deposits into storage - it IS the storage (structural anti-pump)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("mined", 5, 10), stock("bank-home", 2, 100)],
          sinks: [
            sink("ctrl", "controller", 8, 50, 5),
            sink("store", "storage", 2, 1, 1000)
          ]
        })
      );
      const store = plan.sinks.find(s => s.sinkId === "store")!;
      expect(store.sources.find(s => s.sourceId === "mined")?.amount ?? 0, "mined banks to storage").to.be.greaterThan(0);
      expect(
        store.sources.find(s => s.sourceId === "bank-home")?.amount ?? 0,
        "the hub never deposits back into its own store"
      ).to.equal(0);
    });

    it("PRE-storage (no hub): mined feeds consumers directly - hub-and-spoke needs a hub", () => {
      // RCL<4: no storage, therefore no bank source (the storage IS the bank), so
      // the nearest-first race the production-first gate once guarded never
      // arises - mined is the only supply and feeds the consumers straight.
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("remote", 40, 10)],
          sinks: [
            sink("spawn-S", "spawn", 0, 100, 5),
            sink("ctrl", "controller", 6, 50, 100)
          ]
        })
      );
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      // with no hub, the remote's energy is delivered straight to the consumers
      expect(ctrl.sources.find(s => s.sourceId === "remote")?.amount ?? 0, "remote mined delivers to the controller").to.be.greaterThan(0);
      expect(plan.haulers.some(h => h.sourceId === "remote" && h.sinkId === "ctrl"), "a direct remote->controller hauler exists pre-storage").to.equal(true);
    });
  });

  describe("production-first parts ledger (prod t72445337: 70 e/t funded, 0 routed)", () => {
    // The pure value pass filled consumers first; deposits (mined -> hub) sat
    // at storage's value 1 and got the ledger's LEAVINGS - one live solve's
    // bank->consumer routes plus upgrade WORK charges drained partsLeft to
    // 0.0 and all seven funded sources got zero haul routes: the plan read
    // feasible while 70 e/t of income rotted at the containers. Parts now
    // follow the macro doctrine: spawn overhead, then the funded income's
    // haul-home, then consumers burn the residual.
    it("routes the funded deposit BEFORE consumer draws when parts bind (the incident)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("remote", 40, 10), stock("bank-home", 2, 200)],
          sinks: [
            sink("spawn-S", "spawn", 0, 100, 5),
            sink("ctrl", "controller", 5, 50, 200),
            sink("store", "storage", 2, 1, 1000)
          ],
          // Budget ~0.031 parts/t: the remote's deposit needs ~0.022, the
          // spawn ~0.001, and an unchecked controller draw would eat ~27 e/t
          // x 0.0011 = the WHOLE ledger before storage's value-1 turn.
          infraPartsPerTick: 0.297
        })
      );
      const deposit = plan.haulers.find(h => h.sourceId === "remote" && h.sinkId === "store");
      expect(deposit, "the funded source's haul-home exists even under consumer pressure").to.not.equal(undefined);
      expect(deposit!.flowRate, "the deposit routes the FULL rate").to.be.closeTo(10, 1e-6);
      const spawnSink = plan.sinks.find(s => s.sinkId === "spawn-S")!;
      expect(spawnSink.allocated, "spawn overhead still funded first").to.be.closeTo(5, 1e-6);
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      expect(ctrl.allocated, "the consumer burns the RESIDUAL parts").to.be.greaterThan(1);
      expect(ctrl.allocated, "not the deposit's share").to.be.lessThan(15);
      expect(plan.sourceVerdicts.find(v => v.sourceId === "remote")!.verdict).to.equal("funded");
    });

    it("FUNDED => ROUTED: a source whose deposit gets ZERO parts demotes to 'unrouted' (no miner for rot)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          // A (closer to the hub) partially routes and exhausts the ledger;
          // B's deposit gets nothing - a B miner would mine for pure rot.
          sources: [source("A", 30, 20), source("B", 45, 10), stock("bank-home", 2, 200)],
          sinks: [
            sink("spawn-S", "spawn", 0, 100, 1),
            sink("store", "storage", 2, 1, 1000)
          ],
          infraPartsPerTick: 0.302
        })
      );
      expect(plan.miners.map(m => m.sourceId), "only the routed source keeps its miner").to.deep.equal(["A"]);
      expect(plan.sourceVerdicts.find(v => v.sourceId === "A")!.verdict, "partial routing stays funded").to.equal("funded");
      expect(plan.sourceVerdicts.find(v => v.sourceId === "B")!.verdict).to.equal("unrouted");
      const aDeposit = plan.haulers.find(h => h.sourceId === "A" && h.sinkId === "store");
      expect(aDeposit!.flowRate, "A ships what the ledger affords").to.be.greaterThan(5);
      expect(aDeposit!.flowRate).to.be.lessThan(19);
      expect(plan.haulers.some(h => h.sourceId === "B"), "no phantom B route").to.equal(false);
    });

  });

  describe("spec 25: emergent dedication - deposit sources may feed construction NEARER than their hub", () => {
    // The dedicatedToBuild flag bypassed the router (pool zeroed) and needed
    // three same-day exemption patches. The planner-native form: the
    // hub-and-spoke role rule gains ONE refinement - a deposit-class source
    // (mined or scavenge) may route to a CONSTRUCTION sink closer to it than
    // its hub. Nearest-first then makes trunk dedication emergent from
    // prices: source-adjacent road sites out-compete the long deposit leg,
    // the residual banks, and completion re-routes everything home with no
    // lifecycle code. 1-D world: spawn+hub at 0-2, remote source T at 46.
    const world = (extraSinks: PlannerSink[], opts: Partial<ColonyProblem> = {}): ColonyProblem =>
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("T", 46, 10), stock("bank-home", 2, 200)],
        sinks: [
          sink("spawn-S", "spawn", 0, 100, 1),
          sink("store", "storage", 2, 1, 1000),
          ...extraSinks
        ],
        infraPartsPerTick: 0.05,
        ...opts
      });

    it("1. EMERGENT DEDICATION: all of T feeds its adjacent road sinks; nothing ships home", () => {
      const plan = planColony(
        world([sink("road1", "construction", 44, 70, 5), sink("road2", "construction", 48, 70, 5)])
      );
      const toRoads = plan.haulers.filter(h => h.sourceId === "T" && h.sinkId.startsWith("road"));
      expect(toRoads.reduce((s, h) => s + h.flowRate, 0), "T's whole rate builds at-site").to.be.closeTo(10, 1e-6);
      expect(
        plan.haulers.some(h => h.sourceId === "T" && h.sinkId === "store"),
        "no deposit leg while the sites absorb the rate"
      ).to.equal(false);
      expect(plan.sourceVerdicts.find(v => v.sourceId === "T")!.verdict, "the miner stands, no flag").to.equal(
        "funded"
      );
      // anti-pump intact: the bank never deposits
      expect(plan.haulers.some(h => h.sourceId === "bank-home" && h.sinkId === "store")).to.equal(false);
    });

    it("2. RESIDUAL DEPOSITS: sites absorbing 4 of 10 leave 6 shipping home (partial dedication is just routing)", () => {
      const plan = planColony(world([sink("road1", "construction", 44, 70, 4)]));
      const toRoad = plan.haulers.find(h => h.sourceId === "T" && h.sinkId === "road1");
      const toStore = plan.haulers.find(h => h.sourceId === "T" && h.sinkId === "store");
      expect(toRoad!.flowRate).to.be.closeTo(4, 1e-6);
      expect(toStore!.flowRate).to.be.closeTo(6, 1e-6);
    });

    it("3. COMPLETION TRANSITION: no road sinks -> the full rate deposits home (no lifecycle code)", () => {
      const plan = planColony(world([]));
      const toStore = plan.haulers.find(h => h.sourceId === "T" && h.sinkId === "store");
      expect(toStore!.flowRate, "hauling home resumes purely by the sinks vanishing").to.be.closeTo(10, 1e-6);
    });

    it("4. ROLE GUARD: a construction sink FARTHER from T than its hub still draws the bank, never T", () => {
      // site at 96: dist(T)=50 > hubDist(T)=44 - outside T's exception, even
      // though T (50) is nearer the site than the bank (94). Home sites keep
      // their bank funding; the exception is strictly source-LOCAL building.
      const plan = planColony(world([sink("farSite", "construction", 96, 70, 5)]));
      expect(plan.haulers.some(h => h.sourceId === "T" && h.sinkId === "farSite")).to.equal(false);
      const fromBank = plan.haulers.find(h => h.sourceId === "bank-home" && h.sinkId === "farSite");
      expect(fromBank, "the bank funds distant construction, as before").to.not.equal(undefined);
    });

    it("5. HUB ROLES OTHERWISE UNCHANGED: consumers other than construction never draw T", () => {
      const plan = planColony(
        world([sink("ctrl", "controller", 44, 50, 20)]) // adjacent to T, but NOT construction
      );
      expect(
        plan.haulers.some(h => h.sourceId === "T" && h.sinkId === "ctrl"),
        "the exception is construction-only; mined never feeds a controller directly in the hub era"
      ).to.equal(false);
      expect(plan.haulers.find(h => h.sourceId === "T" && h.sinkId === "store")!.flowRate).to.be.closeTo(
        10,
        1e-6
      );
    });
  });

  describe("recovery competes on route economics; SIZING keeps it from crowding (owner 2026-07-20)", () => {
    it("a RIGHT-SIZED near recovery coexists with the mined route in the same tight ledger", () => {
      // The t72447104 displacement replayed: a near backlog stock + a far
      // mined source in a ledger that once could not hold both. The fix is
      // SIZING, not ranking - scavengeRate now drains the halfway amount
      // over an effective ttl (a 16k stock asks ~5 e/t, not the old 20), so
      // nearest-first routes the cheap recovery AND the mined route fits.
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [
            source("mined", 30, 10),
            { ...stock("scavenge-big", 5, 5.5), transient: true }, // ~16k pile at the new rate
            stock("bank-home", 2, 50)
          ],
          sinks: [
            sink("spawn-S", "spawn", 0, 100, 1),
            sink("store", "storage", 2, 1, 1000)
          ],
          infraPartsPerTick: 0.31
        })
      );
      const scav = plan.haulers.find(h => h.sourceId === "scavenge-big" && h.sinkId === "store");
      expect(scav, "the near recovery routes (already-extracted energy is the cheapest there is)").to.not.equal(
        undefined
      );
      const minedRoute = plan.haulers.find(h => h.sourceId === "mined" && h.sinkId === "store");
      expect(minedRoute, "and the mined route still fits beside it").to.not.equal(undefined);
      expect(minedRoute!.flowRate).to.be.closeTo(10, 1e-6);
      expect(plan.sourceVerdicts.find(v => v.sourceId === "mined")!.verdict).to.equal("funded");
    });
  });

  describe("storage-full defund (owner 2026-07-19: top out the storage -> defund the WHOLE corp)", () => {
    // The all-or-nothing rule. A remote source is fully funded (miner + hauler
    // + reserver + container) or fully defunded - never a miner mining into a
    // complete container with no hauler (#19). The trigger is "no home for the
    // energy": total sink capacity < total mined production. In the live
    // economy this only bites once storage tops out (part 2A drops its
    // capacity to physical room-remaining, ~0 when full) and the controller is
    // at its spot cap - otherwise a sink always has room and remotes keep
    // running ("generally we want our remotes running"). Worst net-per-part
    // first, keep at least one so the colony never strands itself.
    it("defunds the worst-density source whole-corp when sink capacity cannot absorb the mining", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          // both profitable and within one spawn's mining budget; near out-densities far
          sources: [source("near", 5, 10), source("far", 40, 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 10)] // room for only 10/tick; mining wants 20
        })
      );
      expect(plan.miners.map(m => m.sourceId), "far is defunded - its energy has no home").to.deep.equal(["near"]);
      const farVerdict = plan.sourceVerdicts.find(v => v.sourceId === "far")!;
      expect(farVerdict.verdict, "the drop is stamped, not silent").to.equal("no-sink");
      // whole corp, not just the hauler: no miner => no supply => no hauler routed
      expect(plan.haulers.some(h => h.sourceId === "far")).to.equal(false);
      // the surviving corp fully feeds the only home
      expect(plan.sinks.find(s => s.sinkId === "ctrl")!.allocated).to.be.closeTo(10, 1e-6);
    });

    it("keeps at least one source even when nothing has a home (never strands the colony)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("near", 5, 10), source("far", 40, 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 0)] // storage full, controller capped: zero room
        })
      );
      expect(plan.miners.length, "one survivor - the densest").to.equal(1);
      expect(plan.miners[0].sourceId).to.equal("near");
    });

    it("does NOT defund when a sink can still absorb the mining (remotes keep running)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("near", 5, 10), source("far", 40, 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)] // plenty of room - the common case
        })
      );
      expect(plan.miners.map(m => m.sourceId).sort()).to.deep.equal(["far", "near"]);
      expect(plan.sourceVerdicts.every(v => v.verdict !== "no-sink")).to.equal(true);
    });
  });

  describe("scavenging - transient sources", () => {
    it("hauls a ground stock to a sink WITHOUT commissioning a miner", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [stock("pile", 10, 8)], // 8/tick scavengeable stock at distance 10
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      // a transient stock is already harvested: no miner, but a scavenger hauls it
      expect(plan.miners).to.have.length(0);
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl")!;
      expect(ctrl.allocated).to.be.closeTo(8, 1e-9);
      expect(plan.haulers.filter(h => h.sourceId === "pile").length).to.be.greaterThan(0);
      expect(plan.totalProduced).to.be.closeTo(8, 1e-9);
    });

    it("adds stock energy to the routed supply alongside staffed sources", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("s1", 10), stock("pile", 15, 6)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      // the staffed source is mined; the stock is scavenged; both reach the sink
      expect(plan.miners.map(m => m.sourceId)).to.deep.equal(["s1"]);
      expect(plan.totalProduced).to.be.closeTo(16, 1e-9);
      expect(plan.sinks.find(s => s.sinkId === "ctrl")!.allocated).to.be.closeTo(16, 1e-9);
      expect(plan.haulers.some(h => h.sourceId === "s1")).to.equal(true);
      expect(plan.haulers.some(h => h.sourceId === "pile")).to.equal(true);
    });

    it("never commissions a miner for a transient source even when steady sources contend", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("s1", 10), stock("pile", 12, 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.miners.some(m => m.sourceId === "pile")).to.equal(false);
    });

    it("skips a stock too far to scavenge profitably (haul cost exceeds the energy)", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [stock("faraway", 350, 8)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.haulers).to.have.length(0);
      expect(plan.totalProduced).to.be.closeTo(0, 1e-9);
    });
  });

  describe("whole-plan accounting", () => {
    it("reports produced, delivered, overhead and per-spawn build-time", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("S", 0)],
          sources: [source("a", 10)],
          sinks: [sink("ctrl", "controller", 0, 50, 1000)]
        })
      );
      expect(plan.totalProduced).to.be.closeTo(10, 1e-9);
      expect(plan.totalDelivered).to.be.closeTo(10, 1e-9);
      expect(plan.totalOverhead).to.be.greaterThan(0);
      expect(plan.sustainable).to.equal(true);
      expect(plan.spawnPartsUsed.get("S")).to.be.greaterThan(0);
    });

    it("generalises to N spawns and sources: each miner on its nearest spawn, budgets independent", () => {
      const plan = planColony(
        problem({
          spawns: [spawn("A", 0), spawn("B", 100), spawn("C", 200)],
          sources: [source("a1", 8), source("a2", 12), source("b1", 95), source("c1", 205), source("c2", 190)],
          sinks: [sink("ctrl", "controller", 100, 50, 10000)]
        })
      );
      // every commissioned miner sits on the spawn nearest its source
      const spawnsById = new Map(plan.miners.map(m => [m.sourceId, m.spawnId]));
      expect(spawnsById.get("a1")).to.equal("A");
      expect(spawnsById.get("a2")).to.equal("A");
      expect(spawnsById.get("b1")).to.equal("B");
      expect(spawnsById.get("c1")).to.equal("C");
      expect(spawnsById.get("c2")).to.equal("C");
      // no spawn's committed build-time runs away (each within budget, or a single best source)
      for (const [, used] of plan.spawnPartsUsed) {
        expect(used).to.be.greaterThan(0);
      }
    });
  });
});

function allocOf(plan: ReturnType<typeof planColony>, sinkId: string): number {
  return plan.sinks.find(s => s.sinkId === sinkId)?.allocated ?? 0;
}

/**
 * OVER-ABUNDANCE: more profitable sources than a spawn's build-time can
 * sustain. The planner must fill the budget by VALUE DENSITY (net energy per
 * spawn build-part), not raw net energy or discovery order - the recurring
 * spawn cost (miner + haulers, amortized over effective life) IS the scarce
 * resource once sources are plentiful.
 *
 * Mutation checks: sort candidates by raw net (drop the /parts) and the
 * density case fails; drop the `spent + parts > budget` guard and the
 * budget-cap case fails.
 */
describe("Phase 1 - over-abundance sizing (value density under the parts budget)", () => {
  it("staffs by value DENSITY, not raw net, when the budget cannot fit everything", () => {
    // a: rate 4 at d=12 - small raw net but extremely cheap to serve (dense).
    // b, c: rate 10 at d=190/200 - each out-nets a in absolute terms, but
    // their hauler fleets are budget hogs. All three together overflow the
    // budget; density order (a, b, c) keeps a+b and drops c. A raw-net sort
    // (the mutation) would pick b first instead.
    const dA = 12;
    const dB = 190;
    const dC = 200;
    const netA = netEnergy(4, dA);
    expect(netEnergy(10, dB)).to.be.greaterThan(netA); // raw net prefers b...
    expect(netA / spawnPartsFor(4, dA)).to.be.greaterThan(netEnergy(10, dB) / spawnPartsFor(10, dB)); // ...density prefers a
    const total = spawnPartsFor(4, dA) + spawnPartsFor(10, dB) + spawnPartsFor(10, dC);
    expect(total).to.be.greaterThan(miningBudgetPerSpawn()); // real contention

    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("b", dB, 10), source("c", dC, 10), source("a", dA, 4)],
        sinks: [sink("ctrl", "controller", 0, 50, 1000)]
      })
    );
    const mined = plan.miners.map(m => m.sourceId);
    expect(mined[0]).to.equal("a"); // density winner staffed first
    expect(mined).to.include("b");
    expect(mined).to.not.include("c"); // the lowest-density candidate is the one dropped
  });

  it("fills the budget with the best subset and never exceeds it (beyond the first pick)", () => {
    // Five profitable sources; the budget affords only some. The planner must
    // take a prefix of the density ordering that fits, skipping any candidate
    // that would overflow but still trying later smaller ones.
    const ds = [20, 60, 100, 150, 200];
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: ds.map((d, i) => source(`s${d}`, d, 10)),
        sinks: [sink("ctrl", "controller", 0, 50, 5000)]
      })
    );
    expect(plan.miners.length).to.be.greaterThan(0);
    expect(plan.miners.length).to.be.lessThan(ds.length); // over-abundance: not all staffed
    // near sources in, farthest out
    const mined = new Set(plan.miners.map(m => m.sourceId));
    expect(mined.has("s20")).to.equal(true);
    expect(mined.has("s200")).to.equal(false);
    // the recurring parts total respects the budget
    let parts = 0;
    for (const m of plan.miners) parts += spawnPartsFor(m.rate, m.distance);
    expect(parts).to.be.at.most(miningBudgetPerSpawn() + 1e-9);
  });

  it("each spawn gets its OWN budget - two spawns staff twice as much", () => {
    const ds = [80, 120, 160, 200];
    const single = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: ds.map(d => source(`p${d}`, d, 10)),
        sinks: [sink("ctrl", "controller", 0, 50, 5000)]
      })
    );
    const double = planColony(
      problem({
        spawns: [spawn("S", 0), spawn("S2", 400)],
        sources: [
          ...ds.map(d => source(`p${d}`, d, 10)),
          ...ds.map(d => source(`q${d}`, 400 - d, 10)) // mirrored cluster near S2
        ],
        sinks: [sink("ctrl", "controller", 0, 50, 5000)]
      })
    );
    expect(double.miners.length).to.be.greaterThan(single.miners.length);
    // and no spawn's MINING selection individually blows its budget (the
    // spawnPartsUsed ledger also carries sink-side hauling, which is
    // budgeted downstream - only the Phase-1 mining fill is capped here)
    const miningPartsBySpawn = new Map<string, number>();
    for (const m of double.miners) {
      miningPartsBySpawn.set(m.spawnId, (miningPartsBySpawn.get(m.spawnId) ?? 0) + spawnPartsFor(m.rate, m.distance));
    }
    for (const [, used] of miningPartsBySpawn) {
      expect(used).to.be.at.most(miningBudgetPerSpawn() + 1e-9);
    }
  });
});

describe("Phase 2 - paved routes (roads)", () => {
  it("stamps a paved source's haulers and prices them at 1.5 spawn parts per CARRY", () => {
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("a", 10), paved: true }, source("b", 12)],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    const pavedHauler = plan.haulers.find(h => h.sourceId === "a")!;
    const plainHauler = plan.haulers.find(h => h.sourceId === "b")!;
    expect(pavedHauler.paved).to.equal(true);
    expect(plainHauler.paved).to.equal(undefined);
    // 2:1 road hauler: 1.5 parts per CARRY instead of 2 - the spawn-budget payoff
    expect(pavedHauler.spawnParts).to.be.closeTo((1.5 * pavedHauler.carryParts) / (1500 - pavedHauler.distance), 1e-9);
    expect(plainHauler.spawnParts).to.be.closeTo((2 * plainHauler.carryParts) / (1500 - plainHauler.distance), 1e-9);
  });

  it("a PARTIALLY paved route sizes CARRY at the EFFECTIVE distance (owner: 32/38 still optimizes)", () => {
    // The 2:1 body is already the winner at >= 1/2 built, but its loaded leg
    // crawls the unpaved stretch - CARRY must cover the true round-trip TIME
    // (ticks, not tiles) or the fleet is undersized until the last tile lands.
    const fraction = 32 / 38;
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("a", 10), paved: true, pavedFraction: fraction }],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    const h = plan.haulers.find(x => x.sourceId === "a")!;
    expect(h.paved).to.equal(true);
    const dEff = effectiveOneWayTiles(h.distance, fraction, 2);
    expect(h.carryParts).to.be.closeTo(carryPartsFor(h.flowRate, dEff), 1e-9);
    // the unpaved-stretch tax is real: more CARRY than the fully paved sizing...
    expect(h.carryParts).to.be.greaterThan(carryPartsFor(h.flowRate, h.distance));
    // ...priced at the road body's 1.5 parts per CARRY, life at the real walk
    expect(h.spawnParts).to.be.closeTo((1.5 * h.carryParts) / (1500 - h.distance), 1e-9);
  });

  it("a fully paved receipt (no fraction - the legacy shape) sizes exactly as before", () => {
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("a", 10), paved: true }],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    const h = plan.haulers.find(x => x.sourceId === "a")!;
    expect(h.carryParts).to.be.closeTo(carryPartsFor(h.flowRate, h.distance), 1e-9);
  });
});

describe("Invader tax on remote sources (spec 13 phase 5)", () => {
  it("subtracts the tax from net: a marginal source flips unfunded when taxed", () => {
    // A source whose untaxed net is barely positive: taxed past it, the
    // profitability gate must drop it.
    const d = 250; // far enough that hauler amortization eats most of the margin
    const untaxedNet = netEnergy(10, d);
    expect(untaxedNet).to.be.greaterThan(0); // fixture sanity
    const killTax = (untaxedNet + 0.001) / 10;

    const funded = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("far", d), invaderTax: killTax / 2 }],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(funded.miners, "half the kill-tax: still profitable").to.have.length(1);

    const dropped = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [{ ...source("far", d), invaderTax: killTax }],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(dropped.miners, "taxed past its margin: not worth mining").to.have.length(0);
  });

  it("ranks an untaxed source above an otherwise-identical taxed one", () => {
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [
          { ...source("taxed", 40), invaderTax: 0.05 },
          source("clean", -40)
        ],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(plan.miners.length, "both still profitable").to.equal(2);
    expect(plan.miners[0].sourceId, "the clean source is staffed first").to.equal("clean");
  });

  it("never taxes what has no field: existing fixtures are byte-identical", () => {
    const a = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("a", 10)],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(a.miners[0].rate).to.equal(10);
    expect(a.miners[0].netEnergy).to.be.closeTo(netEnergy(10, 10), 1e-9);
  });
});

/**
 * Source verdicts (spec 14 phase 5 - planner exclusion stamps). selectProducers
 * was the last silent decision in the economy: candidates dropped for
 * unprofitability (incl. the invader tax) or budget were indistinguishable from
 * ones never considered, which is exactly why "why are the remotes dead - tax
 * overshoot or reservation deadlock?" could not be answered from a capture
 * (live incident 2026-07-18: 5 remotes excluded across 2000+ ticks, cause
 * undeterminable). Every non-transient candidate now gets a verdict with the
 * pricing the decision read.
 */
describe("planColony source verdicts (exclusions stamped, spec 14 phase 5)", () => {
  it("stamps funded, unprofitable (tax visible), and over-budget verdicts", () => {
    const d = 10;
    const heavyTax = (netEnergy(10, d) / 10) * 2; // tax term double the net -> clearly unprofitable
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [
          source("good", d),
          { ...source("taxed", d), invaderTax: heavyTax },
          // enough profitable sources to exhaust the per-spawn mining budget
          // (each costs ~MINER_PARTS/effectiveLife ~ 0.005 parts/tick vs 0.2)
          ...Array.from({ length: 60 }, (_, i) => source(`b${i}`, d + 1 + i))
        ],
        sinks: [sink("ctrl", "controller", 0, 50, 500)]
      })
    );

    const byId = new Map(plan.sourceVerdicts.map(v => [v.sourceId, v]));
    expect(byId.get("good")!.verdict).to.equal("funded");
    const taxed = byId.get("taxed")!;
    expect(taxed.verdict).to.equal("unprofitable");
    expect(taxed.tax).to.be.closeTo(heavyTax * 10, 1e-9); // the tax TERM (e/tick), readable
    expect(taxed.net).to.be.lessThan(0);
    // budget: some profitable source got dropped for build-time, with its price attached
    const overBudget = plan.sourceVerdicts.filter(v => v.verdict === "over-budget");
    expect(overBudget.length).to.be.greaterThan(0);
    expect(overBudget[0].net).to.be.greaterThan(0); // dropped despite profit - the budget said no
    // every funded verdict corresponds to a commissioned miner and vice versa
    const funded = plan.sourceVerdicts.filter(v => v.verdict === "funded").map(v => v.sourceId).sort();
    expect(funded).to.deep.equal(plan.miners.map(m => m.sourceId).sort());
  });

  it("transient stocks get no verdict (they are not mining candidates)", () => {
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("a", 10), stock("loot", 5, 4)],
        sinks: [sink("ctrl", "controller", 0, 50, 100)]
      })
    );
    expect(plan.sourceVerdicts.map(v => v.sourceId)).to.deep.equal(["a"]);
  });
});

describe("unreachable sources get a verdict (no invisible decisions, spec 14)", () => {
  it("a source no spawn can path to is stamped 'unreachable', never silently skipped", () => {
    const plan = planColony(
      problem({
        spawns: [spawn("S", 0)],
        sources: [source("a", 10), source("marooned", 20)],
        sinks: [sink("ctrl", "controller", 0, 50, 100)],
        // Path lens fails for the marooned source only (Infinity = unreachable).
        dist: (x, y) => (x.x === 20 || y.x === 20 ? Number.POSITIVE_INFINITY : manhattan(x, y))
      })
    );
    const v = plan.sourceVerdicts.find(s => s.sourceId === "marooned");
    expect(v).to.not.equal(undefined);
    expect(v!.verdict).to.equal("unreachable");
    expect(plan.miners.map(m => m.sourceId)).to.deep.equal(["a"]);
  });
});

describe("the fill survives a failed path lens (live regression t72417871: planAllocated 97 -> 8.4)", () => {
  const world = (badDist: number) =>
    problem({
      spawns: [spawn("S", 0)],
      sources: [source("a", 10), source("bad", 30), source("c", 20)],
      sinks: [sink("ctrl", "controller", 0, 50, 100)],
      // The path lens fails for ONE source; the others are fine.
      dist: (x, y) => (x.x === 30 || y.x === 30 ? badDist : manhattan(x, y))
    });

  for (const [name, bad] of [["Infinity", Number.POSITIVE_INFINITY], ["NaN", Number.NaN]] as const) {
    it(`a ${name}-distance route neither aborts the sink fill nor poisons the ledger`, () => {
      const plan = planColony(world(bad));
      const ctrl = plan.sinks.find(s => s.kind === "controller")!;
      // The two healthy sources (20 e/t) must still route in full.
      expect(ctrl.allocated).to.be.closeTo(20, 1e-6);
      expect(Number.isFinite(ctrl.allocated)).to.equal(true);
      for (const h of plan.haulers) expect(Number.isFinite(h.spawnParts)).to.equal(true);
    });
  }
});
