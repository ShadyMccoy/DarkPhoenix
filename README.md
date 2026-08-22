# DarkPhoenix — Screeps AI (v2 line)

A Screeps AI being rebuilt from an empty `src/` around one pure economy
planner. **[docs/REBOOT.md](docs/REBOOT.md)** is the constitution of the
rewrite: why v1 was blown up (2026-08-18), what doctrine carries over, the
architecture bet, and the milestone ladder.

- **v1** — 45k lines, RCL8 / GCL 32, still running the live shard1 colony —
  lives on `master` and in this branch's history. `docs/` (ONTOLOGY,
  PIPELINE, 60+ specs, the spec-14 session records, the fiscal closes) is
  its archive and v2's reference library.
- **v2** — this line. One `World` snapshot per tick, a pure planner whose
  output is literal jobs and spawn orders, stateless order-taking
  executors, and a plan-vs-actual fidelity line from tick one.

## Quickstart

```bash
npm run setup:test-env   # fresh clone: install + build the mockup's native/webpack artifacts
npm run probe:mockup     # 30s: prove the mockup executes bot scripts (M0)
npm run build            # webpack → dist/main.js (mockup runs measure THIS)
npm run test-unit        # pure-math units
npm run test-integration # build + mockup milestones (M1+ acceptance)
```

## Layout

| Path | What |
|---|---|
| `src/` | the v2 bot (kept deliberately small — see REBOOT.md's size budget) |
| `test/integration/helper.ts` + `scenario/` | mockup server harness + world staging (implementation-agnostic: runs `dist/main.js`) |
| `test/grid/` | the inflection-grid engine (cells return at M6 with a fresh v2 baseline) |
| `test/fixtures/` | captured real rooms, telemetry snapshots, incidents |
| `scripts/` | env setup, grid runner, live-account tools (`capture:*`, `fiscal:*`, `sweep:arm`, deploy) |
| `docs/` | the v1 archive + `REBOOT.md` |

## The live rule

The live account runs v1 from `master`. Nothing from the v2 line deploys
(`push-main` / `deploy`) until REBOOT.md's M6 gate is green and the owner
calls M7 (adopt vs respawn).
