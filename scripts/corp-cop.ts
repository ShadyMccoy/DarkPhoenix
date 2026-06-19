/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * corp-cop - run one or more scenarios under the CorpCop watch and report any
 * sustained pathologies (orphaned creeps, ...). Exits non-zero if any are found,
 * so it doubles as a CI gate.
 *
 *   npx ts-node -P tsconfig.test.json scripts/corp-cop.ts [ticks] [scenario...]
 *   npx ts-node -P tsconfig.test.json scripts/corp-cop.ts 300 twoSourceRcl3 remoteSource
 *
 * With no scenarios it sweeps a representative default set.
 */
import { runWithCop } from "../test/integration/diagnostics/runWithCop";

const DEFAULT_SCENARIOS = ["twoSourceRcl3", "singleSourceRcl3", "threeChamberRcl3", "remoteSource"];
const SUSTAINED = 5;

async function main(): Promise<void> {
  const ticks = parseInt(process.argv[2] ?? "300", 10);
  const scenarios = process.argv.slice(3);
  const list = scenarios.length > 0 ? scenarios : DEFAULT_SCENARIOS;

  let anyViolations = false;
  for (const scenario of list) {
    process.stdout.write(`\n=== ${scenario} (${ticks} ticks) ===\n`);
    const { cop } = await runWithCop({ scenario, ticks });
    const report = cop.report(SUSTAINED);
    if (report) {
      anyViolations = true;
      console.log(report);
    } else {
      console.log(`  clean - no sustained violations (>= ${SUSTAINED} ticks)`);
    }
  }

  if (anyViolations) {
    console.log(`\nCorpCop: FAIL - sustained violations above.`);
    process.exit(1);
  }
  console.log(`\nCorpCop: PASS - all scenarios clean.`);
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
