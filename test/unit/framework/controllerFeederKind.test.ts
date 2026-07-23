/**
 * ControllerFeederCorp on the corp framework (proof ladder rungs 1-4,
 * docs/specs/00-corp-framework.md). The controller analogue of the extension
 * tender: a dedicated local mover that relays the storage bank to the controller
 * input. Its runtime trigger (rung 3) fires only once a storage bank exists AND a
 * flow miner is producing (infrastructure follows income).
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
import {
  CorpStore,
  deserializeStore,
  materializeCommissions,
  registerCorpKind,
  resetCorpKinds,
  runCommissionedCorps,
  serializeStore
} from "../../../src/economy/CorpKind";
import { planCommissions } from "../../../src/economy/commissionPlan";
import { ControllerFeederCorp } from "../../../src/corps/ControllerFeederCorp";
import { controllerFeederKind } from "../../../src/corps/kinds/controllerFeederKind";
import { describeCorpKindConformance } from "./conformance";

const HOME = "W1N1";

function installGlobals(): void {
  setupGlobals();
  (Game as { map: unknown }).map = { getRoomTerrain: () => ({ get: () => 0 }) };
  const g = global as unknown as Record<string, unknown>;
  g.CARRY = "carry";
  g.MOVE = "move";
  g.FIND_STRUCTURES = 107;
  g.FIND_MY_STRUCTURES = 108;
  g.FIND_MY_SPAWNS = 112;
  g.FIND_DROPPED_RESOURCES = 106;
  g.STRUCTURE_EXTENSION = "extension";
  g.STRUCTURE_SPAWN = "spawn";
  g.STRUCTURE_CONTAINER = "container";
  g.STRUCTURE_STORAGE = "storage";
  g.STRUCTURE_LINK = "link";
  g.RESOURCE_ENERGY = "energy";
}
installGlobals();

const at = (x: number, y = 0): Position => ({ x, y, roomName: HOME });
const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: { x: 25, y: 25, roomName: HOME } }],
  sources: [{ id: "src1", nodeId: "n1", pos: at(10), rate: 10, maxMiners: 1 }],
  sinks: [{ id: "ctrl", kind: "controller", pos: at(5), value: 50, capacity: 1000 }],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

function resetWorld(): void {
  installGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.time = 12345;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
}

/** A room with (optionally) a storage bank and a producing flow miner. */
function installRoom(withStorage: boolean, withMiner: boolean): void {
  Game.creeps = {}; // fresh fleet each install so a prior miner never leaks in
  const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const storage = withStorage
    ? {
        structureType: "storage",
        my: true,
        pos: { x: 26, y: 25, roomName: HOME, findInRange: () => [] },
        store: { energy: 5000, getFreeCapacity: () => 995000, getUsedCapacity: () => 5000 }
      }
    : undefined;
  const controllerPos = { x: 40, y: 25, roomName: HOME, findInRange: () => [] };
  const controller = { my: true, level: 4, pos: controllerPos };
  const spawnPos = {
    x: 25,
    y: 25,
    roomName: HOME,
    findInRange: () => [],
    getRangeTo: (p: { x: number; y: number }) => cheb({ x: 25, y: 25 }, p)
  };
  const spawn = { id: "spawn1", pos: spawnPos } as Record<string, unknown>;
  const room = {
    name: HOME,
    controller,
    storage,
    memory: {},
    find: (type: number) => (type === 112 ? [spawn] : [])
  };
  spawn.room = room;
  Game.rooms[HOME] = room;
  Game.getObjectById = (id: string) => (id === "spawn1" ? spawn : null);
  if (withMiner) {
    Game.creeps.miner1 = {
      name: "miner1",
      spawning: false,
      room: { name: HOME },
      memory: { workType: "harvest", corpId: "mining-src1" }
    };
  }
}

