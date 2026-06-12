# 05 — Toolchain upgrade

**Status:** approved by owner ("not married to it in any way"), not started.
**Priority:** P2 — after the behavior-changing specs, never mixed into the
same commit as one (bisectability is the whole point of separating them).

## Current state

| Tool | Now | Target | Notes |
|------|-----|--------|-------|
| lodash | 3.10 (2015) + `@types/lodash` 3.10 | **remove** | check usage first; Screeps's global `_` is provided by the server at runtime — the local dep likely only feeds tests/types |
| mocha | 5.2 | ^10 | `test/mocha.opts` is dead in mocha 6+ → `.mocharc.yml` |
| chai/sinon/sinon-chai | 4.x/6.x/3.x | latest compatible | mechanical |
| typescript | 4.9 | ^5.x | `rollup-plugin-typescript2`/`ts-loader` compat |
| @types/node | 13 | match engine (>=18) | |
| eslint | 7 + @typescript-eslint 4 | 8.x + @typescript-eslint 6/7 first | eslint 9 flat-config is a separate later step; don't take both jumps at once |
| webpack 5 / rollup 2 | dual build | keep both for now | rollup is the deploy path (`push-*`), webpack the test-bundle path; unifying is OPTIONAL and last |

## Staging — one commit per stage, full gate after each

1. **Stage A — inventory (no changes):** `grep -rn "lodash\|from \"_\"\|_\\."
   src/ test/ scripts/` and record what actually depends on lodash; run
   `npm outdated` and commit the plan deltas to this spec.
2. **Stage B — test stack:** mocha 10 (+ `.mocharc.yml`, delete
   `test/mocha.opts`), chai/sinon/@types bumps. No src changes allowed.
3. **Stage C — TypeScript 5:** bump `typescript`, `ts-node`, `ts-loader`,
   `rollup-plugin-typescript2`. Fix new compile errors only — behavior-neutral
   mechanical edits; anything judgement-y gets split out and flagged.
4. **Stage D — lodash removal** (or upgrade to 4 if removal is blocked):
   replace call-sites with natives.
5. **Stage E — eslint 8 + @typescript-eslint upgrade:** expect new lint
   errors; auto-fix what's mechanical, and the error count afterward must be
   **≤ the count before** (43 at last measure) — no rule-disabling to cheat.
6. **Stage F (optional) — single bundler.**

## Acceptance tests (per stage; the gate IS the spec)

A stage passes only if, in that stage's commit:

1. `npm ci` from scratch succeeds on Node 18 (delete `node_modules` first —
   catches phantom transitive deps).
2. `npm run test-unit`: **same count or more** tests passing as the previous
   stage (currently 400) — zero skips added.
3. `npm run build` (webpack) emits `dist/main.js` and
   `npx rollup -c --environment DEST:sim` compiles (deploy path not broken;
   it can target a dummy dest, the check is compile + bundle, not upload).
4. Integration smoke: `flow-handoff` green (full integration set for stages
   C and D, which can change emitted JS semantics).
5. `git diff --stat` for the stage touches **only** config/lock/test files
   unless the stage explicitly allows src edits (C and D), and any src edit
   is mechanical (reviewer judgement, but the rule forces the question).

## Risks

- screeps-server-mockup 1.5 pins old engine deps; if a bump breaks it, the
  integration harness is untouchable — stop and re-plan rather than fork it.
- `@types/screeps` 3.2 may lag TS 5 strictness; acceptable to pin TS to the
  newest version that's clean.
