# Headless Testing & Simulation

This guide explains how to run Screeps simulations locally for testing colony behavior without deploying to the live servers.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Testing Stack                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐     ┌──────────────────────────────┐ │
│  │   Unit Tests     │     │      Simulation Tests        │ │
│  │   (Fast, Mock)   │     │    (Full Server, Docker)     │ │
│  ├──────────────────┤     ├──────────────────────────────┤ │
│  │ • GameMock.ts    │     │ • ScreepsSimulator.ts        │ │
│  │ • Mocha/Chai     │     │ • Scenario files             │ │
│  │ • No server      │     │ • HTTP API to server         │ │
│  └──────────────────┘     └──────────────────────────────┘ │
│           │                            │                    │
│           │                            ▼                    │
│           │               ┌──────────────────────────────┐ │
│           │               │     Docker Compose Stack     │ │
│           │               ├──────────────────────────────┤ │
│           │               │ • screeps-launcher           │ │
│           │               │ • MongoDB                    │ │
│           │               │ • Redis                      │ │
│           │               └──────────────────────────────┘ │
│           │                                                 │
│           ▼                                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Your Screeps Code (src/)               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Option 1: Docker-based Full Simulation (Recommended)

1. **Prerequisites**:
   - Docker & Docker Compose
   - Steam API key (get one at https://steamcommunity.com/dev/apikey)

2. **Setup**:
   ```bash
   # Set your Steam API key
   export STEAM_KEY="your-steam-api-key"

   # Start the server
   npm run sim:start

   # Reset the world (first time only)
   npm run sim:cli
   # In CLI: system.resetAllData()
   ```

3. **Deploy and test**:
   ```bash
   # Build and deploy your code
   npm run sim:deploy

   # Watch for changes and auto-deploy
   npm run sim:watch
   ```

### Option 2: Lightweight Mocks (Fast Unit Tests)

For quick iteration without a server:

```typescript
import { createMockGame, addMockCreep } from '../test/sim/GameMock';

// Create a mock game environment
const { Game, Memory } = createMockGame({ rooms: ['W0N0'] });

// Add test creeps
addMockCreep(Game, Memory, {
  name: 'Harvester1',
  room: 'W0N0',
  body: ['work', 'work', 'carry', 'move'],
  memory: { role: 'harvester' }
});

// Test your code
// ...
```

## Commands Reference

### Simulation Server Commands

| Command | Description |
|---------|-------------|
| `npm run sim:start` | Start the Docker server stack |
| `npm run sim:stop` | Stop the server |
| `npm run sim:cli` | Open server CLI |
| `npm run sim:deploy` | Build and deploy code |
| `npm run sim:watch` | Watch mode with auto-deploy |
| `npm run sim:reset` | Wipe all game data |
| `npm run sim:bench` | Run benchmark (1000 ticks) |

### Scenario Testing

| Command | Description |
|---------|-------------|
| `npm run scenario:list` | List available scenarios |
| `npm run scenario bootstrap` | Run bootstrap scenario |
| `npm run scenario energy-flow` | Run energy flow scenario |
| `npm run scenario:all` | Run all scenarios |

### Direct Script Access

```bash
# Full help
./scripts/sim.sh help

# Control tick rate
./scripts/sim.sh fast     # 50ms ticks (20 ticks/sec)
./scripts/sim.sh slow     # 1000ms ticks (1 tick/sec)

# Run specific number of ticks
./scripts/sim.sh tick 500

# Pause/resume
./scripts/sim.sh pause
./scripts/sim.sh resume
```

## Writing Scenarios

Scenarios are automated tests that run against the full server. Create new ones in `test/sim/scenarios/`:

```typescript
// test/sim/scenarios/my-test.scenario.ts

import { createSimulator } from '../ScreepsSimulator';

export async function runMyTestScenario() {
  const sim = createSimulator();
  await sim.connect();

  // Run 100 ticks and capture state
  const snapshots = await sim.runSimulation(100, {
    snapshotInterval: 10,
    rooms: ['W0N0'],
    onTick: async (tick, state) => {
      // Check conditions each snapshot
      console.log(`Tick ${tick}: ${state.rooms['W0N0'].length} objects`);
    }
  });

  // Return metrics
  return {
    finalCreepCount: await sim.countObjects('W0N0', 'creep'),
    totalSnapshots: snapshots.length
  };
}

export function validateMyTest(metrics) {
  return metrics.finalCreepCount >= 5;
}
```

## ScreepsSimulator API

The `ScreepsSimulator` class provides programmatic access to the server:

```typescript
const sim = createSimulator({ host: 'localhost', port: 21025 });

// Connection
await sim.connect();
await sim.authenticate('user', 'password');  // For screepsmod-auth

// Game state
const tick = await sim.getTick();
const objects = await sim.getRoomObjects('W0N0');
const memory = await sim.getMemory();

// Control
await sim.console('Game.spawns.Spawn1.createCreep([WORK,CARRY,MOVE])');
await sim.waitTicks(10);

// Analysis
const creepCount = await sim.countObjects('W0N0', 'creep');
const harvesters = await sim.findObjects('W0N0',
  o => o.type === 'creep' && o.memory?.role === 'harvester'
);
```

## Server Configuration

Edit `server/config.yml` to customize:

```yaml
serverConfig:
  # Faster ticks for testing
  tickRate: 100

  # Modified game constants
  constants:
    ENERGY_REGEN_TIME: 150    # Faster energy regen
    CREEP_SPAWN_TIME: 2       # Faster spawning

  # Starting resources
  startingGcl: 5

# Mods
mods:
  - screepsmod-auth          # Local auth
  - screepsmod-admin-utils   # Admin commands
  - screepsmod-mongo         # Persistent storage
```

## CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
test-simulation:
  runs-on: ubuntu-latest
  services:
    mongo:
      image: mongo:6
    redis:
      image: redis:7-alpine
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: npm run build
    - run: npm run scenario:all
```

## Troubleshooting

### Server won't start
```bash
# Check Docker status
docker-compose ps
docker-compose logs screeps

# Verify ports aren't in use
lsof -i :21025
```

### Code not updating
```bash
# Rebuild and redeploy
npm run build && npm run push-pserver

# Or use watch mode
npm run sim:watch
```

### Reset everything
```bash
# Stop server, remove volumes, restart
docker-compose down -v
docker-compose up -d
npm run sim:reset
```

## Performance Tips

1. **Use fast tick rate** during development: `./scripts/sim.sh fast`
2. **Pause between tests**: `./scripts/sim.sh pause`
3. **Run specific scenarios** instead of all: `npm run scenario bootstrap`
4. **Use mocks** for quick logic tests that don't need full simulation

## File Structure

```
├── docker-compose.yml         # Server stack definition
├── server/
│   └── config.yml            # Server configuration
├── scripts/
│   ├── sim.sh                # CLI control script
│   └── run-scenario.ts       # Scenario runner
└── test/
    └── sim/
        ├── ScreepsSimulator.ts   # HTTP API client
        ├── GameMock.ts           # Lightweight mocks
        └── scenarios/
            ├── bootstrap.scenario.ts
            └── energy-flow.scenario.ts
```
