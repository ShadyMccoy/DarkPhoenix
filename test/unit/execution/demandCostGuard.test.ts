/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals } from "../mock";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { collectDemands } from "../../../src/execution/SpawnDirector";
import { resetCommissionHost, seedCommissionStoreForTest } from "../../../src/execution/CommissionHost";
import { SpawnDemand, SpawnDemandContext, SpawnRole, hasFundableCosts } from "../../../src/spawn/SpawnScheduler";
import { Corp } from "../../../src/corps/Corp";
import { ReservationCorp } from "../../../src/corps/ReservationCorp";
import { reset as resetBlackBox, rows as blackBoxRows } from "../../../src/telemetry/BlackBox";

/**
 * THE COST SEAM (incident t72865978, the class fix).
 *
 * `minCost`/`desiredCost` are REQUIRED on SpawnDemand, but a corp can bypass the
 * type with a cast - and one did, for 1804+ live ticks. The failure is silent by
 * construction: every funding comparison is a numeric `>=`, so an undefined cost
 * fails all of them and the demand degrades into gate "impossible" - the verdict
 * meaning "this RCL can never build it" - while publishing no `bank>=N`
 * precondition, which is exactly what S3 and `classifySpawnIdle` read to tell a
 * wedge from a chosen wait. Both printed benign.
 *
 * So the pool itself refuses the demand: a cost the scheduler cannot compare is
 * not a demand, and the agenda is what every instrument reads. `collectDemands`
 * is the ONE seam every demand crosses (it already stamps `kind` and
 * `storageBacked` centrally), so the check lives there and cannot be forgotten
 * per kind - the spec-17 registration-only contract.
 */

const SPAWN_ID = "spawn1";
const ROOM = "W1N1";
const CTX: SpawnDemandContext = { energyCapacity: 550, tick: 100 };

function patchDemand(corp: Corp, demands: SpawnDemand[]): void {
  (corp as unknown as { getSpawnDemand: (ctx: SpawnDemandContext) => SpawnDemand[] }).getSpawnDemand = () => demands;
}

function canned(corp: Corp, role: SpawnRole, over: Partial<SpawnDemand> = {}): SpawnDemand {
  return {
    buyerCorpId: corp.id,
    role,
    value: 90,
    blocking: false,
    producesIncome: true,
    desiredCost: 300,
    minCost: 200,
    since: 0,
    ...over
  };
}

describe("spawn demand cost guard (incident t72865978)", () => {
  beforeEach(() => {
    setupGlobals();
    resetCommissionHost();
    resetBlackBox();
  });
  afterEach(() => resetCommissionHost());

  function collectWith(over: Partial<SpawnDemand>): SpawnDemand[] {
    const corp = new ReservationCorp(`${ROOM}-reservation`, SPAWN_ID);
    patchDemand(corp, [canned(corp, "reserver", over)]);
    seedCommissionStoreForTest(`reservation-${ROOM}`, "reservation", corp);
    return collectDemands(createCorpRegistry(), SPAWN_ID, CTX);
  }

  it("hasFundableCosts: only a pair of finite, non-negative numbers passes", () => {
    const base = { minCost: 200, desiredCost: 300 } as SpawnDemand;
    expect(hasFundableCosts(base)).to.equal(true);
    expect(hasFundableCosts({ ...base, minCost: undefined as unknown as number })).to.equal(false);
    expect(hasFundableCosts({ ...base, desiredCost: undefined as unknown as number })).to.equal(false);
    expect(hasFundableCosts({ ...base, minCost: NaN })).to.equal(false);
    expect(hasFundableCosts({ ...base, desiredCost: Infinity })).to.equal(false);
    expect(hasFundableCosts({ ...base, minCost: -1 })).to.equal(false);
    // A zero-cost min is legal: the cold-start floor bodies price that way.
    expect(hasFundableCosts({ ...base, minCost: 0 })).to.equal(true);
  });

  it("a well-formed demand still reaches the pool", () => {
    expect(collectWith({})).to.have.length(1);
  });

  it("a demand with no minCost never reaches the pool", () => {
    const demands = collectWith({ minCost: undefined as unknown as number });
    expect(demands, "an unfundable demand must not rank, hold, or head the agenda").to.have.length(0);
  });

  it("a demand with no desiredCost never reaches the pool", () => {
    expect(collectWith({ desiredCost: undefined as unknown as number })).to.have.length(0);
  });

  it("and the drop is LOUD - silence is how this cost 1804 ticks", () => {
    collectWith({ minCost: undefined as unknown as number });
    const errs = blackBoxRows().filter(r => r.k === "err");
    expect(errs, "no black-box row recorded the rejected demand").to.have.length(1);
    expect(String(errs[0].d.msg)).to.contain("reserver");
  });
});
