import { expect } from "chai";
import { LINK_TRANSFER_LOSS, linkTransferTax } from "../../../src/economy/primitives";
import { planColony, ColonyProblem, PlannerSource } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";

/**
 * LINK TRANSPORT IS NOT FREE (owner 2026-08-01: "we still have the 'free'
 * hauling from links in the plan as well?").
 *
 * A link-served source has its `haulPos` set to the core link, so the planner
 * prices its haul leg at ~1 tile - correct for the CREEP leg, because the link
 * genuinely does the carrying. What was missing is the link's OWN cost: the
 * engine destroys 3% of every transfer.
 *
 * Measured live t72721419 (W43N23): toHub 48.19 e/t + toController 37.99 e/t,
 * 3% of each = 1.45 + 1.14 = 2.59 e/t, exactly the meter's 2.59. Energy that
 * crosses the network twice pays twice. LINK_LOSS_RATIO existed ONLY in
 * telemetry/LinkMeter - the planner priced none of it, so a link-served source
 * looked strictly cheaper than it is against a walked one.
 *
 * The tax lands where the invader tax lands: in the per-source `tax` term that
 * both the mine/don't-mine gate and the ranking read.
 */
describe("link transfer tax (the 'free' link haul, priced)", () => {
  it("is the engine's 3% per hop, and lives in primitives with the other formulas", () => {
    expect(LINK_TRANSFER_LOSS).to.equal(0.03);
    expect(linkTransferTax(10)).to.be.closeTo(0.3, 1e-9);
    expect(linkTransferTax(0)).to.equal(0);
  });

  const at = (x: number): Position => ({ x, y: 25, roomName: "W1N1" });
  const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  const problemWith = (haulPos: Position | undefined): ColonyProblem => {
    const source: PlannerSource = { id: "s1", pos: at(40), rate: 10, ...(haulPos ? { haulPos } : {}) } as PlannerSource;
    return {
      sources: [source],
      sinks: [{ id: "ctrl", pos: at(10), type: "controller", demand: 100, value: 65 } as any],
      spawns: [{ id: "sp1", pos: at(10) }],
      dist: manhattan
    } as ColonyProblem;
  };

  it("charges a LINK-SERVED source the tax its own output pays to enter the network", () => {
    const plan = planColony(problemWith(at(11))); // haulPos beside the spawn
    const v = plan.sourceVerdicts?.find(x => x.sourceId === "s1");
    expect(v, "the source is evaluated").to.not.equal(undefined);
    // 10 e/t through the link costs 0.30 e/t in transfer loss.
    expect(v!.tax).to.be.closeTo(linkTransferTax(10), 1e-9);
  });

  it("charges a WALKED source nothing - it never touches the link network", () => {
    const plan = planColony(problemWith(undefined));
    const v = plan.sourceVerdicts?.find(x => x.sourceId === "s1");
    expect(v!.tax).to.equal(0);
  });

  it("makes the link-served source's NET strictly lower than the untaxed model", () => {
    // The point of the change: link service still wins on the haul leg (1 tile
    // vs 30), but it no longer wins by MORE than it should.
    const taxed = planColony(problemWith(at(11))).sourceVerdicts!.find(x => x.sourceId === "s1")!;
    expect(taxed.net).to.be.lessThan(10 - 0.29); // at least the tax below gross
  });
});
