#!/usr/bin/env ts-node
/**
 * Regenerate the golden-master snapshot. Run ONLY when the plan->commission
 * mapping changes intentionally, and commit the diff with the economic delta
 * explained (docs/specs/00-corp-framework.md, test B).
 *
 *   npx ts-node -P tsconfig.test.json test/unit/framework/generateSnapshot.ts
 */

import * as fs from "fs";
import * as path from "path";
import { resetCorpKinds } from "../../../src/economy/CorpKind";
import { goldenWorlds, normalizedCommissions } from "./goldenWorlds";

// Guarded so mocha's test glob (which loads every .ts under test/unit) can
// never regenerate the pin as a side effect - only an explicit ts-node run.
if (require.main === module) {
  resetCorpKinds();
  const out: Record<string, unknown> = {};
  for (const name in goldenWorlds) {
    out[name] = normalizedCommissions(goldenWorlds[name]());
  }
  const file = path.resolve(__dirname, "plan-commissions.snapshot.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);
  for (const name in out) {
    console.log(`  ${name}: ${(out[name] as unknown[]).length} commissions`);
  }
}
