/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry, CorpCensusEntry } from "../../../src/telemetry/Telemetry";

/**
 * The creep census is the whole point of the telemetry rewrite: every
 * creep-owning corp kind must have a bucket, the buckets must reconcile with
 * the ground-truth Game.creeps total, and the money-accounting fields must be
 * gone. These assertions guard against a new kind silently going uncounted -
 * the exact bug that motivated the change (tankers/reservers were invisible).
 */
describe("Telemetry creep census (segments 0 & 4)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.rooms = {};
    Game.time = 100;
    // Six creeps live in the world; the census below claims only five of them,
    // so one must land in `untracked`.
    Game.creeps = { a: {}, b: {}, c: {}, d: {}, e: {}, orphan: {} };
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
  });

  const creepCorp = (id: string, kind: string, type: string, nodeId: string, creeps: number): CorpCensusEntry => ({
    corpId: id,
    kind,
    corp: { id, type, nodeId, createdAt: 0, lastActivityTick: 0, getCreepCount: () => creeps } as any
  });

  const census: CorpCensusEntry[] = [
    creepCorp("harvest-s1", "harvest", "mining", "W1N1-1-1", 2),
    creepCorp("carry-s1", "carry", "hauling", "W1N1-1-1", 1),
    creepCorp("reservation-W1N2", "reservation", "reservation", "W1N2", 1),
    creepCorp("W1N1-tender", "tender", "moving", "W1N1", 1),
    // spawning: tracked by pending orders, NOT a creep bucket
    {
      corpId: "spawning-1",
      kind: "spawning",
      corp: { id: "spawning-1", type: "spawning", nodeId: "W1N1-spawn", createdAt: 0, lastActivityTick: 0, getPendingOrderCount: () => 3 } as any
    }
  ];

  it("buckets every creep-owning kind and reconciles tracked + untracked = total", () => {
    new Telemetry().update(undefined, census, undefined);
    const core = JSON.parse(RawMemory.segments[0]);

    expect(core.creeps.byKind).to.deep.equal({
      harvest: 2,
      carry: 1,
      reservation: 1,
      tender: 1
    });
    // spawning contributes NO creeps to the buckets
    expect(core.creeps.tracked).to.equal(5);
    expect(core.creeps.total).to.equal(6);
    expect(core.creeps.untracked).to.equal(1);
    // the census total must always reconcile: tracked + untracked === total
    expect(core.creeps.tracked + core.creeps.untracked).to.equal(core.creeps.total);
  });

  it("corps segment lists every kind by kind and carries no money fields", () => {
    new Telemetry().update(undefined, census, undefined);
    const corps = JSON.parse(RawMemory.segments[4]);

    expect(corps.summary.totalCorps).to.equal(5);
    expect(corps.summary.corpsByKind).to.deep.equal({
      harvest: 1,
      carry: 1,
      reservation: 1,
      tender: 1,
      spawning: 1
    });
    // spawning has pending orders (3), the four creep corps have >0 creeps -> all active
    expect(corps.summary.activeCorps).to.equal(5);

    const sample = corps.corps[0];
    expect(sample).to.have.property("kind");
    expect(sample).to.have.property("creepCount");
    expect(sample).to.not.have.property("balance");
    expect(sample).to.not.have.property("totalRevenue");
    expect(sample).to.not.have.property("roi");
    expect(sample).to.not.have.property("isActive");
  });

  it("dropped colony.averageROI from the core segment", () => {
    new Telemetry().update(undefined, census, undefined);
    const core = JSON.parse(RawMemory.segments[0]);
    expect(core.colony).to.not.have.property("averageROI");
  });
});

/**
 * Actual body capture. "What creep body parts do we actually have" must be
 * MEASURED from live Creep.body, not reconstructed from planner rates (the flow
 * segment's workParts is the PLAN side; this is the ACTUAL side). Per corp so a
 * dashboard can sit the planner's committed parts next to the parts actually
 * walking around, and colony-wide so the plan-vs-actual gauge has one number.
 */
describe("Telemetry actual body capture (segments 0 & 4)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.rooms = {};
    Game.time = 100;
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    // Real bodies, each owned by a corp via memory.corpId. `orphan` belongs to
    // no census corp - it still has a body we are paying for, so the colony
    // total must count it while no per-corp bucket claims it.
    Game.creeps = {
      miner1: { body: [{ type: "work" }, { type: "work" }, { type: "move" }], memory: { corpId: "harvest-s1" } },
      miner2: { body: [{ type: "work" }, { type: "move" }], memory: { corpId: "harvest-s1" } },
      hauler1: { body: [{ type: "carry" }, { type: "carry" }, { type: "move" }, { type: "move" }], memory: { corpId: "carry-s1" } },
      orphan: { body: [{ type: "move" }], memory: { corpId: "ghost-x" } }
    } as any;
  });

  const bodyCensus: CorpCensusEntry[] = [
    {
      corpId: "harvest-s1",
      kind: "harvest",
      corp: { id: "harvest-s1", type: "mining", nodeId: "W1N1-1-1", createdAt: 0, lastActivityTick: 0, getCreepCount: () => 2 } as any
    },
    {
      corpId: "carry-s1",
      kind: "carry",
      corp: { id: "carry-s1", type: "hauling", nodeId: "W1N1-1-1", createdAt: 0, lastActivityTick: 0, getCreepCount: () => 1 } as any
    }
  ];

  it("corps segment carries each corp's ACTUAL aggregate body, summed from Creep.body", () => {
    new Telemetry().update(undefined, bodyCensus, undefined);
    const corps = JSON.parse(RawMemory.segments[4]);

    const harvest = corps.corps.find((c: any) => c.id === "harvest-s1");
    // two miners: (2 work + 1 move) + (1 work + 1 move) => 3 work, 2 move
    expect(harvest.bodyParts).to.equal(5);
    expect(harvest.body).to.deep.equal({ work: 3, move: 2 });

    const carry = corps.corps.find((c: any) => c.id === "carry-s1");
    expect(carry.bodyParts).to.equal(4);
    expect(carry.body).to.deep.equal({ carry: 2, move: 2 });
  });

  it("core segment totals ACTUAL body parts colony-wide, including orphans", () => {
    new Telemetry().update(undefined, bodyCensus, undefined);
    const core = JSON.parse(RawMemory.segments[0]);

    // harvest (3w 2m) + carry (2c 2m) + orphan (1m) => work 3, carry 2, move 5
    expect(core.bodyParts.total).to.equal(10);
    expect(core.bodyParts.byPart).to.deep.equal({ work: 3, carry: 2, move: 5 });
  });

  it("a corp with no live creeps reports an empty actual body, never a reconstruction", () => {
    const emptyCensus: CorpCensusEntry[] = [
      {
        corpId: "carry-empty",
        kind: "carry",
        corp: { id: "carry-empty", type: "hauling", nodeId: "W1N1", createdAt: 0, lastActivityTick: 0, getCreepCount: () => 0 } as any
      }
    ];
    new Telemetry().update(undefined, emptyCensus, undefined);
    const corps = JSON.parse(RawMemory.segments[4]);

    const empty = corps.corps.find((c: any) => c.id === "carry-empty");
    expect(empty.bodyParts).to.equal(0);
    expect(empty.body).to.deep.equal({});
  });
});
