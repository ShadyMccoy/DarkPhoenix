import { assert } from "chai";
import { ChainCandidate, MarketInput, SinkCandidate, clear } from "../../../src/engine/market";
import { Step } from "../../../src/engine/vocabulary";

/**
 * The clearing core certified with SYNTHETIC kinds: made-up schedules, no
 * Screeps economics. Whether the real quotes are right is the sizing and
 * quote suites' job — here we prove the market itself clears correctly:
 * end-to-end increments, merit order, every frontier reason, determinism.
 */

function step(cap: number, o: { upkeep?: number; spawn?: number; upfront?: number; backedBy?: string } = {}): Step {
  return {
    backedBy: o.backedBy,
    buys: o.backedBy ? undefined : { work: 0, carry: 1, move: 1 },
    provides: { energyAt: { bank: cap } },
    requires: {},
    cost: { upfront: o.upfront ?? 0, upkeepEt: o.upkeep ?? 0, spawnTimeEt: o.spawn ?? 0 }
  };
}

function chain(id: string, sourceId: string, caps: number[], steps: Step[]): ChainCandidate {
  return { id, sourceId, stages: [{ offer: { id, kind: "mine", steps }, capacities: caps }] };
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
    // Mouth stage delivers nothing until the transport stage exists: the
    // first increment must bundle both stages' first steps.
    const mine = { id: "m", kind: "mine" as const, steps: [step(10, { upkeep: 0.4, upfront: 500 })] };
    const haul = {
      id: "h",
      kind: "haul" as const,
      steps: [step(5, { upkeep: 0.3, upfront: 300 }), step(5, { upkeep: 0.3, upfront: 300 })]
    };
    const plan = clear(
      input({
        chains: [
          {
            id: "chain:s1",
            sourceId: "s1",
            stages: [
              { offer: mine, capacities: [10] },
              { offer: haul, capacities: [5, 5] }
            ]
          }
        ]
      })
    );
    assert.closeTo(plan.expected.deliveredEt, 10, 1e-9);
    const targets = new Map(plan.corps.map(c => [c.id, c.target]));
    assert.equal(targets.get("m"), 1);
    assert.equal(targets.get("h"), 2);
  });

  it("funds in merit order and prints the spawn-capacity frontier", () => {
    const rich = chain("chain:rich", "s1", [8], [step(8, { upkeep: 0.2, spawn: 0.01 })]);
    const poor = chain("chain:poor", "s2", [8], [step(8, { upkeep: 4, spawn: 0.01 })]);
    // Capacity for exactly one increment: the richer chain must win it.
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

    // One living body anywhere = standing income: the filter lifts.
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
    const sinkSteps = [0, 1, 2].map(() => ({
      buys: { work: 2, carry: 1, move: 1 },
      provides: { controlPoints: 4 },
      requires: { energyAt: { bank: 4 } },
      cost: { upfront: 300, upkeepEt: 0.2, spawnTimeEt: 0.003 }
    }));
    const sinks: SinkCandidate[] = [{ offer: { id: "up", kind: "upgrade", steps: sinkSteps }, burns: [4, 4, 4] }];
    const plan = clear(input({ chains: [prod], sinks }));
    // Residual 9: two 4.2 draws fit, the third prints the frontier.
    assert.equal(plan.corps.find(c => c.id === "up")?.target, 2);
    assert.equal(plan.frontier.find(f => f.offerId === "up")?.reason, "energy residual");
    assert.closeTo(plan.expected.upgradeEt, 8, 1e-9);
    // The heartbeat identity: the refill obligation is Σ funded bills.
    const bills = plan.corps.reduce((s, c) => s + c.pnl.costEt, 0);
    assert.closeTo(plan.expected.refillEt, bills, 1e-9);
    // Conservation: nothing delivered goes unaccounted.
    const leftover = plan.expected.deliveredEt - plan.expected.refillEt - plan.expected.upgradeEt;
    assert.isAtLeast(leftover, -1e-9);
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
