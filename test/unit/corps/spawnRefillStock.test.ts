import { expect } from "chai";
import { setupGlobals } from "../mock";
import { isSpawnRefillStock, SPAWN_REFILL_STOCK_RANGE } from "../../../src/corps/nodeEnergy";

/**
 * THE SPAWN-REFILL STOCK GUARD (phase 3; the #148-surfaced refill-SLA
 * regression, grid plan-t5-remote-pipeline t=537).
 *
 * The sink ladder at the STOCK level: energy standing at the spawn's drop
 * tile while the extension bank is short is the refill apparatus's working
 * capital (spawn 100), and a construction body drawing it inverts the ladder
 * (construction 70). Measured in the grid trace: a builder parked on the
 * drop tile hoovered each hauler delivery the tick it landed (280-350e
 * held), the depot never accumulated, the tender's reload fell back to the
 * source pile 15 tiles out, and the next drain's deadline lapsed while it
 * walked (deficit 238, ~29 ticks outstanding). Pre-#148 the room never
 * showed the geometry: room-capacity hauler bodies dumped ~300e quanta that
 * out-paced the builder's draw. Route-share bodies (#148) deliver in
 * smaller quanta, so the claim ORDER started to matter - this predicate is
 * that order, shared by every construction fuel path (the staffsPost
 * symmetry rule: one lens, every reader).
 *
 * A FULL bank drops the guard entirely: the drop pile is then genuine
 * surplus and the builder may eat it (construction-first doctrine).
 */
describe("isSpawnRefillStock (the sink ladder at the stock - spawn 100 > construction 70)", () => {
  before(() => setupGlobals());

  const room = (energyAvailable: number, energyCapacityAvailable: number, spawns: { x: number; y: number }[]): Room =>
    ({
      energyAvailable,
      energyCapacityAvailable,
      find: () => spawns.map(s => ({ pos: { x: s.x, y: s.y } }))
    } as never);

  it("guards a drop tile beside the spawn while the extension bank is short", () => {
    const r = room(300, 550, [{ x: 25, y: 25 }]);
    expect(isSpawnRefillStock(r, { x: 25, y: 24 } as never)).to.equal(true);
    expect(isSpawnRefillStock(r, { x: 25 + SPAWN_REFILL_STOCK_RANGE, y: 25 } as never)).to.equal(true);
  });

  it("does NOT guard stock beyond the refill reach - site piles stay build fuel", () => {
    const r = room(300, 550, [{ x: 25, y: 25 }]);
    expect(isSpawnRefillStock(r, { x: 25 + SPAWN_REFILL_STOCK_RANGE + 1, y: 25 } as never)).to.equal(false);
    expect(isSpawnRefillStock(r, { x: 40, y: 40 } as never)).to.equal(false);
  });

  it("a FULL extension bank drops the guard - the pile is then surplus and construction may eat it", () => {
    const r = room(550, 550, [{ x: 25, y: 25 }]);
    expect(isSpawnRefillStock(r, { x: 25, y: 24 } as never)).to.equal(false);
  });

  it("covers every spawn in a multi-spawn cluster", () => {
    const r = room(300, 550, [{ x: 10, y: 10 }, { x: 30, y: 30 }]);
    expect(isSpawnRefillStock(r, { x: 30, y: 29 } as never)).to.equal(true);
    expect(isSpawnRefillStock(r, { x: 10, y: 11 } as never)).to.equal(true);
    expect(isSpawnRefillStock(r, { x: 20, y: 20 } as never)).to.equal(false);
  });
});
