# DarkPhoenix - Screeps Economic AI

A Screeps AI that models a colony as a profit-seeking economy. Instead of hardcoded state machines, operations compete for resources through price signals and economic mechanisms.

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

Most Screeps AIs are state machines: "if energy low, spawn harvester." This works, but it's brittle. Add new features and the logic tangles.

DarkPhoenix takes a different approach: **let the market decide**.

Instead of hardcoding what to do, we define *operations* (small units of work with inputs, outputs, and costs) and let economic actors compete to fund them. Good decisions emerge from price signals, not explicit rules.

## Architecture Overview

```
src/
├── main.ts              # Game loop entry point
├── core/                # Base classes
│   └── RoomRoutine.ts   # Routine lifecycle & economic tracking
├── routines/            # Colony operations
│   ├── Bootstrap.ts     # Early-game setup
│   ├── EnergyMining.ts  # Harvester management
│   ├── EnergyCarrying.ts # Logistics
│   └── Construction.ts  # Builder management
├── spatial/             # Room analysis
│   └── RoomMap.ts       # Peak detection & territories
├── planning/            # GOAP planning
│   └── Agent.ts         # Goal-oriented behavior
├── types/               # Domain types
│   ├── SourceMine.ts    # Mining configuration
│   └── EnergyRoute.ts   # Transport routes
└── utils/               # Utilities
    └── ErrorMapper.ts   # Error handling
```

## Economic Framework

### Colony Hierarchy

```
Colony (single AI controlling all rooms)
  └── Room (per-room operations)
        └── Routine (per-domain: mining, logistics, construction)
              └── Creep (smallest executable unit)
```

### Requirements/Outputs Pattern

Every routine declares explicit resource contracts:

```typescript
// EnergyMining routine
requirements: [
  { type: 'work', size: 2 },      // 2 WORK parts
  { type: 'move', size: 1 },      // 1 MOVE part
  { type: 'spawn_time', size: 150 } // Spawn time
]

outputs: [
  { type: 'energy', size: 10 }    // ~10 energy/tick
]
```

This enables:
- **ROI Calculation**: `(actualValue - cost) / cost`
- **Performance Tracking**: Historical records per routine
- **Market Coordination**: Resources flow where they're most valuable

### Design Principles

1. **Emergent over explicit** - Don't hardcode "build extensions before towers." Let the market discover optimal strategies.

2. **Tolerate failure** - Operations can fail. The system recovers through redundancy and adaptation.

3. **Small operations** - The smaller the operation, the more opportunities for optimization.

4. **Test via simulation** - Generate random rooms, measure ROI, iterate.

## Routine System

### Bootstrap (RCL 1-2)

Manages multi-purpose "jack" creeps for colony initialization:

| Property | Value |
|----------|-------|
| Body | `[WORK, CARRY, MOVE]` |
| Cost | 200 energy |
| Quantity | 2 maintained |
| Behavior | Harvest -> Deliver -> Upgrade |

### EnergyMining

Dedicated harvesters at each energy source:

| Property | Value |
|----------|-------|
| Body | `[WORK, WORK, MOVE]` |
| Cost | 200 energy |
| Output | ~10 energy/tick |
| Auto-build | Containers at 500+ piles |

### EnergyCarrying

Route-based logistics between sources and consumers:

| Property | Value |
|----------|-------|
| Body | `[CARRY, CARRY, MOVE, MOVE]` |
| Cost | 200 energy |
| Capacity | 100 energy |
| Routing | Waypoint-based cycles |

### Construction

One builder per active construction site:

| Property | Value |
|----------|-------|
| Body | `[WORK, CARRY, MOVE]` |
| Cost | 200 energy |
| Lifecycle | Self-terminating on completion |

## Spatial Analysis

The `RoomMap` system uses sophisticated algorithms to identify optimal building locations:

### Distance Transform

```
Wall Distance --> Invert --> Distance Transform --> Find Peaks
     0              HIGH          HIGH VALUES          LOCAL MAX
   (walls)          (walls)       (open areas)         (building zones)
```

### Peak Detection

- Finds local maxima (most open areas)
- Clusters same-height tiles into plateaus
- Calculates centroids for precise positioning

### Territory Division

- BFS flood fill from peaks
- Each tile assigned to nearest peak
- Enables zone-based resource allocation

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
| `src/` | Source code |
| `src/core/` | Base classes and lifecycle management |
| `src/routines/` | Colony operation routines |
| `src/spatial/` | Room analysis and territory mapping |
| `src/planning/` | GOAP behavior planning system |
| `src/types/` | TypeScript interfaces and domain types |
| `src/utils/` | Utility functions and helpers |
| `docs/` | Extended documentation |
| `test/` | Unit and simulation tests |

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md) - System design and components
- [Economic Framework](docs/ECONOMIC_FRAMEWORK.md) - Market mechanics and ROI tracking
- [Routine System](docs/ROUTINES.md) - Colony operations guide
- [Spatial Analysis](docs/SPATIAL_SYSTEM.md) - RoomMap algorithms and territory division

## Roadmap

### Implemented
- Bootstrap routine for early-game
- Energy mining with dedicated harvesters
- Construction management
- Spatial analysis with peak detection
- Performance tracking with ROI metrics

### Planned
- Multi-room coordination
- Full market-driven pricing
- Defense operations
- Remote mining
- Advanced logistics optimization

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes with tests
4. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Acknowledgments

Built on the [Screeps TypeScript Starter](https://github.com/screepers/screeps-typescript-starter) template.
