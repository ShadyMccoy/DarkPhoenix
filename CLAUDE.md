# DarkPhoenix — agent playbook

Screeps AI built around ONE pure economy planner (`economy/CorpPlanner.ts`)
whose operators are corps. Read order for architecture truth:

1. [docs/ONTOLOGY.md](docs/ONTOLOGY.md) — the domain model (authoritative)
2. [docs/PIPELINE.md](docs/PIPELINE.md) — the live pipeline, file:line anchors
3. [docs/specs/](docs/specs/README.md) — the work: each spec IS its acceptance tests
4. The code. When code and ONTOLOGY disagree, that is a bug — fix it, don't drift.

## The workflow (non-negotiable)

- **The success metric is the grid**: `npm run grid` (spec 08), ratcheted in
  `test/grid/baseline.json`. BOT LEVEL = highest tier with every tier ≤ T fully
  green. Update the baseline **in the same commit** as the bot change that
  earned it.
- **ALWAYS `npm run build` before any grid/integration run** — they measure
  `dist/main.js`, not your working tree. A stale bundle has cost full false-red
  runs more than once.
- **Regression gate** for live-behavior changes: `npm run test-unit` PLUS the
  `flow-handoff`, `runt-economy`, `storage-depot` integration tests
  (`npx mocha "test/integration/<file>.test.ts"`, one file at a time).
- Write the failing test/cell FIRST. Acceptance criteria live in tests only;
  diag probes (`scripts/diag-*.ts`) are for investigation.
- `test/mocha.opts` has `--bail`: a red run reports only the FIRST failure —
  don't assume the rest of the suite is green.

## Epistemics (measured, not vibes)

- **Multi-draw rule**: identical-code 3000-tick draws vary ±20-30% (measured).
  Any tempo/throughput claim under ~30% needs multiple draws (`npm run
  sim:variance`). Grid-pinned deterministic behaviors are exempt.
- **Plan-vs-actual**: always report the planner's budget NEXT TO the measured
  actual (`npm run sim:real -- --metrics`; fid-* grid cells). On synthetic
  worlds the plan should be achievable — a fidelity gap there is a bug signal
  by construction.
- **Two plans** (spec 11): the GOAL plan (`Memory.economyPlan`, solver
  equilibrium) is not a schedule. The NOW plan (`Memory.spawnAgenda`) is the
  transition. Tight assertions belong on actual-vs-NOW; NOW-vs-GOAL is a ramp
  gauge.
- **Macro doctrine**: production over consumption. Fund producers first, bank
  to the warchest, consumers burn the residual and are sized from ACTUAL stock
  at their work site (`sustainableConsumptionRate`), never from the goal plan.

## Economics rules

- ALL economic formulas live in `economy/primitives.ts`. No module reimplements
  them (the kind-conformance suite enforces this to 1e-9).
- Sink values are a strict ladder (spawn 100 > new-spawn-site 85 >
  controller ≤80 > construction 70 > controller floor 40 > storage 1).
  Ordering inversions have zeroed colony-wide construction before (the
  90-vs-85 founding incident) — never nudge one value in isolation.

## Trap list (each of these has burned a session)

- **Bandaid rules: question the mechanism, not just its failure** (owner
  2026-07-20): a rule whose distress response is REVOCATION — retire
  commissions, strand the standing fleet — is the wrong class regardless of
  its trigger. Standing assets keep working their profitable routes; scarcity
  acts at the SPAWN (defund: no NEW bodies, via priority), and the planner
  prices — it doesn't gate. The retired remote gate took TWO patches (sticky
  window, then agenda reads) across two incidents (t72444963, t72448082: 238
  parts stranded, income 46→20, a 2150 hauler bought for an already-dropped
  route) before the rule itself was questioned. If you are writing the SECOND
  patch on the same mechanism, the mechanism is the bug — stop and interrogate
  it. (Correct-class contrast already in-tree: the hostile-route rule spawns
  no new haulers but strands nobody.)
