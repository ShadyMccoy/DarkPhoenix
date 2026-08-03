/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";

/**
 * Spec 39 phase 2: the FIELDED fleet per commission - the per-post actuals
 * the adapter carries into ColonyProblem so the plan can incorporate what is
 * already walking around (owner 2026-07-31: "Incorporate the actual into the
 * plan... a single consistent framework"). The assembler is host-owned (it
 * joins Game.creeps against the commission STORE - the runtime-id -> commission
 * -id mapping only the store has) and returns plan-space data: per commission
 * corpId, per ROLE (workType inverted through the kind's own roles table),
 * count + parts + ascending TTLs. Spawning creeps count full life; creeps
 * whose corpId no store entry claims are NOT fleet (they are X3's orphans).
 * Inner-squad creeps stamp the OPERATION's id (HarvestCorp.setHaulRoutes:
 * customId = this.id), so an operation's vector rides its commission entry
 * with no special casing.
 */
describe("assembleFieldedFleets (spec 39 phase 2: the actuals the plan receives)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    g.Memory = {};
    g.Game = { time: 100, creeps: {}, spawns: {}, rooms: {}, getObjectById: () => null };
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  const creep = (corpId: string, workType: string, parts: number, ttl?: number): any => ({
    body: Array.from({ length: parts }, () => ({ type: "move" })),
    ticksToLive: ttl,
    memory: { corpId, workType }
  });

  async function rigStoreAndAssemble(creeps: Record<string, any>): Promise<Record<string, any>> {
    const { assembleFieldedFleets } = (await import("../../../src/execution/CommissionHost")) as any;
    const { resetCorpKinds, registerCorpKind, getCorpKind } = await import("../../../src/economy/CorpKind");
    const { harvestKind } = await import("../../../src/corps/kinds/harvestKind");
    const { upgradeKind } = await import("../../../src/corps/kinds/upgradeKind");
    resetCorpKinds();
    if (!getCorpKind("harvest")) registerCorpKind(harvestKind as never);
    if (!getCorpKind("upgrade")) registerCorpKind(upgradeKind as never);
    // A harvest operation commissioned as "harvest-source-a" whose RUNTIME
    // corp id is the legacy Game-derived "mining-W1N1-harvest-aaaa" (the id
    // creeps stamp), plus an upgrade corp with matching ids. The store is
    // INJECTED (house DI style - DemobilizePredicate, CorpRunMeter); live
    // callers pass nothing and get the module store.
    const store = new Map<string, any>([
      [
        "harvest-source-a",
        { kind: "harvest", corp: { id: "mining-W1N1-harvest-aaaa" }, commission: { corpId: "harvest-source-a" } }
      ],
      ["upgrade-ctrl-1", { kind: "upgrade", corp: { id: "upgrading-W1N1" }, commission: { corpId: "upgrade-ctrl-1" } }]
    ]);
    g.Game.creeps = creeps;
    return assembleFieldedFleets(store);
  }

  it("joins creeps to commissions via the store and inverts workType -> role through the kind's table", async () => {
    const fielded = await rigStoreAndAssemble({
      m1: creep("mining-W1N1-harvest-aaaa", "harvest", 8, 900),
      m2: creep("mining-W1N1-harvest-aaaa", "harvest", 5, 300),
      h1: creep("mining-W1N1-harvest-aaaa", "haul", 12, 1200),
      u1: creep("upgrading-W1N1", "upgrade", 9, 50)
    });

    expect(Object.keys(fielded).sort()).to.deep.equal(["harvest-source-a", "upgrade-ctrl-1"]);
    // The operation's two miner bodies under the kind's "miner" role key...
    expect(fielded["harvest-source-a"].miner).to.deep.equal({ count: 2, parts: 13, ttls: [300, 900] });
    // ...and its vector squad under "hauler" (workType "haul" inverted).
    expect(fielded["harvest-source-a"].hauler).to.deep.equal({ count: 1, parts: 12, ttls: [1200] });
    expect(fielded["upgrade-ctrl-1"].upgrader).to.deep.equal({ count: 1, parts: 9, ttls: [50] });
  });

  it("a spawning creep (no ticksToLive yet) counts at FULL life - it is fleet, not a gap", async () => {
    const fielded = await rigStoreAndAssemble({
      m1: creep("mining-W1N1-harvest-aaaa", "harvest", 8, undefined)
    });
    expect(fielded["harvest-source-a"].miner.ttls).to.deep.equal([1500]);
  });

  it("creeps no store entry claims are NOT fleet (orphans belong to X3, not the plan)", async () => {
    const fielded = await rigStoreAndAssemble({
      ghost: creep("ghost-corp", "haul", 6, 500)
    });
    expect(fielded).to.deep.equal({});
  });

  it("a commission with NO live creeps is absent - the plan reads absence, never a fabricated zero row", async () => {
    const fielded = await rigStoreAndAssemble({
      u1: creep("upgrading-W1N1", "upgrade", 9, 50)
    });
    expect(fielded["harvest-source-a"]).to.equal(undefined);
    expect(fielded["upgrade-ctrl-1"]).to.not.equal(undefined);
  });

  it("a workType the kind does not declare buckets under the raw workType - measured, visible, never dropped", async () => {
    const fielded = await rigStoreAndAssemble({
      odd: creep("mining-W1N1-harvest-aaaa", "tank", 4, 700)
    });
    expect(fielded["harvest-source-a"].tank).to.deep.equal({ count: 1, parts: 4, ttls: [700] });
  });

  /** The adapter seam: the assembled actuals ride ColonyProblem verbatim. */
  it("buildColonyProblem carries the fielded map onto the problem (absent stays absent)", async () => {
    const { FlowGraph, buildColonyProblem } = await import("../../../src/economy/flowAdapter");
    const { createNode } = await import("../../../src/nodes/Node");
    const at = (x: number) => ({ x, y: 25, roomName: "W0N0" });
    const home = createNode("home", "W0N0", at(5) as any, 100, ["W0N0"], 0);
    home.resources = [
      { type: "spawn", id: "spawn-0", position: at(5) },
      { type: "controller", id: "ctrl-0", position: at(5), isOwned: true } as any
    ];
    const src = createNode("s1", "W0N0", at(15) as any, 50, ["W0N0"], 0);
    src.resources = [{ type: "source", id: "s1", position: at(15), capacity: 3000 } as any];
    const graph = new FlowGraph([home, src]);
    const dist = (a: any, b: any): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

    const fielded = { "harvest-s1": { miner: { count: 1, parts: 8, ttls: [900] } } };
    const withActuals = buildColonyProblem(
      graph, dist, [], new Map(), new Map(), [], 0, undefined, undefined, [], 0, undefined, fielded
    );
    expect(withActuals.fielded, "the actuals ride the problem verbatim").to.deep.equal(fielded);

    const without = buildColonyProblem(graph, dist, [], new Map(), new Map(), [], 0, undefined, undefined, [], 0, undefined);
    expect(without.fielded, "no actuals passed -> no field").to.equal(undefined);
  });
});
