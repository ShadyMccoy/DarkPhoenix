/**
 * ScoutCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). The first REAL kind through the ladder:
 * conformance in isolation, proposal via the planner, full lifecycle on the
 * generic dispatch (including a real spawn request against a stubbed
 * SpawningCorp), and composition with a second kind. Rung 5 (live cutover
 * replacing runScoutCorps) is the next commit.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory, createMockRoom } from "../mock";
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
import { ScoutCorp } from "../../../src/corps/ScoutCorp";
import { scoutKind, setSpawningCorpResolver } from "../../../src/corps/kinds/scoutKind";
import { SpawningCorp } from "../../../src/corps/SpawningCorp";
import { describeCorpKindConformance } from "./conformance";

/**
 * Re-install the shared mock globals every test: other suites overwrite
 * global.Game wholesale, so module-level setup is not enough.
 */
function installGlobals(): void {
  setupGlobals();
  // Scout pathing/world surface the shared mock doesn't cover.
  (Game as { map: unknown }).map = {
    getRoomTerrain: () => ({ get: () => 0 }),
    describeExits: (roomName: string) => (roomName === "W1N1" ? { "1": "W1N2" } : {}),
    getRoomStatus: () => ({ status: "normal" })
  };
  (global as unknown as Record<string, unknown>).MOVE = "move";
  (global as unknown as Record<string, unknown>).FIND_HOSTILE_STRUCTURES = 109;
}
installGlobals();

const ROOM = "W1N1";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: { x: 25, y: 25, roomName: ROOM } }],
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
  (Memory as Record<string, unknown>).roomIntel = undefined;
  (Memory as Record<string, unknown>).creeps = {};
  setSpawningCorpResolver(() => undefined);
}

/** A spawn whose room is RCL 2 - past the scout gate. */
function installHomeSpawn(): void {
  const room = createMockRoom(ROOM, { controller: { x: 5, y: 0, level: 2 } });
  const spawn = { id: "spawn1", pos: { x: 25, y: 25, roomName: ROOM }, room, spawning: null };
  Game.rooms[ROOM] = room;
  Game.getObjectById = (id: string) => (id === "spawn1" ? spawn : null);
}

describe("scout kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(scoutKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: one scout commission per spawn room, alongside the solver's", () => {
    const { commissions } = planCommissions(world);
    const scout = commissions.filter(c => c.kind === "scout");
    expect(scout).to.have.length(1);
    expect(scout[0].corpId).to.equal("scout-W1N1");
    expect(scout[0].shape).to.equal("auxiliary");
    expect(scout[0].assignment).to.deep.equal({ roomName: ROOM, spawnId: "spawn1" });
    expect(commissions.some(c => c.kind === "harvest")).to.equal(true);
  });

  it("rung 3 - BIND: materialize keeps the LEGACY runtime corp id (live creeps stay attached)", () => {
    const { commissions } = planCommissions(world);
    const store: CorpStore = new Map();
    materializeCommissions(commissions, store);
    const corp = store.get("scout-W1N1")!.corp as ScoutCorp;
    expect(corp.id).to.equal("scout-W1N1-scout"); // what `new ScoutCorp("W1N1-scout", ...)` generated pre-port
    expect(corp.getSpawnId()).to.equal("spawn1");
  });

  it("rung 3 - EXECUTE: run() records intel for every visible room", () => {
    installHomeSpawn();
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    runCommissionedCorps(store, Game.time);
    const intel = (Memory as { roomIntel?: Record<string, { sourceCount: number }> }).roomIntel;
    expect(intel?.[ROOM]).to.not.equal(undefined);
    expect(intel![ROOM].sourceCount).to.equal(0); // mock room has no sources configured
  });

  it("rung 3 - EXECUTE: run() requests a scout via the injected SpawningCorp when a stale room exists", () => {
    installHomeSpawn();
    const calls: { role: string; corpId: string; budget: number }[] = [];
    const stub = {
      countPendingOrdersFrom: () => 0,
      executeSpawn: (role: string, corpId: string, budget: number) => {
        calls.push({ role, corpId, budget });
        return true;
      }
    } as unknown as SpawningCorp;
    setSpawningCorpResolver(id => (id === "spawn1" ? stub : undefined));

    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    runCommissionedCorps(store, Game.time); // W1N2 has no intel -> stale -> spawn
    expect(calls).to.have.length(1);
    expect(calls[0]).to.deep.include({ role: "scout", budget: 50 });

    runCommissionedCorps(store, Game.time + 1); // inside SCOUT_SPAWN_COOLDOWN
    expect(calls).to.have.length(1);
  });

  it("rung 3 - PERSIST: store round-trip preserves the corp's accumulated state", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("scout-W1N1")!.corp as ScoutCorp;
    corp.recordRevenue(42);
    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("scout-W1N1")!.corp as ScoutCorp;
    expect(back.id).to.equal(corp.id);
    expect(back.getSpawnId()).to.equal("spawn1");
    expect(back.balance).to.equal(42);
  });

  it("rung 4 - COMPOSE: scout coexists with another registered kind, ordered by runOrder", () => {
    const order: string[] = [];
    registerCorpKind({
      kind: "early",
      runOrder: 10,
      propose: () => [
        {
          corpId: "early-x",
          kind: "early",
          shape: "produce",
          consumes: { spawnPartsPerTick: 0 },
          produces: {},
          assignment: null
        }
      ],
      materialize: (c: { corpId: string }) => new ScoutCorp("x-scout", "spawn1", c.corpId),
      run: () => order.push("early"),
      serializeCorp: (c: ScoutCorp) => c.serialize(),
      deserializeCorp: (d: { id: string }) => new ScoutCorp("x-scout", "spawn1", d.id),
      body: () => []
    } as never);

    installHomeSpawn();
    const store: CorpStore = new Map();
    const { commissions } = planCommissions(world);
    expect(commissions.filter(c => c.kind === "scout" || c.kind === "early")).to.have.length(2);
    materializeCommissions(commissions, store);
    const realRun = scoutKind.run.bind(scoutKind);
    (scoutKind as { run: typeof scoutKind.run }).run = (c, t) => {
      order.push("scout");
      realRun(c, t);
    };
    try {
      runCommissionedCorps(store, Game.time);
    } finally {
      (scoutKind as { run: typeof scoutKind.run }).run = realRun;
    }
    expect(order).to.deep.equal(["early", "scout"]); // runOrder 10 before 40
  });
});

// Rung 1: the kind alone (worlds re-mocked per test - other suites clobber globals).
describe("scout kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(scoutKind as never, {
  problem: world,
  commission: {
    corpId: "scout-W1N1",
    kind: "scout",
    shape: "auxiliary",
    consumes: { spawnPartsPerTick: 0 },
    produces: { valuePerTick: 0 },
      assignment: { roomName: ROOM, spawnId: "spawn1" }
    },
    expectedSpawnPartsPerTick: 0
  });
});
