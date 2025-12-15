# Headless Testing & Simulation

This guide explains how to run Screeps simulations locally for testing colony behavior without deploying to the live servers.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Testing Stack                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────┐     ┌──────────────────────────────┐ │
│  │   Unit Tests     │     │      Simulation Tests        │ │
│  │   (Fast, Mock)   │     │    (Full Server, Docker)     │ │
│  ├──────────────────┤     ├──────────────────────────────┤ │
│  │ • test/unit/     │     │ • ScreepsSimulator.ts        │ │
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
│           │               │ • screepsmod-auth            │ │
│           │               └──────────────────────────────┘ │
│           │                                                │
│           ▼                                                │
│  ┌─────────────────────────────────────────────────────┐  │
│  │              Your Screeps Code (src/)               │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

## Quick Start

### First-Time Setup

1. **Prerequisites**:
   - Docker & Docker Compose
   - Node.js 18+
   - Steam API key (get one at https://steamcommunity.com/dev/apikey)

2. **Set Steam API Key** (required for first-time setup):

   **PowerShell:**
   ```powershell
   $env:STEAM_KEY="your-steam-api-key"
   ```

   **CMD:**
   ```cmd
   set STEAM_KEY=your-steam-api-key
   ```

   **Linux/Mac:**
   ```bash
   export STEAM_KEY="your-steam-api-key"
   ```

   > Tip: Add this to your system environment variables to make it permanent.

3. **Start the server** (first run takes ~3 minutes to install dependencies):
   ```bash
   npm run sim:start
   ```

4. **Deploy your code**:
   ```bash
   npm run sim:deploy
   ```

### Iterative Development Workflow

Once set up, the typical development cycle is:

```bash
# 1. Make changes to src/

# 2. Deploy to local server
npm run sim:deploy

# 3. Watch logs to see your code running
npm run sim:logs

# 4. Run scenario tests to validate behavior
npm run scenario:all
```

## Commands Reference

### Simulation Server Commands

| Command | Description |
|---------|-------------|
| `npm run sim:start` | Start the Docker server stack |
| `npm run sim:stop` | Stop the server |
| `npm run sim:deploy` | Build and deploy code to local server |
| `npm run sim:logs` | Follow server logs (Ctrl+C to exit) |
| `npm run sim:reset` | Wipe all data and restart fresh |

### Testing Commands

| Command | Description |
|---------|-------------|
| `npm test` | Run unit tests (fast, no server needed) |
| `npm run scenario:list` | List available scenarios |
| `npm run scenario bootstrap` | Run bootstrap scenario |
| `npm run scenario energy-flow` | Run energy flow scenario |
| `npm run scenario:all` | Run all scenarios |

### Direct API Access

You can query the server directly:

```bash
# Check current tick
curl http://localhost:21025/api/game/time

# Check server version
curl http://localhost:21025/api/version
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
      console.log(`Tick ${tick}: ${state.rooms['W0N0'].length} objects`);
    }
  });

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
await sim.authenticate('screeps', 'screeps');  // Default credentials

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

The server is configured via `server/config.yml`:

```yaml
steamKey: ${STEAM_KEY}

mods:
  - screepsmod-auth    # Enables local password authentication

serverConfig:
  tickRate: 100        # Milliseconds per tick (lower = faster)
```

### Adding More Mods

Edit `server/config.yml` to add mods:

```yaml
mods:
  - screepsmod-auth
  - screepsmod-admin-utils   # Admin commands
```

Then restart the server:
```bash
npm run sim:stop && npm run sim:start
```

## Credentials

The local server uses `screepsmod-auth` for authentication:

- **Username**: `screeps`
- **Password**: `screeps`

These are configured in `screeps.json` under the `pserver` section.

## Troubleshooting

### Server won't start

```bash
# Check Docker is running
docker info

# Check container status
docker-compose ps

# View detailed logs
docker-compose logs screeps
```

### Code not updating

```bash
# Rebuild and redeploy
npm run sim:deploy

# Check the server received it
curl http://localhost:21025/api/game/time
```

### Need a fresh start

```bash
# Wipe everything and restart
npm run sim:reset
```

### First-time setup taking too long

The first run downloads and installs the Screeps server (~175 seconds). Subsequent starts are much faster.

### Authentication errors

Make sure `screepsmod-auth` is listed in `server/config.yml` under `mods:`.

## File Structure

```
├── docker-compose.yml           # Server stack definition
├── screeps.json                 # Deploy targets (main, pserver)
├── server/
│   ├── config.yml              # Server configuration
│   ├── mods.json               # Active mods (auto-generated)
│   └── db.json                 # Game database
├── scripts/
│   ├── upload-pserver.js       # Code upload script
│   └── run-scenario.ts         # Scenario runner
└── test/
    ├── unit/                   # Fast unit tests
    └── sim/
        ├── ScreepsSimulator.ts # HTTP API client
        └── scenarios/          # Scenario test files
            ├── bootstrap.scenario.ts
            └── energy-flow.scenario.ts
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test

  simulation-tests:
    runs-on: ubuntu-latest
    services:
      mongo:
        image: mongo:6
        ports:
          - 27017:27017
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - run: docker-compose up -d
      - run: sleep 180  # Wait for server setup
      - run: npm run sim:deploy
      - run: npm run scenario:all
```

## Performance Tips

1. **Run unit tests first** - They're fast and catch most issues
2. **Use scenarios for integration testing** - Validates real game behavior
3. **Check logs** when debugging - `npm run sim:logs`
4. **Reset sparingly** - `sim:reset` wipes everything and requires re-setup
