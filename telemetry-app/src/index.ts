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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { ScreepsAPI } from "./api.js";
import {
  TELEMETRY_SEGMENTS,
  AllTelemetry,
  CoreTelemetry,
  NodeTelemetry,
  NodeTelemetryNode,
  NodeTelemetryNodeCompact,
  EdgesTelemetry,
  CorpsTelemetry,
  FlowTelemetry,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config from file if it exists
interface Config {
  token: string;
  shard: string;
  apiUrl: string;
  pollInterval: number;
  port: number;
}

function loadConfig(): Config {
  const configPath = join(__dirname, "../config.json");
  let fileConfig: Partial<Config> = {};

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(content);
      console.log("Loaded config from config.json");
    } catch (e) {
      console.error("Failed to parse config.json:", e);
    }
  }

  // Environment variables override config file
  return {
    token: process.env.SCREEPS_TOKEN || fileConfig.token || "",
    shard: process.env.SCREEPS_SHARD || fileConfig.shard || "shard3",
    apiUrl: process.env.SCREEPS_API_URL || fileConfig.apiUrl || "https://screeps.com/api",
    pollInterval: parseInt(process.env.POLL_INTERVAL || String(fileConfig.pollInterval || 5000)),
    port: parseInt(process.env.PORT || String(fileConfig.port || 3000)),
  };
}

const config = loadConfig();

// Validate token
if (!config.token) {
  console.error("Error: Screeps token is required");
  console.error("");
  console.error("Option 1: Create config.json from config.example.json");
  console.error("  cp config.example.json config.json");
  console.error("  # Edit config.json and add your token");
  console.error("");
  console.error("Option 2: Use environment variable");
  console.error("  SCREEPS_TOKEN=your-token-here npm start");
  console.error("");
  console.error("Get your token from https://screeps.com/a/#!/account/auth-tokens");
  process.exit(1);
}

// Create API client
const api = new ScreepsAPI({
  token: config.token,
  shard: config.shard,
  apiUrl: config.apiUrl,
});

// Current telemetry state (will be loaded from cache if available)
let telemetry: AllTelemetry = {
  core: null,
  nodes: null,
  edges: null,
  intel: null,
  corps: null,
  chains: null,
  flow: null,
  lastUpdate: 0,
};

// Connected WebSocket clients
const clients = new Set<WebSocket>();

// Cache file path
const CACHE_PATH = join(__dirname, "../telemetry-cache.json");

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
 * Normalize compact node format (v2) to standard format.
 */
function normalizeNode(node: NodeTelemetryNodeCompact): NodeTelemetryNode {
  return {
    id: node.id,
    roomName: node.r,
    peakPosition: { x: node.p.x, y: node.p.y, roomName: node.p.r },
    territorySize: node.t,
    resources: node.res.map(r => ({ type: r.t, x: r.x, y: r.y })),
    roi: node.roi ? {
      score: node.roi.s,
      openness: node.roi.o,
      distanceFromOwned: node.roi.d,
      isOwned: node.roi.own,
      sourceCount: node.roi.src,
      hasController: node.roi.ctrl,
    } : undefined,
    spansRooms: node.spans,
    econ: node.econ,
  };
}

/**
 * Parse and normalize node telemetry.
 * Handles v1 (legacy), v2-v4 (compact with edges), and v5+ (edges in segment 2).
 */
function parseNodeTelemetry(data: string | null): NodeTelemetry | null {
  if (!data) return null;
  try {
    const raw = JSON.parse(data);
    if (!raw || !raw.nodes) return null;

    // Check if this is v2+ compact format (nodes have 'r' instead of 'roomName')
    const isCompact = raw.version >= 2 || (raw.nodes.length > 0 && 'r' in raw.nodes[0]);

    if (isCompact) {
      return {
        version: raw.version,
        tick: raw.tick,
        nodes: raw.nodes.map((n: NodeTelemetryNodeCompact) => normalizeNode(n)),
        // edges are optional in v5+ (moved to segment 2)
        edges: raw.edges,
        economicEdges: raw.economicEdges,
        summary: raw.summary,
      };
    }

    // Legacy format - return as-is
    return raw as NodeTelemetry;
  } catch (e) {
    console.error("Failed to parse node telemetry:", e);
    return null;
  }
}

/**
 * Save telemetry to local cache file.
 */
function saveTelemetryCache(data: AllTelemetry): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
    console.log("  Saved to cache");
  } catch (e) {
    console.error("Failed to save cache:", e);
  }
}

/**
 * Load telemetry from local cache file.
 */
function loadTelemetryCache(): AllTelemetry | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const content = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(content) as AllTelemetry;
    console.log(`Loaded cached telemetry (tick ${data.core?.tick || "unknown"})`);
    return data;
  } catch (e) {
    console.error("Failed to load cache:", e);
    return null;
  }
}

