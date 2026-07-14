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

    expect(core.creeps.miners).to.equal(2);
    expect(core.creeps.haulers).to.equal(1);
    expect(core.creeps.reservers).to.equal(1);
    expect(core.creeps.tankers).to.equal(1);
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
