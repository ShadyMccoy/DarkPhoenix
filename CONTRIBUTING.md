# Contributing to DarkPhoenix

Start with [CLAUDE.md](CLAUDE.md) — it is the working playbook, and its rules
are not optional. The short version:

1. **Read the docs in order**: [docs/ONTOLOGY.md](docs/ONTOLOGY.md) (the
   domain model, authoritative) → [docs/PIPELINE.md](docs/PIPELINE.md) (the
   live pipeline) → [docs/specs/](docs/specs/README.md) (each spec IS its
   acceptance tests) → the code.
2. **Write the failing test/cell first.** Acceptance criteria live in tests
   only; diag probes (`scripts/diag-*.ts`) are for investigation.
3. **The grid is the success metric**: `npm run grid` (spec 08), ratcheted in
   `test/grid/baseline.json`. Update the baseline in the same commit as the
   bot change that earned it.
4. **Always `npm run build` before any grid/integration run** — they measure
   `dist/main.js`, not your working tree.
5. **Fresh clone**: `npm run setup:test-env`, then `npm run probe:mockup`
   before trusting any grid/integration result — see
   [docs/TESTING_THE_ECONOMY.md](docs/TESTING_THE_ECONOMY.md) for the
   invisible-failure trap this avoids.
6. **Regression gate** for live-behavior changes: `npm run test-unit` plus
   the `flow-handoff`, `runt-economy`, `storage-depot` integration tests
   (one file at a time: `npx mocha "test/integration/<file>.test.ts"`).
7. **Economic formulas live in `src/economy/primitives.ts`** — never
   reimplement one, and never nudge a sink value in isolation.
8. **Creeps are requisitioned, never conjured**: spawn work flows through
   the corp contract (`corps/spawnContract.ts`); a naked `spawn.spawnCreep`
   throws at runtime and fails the spawn-authority ratchet.

Measured over vibes: any tempo/throughput claim under ~30% needs multiple
draws (`npm run sim:variance`), and plan-vs-actual is always reported as a
pair.
