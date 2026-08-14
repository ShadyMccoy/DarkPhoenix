# DarkPhoenix — agent playbook

Screeps AI built around ONE pure economy planner (`economy/CorpPlanner.ts`)
whose operators are corps. Read order for architecture truth:

1. [docs/ONTOLOGY.md](docs/ONTOLOGY.md) — the domain model (authoritative)
2. [docs/PIPELINE.md](docs/PIPELINE.md) — the live pipeline, `file → symbol` anchors
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
- **Fresh clone/sandbox: `npm run setup:test-env` BEFORE any grid/integration
  run**, then `npm run probe:mockup` (30s) to prove bot scripts execute. If
  `npm install` failed on `isolated-vm` and you fell back to
  `--ignore-scripts`, the driver's `runtime.bundle.js` is missing and every
  mockup bot dies at load INVISIBLY (the mockup swallows the error): server
  ticks, zero bot console output, every cell times out. That signature is a
  broken ENVIRONMENT, not a broken bot — details in
  [docs/TESTING_THE_ECONOMY.md](docs/TESTING_THE_ECONOMY.md).
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
  (enforced: nothing — prose)
- **Plan-vs-actual**: always report the planner's budget NEXT TO the measured
  actual (`npm run sim:real -- --metrics`; fid-* grid cells). On synthetic
  worlds the plan should be achievable — a fidelity gap there is a bug signal
  by construction.
- **Fidelity is an OBJECTIVE, not just a report** (owner 2026-07-30: "more
  than points what we're chasing is a controllable economy... so that we can
  plan it all on the abstract level and then it gets implemented faithfully...
  we end up having to chase down why is this or that thing happening. That's
  something to optimize for as well"). A plan the runtime does not follow costs
  more than the energy it misprices - it costs the DIAGNOSIS. Measured live by
  the ledger's **F1** line (measured spawn p/t vs plan-priced p/t, two-sided:
  an over-stating plan is as uncontrollable as an under-stating one). Prefer a
  fix that makes the plan and the runtime agree over one that buys points
  around the disagreement; when the two conflict, say so and fix the seam.
- **Two plans** (spec 11): the GOAL plan (`Memory.economyPlan`, solver
  equilibrium) is not a schedule. The NOW plan (`Memory.spawnAgenda`) is the
  transition. Tight assertions belong on actual-vs-NOW; NOW-vs-GOAL is a ramp
  gauge.
- **Macro doctrine**: production over consumption. Fund producers first, bank
  to the warchest, consumers burn the residual.