describe("controller-feeder kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(controllerFeederKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: one feeder commission per spawn room", () => {
    const { commissions } = planCommissions(world);
    const f = commissions.filter(c => c.kind === "controllerFeeder");
    expect(f).to.have.length(1);
    expect(f[0].corpId).to.equal("controllerFeeder-W1N1");
    expect(f[0].shape).to.equal("auxiliary");
    expect(f[0].assignment).to.include({ roomName: HOME, spawnId: "spawn1" });
    expect((f[0].assignment as { controllerAllocation: number }).controllerAllocation).to.be.a("number");
  });

  it("rung 3 - BIND: materialize keeps the LEGACY moving-corp id", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;
    // Type "moving" (a local mover), so its runtime id is `moving-${nodeId}`.
    expect(corp.id).to.equal("moving-W1N1-controllerFeeder");
    expect(corp.getSpawnId()).to.equal("spawn1");
  });

  it("rung 3 - TRIGGER: demands a feeder only with a storage bank + a miner", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;
    const ctx = { energyCapacity: 1300 } as never;

    installRoom(false, true); // miner producing but NO storage yet
    expect(corp.getSpawnDemand(ctx), "no bank -> haulers feed the controller directly").to.have.length(0);

    installRoom(true, false); // storage but NO miner yet
    expect(corp.getSpawnDemand(ctx), "infrastructure waits for income").to.have.length(0);

    installRoom(true, true); // storage + miner
    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("feeder");
    expect(demands[0].blocking).to.equal(false); // never holds the spawn ahead of producers
    expect(demands[0].producesIncome).to.equal(false);
  });

  it("sizes the relay to the save-regime target while the warchest fills", async () => {
    const { STORAGE_UPGRADE_TARGET } = await import("../../../src/economy/bank");
    const { carryPartsFor } = await import("../../../src/economy/primitives");
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;

    installRoom(true, true); // bank at 5000: well below the warchest target
    const demands = corp.getSpawnDemand({ energyCapacity: 1300 } as never);
    expect(demands).to.have.length(1);
    // spawn (25,25) -> controller (40,25): range 15. Sized to sustain the
    // save-regime 15 e/t over the round trip, exactly as before the surplus
    // mechanism existed - a filling warchest must see NO behavior change.
    const expected = Math.ceil(carryPartsFor(STORAGE_UPGRADE_TARGET, 15) * 1.2);
    expect(demands[0].bodyParam).to.equal(expected);
  });

  it("clamps the relay to the PLAN's controller flow in the SAVE regime (t72421124, post-daec503 form)", async () => {
    // The original incident (t72421124): controller floored at 2 e/t while
    // the feeder fielded 94 parts relaying 115 e/t into a FULL 2000 stock -
    // consumers plan-capped tiny while the feeder sized to raw surplus. Since
    // daec503 that mismatch class cannot occur IN SURPLUS: the upgraders size
    // from actuals there (the goal plan is not a cap - owner doctrine), so
    // the feeder now matches them (feederRelayTarget: surplus -> surplusRate;
    // prod t72455355 measured the half-fixed state - upgraders assuming 115
    // while the clamped feeder relayed 7, stock 1520 -> 60, burn 11 of 115).
    // The clamp's guard therefore lives in the NON-surplus regime: while the
    // warchest fills, the relay serves the plan's controller flow only.
    const { carryPartsFor } = await import("../../../src/economy/primitives");
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;

    installRoom(true, true); // bank at 5000: below the warchest target (save regime)

    corp.setControllerAllocation(2); // the plan's floored controller sink
    const demands = corp.getSpawnDemand({ energyCapacity: 1300 } as never);
    expect(demands).to.have.length(1);
    // Sized for ~2+headroom e/t over the 15-range leg - ONE small shuttle.
    const clampedMax = Math.ceil(carryPartsFor(2 + 5, 15) * 1.2);
    expect(demands[0].bodyParam).to.be.at.most(clampedMax);
  });

  it("rung 2 - PLAN: propose threads the draft's controller allocation into the assignment", () => {
    const { commissions } = planCommissions(world);
    const f = commissions.find(c => c.kind === "controllerFeeder")!;
    const a = f.assignment as { controllerAllocation?: number };
    // world's plan allocates the controller sink (capacity 1000, one source
    // at 10 e/t) - whatever it funds, the feeder assignment must carry it.
    expect(a.controllerAllocation, "assignment carries the plan's controller flow").to.be.a("number");
    expect(a.controllerAllocation!).to.be.greaterThan(0);
  });

  it("scales the relay (more feeders) once the bank is in surplus", async () => {
    const { BASE_RESERVE, feederRelayRate } = await import("../../../src/economy/bank");
    const { carryPartsFor } = await import("../../../src/economy/primitives");
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;

    installRoom(true, true);
    // The plan published this reserve last solve; the corp reads it the same
    // way (resolveReserveTarget), so the test's math and the corp agree.
    const reserveTarget = BASE_RESERVE;
    (Memory as Record<string, unknown>).warchestTarget = reserveTarget;
    const banked = reserveTarget + 100_000; // deep surplus: draw at its cap
    (Game.rooms[HOME] as { storage: { store: { energy: number } } }).storage.store.energy = banked;
    // Post-clamp contract: the feeder scales only for flow the PLAN sends to
    // the controller - state a surplus-era plan that allocates the full draw.
    corp.setControllerAllocation(feederRelayRate(banked, reserveTarget));

    // needed carry across the relay exceeds one max body (13 CARRY at 1300
    // capacity), so the corp fields a second (and third) feeder rather than
    // pretending one shuttle can move 35 e/t.
    const needed = Math.ceil(carryPartsFor(feederRelayRate(banked, reserveTarget), 15) * 1.2);
    const maxCarry = 13;
    const wantedFeeders = Math.ceil(needed / maxCarry);
    expect(wantedFeeders).to.be.greaterThan(1); // the scenario actually exercises scaling

    const demands = corp.getSpawnDemand({ energyCapacity: 1300 } as never);
    expect(demands).to.have.length(1);
    expect(demands[0].bodyParam).to.equal(maxCarry);

    // stub live feeders one below the target: still demanding
    for (let i = 0; i < wantedFeeders - 1; i++) {
      Game.creeps[`feed${i}`] = {
        name: `feed${i}`,
        spawning: false,
        room: { name: HOME },
        memory: { corpId: corp.id, workType: "feed" }
      } as never;
    }
    expect(corp.getSpawnDemand({ energyCapacity: 1300 } as never)).to.have.length(1);

    // at the target: satisfied
    Game.creeps[`feed${wantedFeeders - 1}`] = {
      name: `feed${wantedFeeders - 1}`,
      spawning: false,
      room: { name: HOME },
      memory: { corpId: corp.id, workType: "feed" }
    } as never;
    expect(corp.getSpawnDemand({ energyCapacity: 1300 } as never)).to.have.length(0);
  });

  it("rung 3 - EXECUTE/PERSIST: run() is safe; store round-trips to a fixpoint", () => {
    installRoom(true, true);
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const corp = store.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;
    corp.recordProduction(7);
    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;
    expect(back.id).to.equal(corp.id);
    expect(back.getSpawnId()).to.equal("spawn1");
  });

  it("run() with a storage + feeder present sets the controllerFeederActive flag", () => {
    installRoom(true, true);
    const room = Game.rooms[HOME] as { memory: { controllerFeederActive?: boolean } };
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("controllerFeeder-W1N1")!.corp as ControllerFeederCorp;
    // No feeder creep in the field yet -> the flag must stay false (a dead feeder
    // must never leave haulers stranded at the bank; they feed the controller).
    corp.work(Game.time);
    expect(room.memory.controllerFeederActive).to.equal(false);

    // A living feeder -> the flag flips on so CarryCorp defers to the last leg.
    Game.creeps.feed1 = {
      name: "feed1",
      spawning: false,
      room: { name: HOME },
      pos: { getRangeTo: () => 1, isNearTo: () => true, isEqualTo: () => false },
      store: { energy: 0, getFreeCapacity: () => 100, getUsedCapacity: () => 0 },
      withdraw: () => 0,
      transfer: () => 0,
      drop: () => 0,
      memory: { corpId: corp.id, workType: "feed", working: false }
    } as never;
    corp.work(Game.time);
    expect(room.memory.controllerFeederActive).to.equal(true);
  });

  it("rung 4 - COMPOSE: coexists with the extension tender over the same world", async () => {
    const { extensionTenderKind } = await import("../../../src/corps/kinds/extensionTenderKind");
    registerCorpKind(extensionTenderKind as never);
    const { commissions } = planCommissions(world);
    const aux = commissions.filter(c => c.shape === "auxiliary").map(c => c.corpId);
    expect(aux.sort()).to.deep.equal(["controllerFeeder-W1N1", "tender-W1N1"]);
  });
});

describe("controller-feeder kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(controllerFeederKind as never, {
    problem: world,
    commission: {
      corpId: "controllerFeeder-W1N1",
      kind: "controllerFeeder",
      shape: "auxiliary",
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName: HOME, spawnId: "spawn1" }
    },
    expectedSpawnPartsPerTick: 0
  });
});
