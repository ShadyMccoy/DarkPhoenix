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

**All 10 failing cells are resolved and re-verified green by actual grid runs.**

**Environment root cause (why the PR sandbox looked broken):** installing with
`npm install --ignore-scripts` (needed because `isolated-vm`'s native build
fails under parallel make) skips `@screeps/driver`'s webpack step, leaving
`build/runtime.bundle.js` missing — every user script then dies at load with
`Cannot find module '../../build/runtime.bundle.js'`, and the mockup's console
parser DROPS the `error` field of the console event, so the failure is
invisible (bots simply "do nothing"). Fix: `npm run setup:test-env` (added
this session — idempotent, builds all three artifacts), verified by
`npm run probe:mockup`; full write-up in docs/TESTING_THE_ECONOMY.md
("Environment setup FIRST"). After that the mockup executes scripts normally
and every diagnosis below was reproduced and re-verified empirically.

**The report's Class A / host-load theory did not survive contact:** all six
"timeout" cells failed identically on a healthy sandbox. Every one was
baseline drift (deliberate doctrine changes the cells never caught up with) or
a staging artifact — none were host load, and none were code regressions.

### Verdicts (all 10, verified by re-run)

| Cell | Root cause | Fix |
|---|---|---|
| `cons-ext-first-site-checkerboard` | Drift: the extension rung BATCHES the whole remaining set (owner 2026-07-20); cell pinned retired one-at-a-time. Verified: all 5 sites land at t10. | Cell rewritten: cap bound (≤5) + "whole set stands together" pin. Containers keep one-at-a-time via `cons-one-site-at-a-time`. |
| `agenda-t2-receipts-match-head` | Drift via #124's holdToFund walls: the walk can buy at rank 3+ under stacked holds; positional top-2 broke on correct behaviour. | Gate-based matching (the entry the walk itself gated `"buy"`). Also: the global-pool director now re-publishes the winner's re-ranked plan before executing, so multi-spawn receipts match their true predicting queue. |
| `agenda-t2-spawns-match-head` | Same, PLUS a protocol off-by-one in the cell: a newborn's memory entry and its predicting queue land in the SAME tick's export, but the cell matched against the PREVIOUS sample's queue — flaked whenever the head flipped between ticks. | Gate-based matching against the CURRENT sample's queue. |
| `arrive-builder-builds-and-refuels-in-place` | Staging artifact + drift: staged containers carry no `nextDecayTime`, so the engine decays them 4,800 hits ON TICK 1 — below the 99% repair ceiling — and the repair detail (owner 2026-07-18: sites never impact repair) claims the cell's ONLY builder, freezing the site. (Earlier "displacement + grace" hypothesis was wrong; grace reverted.) | Freeze the fuel container's decay in staging; assertions restored to full strength. |
| `haul-t3-dedicated-standdown` | Same container-decay artifact: the repair detail ate builder bB, so "the build consumes B's output" could never fire. | Decay freeze in `dedicatedCommon` staging. |
| `haul-t3-dedicated-resume-container` | Same. | Same (the green groundpile sibling stays green). |
| `haul-t2-scavenge-threshold` | Drift: commissioning is bound by the MICRO-ROUTE FLOOR (owner 2026-07-20, `SCAVENGE_RATE_FLOOR`: rate = amount/2/effectiveLife ≥ 0.5 ⇒ ~1480 energy at this distance). The cell's 900-vs-600 pair sat entirely below the floor — the "commissions" half could mathematically never fire. | Restaged 3000 (commissions, pickup verified) vs 900 (the OLD threshold's yes-case — now pins that the floor overrides it). |
| `churn-retiring-scavenge-corp` | Two drifts: the floor (900 never commissioned), and the retiring contract itself — `flagRetiringForRecycling` (live incident t72525241) now RECYCLES a route-less empty hauler for the refund instead of driving it to natural death, which the cell's "never recycled" pin predates. | Restaged above the floor (1700; decay crosses deterministically) and the cell now pins the CURRENT wind-down: deliver cargo → recycle at spawn → no successor → never orphan-stamped. Full lifecycle verified (fielded @11, floor @66, clean recycle @109). |
| `cons-link-farthest-source` | Drift: spec 24 rung 3 places the CONTROLLER link above every source link; at RCL5's 2-link limit (core + controller) a source link can never place. Verified: the "link site" observed was the controller link at (8,8). | Restaged at RCL6 (3 links) with core + controller links prebuilt and the full 40-extension set (an unbuilt remainder batch-holds the queue above the link rung). The farthest-source selection doctrine itself still holds — passes @20. |
| `plan-t4-link-haul-pricing` | Drift: spec 24's LINK SWAP (t72465499) DESTROYED the staged source link on the first pass (controller link outvalues it; RCL5 slots full), killing the pump and the pricing under test. | Restaged at RCL6 with a prebuilt controller link; the staged pump survives. Passes @10/@23. |

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
