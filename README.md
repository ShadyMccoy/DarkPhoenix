# DarkPhoenix - Screeps Flow-Based AI

A Screeps AI built around a single pure economy planner. Instead of hardcoded
state machines or market price discovery, one deterministic solver —
`economy/CorpPlanner.ts` — reasons over an abstract world description
(spawns, sources, sinks, real path distances) and commissions **corps**:
units of economic activity that consume spawn build-time (± energy) and
produce energy-at-a-place or colony value.

> **Doc authority:** [docs/ONTOLOGY.md](docs/ONTOLOGY.md) (domain model) and
> [docs/PIPELINE.md](docs/PIPELINE.md) (the live pipeline, `file:line`
> anchors) reflect the code as it is. If any doc disagrees with them, they win.

## Quick Start

```bash
# Install dependencies
npm install

# Configure your Screeps credentials
cp screeps.sample.json screeps.json
# Edit screeps.json with your token

# Build and deploy
npm run build
npm run push-main
```

## The Core Idea

Most Screeps AIs use either:
- **State machines**: "if energy low, spawn harvester" - brittle, hard to extend
- **Market economies**: price discovery through supply/demand - slow to converge, circular dependencies

DarkPhoenix plans the colony as one economic problem with **two currencies**:

- **Energy** (e/tick) — what sources yield and sinks consume.
- **Spawn build-time** (parts/tick) — a spawn builds 1 body part / 3 ticks;
  this is usually the *tighter* wall, and it is priced in energy so far
  sources fall out of contention without any hard distance cap.

Each solve (every 50 ticks) runs two pure phases:

1. **Producer selection** — assign each source to its nearest spawn, drop
   net-negative sources, fill each spawn's mining build-time budget in
   net-energy-per-build-part order.
2. **Value routing** — route the produced energy to sinks by value
   (spawn 100 > new-spawn site 85 > controller ≤ 80 > construction 70 >
   storage 1), a reserve pre-pass guaranteeing critical floors (e.g. the
   anti-downgrade trickle) first. Each source→sink flow becomes a hauler.

The plan is wrapped into **Commission** envelopes and materialized into
runtime corps by pluggable **CorpKinds** (`corps/kinds/`) — new capabilities
plug in by declaring their shape, without editing the planner core, the
runner, or `main.ts`. All economic formulas live in ONE place,
[`economy/primitives.ts`](src/economy/primitives.ts); a conformance suite
enforces that no kind ships its own math.

```
terrain ─▶ Nodes ─▶ FlowGraph ─▶ ColonyProblem ─▶ ColonyPlan ─▶ Commissions ─▶ Corps ─▶ creeps
```

See [docs/PIPELINE.md](docs/PIPELINE.md) for every hop with source anchors.

## Corps System

Corps are business units that execute commissioned work:

| Corp | Shape | Purpose |
|------|-------|---------|
| HarvestCorp | produce | static miners on assigned sources |
| CarryCorp | transport | haulers sized to route flow (2:1 body on paved routes) |
| UpgradingCorp | consume | controller upgrading, sized from actual stock |
| ConstructionCorp | consume + auxiliary | building, paving, repair ladder |
| ExtensionTenderCorp / ControllerFeederCorp | auxiliary | local movers: depot→extensions, storage→controller |
| ScoutCorp / ReservationCorp / ClaimCorp | auxiliary | intel, remote reservation, expansion claiming |
| SpawningCorp / BootstrapCorp | infrastructure | spawn queue execution; cold-start jacks (not commissioned) |

Auxiliary kinds `propose()` their own commissions when preconditions hold;
producer/transport/consumer commissions come from the solver. The spawn side
honors a **delivery contract** (`staffsPost`): an incumbent inside its
replacement lead time no longer counts as staffing, so successors spawn early
and posts never go dark.

## Spatial Analysis

The `RoomMap` system identifies optimal locations:

### Distance Transform → Peak Detection → Territory Division

```
Wall Distance → Invert → Distance Transform → Find Peaks
     0           HIGH         HIGH VALUES        LOCAL MAX
   (walls)      (walls)      (open areas)    (building zones)
```

Peaks become territory centers. Each tile is assigned to its nearest peak,
creating natural zones for resource allocation.

## Development

### Building

```bash
npm run build          # Compile TypeScript (grid/integration measure dist/main.js!)
npm run watch          # Watch mode
npm run push-main      # Deploy to main server
npm run push-sim       # Deploy to simulation
```

### Testing

Local verification runs entirely in Node — no Docker, no Steam key.

```bash
npm test                  # Run unit + integration tests
npm run test-unit         # Fast unit tests (mocked Game API)
npm run test-integration  # Build, then run the bot against a full in-process Screeps engine
npm run grid              # The inflection-point grid (spec 08) — the repo's success metric
npm run sim:real -- --home W1N6 --metrics   # Real-map sim with plan-vs-actual sampling
```

The **grid** (`test/grid/`, spec 08) is the primary metric: ~114 cells stage
worlds at decision moments and assert the decision plus its consequence in a
short window, ratcheted in `test/grid/baseline.json` (BOT LEVEL = highest
tier fully green). Real captured rooms live in `test/fixtures/real-rooms/`;
journey snapshots replay organic ramp moments. Integration tests use
[`screeps-server-mockup`](https://github.com/screepers/screeps-server-mockup).
See [docs/in-depth/testing.md](docs/in-depth/testing.md) and
[CLAUDE.md](CLAUDE.md) for the workflow rules.

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/economy/` | The planner: CorpPlanner, primitives (canonical math), Commission/CorpKind framework |
| `src/corps/` | Runtime corps + `kinds/` (the pluggable CorpKind implementations) |
| `src/execution/` | Live-loop glue: CommissionHost, SpawnDirector, OrphanRescue, LinkRunner |
| `src/spawn/` | Pure body building + spawn scheduling math |
| `src/flow/` | Legacy translation layer: FlowGraph world discovery + FlowSolution output shape |
| `src/nodes/`, `src/spatial/` | Territory model, path distances, room analysis |
| `src/telemetry/` | RawMemory segment exports (dashboard: `telemetry-app/`) |
| `docs/` | ONTOLOGY, PIPELINE, specs (each spec = its acceptance tests) |
| `test/` | unit, integration, grid cells, real-room + journey fixtures |

## Roadmap

### Implemented
- Single pure economy planner (two currencies, value routing, reserve floors)
- CorpKind commission framework — all corp kinds run through CommissionHost
- Delivery contract (gapless replacement), runt-recycle upsizing
- Storage banking + local movers (extension tender, controller feeder)
- Link networks (source→core link transport), road economics + paved-route bodies
- Remote mining with reservation; capital-gated expansion (claim + founding)
- The inflection-point grid + real-map fixtures + journey snapshot replay

### Planned (see docs/specs/)
- Storage draw-down as planner supply (spec 03)
- The NOW plan: spawn agenda as the transition contract (spec 11)
- Robustness program: chaos harness, incident pipeline, CPU governor (spec 09)
- Tower defense (spec 07, deferred)

## Documentation

- [Ontology](docs/ONTOLOGY.md) - the domain model (authoritative)
- [Pipeline](docs/PIPELINE.md) - the live architecture, end to end
- [Task specs](docs/specs/README.md) - current work, each with acceptance tests
- [Economic Framework](docs/ECONOMIC_FRAMEWORK.md) - effective energy, spawn-part pricing
- [Spatial Analysis](docs/SPATIAL_SYSTEM.md) - RoomMap algorithms and territories

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Acknowledgments

Built on the [Screeps TypeScript Starter](https://github.com/screepers/screeps-typescript-starter) template.
