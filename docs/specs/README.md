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
| 00 | [Corp Framework](00-corp-framework.md) | **COMPLETE** — all kinds run through CommissionHost; polish notes remain in-spec | landed |
| 01 | [Early-game progression](01-rcl5-cold-start-stall.md) | mostly closed (cold-start pipeline pinned by resilience cells); remaining question: live RCL2-3 throughput | P1 |
| 02 | [Link logistics](02-link-logistics.md) | shipped in altered form: LinkRunner (free function) + planner haulPos pricing; the corp-kind redesign remains open | P2 |
| 03 | [Storage draw-down](03-storage-drawdown.md) | deposit half + controller feeder relay landed; planner-level draw-down (bank as supply) not started | P1 |
| 04 | [Retire the chain/market layer](04-retire-chain-layer.md) | **DONE 2026-07-12** — `economy/siteValue` re-bases node/spawn valuation on planColony; ChainEvaluator/ColonyEconomy deleted | landed |
| 05 | [Toolchain upgrade](05-toolchain-upgrade.md) | approved, not started | P2 |
| 06 | [Expansion: claim the next room](06-expansion.md) | **LANDED 2026-07-10** — capital-gated claiming + sink-based founding, exp-t5 cells green | landed |
| 07 | [Tower defense (minimal)](07-tower-defense.md) | **LANDED 2026-07-17** (spec 13 tranche 1) — TowerRunner + RCL3 placement + tender feeding; tower-defense integration test green | landed |
| 08 | [Inflection-point grid](08-inflection-grid.md) | ~114 cells; BOT LEVEL 3 ratcheted (red: haul-t4-storage-bank-and-spill, plan-t5-remote-pipeline) | ongoing — the success metric |
| 09 | [Robustness program](09-robustness-program.md) | phases 1, 4 done; 5 partial (CpuGovernor + bulkheads; schema versioning open); 6 partial (standdown); 2-3 open | P0 (phase 2) |
| 10 | [RCL journey map](10-rcl-journey.md) | living ledger — most steps cell-pinned; see gap list | ongoing |
| 11 | [Two plans: goal and now](11-two-plans.md) | phases 1-2 landed (agenda published + funding); phase 3 (transitions into agenda) open | P0 |
| 12 | [Invader protocols: flight, and eventually fight](12-invader-protocols.md) | phase 1 (flight) **LANDED 2026-07-16**, stays as the fallback layer; phase 2 **LANDED 2026-07-17** via spec 13's CoreBusterCorp (kill + strip, corrected math), def-t5-core-buster cell green | landed |
| 13 | [Invader economics: keep the remotes flowing](13-invader-economics.md) | **LANDED 2026-07-17** — scout-wipe fix, towers, raid meter + transit embargo, RaidGuardCorp (def-t4 green), CoreBusterCorp (def-t5 green), invader tax, BlackBox/intel telemetry; open: live tax calibration (≥15k-tick windows) | landed (calibration open) |
| 14 | [Telemetry observability: answer the basic questions](14-telemetry-observability.md) | ALL PHASES implemented 2026-07-18 (bodies #111/#113, ledger+sizing #114, gate stamps, spawn meter + NOW-plan mirror core-v5); found+fixed the live reserver purchase loop | P1 |
| 15 | [Waste ledger: make every leak a measured number](15-waste-ledger.md) | proposed 2026-07-18 — owner directive: identify/measure/eliminate CPU, energy, spawn-time waste in planning & execution; phase 1 = audit-side ledger over existing captures | P0 |

Recently completed (for context): economy consolidation onto
`economy/primitives` + CorpPlanner (FlowSolver deleted); storage-as-core-depot
at RCL4 with the `storage-depot` integration test; the free-economy mod fix
(CONSTRUCTION_COST 0 made building impossible, now 1); the
reserve-source-only-with-a-fielded-builder gate.
