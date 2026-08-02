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
  it("books a tombstone's energy as LOST the moment it APPEARS", () => {
    sampleRoomLosses(census(), 90); // baseline: the room, with no tombstones
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 500 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 490 }] }), 110);
    const r = lossReport(110);
    // Counted once, on appearance - not again on every sample it survives.
    expect(r.tombstoneLost * 20).to.be.closeTo(400, 1e-9);
    expect(r.tombstoneRecovered).to.equal(0);
  });

  it("counts it as lost even when it vanishes with life to spare", () => {
    // The old rule guessed "gone early => somebody looted it". With no reliable
    // recovery that guess understates, which is the failure mode that matters.
    sampleRoomLosses(census(), 90);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 500 }] }), 100);
    sampleRoomLosses(census({ tombstones: [] }), 110);
    expect(lossReport(110).tombstoneLost * 20).to.be.closeTo(400, 1e-9);
  });

  it("CREDITS back only witnessed recovery - energy leaving a standing tombstone", () => {
    sampleRoomLosses(census(), 90);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 300 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 100, ticksToDecay: 290 }] }), 110);
    const r = lossReport(110);
    expect(r.tombstoneRecovered * 20).to.be.closeTo(300, 1e-9);
    // Net loss is the 100 that never came back.
    expect(r.tombstoneLost * 20).to.be.closeTo(100, 1e-9);
  });

  it("nets to ZERO when a tombstone is fully recovered", () => {
    sampleRoomLosses(census(), 90);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 300 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 0, ticksToDecay: 290 }] }), 110);
    expect(lossReport(110).tombstoneLost).to.be.closeTo(0, 1e-9);
  });

  it("never books the same tombstone twice, however long it stands", () => {
    sampleRoomLosses(census(), 90);
    for (const t of [100, 110, 120, 130]) {
      sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 500 }] }), t);
    }
    expect(lossReport(130).tombstoneLost * 40).to.be.closeTo(400, 1e-9);
  });

  it("carries the CURRENT tombstone stock as its own figure, backlog included", () => {
    // Stock is a LEVEL - it shows the standing backlog even though the backlog
    // is never charged as a rate. Both facts matter and they are separate.
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 50 }] }), 100);
    expect(lossReport(100).tombstoneStock).to.equal(400);
    expect(lossReport(100).tombstoneLost).to.equal(0);
  });

  /**
   * Vision is not a measurement. A room we stopped seeing must not have its
   * tombstones counted as expired - that is the "room state from creep
   * positions" trap in a different costume (CLAUDE.md), and it would report a
   * loss spike every time a scout died.
   */
  it("does NOT count losses in a room it simply stopped seeing", () => {
    sampleRoomLosses(census(), 90);
    sampleRoomLosses(census({ tombstones: [{ id: "t1", energy: 400, ticksToDecay: 2 }] }), 100);
    sampleRoomLosses(census({ room: "W2N2", tombstones: [] }), 110); // a DIFFERENT room
    const r = lossReport(110);
    // W1N1's tombstone was booked when it appeared (400e); what must NOT happen
    // is a second charge because the room went dark.
    expect(r.tombstoneLost * 20).to.be.closeTo(400, 1e-9);
    expect(r.tombstoneRecovered).to.equal(0);
  });

  /**
   * TOMBSTONE ATTRIBUTION (owner 2026-08-02: "don't we have info about
   * tombstones. What type of creep. What kind of death. TTL.").
   *
   * We do, and the meter was discarding it. `Tombstone.creep` is a full creep
   * object: its `body` and our own `Memory.creeps[name].workType` give the
   * ROLE, and its `ticksToLive` at death gives the CAUSE - a creep that expired
   * has none left, one that was killed still had time on the clock.
   *
   * 10.36 e/t is dying in tombstones and the account cannot say whose or why.
   * If it is haulers expiring mid-route it folds into the carry deficit; if it
   * is anything killed, it is a defense question. Those are different work
   * items and the line could not tell them apart.
   */
  describe("attribution - whose energy, and how they died", () => {
    const tomb = (over: any) => ({ id: "t1", energy: 300, ticksToDecay: 400, ...over });

    it("splits the loss by ROLE", () => {
      sampleRoomLosses(census(), 90);
      sampleRoomLosses(
        census({
          tombstones: [tomb({ id: "a", role: "haul", energy: 300 }), tomb({ id: "b", role: "harvest", energy: 100 })]
        }),
        100
      );
      const r = lossReport(100);
      expect(r.tombstoneByRole.haul).to.equal(300);
      expect(r.tombstoneByRole.harvest).to.equal(100);
    });

    it("splits the loss by CAUSE - expired vs killed", () => {
      sampleRoomLosses(census(), 90);
      sampleRoomLosses(
        census({
          tombstones: [
            tomb({ id: "a", energy: 300, killed: false }), // ran out of life
            tomb({ id: "b", energy: 200, killed: true }) // still had time on the clock
          ]
        }),
        100
      );
      const r = lossReport(100);
      expect(r.tombstoneExpired).to.equal(300);
      expect(r.tombstoneKilled).to.equal(200);
    });

    it("attributes on FIRST SIGHT only, like the loss itself", () => {
      sampleRoomLosses(census(), 90);
      const t = [tomb({ id: "a", role: "haul", energy: 300 })];
      sampleRoomLosses(census({ tombstones: t }), 100);
      sampleRoomLosses(census({ tombstones: t }), 110);
      expect(lossReport(110).tombstoneByRole.haul, "counted once, not per sample").to.equal(300);
    });

    it("buckets an unknown role rather than dropping the energy", () => {
      sampleRoomLosses(census(), 90);
      sampleRoomLosses(census({ tombstones: [tomb({ id: "a", energy: 250 })] }), 100);
      const r = lossReport(100);
      const total = Object.values(r.tombstoneByRole).reduce((a: number, b) => a + (b as number), 0);
      expect(total, "no energy vanishes from the split").to.equal(250);
    });
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

  /**
   * THE RESET SPIKE I SHIPPED (found in the t72721419 account, 2026-08-01).
   *
   * "Book at first sight" is right for a tombstone that APPEARS during the
   * window, and wrong for the standing stock at window start: those creeps died
   * before the meter existed, so charging them makes a rate out of a backlog.
   * Live, 1596e of standing tombstones re-booked on the deploy's global reset -
   * 2.85 e/t of the 12.21 e/t reported, ~23% phantom. Every deploy did it
   * again.
   *
   * The prior reset test only checked the COUNTERS re-based; it never sampled a
   * room afterwards, so it could not see this.
   */
  it("does NOT charge the tombstones already standing when the window opens", () => {
    // First sighting of a room establishes the baseline; the 900e standing
    // there predates the meter and is somebody else's window.
    sampleRoomLosses(census({ tombstones: [{ id: "old", energy: 900, ticksToDecay: 400 }] }), 100);
    sampleRoomLosses(census({ tombstones: [{ id: "old", energy: 900, ticksToDecay: 390 }] }), 110);
    expect(lossReport(110).tombstoneLost).to.equal(0);
  });

  it("DOES charge a tombstone that appears after the baseline", () => {
    sampleRoomLosses(census({ tombstones: [{ id: "old", energy: 900, ticksToDecay: 400 }] }), 100);
    sampleRoomLosses(
      census({
        tombstones: [
          { id: "old", energy: 900, ticksToDecay: 390 },
          { id: "new", energy: 300, ticksToDecay: 400 }
        ]
      }),
      110
    );
    // Only the newcomer is a loss inside this window.
    expect(lossReport(110).tombstoneLost).to.be.closeTo(30, 1e-9);
  });
});

