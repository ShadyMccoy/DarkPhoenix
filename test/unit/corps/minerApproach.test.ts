import { expect } from "chai";
import { minerApproach } from "../../../src/corps/HarvestCorp";

// The fix for "miners standing around a source": only one miner claims the single
// static harvest tile; extra miners (when a poor room splits a source across
// several small miners) spread to the source's other adjacent tiles instead of
// piling onto the one occupied tile, getting blocked, and never harvesting.
describe("HarvestCorp.minerApproach", () => {
  it("stays put when already on the spot", () => {
    expect(minerApproach(true, true, false)).to.equal("stay");
  });

  it("claims the static spot when it is free", () => {
    expect(minerApproach(false, false, false)).to.equal("spot"); // walking in
    expect(minerApproach(false, true, false)).to.equal("spot"); // adjacent, spot free
  });

  it("spreads to another adjacent tile when the spot is held and it is not yet adjacent", () => {
    expect(minerApproach(false, false, true)).to.equal("spread");
  });

  it("harvests where it stands once adjacent and the spot is held", () => {
    expect(minerApproach(false, true, true)).to.equal("stay");
  });
});
