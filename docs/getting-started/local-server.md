# Local Private Server Setup

This guide walks you through setting up a local Screeps private server using Docker for development and testing.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Node.js](https://nodejs.org/) v18 or higher
- [Screeps on Steam](https://store.steampowered.com/app/464350/Screeps/) (for the game client)

## Quick Start

```bash
# Start the server
npm run sim:start

# Build and deploy your code
npm run sim:deploy

# View server logs
npm run sim:logs
```

## Server Architecture

The local server uses Docker Compose with three containers:

| Container | Purpose | Port |
|-----------|---------|------|
| `screeps-server` | Game server + backend | 21025 |
| `screeps-mongo` | Database | 27017 (internal) |
| `screeps-redis` | Cache/pub-sub | 6379 (internal) |

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run sim:start` | Start the server in background |
| `npm run sim:stop` | Stop the server |
| `npm run sim:logs` | Follow server logs |
| `npm run sim:deploy` | Build code and deploy to server |
| `npm run sim:reset` | Reset server (clears all data) |

## Connecting with Steam Client

1. **Launch Screeps** from Steam
2. At the login screen, click the **gear icon** (⚙️) in the top-right corner
3. Select **"Private Server"**
4. Enter connection details:
   - **Host:** `localhost`
   - **Port:** `21025`
5. **Sign Up** to create a new account (any username/password)
6. Choose a room and place your first spawn

> **Note:** The server uses `screepsmod-auth` for local authentication, so you don't need a Steam API key for basic usage.

## Server Configuration

### config.yml

The main server configuration is in `server/config.yml`:

```yaml
steamKey: ${STEAM_KEY}  # Optional: for Steam authentication

mods:
  - screepsmod-auth        # Local password authentication
  - screepsmod-admin-utils # Admin tools and web UI

serverConfig:
  tickRate: 100  # Milliseconds per tick (lower = faster)
```

### Installed Mods

| Mod | Purpose |
|-----|---------|
| `screepsmod-auth` | Enables username/password login without Steam |
| `screepsmod-admin-utils` | Provides admin dashboard at `http://localhost:21025` |

## Admin Dashboard

Access the server dashboard at: **http://localhost:21025**

This provides:
- Server status overview
- Tick timing information
- Basic server management

## Deploying Code

The `sim:deploy` script:
1. Builds your TypeScript code with webpack
2. Registers/authenticates a test user
3. Uploads compiled code to the server

Default test credentials (from `scripts/upload-pserver.js`):
- Username: `testuser`
- Password: `testpass`

To customize, edit `scripts/upload-pserver.js`.

## Troubleshooting

### Server won't start

```bash
# Check container status
docker ps -a

# View detailed logs
docker-compose logs screeps

# Reset everything
npm run sim:reset
```

### Can't connect from Steam client

1. Make sure the server is healthy:
   ```bash
   curl http://localhost:21025/api/version
   ```
2. Ensure no port conflicts (close other Screeps instances)
3. Try restarting Docker Desktop

### Code not running

1. Check server logs for errors:
   ```bash
   npm run sim:logs
   ```
2. Verify code was deployed:
   ```bash
   npm run sim:deploy
   ```
3. Make sure you've placed a spawn in-game

### Port conflicts

If port 21025 is in use:
1. Stop any Steam Screeps servers
2. Check for other Docker containers: `docker ps`
3. Edit `docker-compose.yml` to use different ports

## Advanced Configuration

### Faster Tick Rate

Edit `server/config.yml`:
```yaml
serverConfig:
  tickRate: 50  # 50ms per tick (20 ticks/second)
```

Then restart the server: `npm run sim:reset`

### Adding More Mods

Edit `server/config.yml`:
```yaml
mods:
  - screepsmod-auth
  - screepsmod-admin-utils
  - screepsmod-mongo      # MongoDB storage (required for map imports)
```

Popular mods:
- `screepsmod-mongo` - Use MongoDB for storage
- `screepsmod-features` - Enable Season features
- `screepsmod-admin-utils` - Admin tools

### Persistent Data

Server data is stored in Docker volumes:
- `darkphoenix_mongo-data` - Database
- `darkphoenix_redis-data` - Cache

To backup:
```bash
docker run --rm -v darkphoenix_mongo-data:/data -v $(pwd):/backup alpine tar czf /backup/mongo-backup.tar.gz /data
```

## File Structure

```
server/
├── config.yml       # Main server configuration
├── mods.json        # Generated mod list
├── .screepsrc       # Legacy config (optional)
└── logs/            # Server logs
```

## Next Steps

- [Deploy destinations](../in-depth/deploy-destinations.md) - Configure multiple deployment targets
- [Testing](../in-depth/testing.md) - Run integration tests against local server
