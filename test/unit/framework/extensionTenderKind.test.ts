/**
 * ExtensionTenderCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). The third and last auxiliary; mirrors the
 * scout/reservation ports. The tender-specific proof is rung 3's runtime
 * trigger: getSpawnDemand() fires only once a depot exists, the room has
 * extensions, AND a flow miner is producing (infrastructure follows income).
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
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";
import { extensionTenderKind } from "../../../src/corps/kinds/extensionTenderKind";
import { describeCorpKindConformance } from "./conformance";

const HOME = "W1N1";

function installGlobals(): void {
  setupGlobals();
  (Game as { map: unknown }).map = { getRoomTerrain: () => ({ get: () => 0 }) };
  const g = global as unknown as Record<string, unknown>;
  g.CARRY = "carry";
  g.MOVE = "move";
  g.FIND_MY_STRUCTURES = 108;
  g.FIND_DROPPED_RESOURCES = 106;
  g.STRUCTURE_EXTENSION = "extension";
  g.STRUCTURE_SPAWN = "spawn";
  g.STRUCTURE_CONTAINER = "container";
  g.STRUCTURE_STORAGE = "storage";
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

/**
 * Build a room with a depot container by the spawn, `extCount` extensions, and
 * (optionally) a producing flow miner. Wired so coreDepot() and the demand
 * trigger see what they need.
 */
function installRoom(extCount: number, withMiner: boolean): void {
  const depot = {
    structureType: "container",
    pos: { x: 26, y: 25, roomName: HOME, getRangeTo: () => 1, isNearTo: () => true },
    store: { energy: 2000, getFreeCapacity: () => 0, getUsedCapacity: () => 2000 }
  };
  const extensions = Array.from({ length: extCount }, (_v, i) => ({
    structureType: "extension",
    pos: { x: 20 + i, y: 25, roomName: HOME },
    store: { getFreeCapacity: () => 50 }
  }));
  // coreDepot() walks FIND_MY_SPAWNS then spawn.pos.findInRange for a container.
  const spawnPos = {
    x: 25,
    y: 25,
    roomName: HOME,
    findInRange: (type: number) => (type === 107 ? [depot] : []) // FIND_STRUCTURES
  };
  const spawn = { id: "spawn1", pos: spawnPos, owner: { username: "me" } } as Record<string, unknown>;
  const room = {
    name: HOME,
    controller: { my: true, level: 3, pos: { x: 30, y: 25, roomName: HOME } },
    storage: undefined,
    memory: {},
    find: (type: number, opts?: { filter?: (s: unknown) => boolean }) => {
      let out: unknown[] = [];
      if (type === 108) out = [depot, ...extensions]; // FIND_MY_STRUCTURES
      if (type === 112) out = [spawn]; // FIND_MY_SPAWNS
      if (opts?.filter) out = out.filter(opts.filter);
      return out;
    }
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

describe("extension-tender kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(extensionTenderKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: one tender commission per spawn room", () => {
    const { commissions } = planCommissions(world);
    const t = commissions.filter(c => c.kind === "tender");
    expect(t).to.have.length(1);
    expect(t[0].corpId).to.equal("tender-W1N1");
    expect(t[0].shape).to.equal("auxiliary");
    expect(t[0].assignment).to.deep.equal({ roomName: HOME, spawnId: "spawn1" });
  });

  it("rung 3 - BIND: materialize keeps the LEGACY runtime corp id", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("tender-W1N1")!.corp as ExtensionTenderCorp;
    // The corp's type is "moving" (it is a local mover), so its legacy runtime
    // id is `moving-${nodeId}` - exactly what live tenders carry in memory.corpId.
    expect(corp.id).to.equal("moving-W1N1-tender");
    expect(corp.getSpawnId()).to.equal("spawn1");
  });

  it("rung 3 - TRIGGER: demands a tanker only with depot + extensions + a miner", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("tender-W1N1")!.corp as ExtensionTenderCorp;
    const ctx = { energyCapacity: 800 } as never;

    installRoom(5, false); // depot + extensions but NO miner yet
    expect(corp.getSpawnDemand(ctx), "infrastructure waits for income").to.have.length(0);

    installRoom(5, true); // miner now producing
    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("tanker");
    expect(demands[0].blocking).to.equal(false); // never holds the spawn ahead of producers
    expect(demands[0].producesIncome).to.equal(false);
  });

  it("rung 3 - EXECUTE/PERSIST: run() flags haulers off extensions; store round-trips", () => {
    installRoom(3, true);
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const corp = store.get("tender-W1N1")!.corp as ExtensionTenderCorp;
    corp.recordProduction(11);
    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("tender-W1N1")!.corp as ExtensionTenderCorp;
    expect(back.id).to.equal(corp.id);
    expect(back.getSpawnId()).to.equal("spawn1");
  });

  it("rung 4 - COMPOSE: the three auxiliaries coexist over the same world", async () => {
    const { scoutKind } = await import("../../../src/corps/kinds/scoutKind");
    const { reservationKind } = await import("../../../src/corps/kinds/reservationKind");
    registerCorpKind(scoutKind as never);
    registerCorpKind(reservationKind as never);
    const { commissions } = planCommissions(world);
    const aux = commissions.filter(c => c.shape === "auxiliary").map(c => c.corpId);
    expect(aux.sort()).to.deep.equal(["reservation-W1N1", "scout-W1N1", "tender-W1N1"]);
  });
});

describe("extension-tender kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(extensionTenderKind as never, {
    problem: world,
    commission: {
      corpId: "tender-W1N1",
      kind: "tender",
      shape: "auxiliary",
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName: HOME, spawnId: "spawn1" }
    },
    expectedSpawnPartsPerTick: 0
  });
});
