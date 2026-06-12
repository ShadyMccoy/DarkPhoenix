/**
 * The golden master (spec 00, test B) - rung 4 of the proof ladder: the
 * Commission envelope composed over the solver, pinned across three standard
 * pure worlds. This is what makes the strangler migration safe: any change to
 * how the plan maps onto commissions shows up as a snapshot diff and must be
 * its own commit with the economic delta explained.
 *
 * Regenerate (after an INTENTIONAL change only):
 *   npx ts-node -P tsconfig.test.json test/unit/framework/generateSnapshot.ts
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { resetCorpKinds } from "../../../src/economy/CorpKind";
import { goldenWorlds, normalizedCommissions } from "./goldenWorlds";

const SNAPSHOT = path.resolve(__dirname, "plan-commissions.snapshot.json");

describe("framework golden master: plan -> commissions over the standard worlds", () => {
  before(() => resetCorpKinds()); // solver output only - no registered kinds

  it("matches the checked-in snapshot exactly", () => {
    expect(fs.existsSync(SNAPSHOT), `missing snapshot ${SNAPSHOT} - run generateSnapshot.ts`).to.equal(true);
    const pinned = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    const actual: Record<string, unknown> = {};
    for (const name in goldenWorlds) {
      actual[name] = normalizedCommissions(goldenWorlds[name]());
    }
    // JSON round-trip so undefined-valued keys compare as absent, exactly as
    // the snapshot stores them.
    expect(JSON.parse(JSON.stringify(actual))).to.deep.equal(pinned);
  });
});
