# DarkPhoenix — Test Battery Status Report

- **Date:** 2026-07-25
- **Branch:** `master` @ `3110284`
- **Tree:** clean (no uncommitted changes)
- **Bundle:** `dist/main.js` rebuilt from clean tree before grid/integration runs

---

## Catalog — all stages run

| Stage | Command | Result | Detail |
|---|---|---|---|
| Build | `npm run build` | ✅ Pass | `dist/main.js`, 270 KiB, minified, no errors |
| Unit | `npm run test-unit` | ✅ Pass | **1476 passing, 18 pending** (~5s) |
| Integration | `flow-handoff.test.ts` | ✅ Pass | 1 passing (47s) — bootstrap→flow transition over 600 ticks |
| Integration | `runt-economy.test.ts` | ✅ Pass | 1 passing (41s) — runt upsize proven 2→3 WORK @ tick 440 |
| Integration | `storage-depot.test.ts` | ✅ Pass | 1 passing (2s) — storage site placed near spawn at RCL4 |
| Grid | `npm run grid` | ❌ **RATCHET FAILURE** | botLevel **4 → -1**; 10 baseline-green cells regressed |

**Environment prerequisite:** `node_modules` arrived missing the declared dep
`screeps-server-mockup` (`^1.5.1`) — on the load path of every test entry point.
Restored via `npm install` (exit 0). Post-install the git tree is clean, no
lockfile/package.json change, mockup resolved to exactly `1.5.1`.

---

## Grid regressions — 10 cells (all recorded `"pass"` in `baseline.json`, botLevel 4)

Verified still failing when re-run in isolation (one cell at a time, idle machine).

### Class A — `eventually:` assertions timing out at full tick budget (6)
Consistent with the mockup metering real CPU against a real bucket (host-load coupling).

| Cell | Tier | Failing assertion |
|---|---|---|
| `churn-retiring-scavenge-corp` | T3 | organic scavenger fielded / stock drained below threshold |
| `cons-link-farthest-source` | T4 | link site goes to farthest eligible source |
| `haul-t2-scavenge-threshold` | T2 | 900 stock commissioned / drained below decay trajectory |
| `haul-t3-dedicated-resume-container` | T3 | surplus drained below the gate |
| `haul-t3-dedicated-standdown` | T3 | build consumes B's output (site progresses) |
| `plan-t4-link-haul-pricing` | T4 | linked hauls priced from core / pump reaches core link |

### Class B — hard assertion fails (4)
Not all load-explained.

| Cell | Tier | Failing assertion | Notes |
|---|---|---|---|
| `agenda-t2-receipts-match-head` | T2 | every receipt matches predicting queue (top-2) | fail @387/400 |
| `agenda-t2-spawns-match-head` | T2 | every spawn matches agenda head (top-2 tol) | fail @390/400 |
| `arrive-builder-builds-and-refuels-in-place` | T2 | builds past fuel horizon / refuels in place | fail @4/60 |
| `cons-ext-first-site-checkerboard` | T0 | never more than one site at a time | **fail @10/100 — deterministic** |

**`cons-ext-first-site-checkerboard`** is the standout: it fails identically across
3 isolated runs at **tick 10** — a construction-site placement invariant, CPU-independent
and far too early for a drained bucket. Two extension sites are placed where the
invariant demands one-at-a-time. This one is a genuine reproducible discrepancy against
the committed baseline, not host load.

---

## Interpretation

- **Code-level suites are fully green** — unit + full integration trio pass cleanly.
- The grid failure splits into throughput-sensitive `eventually` timeouts (Class A,
  consistent with this host being slower than the baseline machine — a documented
  CPU-metering coupling) and hard fails (Class B), of which at least the checkerboard
  cell is deterministic and warrants real triage rather than dismissal as load.
- **Baseline NOT lowered.** Ratcheting botLevel down to -1 over an
  environment/measurement mismatch would destroy the earned botLevel-4 baseline;
  baselines move up only, in the same commit as the bot change that earns them.

## Suggested follow-ups (not performed)
1. Re-run the grid on the reference/idle machine to confirm Class A is host-load.
2. Triage `cons-ext-first-site-checkerboard` (fast, deterministic, T0) — the one
   failure that cannot be attributed to CPU throttling.