/**
 * A FISCAL MONTH MUST BE MEASURABLE (owner 2026-08-01: "can it show the last
 * 1500+ ticks of actual?").
 *
 * It could not. The meter's totals were module state, so the measured window
 * was bounded by VM LIFETIME, not by how far apart two captures are - live
 * t72722670 read a 480-tick loss window against a 1251-tick capture window,
 * purely because a deploy had reset the globals. A fiscal month is 1500 ticks,
 * so no month was ever measurable end to end, and the account's window-
 * incoherence guard fired structurally rather than occasionally.
 *
 * The fix is to publish CUMULATIVE energy totals that survive a reset, and let
 * the ledger DIFFERENCE two captures - the same shape the account already uses
 * for gcl.progress and storage. The measured window then EQUALS the capture
 * window by construction, for any length.
 */
describe("LossMeter cumulative totals (a fiscal month must be measurable)", () => {
  beforeEach(() => resetLossMeter());

  const census = (over: any = {}) => ({
    room: "W1N1", owned: true, piles: [], tombstones: [], containers: 0, ramparts: 0, roadDecayEnergy: 0, ...over
  });

  it("reports totals in ENERGY, monotonically - not a rate over its own window", () => {
    sampleRoomLosses(census({ piles: [1000] }), 100);
    sampleRoomLosses(census({ piles: [1000] }), 200);
    const a = lossReport(200).cumulative;
    sampleRoomLosses(census({ piles: [1000] }), 300);
    const b = lossReport(300).cumulative;
    expect(a.pileDecay).to.be.closeTo(100, 1e-9); // 1 e/t over 100t
    expect(b.pileDecay).to.be.closeTo(200, 1e-9);
    expect(b.pileDecay).to.be.greaterThan(a.pileDecay); // monotonic: differenceable
  });

  it("carries totals ACROSS a global reset, so the window is capture-bounded", () => {
    sampleRoomLosses(census({ piles: [1000] }), 100);
    sampleRoomLosses(census({ piles: [1000] }), 200);
    const before = lossReport(200).cumulative.pileDecay;

    resetLossMeter({ keepTotals: true }); // a global reset: Memory survives, globals do not
    // The room must re-baseline (no prior sample), then accumulate onward.
    sampleRoomLosses(census({ piles: [1000] }), 300);
    sampleRoomLosses(census({ piles: [1000] }), 400);

    const after = lossReport(400).cumulative.pileDecay;
    expect(before).to.be.closeTo(100, 1e-9);
    // 100 ticks of the gap are lost to re-baselining - honest, and bounded by
    // the sample stride - but the TOTAL never restarts at zero.
    expect(after).to.be.closeTo(200, 1e-9);
  });

  it("still re-bases the RATE view on a reset (the live-console figure)", () => {
    sampleRoomLosses(census({ piles: [1000] }), 100);
    sampleRoomLosses(census({ piles: [1000] }), 200);
    resetLossMeter({ keepTotals: true });
    expect(lossReport(200).windowTicks).to.equal(0);
  });
});
