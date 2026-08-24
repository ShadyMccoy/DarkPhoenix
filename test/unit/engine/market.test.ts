import { assert } from "chai";
import { ChainCandidate, ChainStage, MarketInput, SinkChain, StageOption, clear } from "../../../src/engine/market";
import { Offer, Step } from "../../../src/engine/vocabulary";

/**
 * The clearing core certified with SYNTHETIC kinds: made-up schedules, no
 * Screeps economics. Whether the real quotes are right is the sizing and
 * quote suites' job — here we prove the market itself clears correctly:
 * end-to-end increments, order-book stages, merit order, every frontier
 * reason, the position book, determinism.
 */

function step(cap: number, o: { upkeep?: number; fee?: number; spawn?: number; upfront?: number; backedBy?: string } = {}): Step {
  return {
    backedBy: o.backedBy,
    body: o.backedBy ? undefined : { work: 0, carry: 1, move: 1 },
    provides: { energyAt: { bank: cap } },
    requires: {},
    cost: { upfront: o.upfront ?? 0, upkeepEt: o.upkeep ?? 0, feeEt: o.fee, spawnTimeEt: o.spawn ?? 0 }
  };
}

function stage(offer: Offer, caps: number[]): ChainStage {
  return { options: caps.map((capacity, i) => ({ offer, step: i, capacity })) };
}

function chain(id: string, sourceId: string, caps: number[], steps: Step[]): ChainCandidate {
  const offer: Offer = { id, kind: "mine", steps };
  return { id, sourceId, stages: [stage(offer, caps)] };
}

function input(over: Partial<MarketInput> = {}): MarketInput {
  return {
    tick: 1,
    bank: "bank",
    chains: [],
    sinks: [],
    spawnCapacity: 1 / 3,
    bankStock: 10000,
    sourceCaps: { s1: 10, s2: 10 },
    ...over
  };
}

