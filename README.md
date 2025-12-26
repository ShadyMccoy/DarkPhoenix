# DarkPhoenix - Screeps Flow-Based AI

A Screeps AI that uses max-flow min-cost (MFMC) algorithms for optimal resource allocation. Instead of hardcoded state machines or slow market price discovery, a centralized solver allocates energy based on priority weights and transport costs.

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

DarkPhoenix takes a different approach: **flow-based allocation**.

A centralized FlowSolver models the colony as a network of sources (energy producers), sinks (energy consumers), and edges (transport paths). Each tick, it computes the optimal allocation based on:
- **Priorities**: Spawn is always critical (100), towers spike during combat (95), construction rises after RCL-up (80)
- **Costs**: Transport distance affects which source serves which sink
- **Capacity**: Each source has limited output, each edge has limited throughput

## Architecture Overview

```
src/
├── main.ts              # Game loop entry point
├── flow/                # Flow-based economy
│   ├── FlowGraph.ts     # Network of sources, sinks, edges
│   ├── FlowSolver.ts    # MFMC allocation algorithm
│   └── PriorityManager.ts # Dynamic priority calculation
├── corps/               # Business units
│   ├── MiningCorp.ts    # Harvester management
│   ├── HaulingCorp.ts   # Logistics
│   ├── UpgradingCorp.ts # Controller upgrades
│   └── SpawningCorp.ts  # Creep production
├── nodes/               # Territory regions
│   └── Node.ts          # Spatial territory with resources
├── spatial/             # Room analysis
│   └── RoomMap.ts       # Peak detection & territories
├── planning/            # Chain validation
│   └── ChainPlanner.ts  # Complete path verification
├── types/               # Domain types
└── utils/               # Utilities
```

## Flow-Based Economy

### How It Works

```
SOURCES (Energy Producers)
├── Source A: 10 energy/tick
└── Source B: 10 energy/tick

         ↓ FlowSolver allocates by priority ↓

SINKS (Energy Consumers)
├── Spawn (priority 100): Gets energy first
├── Tower (priority 95 during combat): Defense priority
├── Construction (priority 80): Building phase
├── Controller (priority 70): Normal upgrading
└── Storage (priority 5): Excess buffer
```

### Priority-Based Allocation

Priorities adjust dynamically based on game state:

```typescript
// After RCL-up with 5 construction sites
context = { rcl: 3, constructionSites: 5, hostileCreeps: 0 }
priorities = { spawn: 100, construction: 80, controller: 10 }
// → Energy flows: Spawn 15%, Construction 60%, Controller 25%

// After construction complete
context = { rcl: 3, constructionSites: 0, hostileCreeps: 0 }
priorities = { spawn: 100, construction: 0, controller: 70 }
// → Energy flows: Spawn 15%, Controller 85%
```

### Benefits Over Markets

| Aspect | Market-Based | Flow-Based |
|--------|--------------|------------|
| Bootstrap problem | Circular: corps need energy to make offers | Single solve: no dependencies |
| State changes | Slow price discovery | Instant priority update |
| Optimization | Local (each corp decides) | Global (solver sees all) |
| Complexity | O(offers²) matching | O(sources × sinks) |

## Corps System

Corps are business units that execute allocated work:

| Corp | Purpose | Allocation Source |
|------|---------|-------------------|
| MiningCorp | Harvest energy sources | FlowSource assignment |
| HaulingCorp | Transport resources | FlowEdge assignment |
| UpgradingCorp | Upgrade controller | Controller sink allocation |
| ConstructionCorp | Build structures | Construction sink allocation |
| SpawningCorp | Spawn creeps | Spawn capacity |
| BootstrapCorp | Emergency recovery | Starvation fallback only |

## Spatial Analysis

The `RoomMap` system identifies optimal locations:

### Distance Transform → Peak Detection → Territory Division

```
Wall Distance → Invert → Distance Transform → Find Peaks
     0           HIGH         HIGH VALUES        LOCAL MAX
   (walls)      (walls)      (open areas)    (building zones)
```

Peaks become territory centers. Each tile is assigned to its nearest peak, creating natural zones for resource allocation.

## Development

### Building

```bash
npm run build          # Compile TypeScript
npm run watch          # Watch mode
npm run push-main      # Deploy to main server
npm run push-sim       # Deploy to simulation
```

### Testing

```bash
npm test               # Run unit tests
npm run test:sim       # Run simulation tests
```

### Docker (Headless Server)

```bash
docker-compose up -d   # Start headless server
docker-compose logs    # View server logs
docker-compose down    # Stop server
```

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/flow/` | Flow-based economy (MFMC solver, priority manager) |
| `src/corps/` | Business units executing allocated work |
| `src/nodes/` | Territory regions derived from spatial analysis |
| `src/spatial/` | Room analysis and territory mapping |
| `src/planning/` | Chain planning and validation |
| `src/types/` | TypeScript interfaces and domain types |
| `src/utils/` | Utility functions and helpers |
| `docs/` | Extended documentation |
| `test/` | Unit and simulation tests |

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md) - System design and components
- [MFMC Migration Plan](docs/MFMC_MIGRATION_PLAN.md) - Flow-based economy design
- [Economic Framework](docs/ECONOMIC_FRAMEWORK.md) - Resource allocation and ROI
- [Spatial Analysis](docs/SPATIAL_SYSTEM.md) - RoomMap algorithms and territories

## Roadmap

### Implemented
- Flow-based resource allocation (MFMC solver)
- Priority-weighted energy distribution
- Spatial analysis with peak detection
- Territory-based node system
- Corps executing allocated work

### Planned
- Multi-room flow networks
- Defense priority escalation
- Remote mining as extended territories
- Mineral/boost flow integration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Acknowledgments

Built on the [Screeps TypeScript Starter](https://github.com/screepers/screeps-typescript-starter) template.