- **Recycling counts as staffing**: do NOT exclude `recycling` creeps from
  staffing counts — the pounce-recycle path orders its own successor;
  excluding them double-orders (measured collapse to a 7-runt fleet).
- **staffsPost symmetry**: every consumer of "how many creeps does this post
  have" must use the SAME `staffsPost` lens as the demand side, or newborns
  get recycled at the spawn door (~25t churn loop, measured).
- **Room state from intel, never creep positions or vision**: a trigger keyed
  to "one of our creeps is standing there" flaps on every death AND goes blind
  with the vision the dead creep provided (stranded-reserver incident: target
  revoked mid-route, the 1300-energy reserver idled out its CLAIM lifetime, 10
  reserver spawns in 2400 ticks). Durable signals only: the draft plan's
  commissions (`CorpKind.propose(problem, draft)`) for "do we work this room",
  the shared `RoomDiscovery` lenses (`isReservableRoom`, `hostileRooms`) for
  room state — and work()/getSpawnDemand() must read the SAME lens.
- **Grid staging**: `addBot`'s `gcl` is POINTS, not level (1e6 = GCL 2). The
  mockup db's `$set` with dotted paths (`"store.energy"`) silently NO-OPS —
  write whole objects. Staged storage needs the OWNED schema
  (user + storeCapacityResource).
- **New corp kinds** integrate by REGISTRATION ONLY (spec 17): one kind file +
  one `KINDS` entry in CommissionHost. Demand policy, body building, orphan
  rescue, and the census all derive from the kind's declarations (`roles`,
  `demandGroup`, `sourceOf`, `claimsOrphan`, `body`) — if adding a kind seems
  to need an edit anywhere else, that's a framework regression; fix the seam,
  don't hand-wire. Enroll every kind in the conformance suite
  (`describeCorpKindConformance`). Every kind's `materialize` must refresh
  `spawnId` on existing corps (immortal consumer corps otherwise keep a dead
  spawn's id forever — conformance test enforces).
- **Corp id prefixes**: planner ids are pure (`harvest-{flowSourceId}`); kinds
  strip flow prefixes (`"source-"`, `"spawn-"`). A rename silently orphans
  live creeps.
- **Sim blind spots**: sims never churn spawn ids, never lose room vision,
  never generate NPC raids, and STAGE NO roadRoutes receipts - a code path
  gated on them (paved repricing, trunk dedication) never executes in the
  integration trio, so its gate can pass for the wrong reason (measured
  t72475006: empty-plan crash live, trio green). Stage the receipts in a
  grid cell for any receipts-gated behavior (raid generation is a backend wall-clock cron
  the mockup doesn't run — invader noise is a LIVE-ONLY effect class; grid
  cells stage their raids by db insert). Don't claim live-readiness from
  sims alone.
- **CPU governor is DRY-RUN by default** (`Memory.cpuGovernor = "on"` arms it,
  live console only). The mockup meters real CPU against a real bucket, so an
  armed governor couples cell behavior to HOST LOAD — a full grid run drained
  heavy worlds' buckets, paused construction colony-wide, and failed six
  baseline-green cells before this was caught.

## Commands

| Command | What |
|---|---|
| `npm run build` | bundle to `dist/main.js` (do this before grid/integration) |
| `npm run test-unit` | unit suite (~seconds) |
| `npm run grid` / `grid:full` | inflection grid; `--cell <id>`, `--update-baseline` |
| `npm run sim:real -- --home <room> [--metrics]` | real-map sim on captured fixtures |
| `npm run capture:rooms -- --shard S --around R` | snapshot live rooms to fixtures |
| `npm run journey:capture` | organic run → trip-point snapshots |
| `npm run sim:variance` / `sim:ab` | single-draw plan-vs-actual gauge / A/B harness (multi-draw = repeated `ab-cold-start` runs) |

App-specific login fields, seed users and workcell notes live in
`AGENTS_CUSTOM.md` (platform-owned) when present.
