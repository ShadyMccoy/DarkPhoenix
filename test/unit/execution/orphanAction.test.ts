import { expect } from "chai";
import { ORPHAN_GRACE_TICKS, orphanAction, readoptKindsFor } from "../../../src/execution/OrphanRescue";
import { resetCommissionHost, seedCommissionStoreForTest } from "../../../src/execution/CommissionHost";
import { ScoutCorp } from "../../../src/corps/ScoutCorp";
import { setupGlobals } from "../mock";

// The safety net for "creeps just standing around until they die": a creep no
// live corp claims is re-adopted into a corp for the same work, or recycled once
// it has been orphaned past the grace window (which rides out the commission
// churn around a flow re-solve so a creep is never recycled for a one-tick gap).
describe("OrphanRescue.orphanAction", () => {
  it("does nothing while a live corp claims the creep", () => {
    expect(orphanAction(true, false, undefined, 1000)).to.equal("none");
    // claimed wins even if it was previously orphaned (its corp came back)
    expect(orphanAction(true, true, 500, 1000)).to.equal("none");
  });

  it("re-adopts an orphan the moment a corp for its work exists", () => {
    expect(orphanAction(false, true, undefined, 1000)).to.equal("readopt");
    // re-adoption beats the grace clock - recover the worker, don't wait it out
    expect(orphanAction(false, true, 0, 1000)).to.equal("readopt");
  });

  it("waits out the grace window before giving up on an orphan", () => {
    // first orphaned tick: start the clock, don't recycle yet
    expect(orphanAction(false, false, undefined, 1000)).to.equal("wait");
    // still within grace
    expect(orphanAction(false, false, 1000, 1000 + ORPHAN_GRACE_TICKS - 1)).to.equal("wait");
  });

  it("recycles an orphan once it is past the grace window", () => {
    expect(orphanAction(false, false, 1000, 1000 + ORPHAN_GRACE_TICKS)).to.equal("recycle");
    expect(orphanAction(false, false, 1000, 5000)).to.equal("recycle");
  });
});

// The workType -> rescuing-kind map is DERIVED from the kinds' roles
// declarations (spec 17), not hand-maintained. These pins freeze the mapping
// the deleted ROLE_KIND table encoded - plus the one gap it had: "claim" was
// missing, so an orphaned claimer was always recycled mid-expansion (eating a
// 650-energy CLAIM body) even while its claim corp lived on.
describe("OrphanRescue.readoptKindsFor (registry-derived rescue map)", () => {
  beforeEach(() => {
    setupGlobals();
    resetCommissionHost();
    // Registers all live kinds via the host's lazy store bootstrap.
    seedCommissionStoreForTest("scout-W1N1", "scout", new ScoutCorp("W1N1-scout", "spawn1"));
  });
  afterEach(() => resetCommissionHost());

  const kindsFor = (workType: string): string[] => readoptKindsFor(workType).map(k => k.kind);

  it("derives the retired ROLE_KIND mapping from the kinds' declarations", () => {
    expect(kindsFor("upgrade")).to.deep.equal(["upgrade"]);
    expect(kindsFor("build")).to.deep.equal(["construction"]);
    expect(kindsFor("reserve")).to.deep.equal(["reservation"]);
    expect(kindsFor("scout")).to.deep.equal(["scout"]);
    expect(kindsFor("feed")).to.deep.equal(["controllerFeeder"]);
    expect(kindsFor("guard")).to.deep.equal(["raidGuard"]);
    expect(kindsFor("buster")).to.deep.equal(["coreBuster"]);
    expect(kindsFor("strike")).to.deep.equal(["coreBuster"]);
    expect(kindsFor("harvest")).to.deep.equal(["harvest"]);
    expect(kindsFor("haul")).to.deep.equal(["carry"]);
  });

  it("tank belongs to the tender kind alone: construction cedes its tankers (readopt: false)", () => {
    expect(kindsFor("tank")).to.deep.equal(["tender"]);
  });

  it("FIXES the ROLE_KIND gap: an orphaned claimer can re-adopt into its claim corp", () => {
    expect(kindsFor("claim")).to.deep.equal(["claim"]);
  });

  it("unknown workTypes rescue nowhere (recycle path)", () => {
    expect(kindsFor("mystery")).to.deep.equal([]);
  });
});
