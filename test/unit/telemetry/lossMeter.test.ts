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
  // TOMBSTONES ARE LOST BY DEFAULT (owner 2026-08-01: "we don't have any to
  // recover tombstones so we can assume that it's lost for now").
  //
  // Three opportunistic recovery paths DO exist (scavengeSpot's range-1
  // withdraw, the builder's PICKUP_RANGE withdraw, and the scavenge corp when
  // the planner funds the stock) - but all three require a creep to already be
  // beside the tombstone, so a hauler that dies mid-route in a remote room is
  // simply gone. The default must therefore be LOSS.
  //
  // Booking at FIRST SIGHT, not at disappearance, is what makes that default
  // safe: it needs no theory about why a tombstone vanished, and it survives
  // the sample stride (a short-lived tombstone seen once is still counted).
  // Recovery is then a CREDIT, granted only on the direct evidence of energy
  // leaving a tombstone that is still standing - so if recovery is ever built
  // out, this number self-corrects instead of needing a rewrite.
  // -----------------------------------------------------------------------
  it("books a tombstone's energy as LOST the moment it is first seen", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 500 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 490 }] }), 110);
    const r = lossReport(110);
    // Counted once, at first sight - not again on every sample it survives.
    expect(r.tombstoneLost).to.be.closeTo(40, 1e-9);
    expect(r.tombstoneRecovered).to.equal(0);
  });

  it("counts it as lost even when it vanishes with life to spare", () => {
    // The old rule guessed "gone early => somebody looted it". With no reliable
    // recovery that guess understates, which is the failure mode that matters.
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 500 }] }), 100);
    sampleRoomLosses(census({ tombstones: [] }), 110);
    expect(lossReport(110).tombstoneLost).to.be.closeTo(40, 1e-9);
  });

  it("CREDITS back only witnessed recovery - energy leaving a standing tombstone", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 300 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 100, ticksToDecay: 290 }] }), 110);
    const r = lossReport(110);
    expect(r.tombstoneRecovered).to.be.closeTo(300 / 10, 1e-9);
    // Net loss is the 100 that never came back.
    expect(r.tombstoneLost).to.be.closeTo(100 / 10, 1e-9);
  });

  it("nets to ZERO when a tombstone is fully recovered", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 300 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 0, ticksToDecay: 290 }] }), 110);
    expect(lossReport(110).tombstoneLost).to.be.closeTo(0, 1e-9);
  });

  it("never books the same tombstone twice, however long it stands", () => {
    for (const t of [100, 110, 120, 130]) {
      sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 500 }] }), t);
    }
    expect(lossReport(130).tombstoneLost * 30).to.be.closeTo(400, 1e-9);
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
    // W1N1's tombstone was booked at first sight (400e over the window); what
    // must NOT happen is a second charge because the room went dark.
    expect(r.tombstoneLost * 10).to.be.closeTo(400, 1e-9);
    expect(r.tombstoneRecovered).to.equal(0);
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
