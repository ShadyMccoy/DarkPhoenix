/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * Spec 14 phase 4 - NOW-plan mirror. The queue that explained the feeder
 * starvation and the receipts that convicted the reserver loop lived only in
 * Memory.spawnAgenda (a /user/memory hand-pull). Mirror the queue heads and
 * executed receipts VERBATIM into the core segment: actual-vs-NOW (spec 11's
 * tight-assertion pair) becomes a telemetry read. Verbatim - never summarized,
 * never recomputed (decision symmetry).
 */
describe("Telemetry NOW-plan mirror (segment 0, spec 14 phase 4)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.rooms = {};
    Game.creeps = {};
    Game.time = 100;
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    (Memory as any).spawnMeter = undefined;
  });

  const queueEntry = (role: string, corp: string, extra: any = {}): any => ({
    role,
    corp,
    minCost: 300,
    desiredCost: 1000,
    mustFund: false,
    ...extra
  });

  it("mirrors queue heads and executed receipts verbatim per spawn", () => {
    (Memory as any).spawnAgenda = {
      sid1: {
        tick: 99,
        fundingNeed: 1950,
        queue: [
          queueEntry("reserver", "reservation-X", { mustFund: true, precondition: "bank>=1300", why: "campaign" }),
          queueEntry("hauler", "hauling-A"),
          queueEntry("hauler", "hauling-B"),
          queueEntry("feeder", "moving-F", { why: "infra" }),
          queueEntry("miner", "mining-M"),
          queueEntry("builder", "building-C")
        ],
        executed: [
          { tick: 90, role: "miner", corp: "mining-M", cost: 650 },
          { tick: 95, role: "reserver", corp: "reservation-X", cost: 1300 }
        ]
      }
    };

    new Telemetry().update(undefined, [], undefined);
    const core = JSON.parse(RawMemory.segments[0]);

    const a = core.agenda.sid1;
    expect(a.tick).to.equal(99);
    expect(a.fundingNeed).to.equal(1950);
    expect(a.queueDepth).to.equal(6);
    // The WHOLE queue verbatim (v11 - prod t72483599: the upgrader demand
    // sat at rank 5+ through a 550t staffing collapse and its `since` age,
    // the anti-starvation clock, was invisible behind a 4-head cap).
    expect(a.queue).to.have.length(6);
    expect(a.queue[0]).to.deep.equal((Memory as any).spawnAgenda.sid1.queue[0]);
    expect(a.queue[5]).to.deep.equal((Memory as any).spawnAgenda.sid1.queue[5]);
    // receipts verbatim
    expect(a.executed).to.deep.equal((Memory as any).spawnAgenda.sid1.executed);
  });

  it("omits the agenda block entirely when no spawnAgenda exists", () => {
    (Memory as any).spawnAgenda = undefined;
    new Telemetry().update(undefined, [], undefined);
    const core = JSON.parse(RawMemory.segments[0]);
    expect(core).to.not.have.property("agenda");
  });
});
