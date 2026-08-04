import { expect } from "chai";
import { Telemetry } from "../../../src/telemetry";
import { CorpCensusEntry } from "../../../src/execution/CommissionHost";
import { RawMemory, setupGlobals, Game } from "../mock";

/**
 * THROUGHPUT COUNTERS REACH THE CAPTURE (phase 2 of the income-statement
 * program; spec 36 item 3's instrument, spec 32's hard prerequisite).
 *
 * The account's revenue line is PLAN CAPACITY because nothing measured what a
 * source actually yielded: Corp.recordProduction accrues cumulative units per
 * corp - harvested energy for mining, DELIVERED energy for carry corps (every
 * CarryCorp transfer path records the moved amount; that IS its declared
 * unit) - reset-surviving via the commission store's serialize, but no
 * segment published it. Publishing lets the ledger difference two captures
 * per corp: measured mined per source over exactly the capture window (the
 * #7 shape), and on mining OPERATIONS (spec 34 D5) the inner haul squads'
 * summed counter is what actually LANDED - produced-vs-delivered finally
 * separates idle-fleet / wrong-route / insufficient-carry.
 */
describe("throughput counters reach the corps segment (phase 2)", () => {
  beforeEach(() => {
    setupGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.rooms = {};
    Game.time = 100;
    Game.creeps = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Game as any).shard = { name: "shard1" };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bareCorp = (id: string, type: string, over: any = {}): any => ({
    id,
    type,
    nodeId: "W1N1-1-1",
    createdAt: 0,
    lastActivityTick: 0,
    unitsProduced: 0,
    getCreepCount: () => 1,
    ...over
  });

  it("publishes each corp's cumulative produced units", () => {
    const census: CorpCensusEntry[] = [
      { corpId: "harvest-s1", kind: "harvest", corp: bareCorp("mining-W1N1-harvest-s1", "mining", { unitsProduced: 12345 }) }
    ];
    new Telemetry().update(undefined, census, undefined);
    const seg = JSON.parse(RawMemory.segments[4]);
    expect(seg.corps[0].produced, "cumulative harvested energy rides the segment").to.equal(12345);
  });

  it("publishes an operation's inner-squad deliveries as `delivered`", () => {
    const op = bareCorp("mining-W1N1-harvest-s1", "mining", {
      unitsProduced: 9000, // the miner's harvest
      innerCorps: () => [
        bareCorp("inner-haul-1", "hauling", { unitsProduced: 4000 }),
        bareCorp("inner-haul-2", "hauling", { unitsProduced: 2500 })
      ]
    });
    const census: CorpCensusEntry[] = [{ corpId: "harvest-s1", kind: "harvest", corp: op }];
    new Telemetry().update(undefined, census, undefined);
    const seg = JSON.parse(RawMemory.segments[4]);
    expect(seg.corps[0].produced).to.equal(9000);
    expect(seg.corps[0].delivered, "the evacuation squads' landed energy").to.equal(6500);
  });

  it("omits the fields on corps that never counted (no fabricated zeros)", () => {
    const census: CorpCensusEntry[] = [
      { corpId: "reservation-W1N2", kind: "reservation", corp: bareCorp("reservation-W1N2-reservation", "reservation") }
    ];
    new Telemetry().update(undefined, census, undefined);
    const seg = JSON.parse(RawMemory.segments[4]);
    expect(seg.corps[0].produced).to.equal(undefined);
    expect(seg.corps[0].delivered).to.equal(undefined);
  });
});
