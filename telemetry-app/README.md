# Screeps Telemetry Dashboard

External telemetry viewer for the DarkPhoenix Screeps AI. Polls the Screeps HTTP API to read telemetry data from RawMemory segments and displays it in a web dashboard.

## Setup

1. Install dependencies:
   ```bash
   cd telemetry-app
   npm install
   ```

2. Get your auth token from https://screeps.com/a/#!/account/auth-tokens

3. Run the server:
   ```bash
   SCREEPS_TOKEN=your-token-here npm start
   ```

4. Open http://localhost:3000 in your browser

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SCREEPS_TOKEN` | (required) | Your Screeps auth token |
| `SCREEPS_SHARD` | `shard3` | Shard to read data from |
| `SCREEPS_API_URL` | `https://screeps.com/api` | API base URL |
| `POLL_INTERVAL` | `5000` | Polling interval in ms |
| `PORT` | `3000` | Web server port |

## Architecture

### Data Flow

```
Screeps Game → RawMemory.segments[0-5] → HTTP API → Telemetry Server → Dashboard
```

### Segment Layout

| Segment | Content |
|---------|---------|
| 0 | Core telemetry (CPU, GCL, money, creeps, rooms) |
| 1 | Node data (territories, resources, ROI) |
| 2 | Room terrain data (encoded as string) |
| 3 | Room intel (scouted room information) |
| 4 | Corps data (mining, hauling, upgrading) |
| 5 | Active chains data |

### Dashboard Features

- **Overview**: CPU usage, GCL progress, economy stats, creep counts
- **Nodes**: Territory listing with ROI scores and resources
- **Corps**: Economic units with balance, profit, and ROI
- **Terrain**: Visual room terrain with nodes and resources
- **Intel**: Scouted room information

## API Endpoints

- `GET /api/telemetry` - All telemetry data
- `GET /api/telemetry/:segment` - Specific segment data
- WebSocket at `/` for real-time updates

## Development

```bash
# Run with auto-reload
npm run dev

# Build for production
npm run build
```
