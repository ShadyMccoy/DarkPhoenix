/**
 * Screeps Telemetry Server
 *
 * Polls the Screeps API for telemetry data and serves a web dashboard.
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ScreepsAPI } from "./api.js";
import {
  TELEMETRY_SEGMENTS,
  AllTelemetry,
  CoreTelemetry,
  NodeTelemetry,
  TerrainTelemetry,
  IntelTelemetry,
  CorpsTelemetry,
  ChainsTelemetry,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration from environment variables
const config = {
  token: process.env.SCREEPS_TOKEN || "",
  shard: process.env.SCREEPS_SHARD || "shard3",
  apiUrl: process.env.SCREEPS_API_URL || "https://screeps.com/api",
  pollInterval: parseInt(process.env.POLL_INTERVAL || "5000"),
  port: parseInt(process.env.PORT || "3000"),
};

// Validate token
if (!config.token) {
  console.error("Error: SCREEPS_TOKEN environment variable is required");
  console.error("Get your token from https://screeps.com/a/#!/account/auth-tokens");
  console.error("");
  console.error("Usage:");
  console.error("  SCREEPS_TOKEN=your-token-here npm start");
  process.exit(1);
}

// Create API client
const api = new ScreepsAPI({
  token: config.token,
  shard: config.shard,
  apiUrl: config.apiUrl,
});

// Current telemetry state
let telemetry: AllTelemetry = {
  core: null,
  nodes: null,
  terrain: null,
  intel: null,
  corps: null,
  chains: null,
  lastUpdate: 0,
};

// Connected WebSocket clients
const clients = new Set<WebSocket>();

/**
 * Parse telemetry JSON safely.
 */
function parseTelemetry<T>(data: string | null): T | null {
  if (!data) return null;
  try {
    return JSON.parse(data) as T;
  } catch (e) {
    console.error("Failed to parse telemetry:", e);
    return null;
  }
}

/**
 * Poll telemetry data from Screeps API.
 */
async function pollTelemetry(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Polling telemetry...`);

  try {
    const segments = await api.readSegments([
      TELEMETRY_SEGMENTS.CORE,
      TELEMETRY_SEGMENTS.NODES,
      TELEMETRY_SEGMENTS.TERRAIN,
      TELEMETRY_SEGMENTS.INTEL,
      TELEMETRY_SEGMENTS.CORPS,
      TELEMETRY_SEGMENTS.CHAINS,
    ]);

    // Parse each segment
    const newTelemetry: AllTelemetry = {
      core: parseTelemetry<CoreTelemetry>(segments[TELEMETRY_SEGMENTS.CORE]),
      nodes: parseTelemetry<NodeTelemetry>(segments[TELEMETRY_SEGMENTS.NODES]),
      terrain: parseTelemetry<TerrainTelemetry>(segments[TELEMETRY_SEGMENTS.TERRAIN]),
      intel: parseTelemetry<IntelTelemetry>(segments[TELEMETRY_SEGMENTS.INTEL]),
      corps: parseTelemetry<CorpsTelemetry>(segments[TELEMETRY_SEGMENTS.CORPS]),
      chains: parseTelemetry<ChainsTelemetry>(segments[TELEMETRY_SEGMENTS.CHAINS]),
      lastUpdate: Date.now(),
    };

    // Check if data changed
    const hasNewData = newTelemetry.core?.tick !== telemetry.core?.tick;

    telemetry = newTelemetry;

    if (hasNewData && newTelemetry.core) {
      console.log(`  Tick: ${newTelemetry.core.tick}, Nodes: ${newTelemetry.nodes?.summary.totalNodes || 0}`);

      // Broadcast to all connected clients
      broadcastTelemetry();
    } else if (!newTelemetry.core) {
      console.log("  No telemetry data available (segments may be empty)");
    }
  } catch (error) {
    console.error("Failed to poll telemetry:", error);
  }
}

/**
 * Broadcast telemetry to all connected WebSocket clients.
 */
function broadcastTelemetry(): void {
  const message = JSON.stringify({
    type: "telemetry",
    data: telemetry,
  });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Start the server.
 */
async function main(): Promise<void> {
  console.log("Screeps Telemetry Server");
  console.log("========================");
  console.log(`Shard: ${config.shard}`);
  console.log(`Poll interval: ${config.pollInterval}ms`);
  console.log(`Port: ${config.port}`);
  console.log("");

  // Test API connection
  console.log("Testing API connection...");
  const connected = await api.testConnection();
  if (!connected) {
    console.error("Failed to connect to Screeps API. Check your token and network.");
    process.exit(1);
  }
  console.log("Connected to Screeps API!");
  console.log("");

  // Create Express app
  const app = express();
  const server = createServer(app);

  // Create WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("Client connected");
    clients.add(ws);

    // Send current telemetry immediately
    if (telemetry.core) {
      ws.send(
        JSON.stringify({
          type: "telemetry",
          data: telemetry,
        })
      );
    }

    ws.on("close", () => {
      console.log("Client disconnected");
      clients.delete(ws);
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
      clients.delete(ws);
    });
  });

  // Serve static files
  app.use(express.static(join(__dirname, "../public")));

  // API endpoint for current telemetry
  app.get("/api/telemetry", (req, res) => {
    res.json(telemetry);
  });

  // API endpoint for specific segment
  app.get("/api/telemetry/:segment", (req, res) => {
    const segment = req.params.segment as keyof AllTelemetry;
    if (segment in telemetry) {
      res.json(telemetry[segment]);
    } else {
      res.status(404).json({ error: "Segment not found" });
    }
  });

  // Start server
  server.listen(config.port, () => {
    console.log(`Server running at http://localhost:${config.port}`);
    console.log("");
  });

  // Initial poll
  await pollTelemetry();

  // Start polling loop
  setInterval(pollTelemetry, config.pollInterval);
}

main().catch(console.error);
