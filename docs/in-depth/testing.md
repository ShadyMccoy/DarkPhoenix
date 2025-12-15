# Testing

Automated testing helps prevent regressions and reproduce complex failure
scenarios for bug fixing or feature implementation. This project comes with
support for both unit and integration testing with your Screeps code.

You can read more about [unit and integration testing on
Wikipedia](https://en.wikipedia.org/wiki/Test-driven_development).

This documentation will cover the testing setup for those already familiar with
the process of test driven design.

Tests are written via [Mocha](https://mochajs.org/) and executed as tests only
if they include `.test.ts` in their filename. If you have written a test file
but aren't seeing it executed, this is probably why. There are two separate test
commands and configurations, as unit tests don't need the complete Screeps
server run-time as integration tests do.

## Running Tests

The standard `npm test` will execute all unit and integration tests in sequence.
This is helpful for CI/CD and pre-publish checks, however during active
development it's better to run just a subset of interesting tests.

You can use `npm run test-unit` or `npm run test-integration` to run just one of
the test suites. Additionally you can supply Mocha options to these test
commands to further control the testing behavior. As an example, the following
command will only execute integration tests with the word `memory` in their
description:

```
npm run test-integration -- -g memory
```

Note that arguments after the initial `--` will be passed to `mocha` directly.

## Unit Testing

You can test code with simple run-time dependencies via the unit testing
support. Since unit testing is much faster than integration testing by orders of
magnitude, it is recommended to prefer unit tests wherever possible.

## Integration Testing

### Installing Screeps Server Mockup

Before starting to use integration testing, you must install [screeps-server-mockup](https://github.com/screepers/screeps-server-mockup) to your project.
Please view that repository for more instruction on installation.

```bash
# Using yarn:
yarn add -D screeps-server-mockup
# Using npm
npm install --save-dev screeps-server-mockup
```

You will also need to add scripts to run integration tests.

In `package.json`, add a new `test-integration` script and add the new integration testing to the main `test` script.

```json
  "scripts": {
    "test": "npm run test-unit && npm run test-integration",
    "test-integration": "npm run build && mocha test/integration/**/*.ts",
  }
```

Now you can run integration tests by using the `test-integration` script or run both unit and integration tests using the `test` script.

### Integration Testing with Screeps Server Mockup

Integration testing is for code that depends heavily on having a full game
environment. Integration tests are completely representative of the real game
(in fact they run with an actual Screeps server). This comes at the cost of
performance and very involved setup when creating specific scenarios.

Server testing support is implemented via
[screeps-server-mockup](https://github.com/screepers/screeps-server-mockup). View
this repository for more information on the API.

By default the test helper will create a "stub" world with a 3x3 grid of rooms
with sources and controllers. Additionally it spawns a bot called "player"
running the compiled main.js file from this repository.

It falls on the user to properly set up preconditions using the
screeps-server-mockup API. Importantly, most methods exposed with this API are
asynchronous, so using them requires frequent use of the `await` keyword to get
a result and ensure order of execution. If you find that some of your
preconditions don't seem to take effect, or that you receive a Promise object
rather than an expected value, you're likely missing `await` on an API method.

Finally, please note that screeps-server-mockup, and this repo by extension,
come with a specific screeps server version at any given time. It's possible
that either your local package.json, or the screeps-server-mockup package itself
are out of date and pulling in an older version of the [screeps
server](https://github.com/screeps/screeps). If you notice that test environment
behavior differs from the MMO server, ensure that all of these dependencies are
correctly up to date.

## Simulation Testing with Private Server

For more realistic testing scenarios, this project includes a simulation testing
framework that runs against a real Screeps private server via Docker.

### Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ (for native fetch support)

### Starting the Private Server

```bash
# Start the server (first time will download images)
docker-compose up -d

# Check server status
docker-compose ps

# View server logs
docker-compose logs -f screeps
```

The server runs on `http://localhost:21025` with these components:
- **screeps-server**: The game server (screepers/screeps-launcher)
- **mongo**: Database for game state
- **redis**: Cache and pub/sub

### Server Configuration

The server is configured via `server/config.yml`:

```yaml
steamKey: ${STEAM_KEY}

mods:
  - screepsmod-auth          # Password authentication
  - screepsmod-admin-utils   # Admin API endpoints

serverConfig:
  tickRate: 100              # Milliseconds per tick
```

### Deploying Code to Private Server

```bash
# Build and deploy code
npm run sim:deploy

# Or manually:
npm run build
node scripts/upload-pserver.js
```

This deploys to user `screeps` with password `screeps`.

### Running Simulation Scenarios

Scenarios are located in `test/sim/scenarios/` and test specific game behaviors:

```bash
# Run a specific scenario
npm run scenario bootstrap
npm run scenario energy-flow

# Run all scenarios
npm run scenario -- --all

# List available scenarios
npm run scenario -- --list
```

### Writing Scenarios

Scenarios use the `ScreepsSimulator` API to interact with the server:

```typescript
import { createSimulator } from '../ScreepsSimulator';

export async function runMyScenario() {
  const sim = createSimulator();
  await sim.connect();  // Auto-authenticates as screeps/screeps

  // Place a spawn (if user doesn't have one)
  await sim.placeSpawn('W1N1');

  // Run simulation for N ticks
  await sim.runSimulation(100, {
    snapshotInterval: 10,
    rooms: ['W1N1'],
    onTick: async (tick, state) => {
      const objects = state.rooms['W1N1'] || [];
      const creeps = objects.filter(o => o.type === 'creep');
      console.log(`Tick ${tick}: ${creeps.length} creeps`);
    }
  });

  // Read game memory
  const memory = await sim.getMemory();

  // Get room objects
  const objects = await sim.getRoomObjects('W1N1');
}
```

### ScreepsSimulator API

| Method | Description |
|--------|-------------|
| `connect()` | Connect and auto-authenticate |
| `placeSpawn(room, x?, y?)` | Place a spawn for the user |
| `getTick()` | Get current game tick |
| `getRoomObjects(room)` | Get all objects in a room |
| `getMemory(path?)` | Read player memory |
| `setMemory(path, value)` | Write player memory |
| `console(expression)` | Execute server console command |
| `runSimulation(ticks, options)` | Run for N ticks with callbacks |
| `waitTicks(count)` | Wait for N ticks to pass |

### Available Rooms

Not all rooms have sources/controllers. Query available spawn rooms:

```typescript
const result = await sim.get('/api/user/rooms');
console.log(result.rooms);  // ['W1N1', 'W2N2', ...]
```

### Troubleshooting

**Server not responding:**
```bash
docker-compose logs screeps
docker-compose restart screeps
```

**Authentication errors:**
The simulator auto-registers and authenticates. If issues persist:
```bash
# Reset the database
docker-compose down -v
docker-compose up -d
```

**No creeps spawning:**
- Ensure spawn is in a valid room with sources
- Check that code was deployed: `npm run sim:deploy`
- Verify server is running ticks: check tick number increases

**HTML instead of JSON errors:**
This usually means the API endpoint doesn't exist or requires authentication.
The simulator handles this automatically, but ensure `screepsmod-admin-utils`
is in `server/config.yml`.
