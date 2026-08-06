import { expect } from "chai";
import { CorpRow, formatCorpBudget, rollUp } from "../../../scripts/corp-budget";

/**
 * THE ROLL-UP (spec 51): a category row is DEFINED as the sum of its corps.
 *
 * That definition is the whole design - it is what makes the drill-down exact
 * rather than illustrative, and what stops the statement from re-deriving a
 * number the corps already declared. These tests pin the definition, the
 * ordering, and the two honesty rules (nothing silently dropped, nothing
 * silently absorbed).
 */
const corp = (
  id: string,
  kind: string,
  account: string | undefined,
  parts: number,
  opts: Partial<CorpRow> = {}
): CorpRow => ({
  id,
  kind,
  account,
  consumes: { spawnPartsPerTick: parts, energyRate: opts.consumes?.energyRate },
  produces: opts.produces,
  shape: opts.shape
});

describe("spec 51: the corp budget roll-up", () => {
  it("a category row is exactly the sum of its corps", () => {
    const rows = [
      corp("harvest-a", "harvest", "extraction", 0.01),
      corp("harvest-b", "harvest", "extraction", 0.02),
      corp("upgrade-ctrl", "upgrade", "consumers", 0.05)
    ];
    const rolls = rollUp(rows);
    const extraction = rolls.find(r => r.account === "extraction")!;
    expect(extraction.corps).to.have.length(2);
    expect(extraction.spawnPartsPerTick).to.be.closeTo(0.03, 1e-12);
    // The drill-down IS the addends - re-summing them must reproduce the row.
    expect(extraction.corps.reduce((s, c) => s + (c.consumes?.spawnPartsPerTick ?? 0), 0)).to.be.closeTo(
      extraction.spawnPartsPerTick,
      1e-12
    );
  });

  it("the categories sum to the colony budget - no row is lost or double-counted", () => {
    const rows = [
      corp("harvest-a", "harvest", "extraction", 0.01),
      corp("carry-a", "carry", "evacuation", 0.02),
      corp("reservation-W1", "reservation", "reservation", 0.03),
      corp("raidGuard-W1", "raidGuard", "defense", 0.04),
      corp("upgrade-ctrl", "upgrade", "consumers", 0.05)
    ];
    const total = rollUp(rows).reduce((s, r) => s + r.spawnPartsPerTick, 0);
    expect(total).to.be.closeTo(0.15, 1e-12);
    expect(rollUp(rows).reduce((s, r) => s + r.corps.length, 0)).to.equal(rows.length);
  });

  it("prints direct-cost-of-mining lines before overhead, overhead before capital", () => {
    const rows = [
      corp("claim-W2", "claim", "expansion", 0.01),
      corp("upgrade-ctrl", "upgrade", "consumers", 0.01),
      corp("harvest-a", "harvest", "extraction", 0.01),
      corp("reservation-W1", "reservation", "reservation", 0.01)
    ];
    expect(rollUp(rows).map(r => r.account)).to.deep.equal(["extraction", "reservation", "consumers", "expansion"]);
  });

  it("an UNCLASSIFIED corp is surfaced, never folded into a residual", () => {
    // This is the `jack` lesson: it sat inside overhead for months because the
    // reporting layer had an `other` bucket to put it in.
    const rows = [corp("harvest-a", "harvest", "extraction", 0.01), corp("mystery-1", "mystery", undefined, 0.02)];
    const rolls = rollUp(rows);
    const unclassified = rolls.find(r => r.account === "UNCLASSIFIED");
    expect(unclassified, "an unclassified corp must get its own visible row").to.not.equal(undefined);
    expect(unclassified!.spawnPartsPerTick).to.be.closeTo(0.02, 1e-12);
    expect(rolls[rolls.length - 1].account, "and it sorts LAST, where it is conspicuous").to.equal("UNCLASSIFIED");

    const text = formatCorpBudget(rows, false);
    expect(text).to.contain("UNCLASSIFIED");
    expect(text).to.contain("classify them in");
  });

  it("names the zero-budget corps rather than letting the total look complete", () => {
    // GAP 2: auxiliary corps declare 0. A statement that silently sums them as
    // free reads as a complete book when it is short by the whole infra fleet.
    const rows = [
      corp("harvest-a", "harvest", "extraction", 0.01),
      corp("reservation-W1", "reservation", "reservation", 0),
      corp("tender-W1", "tender", "infra", 0)
    ];
    const text = formatCorpBudget(rows, false);
    expect(text).to.contain("2 of 3 corps declare a ZERO budget");
    expect(text).to.contain("reservation");
    expect(text).to.contain("tender");
  });

  it("drill mode lists the corps under each category, largest first", () => {
    const rows = [
      corp("harvest-small", "harvest", "extraction", 0.01),
      corp("harvest-big", "harvest", "extraction", 0.09)
    ];
    const drilled = formatCorpBudget(rows, true);
    expect(drilled).to.contain("harvest-big");
    expect(drilled).to.contain("harvest-small");
    expect(drilled.indexOf("harvest-big"), "biggest spender first").to.be.lessThan(drilled.indexOf("harvest-small"));
    // Without the flag the corps stay collapsed - the category row is the view.
    expect(formatCorpBudget(rows, false)).to.not.contain("harvest-big");
  });

  it("carries the energy and value columns, not just spawn parts", () => {
    const rows = [
      corp("harvest-a", "harvest", "extraction", 0.01, { produces: { energyRate: 10 } }),
      corp("upgrade-ctrl", "upgrade", "consumers", 0.05, {
        consumes: { spawnPartsPerTick: 0.05, energyRate: 40 },
        produces: { valuePerTick: 3200 }
      })
    ];
    const rolls = rollUp(rows);
    expect(rolls.find(r => r.account === "extraction")!.energyOut).to.equal(10);
    expect(rolls.find(r => r.account === "consumers")!.energyIn).to.equal(40);
    expect(rolls.find(r => r.account === "consumers")!.valueOut).to.equal(3200);
  });
});
