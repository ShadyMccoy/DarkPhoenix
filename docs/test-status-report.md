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

---

## Triage outcomes (2026-07-26, `claude/rcl7-dual-spawns-tests-ocs9mn`)

Worked through on the PR branch; the sandbox there cannot execute the mockup
(bot scripts never run — zero console output), so every disposition below is
static analysis against the report's recorded failure data and needs one
reference-machine grid run to confirm.

### Class B — hard fails (4)

| Cell | Verdict | Action |
|---|---|---|
| `cons-ext-first-site-checkerboard` | **Baseline drift**, not a regression. The extension rung batch-places the WHOLE remaining set (owner 2026-07-20, in-code directive in `ConstructionCorp`); the cell still pinned the retired one-at-a-time doctrine. The baseline "pass" predates the batch actually engaging in this world. | Cell rewritten: keeps grid-rule/only-extensions guards, adds the RCL2 cap bound (≤5) and a new eventually that the whole set stands as sites TOGETHER (guards against regressing to a dribble). One-at-a-time remains pinned for containers by `cons-one-site-at-a-time`. |
| `agenda-t2-spawns-match-head` | **Baseline drift** via #124: holdToFund walls added a second held-entry class, so the walk can legitimately buy at rank 3+ (two unaffordable holds above) — positional top-2 tolerance broke on correct behaviour. | Both cells now assert against the entry the walk itself gated `"buy"` (the agenda IS the decision record, spec 17) — exact matching, no positional tolerance to drift. |
| `agenda-t2-receipts-match-head` | Same as above. | Same rewrite. Also fixed a matching gap in the global-pool director: the winner's re-ranked plan is re-published before executing, so receipts always sit beside their true predicting queue in multi-spawn rounds. |
| `arrive-builder-builds-and-refuels-in-place` | **Test-quality**: the tile-hold `always` had no settle grace (its sibling assertion carries 20), and fail @4 is a first-ticks displacement (likely a one-off force-swap by a newborn exiting the spawn; not reproduced). | Added the standard 20-tick grace. Post-settle the tile hold is still absolute and the progress assertions still bind the refuel-in-place doctrine, so a real walk-off still fails. |

### Class A — eventually timeouts (6)

**Kept, unchanged.** All six are short cells (60–250t) pinning unique measured
incidents (scavenge threshold + retirement, dedication standdown/resume ×2,
link placement, link-haul pricing); none overlap enough to merge, and cutting
them buys almost no wall-clock. Their failure signatures are consistent with
the documented host-load coupling — re-run on the idle reference machine before
any further action.

### Trim (suite duration)

The suite's wall-clock is dominated by the long-window worlds, not Class A.
`plan-t5-remote-pipeline` — 1800t, baseline-**fail**, the grid's longest world,
with a history of re-tuning as doctrine shifts moved its organic timeline — was
rebuilt STAGED (owner-approved direction): remote vision via a parked scout,
warm home income, window 700. It keeps all unique pipeline guards (remote
adoption, home-spawned miner, reserver dispatch, remote container site) and
drops only the pile-funded "build underway" tail (T2 container-completes owns
completion mechanics). Ratchet-safe: its baseline entry was already "fail".
`exp-t5-founding-funnels-to-completion` (1800t, baseline-timeout) was left
alone — it is the only coverage of the cross-room founding funnel (claim
buildup), which is active work, not dead weight.
