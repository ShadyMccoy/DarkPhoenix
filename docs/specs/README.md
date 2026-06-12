# Task Specs

Detailed, self-contained specifications for the next tranche of work. Each spec
defines its goal, design, file-level changes, and — most importantly — the
**acceptance tests**: a task is DONE exactly when its listed tests pass (and
nothing previously green breaks). Write the tests first; they are the contract.

**The keystone is [spec 00 — the Corp Framework](00-corp-framework.md):** corps
as interchangeable units behind an abstract input/output interface, so the
planner reasons over an abstracted world and new corp kinds plug in without
touching the core. Specs 02, 03, 06 and 07 should be implemented as corp kinds
through that framework; they double as proof that it works.

Conventions used by every spec:

- **Unit tests** run via `npm run test-unit` (mocha, mocked Game API, ~seconds).
- **Integration tests** run one file at a time via
  `npx mocha "test/integration/<file>.test.ts"` (screeps-server-mockup, real
  engine, minutes). Always `npm run build` first — the engine runs
  `dist/main.js`, not your working tree (a stale bundle cost this project a
  debugging hour already).
- **Regression gate** for any task touching live behavior: `npm run test-unit`,
  plus the `flow-handoff`, `runt-economy`, and `storage-depot` integration
  tests, all green.
- Diag probes (`scripts/diag-*.ts`) are for investigation, not acceptance.
  Acceptance criteria live in tests only.

| # | Spec | Status | Priority |
|---|------|--------|----------|
| 00 | [Corp Framework](00-corp-framework.md) | partially real, not enforced | P0 — the keystone |
| 01 | [RCL5 cold-start stall](01-rcl5-cold-start-stall.md) | OPEN — blocks 02 | P0 |
| 02 | [Link logistics (RCL5)](02-link-logistics.md) | groundwork committed, unverified | P0 (after 01) |
| 03 | [Storage draw-down](03-storage-drawdown.md) | not started | P1 |
| 04 | [Retire the chain/market layer](04-retire-chain-layer.md) | not started | P1 |
| 05 | [Toolchain upgrade](05-toolchain-upgrade.md) | approved, not started | P2 |
| 06 | [Expansion: claim the next room](06-expansion.md) | not started | P2 |
| 07 | [Tower defense (minimal)](07-tower-defense.md) | deferred by owner | P3 |

Recently completed (for context): economy consolidation onto
`economy/primitives` + CorpPlanner (FlowSolver deleted); storage-as-core-depot
at RCL4 with the `storage-depot` integration test; the free-economy mod fix
(CONSTRUCTION_COST 0 made building impossible, now 1); the
reserve-source-only-with-a-fielded-builder gate.
