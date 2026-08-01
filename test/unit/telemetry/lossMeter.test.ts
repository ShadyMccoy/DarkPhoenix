import { expect } from "chai";
import { resetLossMeter, sampleRoomLosses, recordRepair, lossReport } from "../../../src/telemetry/LossMeter";

/**
 * THE LOSS METER (owner 2026-08-01: "I'd like to see pile decay, tombstone and
 * decay (structures) and repair show up in the report").
 *
 * The energy account balances to a RESIDUAL - 31.69 e/t, 32% of gross mining at
 * the last close - that bounds ground decay, rot, raid losses and measurement
 * error all together. Spec 15's rule is that a residual which cannot be split
 * is itself the work item, so this meter prices the parts that ARE knowable.
 *
 * The measurement natures deliberately differ, and the report must not blur
 * them: pile decay is EXACT (the engine's own arithmetic on an observed stock),
 * structure decay is a MODELLED liability (what holding hits constant costs),
 * repair is MEASURED spend, and tombstone loss is measured but needs a
 * discriminator - energy that leaves a tombstone was either looted (recovered,
 * no loss) or decayed (gone). Counting all of it as loss would overstate;
 * counting none would hide it.
 */
describe("LossMeter (residual line items)", () => {
  beforeEach(() => resetLossMeter());

  const census = (over: any = {}) => ({
    room: "W1N1",
    owned: true,
    piles: [],
    tombstones: [],
    containers: 0,
    ramparts: 0,
    roadDecayEnergy: 0,
    ...over
  });

  it("prices ground piles by the engine's ceil rule, over the ticks elapsed", () => {
    sampleRoomLosses(census({ piles: [2500, 1000] }), 100);
    sampleRoomLosses(census({ piles: [2500, 1000] }), 110);
    // ceil(2500/1000)=3, ceil(1000/1000)=1 => 4 e/t, over 10 ticks.
    const r = lossReport(110);
    expect(r.pileDecay).to.be.closeTo(4, 1e-9);
  });

  it("prices structure decay as the cost of HOLDING hits, remote containers dearer", () => {
    sampleRoomLosses(census({ owned: false, containers: 2, roadDecayEnergy: 0.05 }), 100);
    sampleRoomLosses(census({ owned: false, containers: 2, roadDecayEnergy: 0.05 }), 200);
    // 2 remote containers @0.50 + roads 0.05 = 1.05 e/t
    expect(lossReport(200).structureDecay).to.be.closeTo(1.05, 1e-9);
  });

  // -----------------------------------------------------------------------
  // THE DISCRIMINATOR. A tombstone that vanishes has either been emptied by a
  // hauler or has expired. The engine destroys an expired tombstone's contents,
  // so only the second is a LOSS - and the two are told apart by the life
  // remaining when it was last seen.
  // -----------------------------------------------------------------------
  it("counts a tombstone that EXPIRED as a loss", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 3 }] }), 100);
    sampleRoomLosses(census({ tombstones: [] }), 110); // gone, and it was due
    const r = lossReport(110);
    // Reported as a RATE, like every other account line: 400e over a 10t window.
    expect(r.tombstoneDecayed).to.be.closeTo(40, 1e-9);
    expect(r.tombstoneLooted).to.equal(0);
  });

  it("does NOT count a tombstone that was LOOTED - that energy came home", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 500 }] }), 100);
    sampleRoomLosses(census({ tombstones: [] }), 110); // gone with life to spare
    const r = lossReport(110);
    expect(r.tombstoneDecayed).to.equal(0);
    expect(r.tombstoneLooted).to.be.closeTo(40, 1e-9);
  });

  it("counts a PARTIAL loot as recovered, and only the remainder as decayed", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 300 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 100, ticksToDecay: 290 }] }), 110);
    sampleRoomLosses(census({ tombstones: [] }), 120); // the husk cleared, life to spare
    const r = lossReport(120);
    expect(r.tombstoneLooted).to.be.closeTo(400 / 20, 1e-9); // 300 drawn down, then 100 taken
    expect(r.tombstoneDecayed).to.equal(0);
  });

  it("carries the CURRENT tombstone stock as its own figure (energy still at risk)", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 50 }] }), 100);
    expect(lossReport(100).tombstoneStock).to.equal(400);
  });

  /**
   * Vision is not a measurement. A room we stopped seeing must not have its
   * tombstones counted as expired - that is the "room state from creep
   * positions" trap in a different costume (CLAUDE.md), and it would report a
   * loss spike every time a scout died.
   */
  it("does NOT count losses in a room it simply stopped seeing", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 2 }] }), 100);
    sampleRoomLosses(census({ room: "W2N2", tombstones: [] }), 110); // a DIFFERENT room
    const r = lossReport(110);
    expect(r.tombstoneDecayed).to.equal(0);
    expect(r.tombstoneLooted).to.equal(0);
  });

  it("accumulates measured repair spend", () => {
    recordRepair(5);
    recordRepair(3);
    sampleRoomLosses(census(), 100);
    sampleRoomLosses(census(), 200);
    expect(lossReport(200).repairSpend).to.be.closeTo(8 / 100, 1e-9); // 8 energy over 100t
  });

  it("reports zero rates - not NaN - before any window has elapsed", () => {
    const r = lossReport(100);
    expect(r.windowTicks).to.equal(0);
    expect(r.pileDecay).to.equal(0);
    expect(r.structureDecay).to.equal(0);
    expect(r.repairSpend).to.equal(0);
  });

  it("survives a global reset by re-basing, never by reporting a spike", () => {
    sampleRoomLosses(census({ piles: [1000] }), 5000);
    resetLossMeter(); // global reset wipes module state
    const r = lossReport(5000);
    expect(r.windowTicks).to.equal(0);
    expect(r.pileDecay).to.equal(0);
  });
});
