import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { decideNextSpawn } from "../harness/spawnDecision";

/**
 * "What does the colony spawn NEXT?" - key economic moments frozen as fast
 * regression tests.
 *
 * Each case is a real decision point we have actually hit (and in two cases,
 * actually broken) in the sims, captured at the millisecond level: a tiny
 * declarative situation run through the REAL collectDemands + scheduleSpawn
 * pipeline (see spawnDecision harness). They give clear signal at near-zero cost
 * and let us iterate on the spawn logic without standing up a server.
 */
describe("next spawn decision (key moments)", () => {
  it("cold start: spawns the source's MINER before the upgrader", () => {
    // Empty colony at RCL 2 (bare 300 spawn): a source needing its first miner,
    // and an upgrader. Both demands are blocking, but the income producer must
    // come first - there is no energy to upgrade with until a source is mined.
    const decision = decideNextSpawn({
      energyAvailable: 300,
      energyCapacity: 300,
      energyIncome: 0,
      sources: [{ id: "A" }],
      upgrader: true
    });

    expect(decision.role).to.equal("miner");
    expect(decision.buyerCorpId).to.equal("mining-A");
  });

  it("bootstrap hand-off: a flow miner stays blocking while only a bootstrap jack is alive", () => {
    // The bug this guards: colonyHasMiner once counted bootstrap jacks (also
    // workType "harvest"), so the flow miner read as non-blocking and the
    // blocking upgrader out-ranked it forever - the colony never moved off
    // bootstrap. A live jack must NOT demote the flow miner: it is still the
    // colony's first real income producer and must out-rank the upgrader.
    const decision = decideNextSpawn({
      energyAvailable: 300,
      energyCapacity: 300,
      energyIncome: 0,
      sources: [{ id: "A" }],
      upgrader: true,
      creeps: [{ corpId: "bootstrap-W1N1", workType: "harvest", work: 2 }]
    });

    expect(decision.role).to.equal("miner");
    expect(decision.buyerCorpId).to.equal("mining-A");
  });

  it("miner precedence: a source's hauler is held until its first miner exists", () => {
    // Source A has neither a miner nor a hauler yet. The hauler must NOT be
    // spawned first - it would have nothing to carry. withMinerPrecedence holds
    // A's hauler back until A has a miner in the field.
    const decision = decideNextSpawn({
      energyAvailable: 550,
      energyCapacity: 550,
      sources: [{ id: "A", haulCarry: 4 }]
    });

    expect(decision.role).to.equal("miner");
    expect(decision.buyerCorpId).to.equal("mining-A");
  });

  it("fund one corp fully: completes a started source's haulers before opening a fresh source", () => {
    // Source A is already underway (a miner + one hauler in the field) and wants
    // a second hauler; source B is fresh and wants its (non-blocking, since the
    // colony already mines A) first miner. Neither demand is blocking and B's
    // miner has the higher BASE value - but the completion boost must carry A's
    // hauler so the colony finishes hauling A's energy home before opening B,
    // instead of stranding A's energy to start a source it won't finish.
    const decision = decideNextSpawn({
      energyAvailable: 550,
      energyCapacity: 550,
      sources: [
        { id: "A", haulCarry: 8 }, // wants 2 haulers; one already exists
        { id: "B" } // fresh source, first miner pending
      ],
      creeps: [
        { corpId: "mining-A", workType: "harvest", work: 5 }, // A's miner: A is "started"
        { corpId: "hauling-A", workType: "haul", carry: 5 } // A's first hauler
      ]
    });

    expect(decision.role).to.equal("hauler");
    expect(decision.buyerCorpId).to.equal("hauling-A");
  });

  it("opens the next source once the started one is fully staffed", () => {
    // Counterpart to the previous case: A is now fully staffed (miner + enough
    // hauler CARRY for its whole rate), so there is nothing left to complete -
    // the colony should open source B's miner.
    const decision = decideNextSpawn({
      energyAvailable: 550,
      energyCapacity: 550,
      sources: [
        { id: "A", haulCarry: 4 }, // one hauler is enough
        { id: "B" }
      ],
      creeps: [
        { corpId: "mining-A", workType: "harvest", work: 5 },
        { corpId: "hauling-A", workType: "haul", carry: 5 }
      ]
    });

    expect(decision.role).to.equal("miner");
    expect(decision.buyerCorpId).to.equal("mining-B");
  });
});
