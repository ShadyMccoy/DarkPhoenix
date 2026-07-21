/**
 * Pin the DEMAND-POLICY semantics of SpawnDirector.collectDemands (spec 17
 * acceptance test 2, the demand-side half).
 *
 * These assertions freeze what the director's per-kind policy DOES today, so
 * the generic (kind-declared) rewrite must reproduce it exactly:
 *
 *   - reservation / raidGuard / coreBuster demands are stamped into the income
 *     tier as already-started units (groupId = corp.id, groupStarted = true);
 *   - claim / tender / controllerFeeder / construction / upgrade demands pass
 *     through UNDECORATED (no groupId - they compete at base value);
 *   - a carry corp whose route draws a scavenge- stock is always "started"
 *     (its energy is already on the ground - no miner to wait for);
 *   - the uniform filters: only corps of the queried spawn, never retiring
 *     corps, and corps without getSpawnDemand (scout) contribute nothing.
 *
 * The corps are real instances; their getSpawnDemand is patched to a canned
 * demand because THIS suite pins only what collectDemands ADDS on top.
 */

import { expect } from "chai";
import { setupGlobals } from "../mock";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";
import { collectDemands } from "../../../src/execution/SpawnDirector";
import { resetCommissionHost, seedCommissionStoreForTest } from "../../../src/execution/CommissionHost";
import { SpawnDemand, SpawnDemandContext, SpawnRole } from "../../../src/spawn/SpawnScheduler";
import { Corp } from "../../../src/corps/Corp";
import { ReservationCorp } from "../../../src/corps/ReservationCorp";
import { RaidGuardCorp } from "../../../src/corps/RaidGuardCorp";
import { CoreBusterCorp } from "../../../src/corps/CoreBusterCorp";
import { ClaimCorp } from "../../../src/corps/ClaimCorp";
import { ExtensionTenderCorp } from "../../../src/corps/ExtensionTenderCorp";
import { ControllerFeederCorp } from "../../../src/corps/ControllerFeederCorp";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";

const SPAWN_ID = "spawn1";
const ROOM = "W1N1";
const CTX: SpawnDemandContext = { energyCapacity: 550, tick: 100 };

function canned(corp: Corp, role: SpawnRole, producesIncome = false): SpawnDemand {
  return {
    buyerCorpId: corp.id,
    role,
    value: 90,
    blocking: false,
    producesIncome,
    desiredCost: 300,
    minCost: 200,
    since: 0
  };
}

/** Patch a real corp's demand method so the suite pins only the decoration. */
function patchDemand(corp: Corp, demands: SpawnDemand[]): void {
  (corp as unknown as { getSpawnDemand: (ctx: SpawnDemandContext) => SpawnDemand[] }).getSpawnDemand = () => demands;
}

describe("SpawnDirector.collectDemands - per-kind policy pins (spec 17)", () => {
  beforeEach(() => {
    setupGlobals();
    resetCommissionHost();
  });
  afterEach(() => resetCommissionHost());

  function collect(): SpawnDemand[] {
    return collectDemands(createCorpRegistry(), SPAWN_ID, CTX);
  }

  it("reservation demands are stamped as a started income unit (groupId = corp.id)", () => {
    const corp = new ReservationCorp(`${ROOM}-reservation`, SPAWN_ID);
    patchDemand(corp, [canned(corp, "reserver", true)]);
    seedCommissionStoreForTest(`reservation-${ROOM}`, "reservation", corp);

    const demands = collect();
    expect(demands).to.have.length(1);
    expect(demands[0].groupId).to.equal(corp.id);
    expect(demands[0].groupStarted).to.equal(true);
  });

  it("raidGuard demands are stamped as a started income unit", () => {
    const corp = new RaidGuardCorp(`${ROOM}-raidGuard`, SPAWN_ID);
    patchDemand(corp, [canned(corp, "guard", true)]);
    seedCommissionStoreForTest(`raidGuard-${ROOM}`, "raidGuard", corp);

    const demands = collect();
    expect(demands).to.have.length(1);
    expect(demands[0].groupId).to.equal(corp.id);
    expect(demands[0].groupStarted).to.equal(true);
  });

  it("coreBuster demands are stamped as a started income unit", () => {
    const corp = new CoreBusterCorp(`${ROOM}-coreBuster`, SPAWN_ID);
    patchDemand(corp, [canned(corp, "buster", true)]);
    seedCommissionStoreForTest(`coreBuster-${ROOM}`, "coreBuster", corp);

    const demands = collect();
    expect(demands).to.have.length(1);
    expect(demands[0].groupId).to.equal(corp.id);
    expect(demands[0].groupStarted).to.equal(true);
  });

  it("claim / tender / controllerFeeder / construction / upgrade pass through undecorated", () => {
    const cases: [string, Corp, SpawnRole][] = [
      ["claim", new ClaimCorp(`${ROOM}-claim`, SPAWN_ID), "claimer"],
      ["tender", new ExtensionTenderCorp(`${ROOM}-tender`, SPAWN_ID), "tanker"],
      ["controllerFeeder", new ControllerFeederCorp(`${ROOM}-feeder`, SPAWN_ID), "feeder"],
      ["construction", new ConstructionCorp(`${ROOM}-construction`, SPAWN_ID), "builder"],
      ["upgrade", new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID), "upgrader"]
    ];
    for (const [kind, corp, role] of cases) {
      patchDemand(corp, [canned(corp, role)]);
      seedCommissionStoreForTest(`${kind}-${ROOM}`, kind, corp);
    }

    const demands = collect();
    expect(demands).to.have.length(cases.length);
    for (const d of demands) {
      expect(d.groupId, `${d.buyerCorpId} must stay ungrouped`).to.equal(undefined);
      expect(d.groupStarted, `${d.buyerCorpId} must stay unstarted`).to.equal(undefined);
    }
  });

  it("a carry corp on a scavenge- stock is always a started unit (no miner to wait for)", () => {
    const corp = new CarryCorp(`${ROOM}-hauling-scav`, SPAWN_ID, `hauling-scav`);
    corp.setHaulerAssignments([
      { fromId: "scavenge-abc", carryParts: 4, spawnId: `spawn-${SPAWN_ID}`, haulerRatio: "1:1" } as HaulerAssignment
    ]);
    patchDemand(corp, [canned(corp, "hauler", true)]);
    seedCommissionStoreForTest("carry-scavenge-abc", "carry", corp);

    const demands = collect();
    expect(demands).to.have.length(1);
    expect(demands[0].groupId).to.equal("scavenge-abc");
    expect(demands[0].groupStarted).to.equal(true);
  });

  it("filters: another spawn's corps and retiring corps contribute nothing", () => {
    const other = new ReservationCorp(`${ROOM}-reservation`, "spawn-elsewhere");
    patchDemand(other, [canned(other, "reserver", true)]);
    seedCommissionStoreForTest(`reservation-${ROOM}`, "reservation", other);

    const retiring = new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID);
    retiring.retiring = true;
    patchDemand(retiring, [canned(retiring, "upgrader")]);
    seedCommissionStoreForTest(`upgrade-${ROOM}`, "upgrade", retiring);

    expect(collect()).to.have.length(0);
  });
});