- **THE TENDER IS A HEARTBEAT — assume it works** (owner 2026-08-06: *"We have
  to assume the tender is working. It's a heart beat. It's non negotiable. The
  body dies slowly if there's issues there."*). The tender/feeder drain is an
  AXIOM every other rule builds on, not a variable to hedge against
  (enforced: nothing — prose). Two
  consequences, and the second is the one that keeps being missed:
  1. Never design around the possibility that it is failing. If a measurement
     suggests it is, that is a **P0 bug in the tender itself** — fix it there;
     never add a compensating rule elsewhere.
  2. **A drained core is the heartbeat WORKING, not congestion.** The core link
     is a pass-through to storage by design, so `coreEmptyShare` running high
     is health, and `toControllerRate` (link receipts into the CTRL link) is
     therefore NOT a controller-supply gauge — a healthy drained core makes it
     structurally small. The controller's supply line is storage → feeder.
     Read supply health from `dryShare` / `workUtil` on the upgrading corp
     (0.00 / 1.00 = the standing WORK is never starved), and read the
     controller line from P7. Measured t72808131: delivery tracks FIELDED WORK
     at ~1 e/t per part and nothing else — 48 WORK delivered 45.03 e/t,
     25 WORK delivered 39.33 e/t over a window straddling the death.
- **ONE VALVE: the plan allocation** (owner 2026-08-02, SUPERSEDES the former
  "sized from ACTUAL stock at their work site, never from the goal plan"). The
  upgrader fleet is sized from the plan's controller allocation and nothing
  else. The stock-grounded valve was added when the plan under-stated (t72448020:
  plan pinned at 2 with 234k banked); by 2026-08-02 it had inverted and was
  throttling BELOW a plan that no longer under-states (79.11 plan vs 2.00
  allowed; 81.19 vs 47.70) — the same failure it was built to prevent, sign
  flipped. **If the plan is wrong, fix the plan**: one number that can be
  audited beats two that disagree quietly. The bank still answers exactly one
  question here, and it is not sizing — FINANCING (`surplus` → holdToFund, so
  the walk can bank toward an indivisible full-size body).
  `sustainableConsumptionRate` remains the drain law for OTHER consumers
  (construction fuel, haul policy); it is no longer an upgrader valve.
  **The feeder is the same valve since spec 38 phase B (2026-08-03)**:
  `feederRelayTarget` = plan allocation + stock headroom in every regime (the
  surplus-regime override and `feederBodyRate` are retired; the t72455355
  floor lives INSIDE the plan as the controller sink reserve,
  `controllerFloorRate`). Off-plan readers resolve the published
  `Memory.controllerAllocations` through `bank.plannedControllerFlow` — never
  `feederRelayRate`, which is now a plan INPUT only (bank source rate).

## Economics rules

- ALL economic formulas live in `economy/primitives.ts`. No module reimplements
  them (the kind-conformance suite enforces this to 1e-9).
- Sink values are a strict ladder (spawn 100 > new-spawn-site 85 >
  claim-pump controller 82 > controller ≤80 > construction 70 > controller
  floor 40 > storage 1; claim-pump = an owned storage-less room's controller
  while a bank stands somewhere, owner 2026-08-13 "few corps more valuable
  than pumping up a new claim room") — never nudge one value in isolation
  (enforced: `test/unit/economy/goals.test.ts` rung-by-rung chain pin +
  `assertValuationInvariants` at compile; incident detail lives in the pin's
  docblock).

## Trap list (each of these has burned a session)

Spec 61 converts traps into DOORS (a cop, probe, or throwing helper at the one
seam the mistake passes through); a landed door's entry shrinks to a pointer,
and the incident detail lives in the enforcing test's docblock. **A new trap
entry ships with its door in the same PR, or carries an explicit
`(enforced: nothing — debt, spec 61)` marker.**

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
  no new haulers but strands nobody.) (enforced: nothing — prose)
- **Recycling counts as staffing** — a recycling incumbent still staffs its
  post; the pounce orders its own successor (enforced:
  `test/unit/framework/conformance.ts` recycling-lifecycle probe, per kind via
  its staffing fixture; unfixtured kinds are visible on `UNSTAFFED_KINDS`).
- **staffsPost symmetry** — demand and work sides must count a post through
  ONE lens (enforced, symptom-level: conformance live-at-post probe — no
  replacement demanded, no newborn churned; the two-lens root dies with spec
  39 phases 4–5).
- **Room state from intel, never creep positions or vision**: durable signals
  only — the draft plan's commissions (`CorpKind.propose(problem, draft)`) for
  "do we work this room", the shared `RoomDiscovery` lenses
  (`isReservableRoom`, `hostileRooms`) for room state (enforced: conformance
  propose-purity probe deletes Game/Memory — the stranded-reserver class fails
  there; the "work()/getSpawnDemand read the SAME lens" half is prose until it
  dies with spec 39 phases 4–5).
- **Grid staging**: stage through the vocabulary in `test/grid/stage.ts` —
  `gclPoints` (addBot's `gcl` is POINTS), `dbPatch` (dotted `$set` silently
  no-ops), `stagedStorage` (the OWNED schema) (enforced:
  `test/unit/grid/stage.test.ts` helper pins + the dotted-`$set` source cop
  over `test/grid/`).
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
  live creeps (enforced: conformance corp-id round-trip probe drives the live
  `resolveReadoption` per kind — spec 63's regression net; claimsOrphan kinds
  enroll as their staffing fixtures land, visible on `UNSTAFFED_KINDS`).
- **Sim blind spots**: sims never churn spawn ids, never lose room vision,
  never generate NPC raids, and STAGE NO roadRoutes receipts - a code path
  gated on them (paved repricing, trunk dedication) never executes in the
  integration trio, so its gate can pass for the wrong reason (measured
  t72475006: empty-plan crash live, trio green). Stage the receipts in a
  grid cell for any receipts-gated behavior (raid generation is a backend wall-clock cron
  the mockup doesn't run — invader noise is a LIVE-ONLY effect class; grid
  cells stage their raids by db insert). Don't claim live-readiness from
  sims alone. (enforced: nothing — prose)
- **CPU governor is DRY-RUN by default** (`Memory.cpuGovernor = "on"` arms it,
  live console only); an armed governor couples cell verdicts to HOST load
  (enforced: the grid harness refuses a cell staging it armed unless the cell
  declares `expectsGovernor: true` — `test/grid/stage.ts armedGovernorError`,
  pinned in `test/unit/grid/stage.test.ts`).

## Commands

| Command | What |
|---|---|
| `npm run build` | bundle to `dist/main.js` (do this before grid/integration) |
| `npm run test-unit` | unit suite (~seconds) |
| `npm run grid` / `grid:full` | inflection grid; `--cell <id>`, `--update-baseline` |
| `npm run sim:real -- --home <room> [--metrics]` | real-map sim on captured fixtures |
| `npm run capture:rooms -- --shard S --around R` | snapshot live rooms to fixtures |
| `npm run fiscal:archive` | close months from the BOT'S OWN boundary archive (segments 8-9) |
| `npm run sweep:arm [-- --pct N \| --status \| --disarm]` | arm/read the spawn-handicap sweep (spec 50) |
| `npm run journey:capture` | organic run → trip-point snapshots |
| `npm run sim:variance` / `sim:ab` | single-draw plan-vs-actual gauge / A/B harness (multi-draw = repeated `ab-cold-start` runs) |

App-specific login fields, seed users and workcell notes live in
`AGENTS_CUSTOM.md` (platform-owned) when present.