/**
 * Poll telemetry data from Screeps API.
 */
async function pollTelemetry(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Polling telemetry...`);

  try {
    // Fetch core, nodes, edges, corps, and flow segments (with delay between to avoid rate limiting)
    const segments = await api.readSegments([
      TELEMETRY_SEGMENTS.CORE,
      TELEMETRY_SEGMENTS.NODES,
      TELEMETRY_SEGMENTS.EDGES,
      TELEMETRY_SEGMENTS.CORPS,
      TELEMETRY_SEGMENTS.FLOW,
    ]);

    // Parse segments (nodes uses special parser for v2 compact format)
    const newTelemetry: AllTelemetry = {
      core: parseTelemetry<CoreTelemetry>(segments[TELEMETRY_SEGMENTS.CORE]),
      nodes: parseNodeTelemetry(segments[TELEMETRY_SEGMENTS.NODES]),
      edges: parseTelemetry<EdgesTelemetry>(segments[TELEMETRY_SEGMENTS.EDGES]),
      intel: null,
      corps: parseTelemetry<CorpsTelemetry>(segments[TELEMETRY_SEGMENTS.CORPS]),
      chains: null,
      flow: parseTelemetry<FlowTelemetry>(segments[TELEMETRY_SEGMENTS.FLOW]),
      lastUpdate: Date.now(),
    };

    // Check if data changed
    const hasNewData = newTelemetry.core?.tick !== telemetry.core?.tick;

    telemetry = newTelemetry;

    if (hasNewData && newTelemetry.core) {
      const edgeCount = newTelemetry.edges?.edges?.length || 0;
      console.log(`  Tick: ${newTelemetry.core.tick}, Nodes: ${newTelemetry.nodes?.summary?.totalNodes || 0}, Edges: ${edgeCount}`);

      // Save to local cache
      saveTelemetryCache(newTelemetry);

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
  console.log(`Port: ${config.port}`);
  console.log("");

  // Load cached telemetry if available
  const cached = loadTelemetryCache();
  if (cached) {
    telemetry = cached;
  }

  // Test API connection (non-fatal - can use cached data)
  console.log("Testing API connection...");
  const connected = await api.testConnection();
  if (!connected) {
    console.warn("Failed to connect to Screeps API - using cached data if available");
  } else {
    console.log("Connected to Screeps API!");
  }
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
  app.get("/api/telemetry", (_req, res) => {
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

  // === Economic data endpoints for iteration ===

  // Economic nodes (nodes with econ flag or resources)
  app.get("/api/econ/nodes", (_req, res) => {
    const nodes = telemetry.nodes?.nodes || [];
    const econNodes = nodes.filter(n => n.econ || (n.resources && n.resources.length > 0));
    res.json({
      tick: telemetry.nodes?.tick,
      count: econNodes.length,
      nodes: econNodes.map(n => ({
        id: n.id,
        roomName: n.roomName,
        resources: n.resources,
        roi: n.roi,
        econ: n.econ
      }))
    });
  });

  // Economic edges with flow rates
  app.get("/api/econ/edges", (_req, res) => {
    const edges = telemetry.edges;
    if (!edges) {
      res.json({ tick: null, edges: [] });
      return;
    }
    // Convert indexed edges to readable format
    const nodeIndex = edges.nodeIndex || [];
    const economicEdges = (edges.economicEdges || []).map(e => ({
      from: nodeIndex[e[0]] || `idx-${e[0]}`,
      to: nodeIndex[e[1]] || `idx-${e[1]}`,
      distance: e[2],
      flowRate: e[3] ?? null
    }));
    res.json({
      tick: edges.tick,
      version: edges.version,
      count: economicEdges.length,
      edges: economicEdges
    });
  });

  // Flow economy data
  app.get("/api/econ/flow", (_req, res) => {
    res.json({
      tick: telemetry.flow?.tick,
      ...telemetry.flow
    });
  });

  // Corps data
  app.get("/api/econ/corps", (_req, res) => {
    res.json({
      tick: telemetry.corps?.tick,
      summary: telemetry.corps?.summary,
      corps: telemetry.corps?.corps || []
    });
  });

  // Manual refresh endpoint
  app.post("/api/refresh", async (_req, res) => {
    console.log("Manual refresh requested");
    await pollTelemetry();
    res.json({ ok: true, tick: telemetry.core?.tick });
  });

  // Start server
  server.listen(config.port, () => {
    console.log(`Server running at http://localhost:${config.port}`);
    console.log("");
  });

  // Use cached data on startup - don't auto-fetch
  // Use POST /api/refresh to fetch manually when needed
  if (telemetry.core) {
    console.log(`Using cached data from tick ${telemetry.core.tick}`);
  } else {
    console.log("No cached data available - use Refresh button to fetch");
  }
}

main().catch(console.error);
