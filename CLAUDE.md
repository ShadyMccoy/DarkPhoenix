# DarkPhoenix — agent playbook (v2 line)

This branch line is the **v2 rewrite** (owner decision 2026-08-18: "blow it
up and start over"). **[docs/REBOOT.md](docs/REBOOT.md) is the constitution**
— the why, the architecture bet, the milestone ladder. Read it before
touching `src/`.

The v1 bot lives on `master` and still runs the live shard1 colony
(RCL8 / GCL 32). `docs/` (ONTOLOGY, PIPELINE, the specs, spec 14's session
records) is v1's archive: the reference library for decisions, **not law**.
When v2 needs a formula v1 hardened, port it from
`git show master:src/economy/primitives.ts` with its docblock and pin it
with a test — never re-derive from memory what v1 already paid to verify.

## The law (v2 — structural, not checklist)

1. **One snapshot.** `src/world.ts` is the only module that reads `Game.*`
   or raw `Memory`. Planner and executors read only the `World` value. A
   second lens on the same fact is the v1 disease — don't write one.
2. **The plan is the only state — and the plan IS the corps.** One
   representation per thing (owner 2026-08-18): a corp is a row in the
   plan (`Plan = { corps: Corp[] }`), never a class with a lifecycle;
   demand = target − (live + in-spawn), computed in one place. No mirror
   objects, no derived caches in Memory. A global reset must be a
   non-event.
3. **Every game verb has one owner** (owner 2026-08-18: "harvest corp
   harvests, spawn corp spawns"). A verb with one corporate user lives in
   that corp kind's vertical (`corps/<kind>.ts` — pricing, runner, and
   the codebase's only call site); universal verbs (move/transfer/
   withdraw/pickup) live in the one shared desk. Every chokepoint stamps
   through one counter (intents + same-tick clobber), lint-enforced.
   Rows never gain methods; an economic decision inside a runner belongs
   in the planner. REBOOT.md "The planning concept" holds the full
   shaped design.
4. **Fidelity line from tick one:** the plan prints expected e/t next to
   measured actual. A gap is a P0 at the seam — never valve around it.
5. **Sizing is solved once** (owner 2026-08-18). Bodies are derived by ONE
   pure module that every job kind calls; a second sizing site anywhere is
   the v1 thrash coming back. Its unit suite is the exhaustive one.
6. **Size budget:** src stays under ~3k lines until the grid ratchet
   (M6) says otherwise. Grow the planner's vocabulary, not new mechanisms.
   A change that needs a trap-list entry to be safe is the wrong change.
7. **Tests assert outcomes WITH an economic oracle** — survival alone is
   the v1 failure (wrong bodies don't fail, they waste). Milestone cells
   also assert: no body exceeding what the sizing module derives for its
   job (recomputed in the test), and plan-vs-actual inside a band pinned
   from a multi-draw baseline. Never pin internal shapes.

Carried doctrine (see REBOOT.md "what was never the problem"): production
over consumption; the tender heartbeat is an axiom; the sink ladder moves
only as a list; measured-not-vibes (±20-30% single-draw variance is real —
multi-draw any tempo claim); value-per-intent is the north star.

## Workflow

- **ALWAYS `npm run build` before any mockup/integration run** — they
  measure `dist/main.js`, not your working tree.
- **Fresh clone/sandbox: `npm run setup:test-env` first**, then
  `npm run probe:mockup` (30s). If bots produce zero console output and
  cells time out, the driver's `runtime.bundle.js` is missing — a broken
  ENVIRONMENT, not a broken bot (the script's header documents it).
- Gate: `npm run test-unit` + `npm run test-integration` (harness
  self-tests + the v2 milestone tests).
- **Milestones are owner-gated** (REBOOT.md working agreement): acceptance
  criteria are agreed with the owner BEFORE code is written toward them.
  Rulings recorded in REBOOT.md are the record; don't act on inferred ones.
- Write the failing test first; acceptance criteria live in tests only.
- `test/mocha.opts` has `--bail`: a red run shows only the FIRST failure.
- **The live rule: never run `push-main`/`deploy` from the v2 line** until
  REBOOT.md's M7 is called by the owner. Live-servicing scripts
  (`capture:*`, `fiscal:*`, `sweep:arm`, `rescue-console`) talk to the
  LIVE v1 bot and remain safe to run.
