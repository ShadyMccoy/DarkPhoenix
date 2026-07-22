/**
 * THE ORGANISM SCENARIO (owner 2026-07-20, expansion prep on the back
 * burner): room A (mature, storage hub, remote sources in each of N/E/S/W)
 * founds room B to its SOUTH-WEST. Nothing is hardcoded to rooms - the test
 * exercises the ALGORITHMS:
 *
 *  1. TRIVIAL: A funds B's founding build (the founding sink outvalues A's
 *     own consumers under the foundRoom goal - "an artificial boost, it
 *     doesn't matter for now exactly how it's weighed").
 *  2. THE UNIQUE PART: the S and W remotes - the ones NEAR B - keep their
 *     miners, and their output flows toward B; N and E keep feeding A.
 *     Once B's spawn STANDS, S/W miners re-home to it (nearest-spawn).
 *
 * PURE PLANNER TEST, fast to iterate: rooms are embedded on a world grid
 * (A at (0,0), N=(0,1), E=(1,0), S=(0,-1), W=(-1,0), B=(-1,-1)) and dist is
 * manhattan over the embedding, so cross-room distances are honest without
 * a sim. Aspirational seams are staged as it.skip with exact assertions -
 * un-skip each as the planner learns the behavior:
 *
 *  - DIRECT founding deposits: hub-and-spoke currently declares deposits
 *    GLOBALLY (any storage anywhere makes ALL mined bank-only), so S/W
 *    mined must round-trip through A's hub before the bank draw walks to
 *    B. The organism wants mined near a founding routed THERE directly.
 */

import { expect } from "chai";
import { ColonyProblem, planColony } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";
import { compileGoal } from "../../../src/economy/goals";
import { projectAbsorbRate } from "../../../src/economy/primitives";

/** Rooms on a world grid; a position embeds to world tiles for dist. */
const GRID: { [room: string]: { gx: number; gy: number } } = {
  A: { gx: 0, gy: 0 },
  N: { gx: 0, gy: 1 },
  E: { gx: 1, gy: 0 },
  S: { gx: 0, gy: -1 },
  W: { gx: -1, gy: 0 },
  B: { gx: -1, gy: -1 }
};
const at = (room: string, x: number, y: number): Position => ({ x, y, roomName: room });
const embed = (p: Position): { x: number; y: number } => ({
  x: GRID[p.roomName].gx * 50 + p.x,
  y: GRID[p.roomName].gy * 50 + p.y
});
const dist = (a: Position, b: Position): number => {
  const ea = embed(a);
  const eb = embed(b);
  return Math.abs(ea.x - eb.x) + Math.abs(ea.y - eb.y);
};

/** The foundRoom goal is the owner's "value building this spawn higher". */
const V = compileGoal({ blend: { foundRoom: 1 } });

/** The founding build: a spawn site, 15000 to go, in B's center. */
const FOUNDING_REMAINING = 15_000;

/**
 * The world, pre- or post- B's spawn standing. Sources sit toward the side
 * of their room that faces their natural spawn (S and W lean toward B), so
 * nearest-spawn assignment is decided by geometry, not by naming.
 */
function organismWorld(bSpawnStands: boolean): ColonyProblem {
  const foundingPos = at("B", 25, 25);
  const spawns = [
    { id: "spawnA", pos: at("A", 25, 25) },
    ...(bSpawnStands ? [{ id: "spawnB", pos: foundingPos }] : [])
  ];
  const bTravel = dist(at("A", 25, 25), foundingPos);
  return {
    spawns,
    sources: [
      // A's own two home sources
      { id: "srcA1", nodeId: "nA1", pos: at("A", 10, 20), rate: 10, maxMiners: 1 },
      { id: "srcA2", nodeId: "nA2", pos: at("A", 40, 30), rate: 10, maxMiners: 1 },
      // one remote per direction; S and W lean toward B's corner
      { id: "srcN", nodeId: "nN", pos: at("N", 25, 20), rate: 10, maxMiners: 1 },
      { id: "srcE", nodeId: "nE", pos: at("E", 20, 25), rate: 10, maxMiners: 1 },
      { id: "srcS", nodeId: "nS", pos: at("S", 12, 20), rate: 10, maxMiners: 1 },
      { id: "srcW", nodeId: "nW", pos: at("W", 20, 12), rate: 10, maxMiners: 1 },
      // A is RICH (the owner's premise): a surplus bank at its hub
      { id: "bank-A", nodeId: "A-bank", pos: at("A", 24, 25), rate: 100, maxMiners: 0, transient: true }
    ],
    sinks: [
      { id: "spawn-A", kind: "spawn", pos: at("A", 25, 25), value: V.spawn, capacity: 10 },
      // A's controller is late-game (RCL8-ish): the LOW end of the band -
      // the artificial boost is simply that founding outvalues it
      { id: "ctrl-A", kind: "controller", pos: at("A", 40, 10), value: V.controllerMin, capacity: 60, reserve: 2 },
      { id: "store-A", kind: "storage", pos: at("A", 24, 25), value: V.storage, capacity: 1000 },
      // THE FOUNDING: B's new-spawn site, priced at the newSpawnSite anchor,
      // absorbing what a travel-aware crew can actually build
      {
        id: "founding-B",
        kind: "construction",
        pos: foundingPos,
        value: V.newSpawnSite,
        capacity: projectAbsorbRate(FOUNDING_REMAINING, bTravel)
      }
    ],
    dist
  };
}

