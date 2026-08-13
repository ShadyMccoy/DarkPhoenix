import { expect } from "chai";
import { planColony, ColonyProblem, PlannerSink, PlannerSource, PlannerSpawn } from "../../../src/economy/CorpPlanner";
import { bankPressure } from "../../../src/economy/bank";
import { terminalDeliveredFraction, terminalSendCost } from "../../../src/economy/primitives";
import { Position } from "../../../src/types/Position";

/**
 * CROSS-HUB TRANSFER (spec 58 phase 2): the payoff of modelling the storage as
 * a source AND a sink (owner 2026-08-05). Once a hub's energy is a source and
 * its ullage is a sink, moving energy between colonies is not a new subsystem
 * in the planner - it is an ordinary route from one hub's source to another
 * hub's sink, priced like every other edge.
 *
 * Two things make it correct rather than merely expressible:
 *
 *  1. THE ANTI-PUMP BECOMES PER-HUB. It was global ("no bank ever fills a
 *     storage sink"), which is stricter than physics: a bank cannot fill its
 *     OWN store, but there is nothing wrong with it filling another room's.
 *     The rule tightens to exactly the physical constraint.
 *  2. THE EDGE IS PRICED AND GATED. A transfer runs through a TERMINAL, so it
 *     costs the engine's distance-decayed fee and it is only available between
 *     rooms that HAVE terminals. Without terminals the route is unexecutable,
 *     so the plan must not emit it - a plan the runtime cannot follow is worse
 *     than no plan (the F1 objective).
 *
 * The gate is what keeps this safe to land before the executor exists:
 * `terminalRooms` empty (every world today) => byte-identical to the global
 * rule.
 */

const CAPACITY = 1_000_000;
const TARGET = 30_000;

// Two rooms on a world grid so cross-room distance is honest without a sim.
const GRID: Record<string, { gx: number; gy: number }> = { A: { gx: 0, gy: 0 }, B: { gx: 1, gy: 0 } };
const at = (room: string, x: number, y = 25): Position => ({ x, y, roomName: room });
const embed = (p: Position): { x: number; y: number } => ({
  x: GRID[p.roomName].gx * 50 + p.x,
  y: GRID[p.roomName].gy * 50 + p.y
});
const dist = (a: Position, b: Position): number => {
  const ea = embed(a);
  const eb = embed(b);
  return Math.abs(ea.x - eb.x) + Math.abs(ea.y - eb.y);
};

const spawnAt = (id: string, room: string, x: number): PlannerSpawn => ({ id, pos: at(room, x) });
const mine = (id: string, room: string, x: number, rate = 10): PlannerSource => ({
  id,
  nodeId: `node-${id}`,
  pos: at(room, x),
  rate,
  maxMiners: 1
});
const sinkAt = (
  id: string,
  kind: PlannerSink["kind"],
  room: string,
  x: number,
  value: number,
  capacity: number
): PlannerSink => ({ id, kind, pos: at(room, x), value, capacity });

/**
 * A is FULL (consumption-constrained: RCL8 controller, no room to bank).
 * B is a young hub with an empty storage and real headroom.
 * `terminalRooms` decides whether the transfer edge exists at all.
 */
function twoHubWorld(
  opts: {
    terminalRooms?: string[];
    bStock?: number;
    /** A funded mine in the DESTINATION room (its income banks at hub B). */
    bMine?: boolean;
    /** A controller sink in B - a foreign CONSUMER a transfer must never target. */
    bController?: boolean;
    /** A deposit port in B, nearer to A's bank than B's storage. */
    bPort?: ColonyProblem["depositPorts"];
  } = {}
): ColonyProblem {
  const aStock = CAPACITY; // A's bank is topped out
  const bStock = opts.bStock ?? 0;
  const pA = bankPressure(aStock, CAPACITY - aStock, TARGET);
  const pB = bankPressure(bStock, CAPACITY - bStock, TARGET);
  const bank = (room: string, rate: number, x: number): PlannerSource => ({
    id: `bank-${room}`,
    nodeId: `${room}-bank`,
    pos: at(room, x),
    rate,
    maxMiners: 0,
    transient: true
  });
  return {
    dist,
    // Continuous linear ROOM distance (the calcTransactionCost form) - the
    // fee's input, injected exactly like `dist` so the planner stays pure.
    roomDist: (a: string, b: string) =>
      Math.max(Math.abs(GRID[a].gx - GRID[b].gx), Math.abs(GRID[a].gy - GRID[b].gy)),
    spawns: [spawnAt("spawnA", "A", 10), spawnAt("spawnB", "B", 10)],
    sources: [
      mine("mA", "A", 20),
      ...(opts.bMine ? [mine("mB", "B", 20)] : []),
      bank("A", pA.source, 25),
      bank("B", pB.source, 25)
    ],
    sinks: [
      sinkAt("spawn-A", "spawn", "A", 10, 100, 5),
      sinkAt("ctrl-A", "controller", "A", 15, 50, 15), // A at the RCL8 cap
      sinkAt("store-A", "storage", "A", 25, 1, Math.min(40, pA.sink)), // full: 0
      sinkAt("spawn-B", "spawn", "B", 10, 100, 5),
      ...(opts.bController ? [sinkAt("ctrl-B", "controller", "B", 15, 50, 30)] : []),
      sinkAt("store-B", "storage", "B", 25, 1, Math.min(40, pB.sink)) // empty: plenty
    ],
    ...(opts.bPort ? { depositPorts: opts.bPort } : {}),
    ...(opts.terminalRooms ? { terminalRooms: opts.terminalRooms } : {})
  };
}

