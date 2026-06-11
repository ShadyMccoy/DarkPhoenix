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

  it("breadth-first: opens a fresh source's first miner before a started source's SECOND hauler", () => {
    // Source A is already underway (miner + one hauler) and its energy is being
    // hauled, so its pending demand is a SCALING second hauler. Source B has never
    // been mined - its first miner is the critical path of a whole second source.
    // Opening B (its first miner) beats topping up A, so every source gets producing
    // before any is fully fleshed out. (The old "fund A fully first" let A's endless
    // scaling demand monopolise the spawn so B never got a miner.)
    const decision = decideNextSpawn({
      energyAvailable: 550,
      energyCapacity: 550,
      sources: [
        { id: "A", haulCarry: 8 }, // wants 2 haulers; one already exists (scaling)
        { id: "B" } // fresh source, first miner pending (critical path)
      ],
      creeps: [
        { corpId: "mining-A", workType: "harvest", work: 5 }, // A's miner: A is "started"
        { corpId: "hauling-A", workType: "haul", carry: 5 } // A's first hauler already hauling
      ]
    });

    expect(decision.role).to.equal("miner");
    expect(decision.buyerCorpId).to.equal("mining-B");
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

  it("an upgrader stands down until a hauler is delivering (supply before demand)", () => {
    // The controller wants energy and the spawn is full, but there is no hauler in
    // the room. The upgrader must stand down - that energy is reserved for the
    // hauler that closes the delivery loop. Funding the upgrader here is the
    // cold-start deadlock the gate prevents: the spawn drains on upgraders and can
    // never afford the hauler that would refill it. With no other eligible demand,
    // the director spawns nothing this tick.
    const noHauler = decideNextSpawn({
      energyAvailable: 550,
      energyCapacity: 550,
      upgrader: true // controller wants energy, but no hauler is configured
    });
    expect(noHauler.role).to.equal(null);

    // The moment a hauler is delivering (corpId "hauling-*"), the same upgrader is
    // eligible and funded. The contrast IS the gate.
    const withHauler = decideNextSpawn({
      energyAvailable: 550,
      energyCapacity: 550,
      upgrader: true,
      creeps: [{ corpId: "hauling-A", workType: "haul", carry: 4 }]
    });
    expect(withHauler.role).to.equal("upgrader");
  });

  it("opens a fresh (profitable) source's miner before the first upgrader", () => {
    // Source A is fully staffed and its energy is coming home. A fresh source B
    // wants its first miner; an upgrader also waits. Income outranks consumption:
    // a source's miner is the highest-value corp and is staffed first, before the
    // colony spends spawn time upgrading. (Sources B would NOT exist here if the
    // miner-profitability gate had rejected it as an unprofitable remote - that
    // gate, not the upgrader, is what keeps the colony from sprawling.)
    const decision = decideNextSpawn({
      energyAvailable: 550,
      energyCapacity: 550,
      sources: [
        { id: "A", haulCarry: 4 }, // fully staffed below
        { id: "B" } // fresh: first miner pending (blocking, per source)
      ],
      upgrader: true,
      creeps: [
        { corpId: "mining-A", workType: "harvest", work: 5 },
        { corpId: "hauling-A", workType: "haul", carry: 5 }
      ]
    });

    expect(decision.role).to.equal("miner");
    expect(decision.buyerCorpId).to.equal("mining-B");
  });

  it("holds the spawn rather than spawning a 1-WORK miner runt at a drained spawn", () => {
    // Cold start with the spawn drained to 200: a 1-WORK miner (150) is
    // affordable right now, but a 1-WORK miner harvests just 2/tick against a
    // ~10/tick source - a runt that occupies the source's spot for its whole
    // life. The first miner is floored at 2 WORK (250), which is not affordable
    // yet; since it is blocking and income is flowing, the director must HOLD the
    // spawn to accumulate energy for the real miner, not spend it on the runt.
    const decision = decideNextSpawn({
      energyAvailable: 200,
      energyCapacity: 550,
      energyIncome: 10,
      sources: [{ id: "A" }]
    });

    expect(decision.role).to.equal(null); // spawn nothing this tick - wait for the floored miner
  });
});