describe("engine/market", () => {
  it("zips multi-stage chains into end-to-end increments", () => {
    const mine: Offer = { id: "m", kind: "mine", steps: [step(10, { upkeep: 0.4, upfront: 500 })] };
    const haul: Offer = {
      id: "h",
      kind: "haul",
      steps: [step(5, { upkeep: 0.3, upfront: 300 }), step(5, { upkeep: 0.3, upfront: 300 })]
    };
    const plan = clear(
      input({
        chains: [{ id: "chain:s1", sourceId: "s1", stages: [stage(mine, [10]), stage(haul, [5, 5])] }]
      })
    );
    assert.closeTo(plan.expected.deliveredEt, 10, 1e-9);
    const targets = new Map(plan.corps.map(c => [c.id, c.target]));
    assert.equal(targets.get("m"), 1);
    assert.equal(targets.get("h"), 2);
  });

  it("a stage is an order book: options from rival offers fund cheapest-first", () => {
    const mine: Offer = { id: "m", kind: "mine", steps: [step(10, { upkeep: 0.4 })] };
    const dear: Offer = { id: "t:dear", kind: "haul", steps: [step(6, { upkeep: 0.9 }), step(6, { upkeep: 0.9 })] };
    const cheap: Offer = { id: "t:cheap", kind: "link", steps: [step(6, { fee: 0.2 })] };
    // The broker's sort put the cheap option first; the zipper consumes in
    // that order, so the dear rival covers only the remainder.
    const book: StageOption[] = [
      { offer: cheap, step: 0, capacity: 6 },
      { offer: dear, step: 0, capacity: 6 },
      { offer: dear, step: 1, capacity: 6 }
    ];
    const plan = clear(
      input({ chains: [{ id: "chain:s1", sourceId: "s1", stages: [stage(mine, [10]), { options: book }] }] })
    );
    const byId = new Map(plan.corps.map(c => [c.id, c]));
    assert.equal(byId.get("t:cheap")?.target, 1, "the cheaper kind wins the edge first");
    assert.equal(byId.get("t:dear")?.target, 1, "the rival covers only the remainder");
    // Allocation follows book order: the winner runs full, the rival trims.
    assert.closeTo(byId.get("t:cheap")?.pnl.grossEt ?? 0, 6, 1e-9);
    assert.closeTo(byId.get("t:dear")?.pnl.grossEt ?? 0, 4, 1e-9);
    assert.closeTo(plan.expected.feesEt, 0.2, 1e-9, "the winner's fee is on the books");
  });

  it("funds in merit order and prints the spawn-capacity frontier", () => {
    const rich = chain("chain:rich", "s1", [8], [step(8, { upkeep: 0.2, spawn: 0.01 })]);
    const poor = chain("chain:poor", "s2", [8], [step(8, { upkeep: 4, spawn: 0.01 })]);
    const plan = clear(input({ chains: [poor, rich], spawnCapacity: 0.01 }));
    assert.deepEqual(
      plan.corps.map(c => c.id),
      ["chain:rich"]
    );
    const line = plan.frontier.find(f => f.offerId === "chain:poor");
    assert.equal(line?.reason, "spawn capacity");
  });

  it("closes unprofitable increments with net<0", () => {
    const plan = clear(input({ chains: [chain("chain:waste", "s1", [2], [step(2, { upkeep: 5 })])] }));
    assert.lengthOf(plan.corps, 0);
    assert.equal(plan.frontier[0]?.reason, "net<0");
  });

  it("applies the ramp-solvency filter only while nothing stands", () => {
    const dear = chain("chain:dear", "s1", [10], [step(10, { upkeep: 0.5, upfront: 550 })]);
    const cheap = chain("chain:cheap", "s2", [2], [step(2, { upkeep: 0.2, upfront: 250 })]);
    const cold = clear(input({ chains: [dear, cheap], bankStock: 300 }));
    assert.deepEqual(
      cold.corps.map(c => c.id),
      ["chain:cheap"],
      "the affordable root funds; the two-body chain cannot close"
    );
    assert.equal(cold.frontier.find(f => f.offerId === "chain:dear")?.reason, "ramp insolvent");

    const standing = chain("chain:alive", "s2", [1], [step(1, { backedBy: "creepA" })]);
    const warm = clear(input({ chains: [dear, cheap, standing], bankStock: 300 }));
    assert.include(
      warm.corps.map(c => c.id),
      "chain:dear",
      "with standing income the dear chain accumulates toward its ramp"
    );
  });

  it("shares a source: standing capital holds it, the challenger trims in, the loser reads outcompeted", () => {
    const incumbent = chain("chain:old", "s1", [6, 2], [step(6, { backedBy: "old1" }), step(2, { upkeep: 0.2 })]);
    const challenger = chain("chain:new", "s1", [10], [step(10, { upkeep: 0.5 })]);
    const plan = clear(input({ chains: [incumbent, challenger] }));
    assert.closeTo(plan.expected.deliveredEt, 10, 1e-9, "the regen cap binds the total");
    const old = plan.corps.find(c => c.id === "chain:old");
    assert.equal(old?.backed, 1, "the living body kept its funding");
    assert.include(plan.corps.map(c => c.id), "chain:new", "the challenger funds the trimmed remainder");
    const line = plan.frontier.find(f => f.offerId === "chain:old");
    assert.equal(line?.reason, "outcompeted", "the incumbent's NEW step lost the residual capacity");
  });

  it("draws sinks from the residual and keeps the books conserved", () => {
    const prod = chain("chain:p", "s1", [10], [step(10, { upkeep: 1 })]);
    const sinkSteps: Step[] = [0, 1, 2].map(() => ({
      body: { work: 2, carry: 1, move: 1 },
      provides: { controlPoints: 4 },
      requires: { energyAt: { bank: 4 } },
      cost: { upfront: 300, upkeepEt: 0.2, spawnTimeEt: 0.003 }
    }));
    const up: Offer = { id: "up", kind: "upgrade", steps: sinkSteps };
    const sinks: SinkChain[] = [{ stages: [stage(up, [4, 4, 4])] }];
    const plan = clear(input({ chains: [prod], sinks }));
    // Two full 4.2 e/t draws, then the third funds PARTIALLY at the 0.4
    // left — the sink drains the residual exactly (nothing stranded).
    assert.equal(plan.corps.find(c => c.id === "up")?.target, 3);
    assert.equal(plan.frontier.find(f => f.offerId === "up")?.reason, "energy residual");
    assert.closeTo(plan.expected.upgradeEt, 8.4, 1e-9);
    const bills = plan.corps.reduce((s, c) => s + c.pnl.costEt, 0);
    assert.closeTo(plan.expected.refillEt + plan.expected.feesEt, bills, 1e-9);
    const leftover = plan.expected.deliveredEt - plan.expected.refillEt - plan.expected.feesEt - plan.expected.upgradeEt;
    assert.isAtLeast(leftover, -1e-9);
  });

  it("charges the standing fleet's sustain stream against the residual — sunk quotes never let the controller drink owed bills", () => {
    // A fully-backed producer quotes zero bills (sunk), but the bank
    // still owes its replacement stream continuously (standingBills).
    // Before the fix the residual read 10 e/t and the sink drank it all,
    // draining the bank at exactly standingBills until pinned.
    const backedProd = chain("chain:p", "s1", [10], [step(10, { backedBy: "m1" })]);
    const sinkSteps: Step[] = [0, 1, 2, 3, 4].map(() => ({
      body: { work: 2, carry: 1, move: 1 },
      provides: { controlPoints: 2 },
      requires: { energyAt: { bank: 2 } },
      cost: { upfront: 300, upkeepEt: 0.2, spawnTimeEt: 0.003 }
    }));
    const up: Offer = { id: "up", kind: "upgrade", steps: sinkSteps };
    const plan = clear(input({ chains: [backedProd], sinks: [{ stages: [stage(up, [2, 2, 2, 2, 2])] }], standingBills: 3.2 }));
    // Residual 10 − 3.2 = 6.8: three 2.2 e/t draws fit, the fourth prints.
    assert.closeTo(plan.expected.upgradeEt, 6, 1e-9);
    assert.equal(plan.frontier.find(f => f.offerId === "up")?.reason, "energy residual");
  });

  it("seeds machine time with the LIVE fleet's sustain draw — the spawn constraint holds across replans", () => {
    // Backed steps quote sunk spawnTimeEt, so without the seed each
    // replan saw a free spawn and funded more without bound.
    const fresh = chain("chain:new", "s1", [8], [step(8, { upkeep: 0.2, spawn: 0.2 })]);
    const unconstrained = clear(input({ chains: [fresh], spawnCapacity: 1 / 3 }));
    assert.lengthOf(unconstrained.corps, 1, "headroom: the chain funds");
    const seeded = clear(input({ chains: [fresh], spawnCapacity: 1 / 3, standingSpawnEt: 0.3 }));
    assert.lengthOf(seeded.corps, 0, "the live fleet already owns the machine");
    assert.equal(seeded.frontier.find(f => f.offerId === "chain:new")?.reason, "spawn capacity");
  });

  it("reports the standing fleet's operating fees — the wire's tax reaches the cash reader", () => {
    const wired = chain("chain:w", "s1", [10], [step(10, { backedBy: "pair", fee: 0.3 })]);
    const plan = clear(input({ chains: [wired] }));
    assert.closeTo(plan.expected.standingEt, 10, 1e-9);
    assert.closeTo(plan.expected.standingFeesEt, 0.3, 1e-9, "gross earn minus this is the honest cash line");
  });

  it("the position book flags funded demand with no match at its place — the controller-feed bug, pinned", () => {
    const prod = chain("chain:p", "s1", [10], [step(10, { upkeep: 1 })]);
    const orphanSteps: Step[] = [0, 1].map(() => ({
      body: { work: 2, carry: 1, move: 1 },
      provides: { controlPoints: 4 },
      requires: { energyAt: { ctrl: 4 } },
      cost: { upfront: 300, upkeepEt: 0.2, spawnTimeEt: 0.003 }
    }));
    const up: Offer = { id: "up", kind: "upgrade", steps: orphanSteps };
    const sinks: SinkChain[] = [{ stages: [stage(up, [4, 4])] }];
    const plan = clear(input({ chains: [prod], sinks }));
    assert.isNotEmpty(plan.violations);
    assert.include(plan.violations[0], "unmatched demand at ctrl");
    const ctrl = plan.positions.find(p => p.place === "ctrl");
    assert.isBelow(ctrl?.netEt ?? 0, 0, "the book shows the hole");
  });

  it("charges a step shared by several chains ONCE — the trunk's throat funds with whichever member funds first", () => {
    // Addendum 4's anatomy: the throat rides EVERY member chain at zero
    // capacity, so no member can fund without affording it — and the
    // market must not hire or bill it once per member.
    const throat: Step = {
      body: { work: 0, carry: 2, move: 1 },
      provides: {},
      requires: {},
      cost: { upfront: 150, upkeepEt: 0.1, feeEt: 0.2, spawnTimeEt: 0.002 }
    };
    const trunk: Offer = {
      id: "t",
      kind: "link",
      steps: [throat, step(10, { backedBy: "pair", fee: 0.3 }), step(10, { backedBy: "pair", fee: 0.3 })]
    };
    const mineA: Offer = { id: "mA", kind: "mine", steps: [step(10, { upkeep: 0.4 })] };
    const mineB: Offer = { id: "mB", kind: "mine", steps: [step(10, { upkeep: 0.4 })] };
    const member = (cid: string, src: string, mine: Offer, slice: number): ChainCandidate => ({
      id: cid,
      sourceId: src,
      stages: [
        stage(mine, [10]),
        {
          options: [
            { offer: trunk, step: 0, capacity: 0 },
            { offer: trunk, step: slice, capacity: 10 }
          ]
        }
      ]
    });
    const plan = clear(
      input({ chains: [member("chain:s1", "s1", mineA, 1), member("chain:s2", "s2", mineB, 2)] })
    );
    const t = plan.corps.find(c => c.id === "t");
    assert.equal(t?.target, 3, "throat + two slices — the shared step counted once");
    assert.deepEqual(
      t?.staff,
      [{ body: { work: 0, carry: 2, move: 1 }, live: null }],
      "ONE throat on the roster, never one per member"
    );
    assert.closeTo(plan.expected.deliveredEt, 20, 1e-9, "both members deliver");
    assert.closeTo(plan.expected.refillEt, 0.4 + 0.4 + 0.1, 1e-9, "the throat's bill charged once");
    assert.closeTo(plan.expected.feesEt, 0.2 + 0.3 + 0.3, 1e-9, "its fee too");
  });

  it("is deterministic: same input, same plan; order of candidates does not matter", () => {
    const a = chain("chain:a", "s1", [5], [step(5, { upkeep: 0.3 })]);
    const b = chain("chain:b", "s2", [5], [step(5, { upkeep: 0.4 })]);
    const one = clear(input({ chains: [a, b] }));
    const two = clear(input({ chains: [a, b] }));
    const flipped = clear(input({ chains: [b, a] }));
    assert.deepEqual(one, two);
    assert.deepEqual(one.corps, flipped.corps);
  });
});