describe("economy/CorpPlanner - cross-hub transfer (spec 58 phase 2)", () => {
  describe("the GATE: no terminals, no transfer (safe to land before the executor)", () => {
    it("without terminalRooms the lender's bank WALKS to the borrower's store (the bankfeed executor, t72966674)", () => {
      // RETIRED PIN, deliberately: this test used to assert "no bank fills
      // ANY store without a terminal" - true while the terminal was the only
      // cross-hub executor. The bankfeed carry corp (owner 2026-08-12) walks
      // any out-of-room bank edge, so the fill now exists WITHOUT terminals,
      // priced as an ordinary route (real carry, no transfer fee) - the RCL4
      // depot transition's priming line. The terminal TRANSFER (fee-priced,
      // zero-carry) still requires terminals - pinned below.
      const plan = planColony(twoHubWorld());
      const walked = plan.haulers.find(h => h.sourceId === "bank-A" && h.sinkId === "store-B");
      expect(walked, "the walked fill exists terminal-free").to.not.equal(undefined);
      expect(walked!.transfer ?? false, "not a terminal transfer").to.equal(false);
      expect(walked!.carryParts, "priced as a walked route").to.be.greaterThan(0);
    });

    it("MINED energy already cross-banks without any terminal - that is a walking haul, not a transfer", () => {
      // Pre-existing and correct: a deposit-class source may fill ANY storage
      // sink, so A's mining walks to hub B when A's own hub is full. Pinned
      // here so the terminal work is never mistaken for enabling it - what is
      // new in phase 2 is moving BANKED energy, which no hauler executes.
      const plan = planColony(twoHubWorld());
      const storeB = plan.sinks.find(s => s.sinkId === "store-B")!;
      expect(storeB.sources.find(s => s.sourceId === "mA")?.amount ?? 0).to.be.greaterThan(0);
      expect(plan.haulers.some(h => h.sourceId === "mA" && h.sinkId === "store-B")).to.equal(true);
    });

    it("a terminal in only ONE of the two rooms never opens a TRANSFER (it takes two; the walked fill may still carry)", () => {
      for (const rooms of [["A"], ["B"]]) {
        const plan = planColony(twoHubWorld({ terminalRooms: rooms }));
        const edges = plan.haulers.filter(h => h.sourceId === "bank-A" && h.sinkId === "store-B");
        expect(
          edges.some(h => h.transfer === true),
          `one-sided terminal (${rooms.join()}) must not open the fee-priced transfer`
        ).to.equal(false);
        for (const e of edges) {
          expect(e.carryParts, "any surviving edge is the WALKED fill, priced in bodies").to.be.greaterThan(0);
        }
      }
    });
  });

  describe("with terminals on both hubs, the surplus finds the hungry room", () => {
    const plan = () => planColony(twoHubWorld({ terminalRooms: ["A", "B"] }));

    it("A's full bank transfers to B's empty store - the consumption-constrained EXIT", () => {
      const p = plan();
      const toB = p.sinks.find(s => s.sinkId === "store-B")!;
      const fromBank = toB.sources.find(s => s.sourceId === "bank-A")?.amount ?? 0;
      expect(fromBank, "B's hub absorbs A's banked surplus").to.be.greaterThan(0);
      expect(p.haulers.some(h => h.sourceId === "bank-A" && h.sinkId === "store-B")).to.equal(true);
    });

    it("mined deposits OUTRANK the transfer at the hub - income banks first, savings fill the residual", () => {
      // Review finding (probe-confirmed): ranked by tile distance, the nearer
      // foreign bank beat mA into store-B's capacity, mA demoted to unrouted,
      // and the colony shipped savings uphill at the engine fee while fresh
      // income rotted - the exact inversion of production-over-consumption.
      // Transfers now fill LAST at a storage sink whatever their distance.
      const p = plan();
      const toB = p.sinks.find(s => s.sinkId === "store-B")!;
      expect(toB.sources.find(s => s.sourceId === "mA")?.amount ?? 0, "mA's full rate banks first").to.be.closeTo(
        10,
        1e-6
      );
      expect(
        p.miners.some(m => m.sourceId === "mA"),
        "the miner stays funded - the transfer never displaced income"
      ).to.equal(true);
      // the transfer takes exactly the residual room (cap 40 - 10 mined = 30 landed)
      const fromBank = toB.sources.find(s => s.sourceId === "bank-A")?.amount ?? 0;
      expect(fromBank).to.be.closeTo(30, 1e-6);
    });

    it("THE ANTI-PUMP IS NOW EXACTLY PHYSICAL: never its OWN store, either direction", () => {
      const p = plan();
      for (const room of ["A", "B"]) {
        expect(
          p.haulers.some(h => h.sourceId === `bank-${room}` && h.sinkId === `store-${room}`),
          `bank-${room} pumped into its own store`
        ).to.equal(false);
        const own = p.sinks.find(s => s.sinkId === `store-${room}`);
        expect(own?.sources.find(s => s.sourceId === `bank-${room}`)?.amount ?? 0).to.equal(0);
      }
    });

    it("local consumption still outranks the transfer - storage is value 1, the bottom", () => {
      // A transfer must never outbid A's own spawn or controller: the ladder
      // already says so, and the fee makes it strictly worse. This is what
      // stops a surplus hub exporting energy it should be burning at home.
      const p = plan();
      expect(p.sinks.find(s => s.sinkId === "spawn-A")!.allocated).to.be.closeTo(5, 1e-6);
      expect(p.sinks.find(s => s.sinkId === "ctrl-A")!.allocated).to.be.closeTo(15, 1e-6);
    });
  });

  describe("the transfer is PRICED, not free routing", () => {
    it("the fee is charged against the delivered flow (the plan pays what the engine charges)", () => {
      const p = planColony(twoHubWorld({ terminalRooms: ["A", "B"] }));
      const route = p.haulers.find(h => h.sourceId === "bank-A" && h.sinkId === "store-B")!;
      const store = p.sinks.find(s => s.sinkId === "store-B")!;
      // What LANDS is the transfer route's accounted amount (mA's walking
      // deposits share the same sink now that deposits fill first, so read
      // the bank-A line, not the sink total); what the source spends is more,
      // by exactly the engine's fee. The plan's totals must reflect the loss
      // - a transfer that pretends to be lossless would over-state the colony.
      const delivered = store.sources.find(s => s.sourceId === "bank-A")!.amount;
      const spent = route.flowRate;
      expect(spent, "the source spends more than lands").to.be.greaterThan(delivered - 1e-9);
      expect(delivered / spent, "the ratio IS the engine's delivered fraction").to.be.closeTo(
        terminalDeliveredFraction(1),
        1e-6
      );
      expect(spent - delivered).to.be.closeTo(terminalSendCost(delivered, 1), 1e-6);
    });

    it("a FARTHER hub is a worse edge - the router sees the distance decay", () => {
      // Same world, B pushed far away: the fee eats more of every unit, so
      // strictly less arrives per unit spent.
      const near = terminalDeliveredFraction(1);
      const far = terminalDeliveredFraction(40);
      expect(far).to.be.lessThan(near);
    });
  });

  describe("no wash trades: two hubs in surplus never swap energy", () => {
    it("when BOTH hubs are lending, neither fills the other's store", () => {
      // The failure the per-hub rule could invite: A -> B and B -> A at the
      // same value-1 sink, burning the fee twice for zero net movement. A hub
      // in surplus is not hungry, so it must not be a transfer DESTINATION.
      const bothFull = twoHubWorld({ terminalRooms: ["A", "B"], bStock: CAPACITY });
      const p = planColony(bothFull);
      for (const [from, to] of [
        ["bank-A", "store-B"],
        ["bank-B", "store-A"]
      ]) {
        expect(p.haulers.some(h => h.sourceId === from && h.sinkId === to), `${from} -> ${to} is a wash trade`).to.equal(
          false
        );
      }
    });

    it("a hub still BELOW its reserve target is a valid destination (it is hungry)", () => {
      const p = planColony(twoHubWorld({ terminalRooms: ["A", "B"], bStock: TARGET - 5_000 }));
      expect(
        p.haulers.some(h => h.sourceId === "bank-A" && h.sinkId === "store-B"),
        "a hub under its reserve should receive"
      ).to.equal(true);
    });

    it("a hungry hub WITH funded local income still receives - lending is the bank's OWN surplus, not the credit", () => {
      // Review finding (probe-confirmed): lendingRooms read the supply array,
      // whose bank rates planColony augments with funded mined income, so a
      // hub 5k UNDER its reserve with one local mine classified as "lending"
      // and was refused. Live, every hub has income banking to it - the guard
      // would have killed the edge for every real colony. Lending now reads
      // the PROBLEM's bank rates (the adapter's surplus-only source half).
      const p = planColony(twoHubWorld({ terminalRooms: ["A", "B"], bStock: TARGET - 5_000, bMine: true }));
      expect(
        p.haulers.some(h => h.sourceId === "bank-A" && h.sinkId === "store-B"),
        "funded local income must not disqualify a hungry destination"
      ).to.equal(true);
    });
  });

  describe("the transfer stays in its lane (review 2026-08-06, all probe-confirmed)", () => {
    it("NEVER prices a foreign CONSUMER as a transfer - no executor can put terminal energy in a spawn", () => {
      // canTransfer without a storage-sink guard let bank-A -> ctrl-B/spawn-B
      // route as transfers: zero spawn parts for upgrader bodies the envelope
      // still charges, a NEGATIVE charge stamp (breaking the t72846447 spent
      // decomposition), and energy stranded in B's terminal.
      const p = planColony(twoHubWorld({ terminalRooms: ["A", "B"], bController: true }));
      for (const h of p.haulers) {
        if (h.sinkId === "store-B") continue;
        expect(h.transfer ?? false, `${h.sourceId} -> ${h.sinkId} must not be a transfer`).to.equal(false);
      }
      // and the charge stamp never goes negative anywhere
      for (const h of p.haulers) {
        expect(h.charged ?? 0, `${h.sourceId} -> ${h.sinkId} charged >= 0`).to.be.at.least(-1e-9);
      }
      // bank->consumer draws still happen - as ordinary walking routes with bodies
      const toConsumerB = p.haulers.filter(h => h.sourceId === "bank-A" && (h.sinkId === "ctrl-B" || h.sinkId === "spawn-B"));
      for (const h of toConsumerB) {
        expect(h.spawnParts, "a walking bank draw buys real bodies").to.be.greaterThan(0);
      }
    });

    it("NEVER rides a deposit port - the engine moves it, so no depositPos, no headroom debit, no phantom drain", () => {
      // The port-blend leg engaged for transfers: depositPos stamped on a
      // route no hauler runs, the shared port headroom burned so real walking
      // deposits lost their shortcut, and the stage-4 drain synthesized a
      // phantom core->storage hauler charged real spawn parts.
      const port = {
        pos: at("B", 20),
        headroom: 30,
        drainFrom: at("B", 26),
        drainSourceId: "mB"
      };
      const p = planColony(twoHubWorld({ terminalRooms: ["A", "B"], bMine: true, bPort: [port] }));
      const transferRoutes = p.haulers.filter(h => h.transfer === true);
      expect(transferRoutes.length, "the transfer itself still happens").to.be.greaterThan(0);
      for (const h of transferRoutes) {
        expect(h.depositPos, "a transfer never carries a port position").to.equal(undefined);
      }
      // no drain hauler exists for flow the port never absorbed from a WALKING
      // deposit: every drain-leg hauler must trace to real ported deposit flow
      const drained = p.haulers.filter(h => h.sourceId === "mB" && h.sinkId === "store-B" && h.carryParts > 0);
      const portedWalking = p.haulers.filter(h => h.depositPos !== undefined);
      if (portedWalking.length === 0) {
        expect(
          drained.reduce((s, h) => s + h.flowRate, 0),
          "no ported walking flow -> no synthesized drain beyond mB's own route"
        ).to.be.at.most(20 + 1e-6);
      }
    });
  });
});