const routesOf = (plan: ReturnType<typeof planColony>, sourceId: string): string[] =>
  plan.haulers.filter(h => h.sourceId === sourceId).map(h => h.sinkId);

describe("the organism scenario: founding B pulls the west economy (owner 2026-07-20)", () => {
  describe("phase 1 - B is a construction site (no spawn of its own)", () => {
    const plan = planColony(organismWorld(false));

    it("A funds the founding: the B site is allocated at its full absorb rate (the trivial part)", () => {
      const founding = plan.sinks.find(s => s.sinkId === "founding-B")!;
      expect(founding.allocated, "the founding outvalues A's own consumers").to.be.closeTo(
        founding.demand,
        1e-6
      );
      // and A's late-game controller gets only what remains after the founding
      const ctrl = plan.sinks.find(s => s.sinkId === "ctrl-A")!;
      expect(founding.value).to.be.greaterThan(ctrl.value);
    });

    it("every direction keeps its miner: N, E, S, W all stay funded while founding", () => {
      const funded = new Set(plan.miners.map(m => m.sourceId));
      for (const id of ["srcN", "srcE", "srcS", "srcW"]) {
        expect(funded.has(id), `${id} keeps producing during the founding`).to.equal(true);
      }
    });

    it("all miners stage from spawnA (B has no spawn yet)", () => {
      for (const m of plan.miners) expect(m.spawnId).to.equal("spawnA");
    });

    // ASPIRATIONAL (the planner seam this scenario exists to iterate on):
    // hub-and-spoke declares deposits GLOBALLY, so S/W mined must bank at
    // A's hub and the founding draws the bank - energy physically walks
    // S -> A -> B instead of S -> B. The organism wants the mined output
    // NEAR the founding routed there directly when the founding outvalues
    // banking. Un-skip when the deposit role becomes founding-aware.
    it.skip("S and W output routes DIRECTLY to the founding (not through A's hub)", () => {
      expect(routesOf(plan, "srcS"), "S ships to B").to.include("founding-B");
      expect(routesOf(plan, "srcW"), "W ships to B").to.include("founding-B");
      // while the far-side remotes keep banking at home
      expect(routesOf(plan, "srcN")).to.deep.equal(["store-A"]);
      expect(routesOf(plan, "srcE")).to.deep.equal(["store-A"]);
    });
  });

  describe("phase 2 - B's spawn stands: the west economy re-homes", () => {
    const plan = planColony(organismWorld(true));

    it("S and W miners re-home to spawnB by geometry alone (nearest spawn, nothing hardcoded)", () => {
      const bySource = new Map(plan.miners.map(m => [m.sourceId, m.spawnId]));
      expect(bySource.get("srcS"), "S is nearer B").to.equal("spawnB");
      expect(bySource.get("srcW"), "W is nearer B").to.equal("spawnB");
      expect(bySource.get("srcN"), "N stays with A").to.equal("spawnA");
      expect(bySource.get("srcE"), "E stays with A").to.equal("spawnA");
      expect(bySource.get("srcA1"), "A's home sources stay home").to.equal("spawnA");
    });

    // ASPIRATIONAL: B has no storage yet, and the GLOBAL deposit rule sends
    // even B-homed mining back to A's hub. The organism wants B's economy
    // self-contained the moment its spawn stands: S/W output lands in B
    // (its founding build, then its own consumers). Un-skip with the same
    // founding-aware deposit seam as phase 1.
    it.skip("S and W output lands in B once its spawn stands", () => {
      for (const id of ["srcS", "srcW"]) {
        const sinks = routesOf(plan, id);
        expect(
          sinks.every(s => s === "founding-B" || s.endsWith("-B")),
          `${id} feeds B, not A's hub (got ${sinks.join(",")})`
        ).to.equal(true);
      }
    });
  });

  /**
   * THE SPAWN ANNEX (owner 2026-07-20): "A lot of times we run into spawn
   * shortage. We could use more energy but we can't spawn enough. The
   * colony could claim a room next door and build a spawn and extensions
   * there. The room itself might have no good energy supply. We don't
   * necessarily need to mine there. It's just extra spawn capacity."
   *
   * The fixture makes A parts-BOUND: heavy standing infra + far remotes,
   * so with one spawn the ledger cannot route every profitable source (the
   * live 'unrouted' demotion - the demand curve for spawn time). The annex
   * room X (due west, NO sources of its own) then stands a bare spawn. The
   * parts ledger scales with spawn count, so the SAME world with the annex
   * must fund and ROUTE more mining - the annex converts to income without
   * mining a single tile of its own room - and the annex spawn's refill is
   * financed from A's bank like any consumer (energy walks to the annex).
   */
  describe("phase 3 - the spawn annex: an empty room's spawn converts to routed income", () => {
    function annexWorld(annexStands: boolean): ColonyProblem {
      const spawns = [
        { id: "spawnA", pos: at("A", 25, 25) },
        ...(annexStands ? [{ id: "spawnX", pos: at("W", 40, 25) }] : [])
      ];
      return {
        spawns,
        sources: [
          { id: "srcA1", nodeId: "nA1", pos: at("A", 10, 20), rate: 10, maxMiners: 1 },
          // FAR remotes: expensive haul routes - the parts pressure
          { id: "srcN", nodeId: "nN", pos: at("N", 25, 5), rate: 10, maxMiners: 1 },
          { id: "srcE", nodeId: "nE", pos: at("E", 45, 25), rate: 10, maxMiners: 1 },
          { id: "srcS", nodeId: "nS", pos: at("S", 25, 45), rate: 10, maxMiners: 1 },
          { id: "srcW", nodeId: "nW", pos: at("W", 5, 25), rate: 10, maxMiners: 1 },
          { id: "bank-A", nodeId: "A-bank", pos: at("A", 24, 25), rate: 60, maxMiners: 0, transient: true }
        ],
        sinks: [
          { id: "spawn-A", kind: "spawn", pos: at("A", 25, 25), value: V.spawn, capacity: 10 },
          ...(annexStands
            ? [{ id: "spawn-X", kind: "spawn" as const, pos: at("W", 40, 25), value: V.spawn, capacity: 6 }]
            : []),
          { id: "ctrl-A", kind: "controller", pos: at("A", 40, 10), value: V.controllerMin, capacity: 60, reserve: 2 },
          { id: "store-A", kind: "storage", pos: at("A", 24, 25), value: V.storage, capacity: 1000 }
        ],
        // Heavy standing infra (feeder/tenders/reservers of a mature room):
        // with ONE spawn this leaves too few parts to route every remote.
        infraPartsPerTick: 0.22,
        dist
      };
    }

    const routedRate = (plan: ReturnType<typeof planColony>): number =>
      plan.haulers.filter(h => !h.sourceId.startsWith("bank-")).reduce((s, h) => s + h.flowRate, 0);

    it("parts-bound with one spawn: profitable mining goes unrouted (the shortage, made visible)", () => {
      const plan = planColony(annexWorld(false));
      const unrouted = plan.sourceVerdicts.filter(v => v.verdict === "unrouted" || v.verdict === "over-budget");
      expect(unrouted.length, "the single-spawn ledger cannot carry every profitable source").to.be.greaterThan(0);
    });

    it("the annex spawn converts to ROUTED income without mining its own room", () => {
      const without = planColony(annexWorld(false));
      const withAnnex = planColony(annexWorld(true));
      expect(routedRate(withAnnex), "more mined e/t actually moves").to.be.greaterThan(routedRate(without));
      expect(withAnnex.miners.length, "more sources staffed").to.be.greaterThan(without.miners.length);
      // the annex itself mines nothing - it has no sources; its value is the ledger
      expect(withAnnex.partsLedger.capacity).to.be.closeTo(without.partsLedger.capacity * 2, 1e-9);
    });

    it("energy walks to the annex: its spawn refill is financed from A's economy", () => {
      const withAnnex = planColony(annexWorld(true));
      const annexSink = withAnnex.sinks.find(s => s.sinkId === "spawn-X")!;
      expect(annexSink.allocated, "the annex spawn is fed").to.be.greaterThan(0);
      expect(
        annexSink.sources.every(s => s.sourceId === "bank-A"),
        "fed from the hub, like any consumer"
      ).to.equal(true);
    });
  });
});
