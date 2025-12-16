# Simulation Testing Guide

This guide covers how to run simulation tests against a local Screeps private server.

## Overview

The simulation testing framework allows you to test the bot's behavior in a controlled environment using a local Screeps private server running in Docker.

## Prerequisites

### Required Software
- Docker and Docker Compose
- Node.js 18+ (required for native `fetch` support)
- npm

### Game World Requirements

**Important:** The bot requires a properly initialized game world to function. The bot code (`src/main.ts`) has the following requirements:

1. **Room Controller** - `getRoomRoutines()` returns early if no controller exists
2. **Energy Sources** - Required for EnergyMining routines
3. **Spawn Structure** - Required for creating creeps (Bootstrap routine)

Without these game objects, the bot will not execute any routines.

## Quick Start

```bash
# 1. Start the server
npm run sim:start

# 2. Wait for server to be healthy (check with docker-compose ps)
docker-compose ps

# 3. Build and deploy your code
npm run sim:deploy

# 4. Run scenario tests
npm run scenario:all
```

## Server Setup

### Starting the Server

```bash
npm run sim:start    # Start server in background
npm run sim:stop     # Stop server
npm run sim:reset    # Reset server (wipes all data)
npm run sim:logs     # View server logs
```

### Server Configuration

The server configuration is in `server/config.yml`:

```yaml
steamKey: ${STEAM_KEY}

mods:
  - screepsmod-auth       # Required for user authentication
  - screepsmod-admin-utils # Admin commands for testing

serverConfig:
  tickRate: 100          # Milliseconds per tick
```

## Authentication

The deploy script (`scripts/upload-pserver.js`) handles user registration and authentication automatically.

**Default credentials:**
- Username: `testuser`
- Password: `testpass`

### Common Authentication Issues

1. **"Unauthorized" error after server reset:**
   - The server was reset but old user data persists
   - Solution: Run `npm run sim:reset` to fully wipe data

2. **User already exists error:**
   - This is normal and can be ignored
   - The script will proceed to authenticate

## World Initialization Problem

### The Issue

A fresh Screeps private server has rooms with terrain but **no game objects** (controllers, sources, spawns). This is different from the official Screeps server which has a pre-generated world.

To verify this, run:
```bash
node scripts/spawn-user.js
```

Expected output showing the problem:
```
Room W0N0 status:
  Spawns: 0
  Controllers: 0
  Sources: 0
```

### Solutions

#### Option 1: Use screeps-server-mockup (Recommended for Unit/Integration Tests)

Install the mockup server for proper integration testing:

```bash
npm install --save-dev screeps-server-mockup
```

Then use it in your test files. The mockup automatically creates a 3x3 grid of rooms with sources and controllers.

See [testing.md](./testing.md) for integration test setup.

**Windows Users:** screeps-server-mockup has native dependencies that may fail to build due to node-gyp/Python version issues. If installation fails:
- Ensure Python 2.7 is installed (not Python 3)
- Or use WSL2 with Linux for development
- Or use Option 2 (Docker-based private server with map import)

#### Option 2: Import a Map (Requires screepsmod-mongo)

1. Add `screepsmod-mongo` to your `server/config.yml`:
   ```yaml
   mods:
     - screepsmod-auth
     - screepsmod-admin-utils
     - screepsmod-mongo
   ```

2. Restart the server:
   ```bash
   npm run sim:reset
   ```

3. Access the CLI and import a map:
   ```bash
   docker exec -it screeps-server screeps-launcher cli
   ```
   Then run:
   ```javascript
   utils.importMap("random_1x1")
   system.resumeSimulation()
   ```

**Note:** screepsmod-mongo requires MongoDB to be properly configured. Check server logs if you encounter issues.

#### Option 3: Manual Object Insertion (Advanced)

Use the admin CLI to manually create game objects. This requires understanding the internal database structure.

## Running Scenarios

### Available Commands

```bash
npm run scenario:all          # Run all scenarios
npm run scenario -- bootstrap # Run specific scenario
npm run scenario -- --list    # List available scenarios
```

### Scenario Prerequisites Check

The scenario runner checks for required game objects before running tests:

```
Server Status:
  Connected: ✓
  Spawns: 0        # Should be > 0
  Controllers: 0    # Should be > 0
  Sources: 0       # Should be > 0

WARNING: Server world is not properly initialized.
```

If you see this warning, follow the World Initialization solutions above.

### Available Scenarios

| Scenario | Description | Requirements |
|----------|-------------|--------------|
| `bootstrap` | Tests initial colony setup | Spawn, Controller, Sources |
| `energy-flow` | Tests harvester/carrier efficiency | Spawn, Controller, Sources |

## Troubleshooting

### TypeScript Errors in ScreepsSimulator.ts

If you see errors about `fetch` not being found:
- Ensure you're using Node.js 18+
- The simulator uses native `fetch` which requires Node 18+

### Server Unhealthy

Check logs for errors:
```bash
docker-compose logs screeps --tail 100
```

Common issues:
- MongoDB connection failures (if using screepsmod-mongo)
- Missing mods
- Port conflicts (21025)

### Tests Time Out

The simulation tests wait for game ticks. If the server is slow or stuck:
1. Check server logs for errors
2. Verify tick rate in config.yml
3. Ensure the game loop is actually running

### Bot Not Executing

If deployed code isn't running:
1. Check that the room has a controller (`room.controller` is required)
2. Verify code was uploaded: check server logs or use the web UI at http://localhost:21025
3. Check for JavaScript errors in the bot's console output

## File Reference

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Server container configuration |
| `server/config.yml` | Screeps server configuration |
| `scripts/upload-pserver.js` | Deploy code to server |
| `scripts/spawn-user.js` | Check room status |
| `scripts/run-scenario.ts` | Scenario test runner |
| `test/sim/ScreepsSimulator.ts` | HTTP API client for testing |
| `test/sim/scenarios/*.scenario.ts` | Individual test scenarios |

## CI/CD Integration

For CI pipelines, ensure:
1. Docker is available
2. Server has time to start (add health check wait)
3. World is properly initialized before tests

Example CI workflow:
```yaml
- name: Start Screeps Server
  run: npm run sim:start

- name: Wait for server
  run: sleep 60

- name: Deploy code
  run: npm run sim:deploy

- name: Run tests
  run: npm run scenario:all
```

**Note:** CI tests will fail unless the world is properly initialized. Consider using screeps-server-mockup for CI integration tests instead of the private server.
