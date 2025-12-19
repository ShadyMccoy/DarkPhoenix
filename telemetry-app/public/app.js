/**
 * Screeps Telemetry Dashboard Client
 */

// WebSocket connection
let ws = null;
let reconnectTimeout = null;

// Current telemetry data
let telemetry = {
  core: null,
  nodes: null,
  terrain: null,
  intel: null,
  corps: null,
  chains: null,
  lastUpdate: 0,
};

// DOM elements
const elements = {
  refreshBtn: document.getElementById("refresh-btn"),
  connectionStatus: document.getElementById("connection-status"),
  tickDisplay: document.getElementById("tick-display"),
  lastUpdate: document.getElementById("last-update"),

  // CPU
  cpuUsed: document.getElementById("cpu-used"),
  cpuLimit: document.getElementById("cpu-limit"),
  cpuBucket: document.getElementById("cpu-bucket"),
  cpuBar: document.getElementById("cpu-bar"),

  // GCL
  gclLevel: document.getElementById("gcl-level"),
  gclProgress: document.getElementById("gcl-progress"),
  gclBar: document.getElementById("gcl-bar"),

  // Money
  moneyTreasury: document.getElementById("money-treasury"),
  moneyMinted: document.getElementById("money-minted"),
  moneyTaxed: document.getElementById("money-taxed"),
  moneyNet: document.getElementById("money-net"),

  // Colony
  colonyNodes: document.getElementById("colony-nodes"),
  colonyCorps: document.getElementById("colony-corps"),
  colonyActive: document.getElementById("colony-active"),
  colonyChains: document.getElementById("colony-chains"),

  // Creeps
  creepsTotal: document.getElementById("creeps-total"),
  creepsMiners: document.getElementById("creeps-miners"),
  creepsHaulers: document.getElementById("creeps-haulers"),
  creepsUpgraders: document.getElementById("creeps-upgraders"),
  creepsScouts: document.getElementById("creeps-scouts"),

  // Tables
  roomsTable: document.querySelector("#rooms-table tbody"),
  nodesTable: document.querySelector("#nodes-table tbody"),
  corpsTable: document.querySelector("#corps-table tbody"),
  intelTable: document.querySelector("#intel-table tbody"),

  // Nodes summary
  nodesTotal: document.getElementById("nodes-total"),
  nodesOwned: document.getElementById("nodes-owned"),
  nodesExpansion: document.getElementById("nodes-expansion"),
  nodesSources: document.getElementById("nodes-sources"),

  // Corps summary
  corpsTotal: document.getElementById("corps-total"),
  corpsActive: document.getElementById("corps-active"),
  corpsBalance: document.getElementById("corps-balance"),

  // Network
  networkCanvas: document.getElementById("network-canvas"),
};

/**
 * Connect to WebSocket server.
 */
function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`;

  console.log("Connecting to", wsUrl);

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected");
    elements.connectionStatus.textContent = "Connected";
    elements.connectionStatus.className = "status-connected";
    clearTimeout(reconnectTimeout);
  };

  ws.onclose = () => {
    console.log("Disconnected");
    elements.connectionStatus.textContent = "Disconnected";
    elements.connectionStatus.className = "status-disconnected";

    // Reconnect after 3 seconds
    reconnectTimeout = setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "telemetry") {
        telemetry = message.data;
        updateUI();
      }
    } catch (e) {
      console.error("Failed to parse message:", e);
    }
  };
}

/**
 * Format a number with commas.
 */
function formatNumber(n) {
  if (n === null || n === undefined) return "--";
  return n.toLocaleString();
}

/**
 * Format a percentage.
 */
function formatPercent(n, total) {
  if (!total) return "0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

/**
 * Update all UI elements.
 */
function updateUI() {
  if (!telemetry.core) return;

  const core = telemetry.core;

  // Update header
  elements.tickDisplay.textContent = `Tick: ${formatNumber(core.tick)}`;
  elements.lastUpdate.textContent = `Last update: ${new Date(
    telemetry.lastUpdate
  ).toLocaleTimeString()}`;

  // Update CPU
  elements.cpuUsed.textContent = core.cpu.used.toFixed(2);
  elements.cpuLimit.textContent = core.cpu.limit;
  elements.cpuBucket.textContent = formatNumber(core.cpu.bucket);
  elements.cpuBar.style.width = `${(core.cpu.used / core.cpu.limit) * 100}%`;

  // Update GCL
  elements.gclLevel.textContent = core.gcl.level;
  elements.gclProgress.textContent = `${formatNumber(
    core.gcl.progress
  )} / ${formatNumber(core.gcl.progressTotal)}`;
  elements.gclBar.style.width = `${
    (core.gcl.progress / core.gcl.progressTotal) * 100
  }%`;

  // Update Money
  elements.moneyTreasury.textContent = formatNumber(
    Math.round(core.money.treasury)
  );
  elements.moneyMinted.textContent = formatNumber(
    Math.round(core.money.minted)
  );
  elements.moneyTaxed.textContent = formatNumber(Math.round(core.money.taxed));
  elements.moneyNet.textContent = formatNumber(Math.round(core.money.net));

  // Update Colony
  elements.colonyNodes.textContent = core.colony.nodeCount;
  elements.colonyCorps.textContent = core.colony.totalCorps;
  elements.colonyActive.textContent = core.colony.activeCorps;
  elements.colonyChains.textContent = core.colony.activeChains;

  // Update Creeps
  elements.creepsTotal.textContent = core.creeps.total;
  elements.creepsMiners.textContent = core.creeps.miners;
  elements.creepsHaulers.textContent = core.creeps.haulers;
  elements.creepsUpgraders.textContent = core.creeps.upgraders;
  elements.creepsScouts.textContent = core.creeps.scouts;

  // Update Rooms table
  updateRoomsTable(core.rooms);

  // Update Nodes
  if (telemetry.nodes) {
    updateNodesUI(telemetry.nodes);
  }

  // Update Corps
  if (telemetry.corps) {
    updateCorpsUI(telemetry.corps);
  }

  // Update Intel
  if (telemetry.intel) {
    updateIntelUI(telemetry.intel);
  }

  // Update Network graph
  if (telemetry.nodes) {
    drawNetworkGraph(telemetry.nodes);
  }
}

/**
 * Update rooms table.
 */
function updateRoomsTable(rooms) {
  elements.roomsTable.innerHTML = rooms
    .map(
      (room) => `
    <tr>
      <td>${room.name}</td>
      <td>${room.rcl}</td>
      <td>
        <div class="progress-bar" style="width: 100px; display: inline-block; vertical-align: middle;">
          <div class="progress-fill" style="width: ${
            (room.rclProgress / room.rclProgressTotal) * 100
          }%"></div>
        </div>
        <span>${formatPercent(room.rclProgress, room.rclProgressTotal)}</span>
      </td>
      <td>${room.energyAvailable} / ${room.energyCapacity}</td>
    </tr>
  `
    )
    .join("");
}

/**
 * Update nodes UI.
 */
function updateNodesUI(nodes) {
  // Update summary
  elements.nodesTotal.textContent = nodes.summary.totalNodes;
  elements.nodesOwned.textContent = nodes.summary.ownedNodes;
  elements.nodesExpansion.textContent = nodes.summary.expansionCandidates;
  elements.nodesSources.textContent = nodes.summary.totalSources;

  // Update table
  elements.nodesTable.innerHTML = nodes.nodes
    .sort((a, b) => (b.roi?.score || 0) - (a.roi?.score || 0))
    .map(
      (node) => `
    <tr>
      <td>${node.id}</td>
      <td>${node.roomName}</td>
      <td>${node.territorySize} tiles</td>
      <td>${node.roi?.sourceCount || 0}</td>
      <td>${node.roi?.hasController ? "Yes" : "No"}</td>
      <td>${node.roi?.score?.toFixed(1) || "--"}</td>
      <td>
        <span class="badge ${node.roi?.isOwned ? "badge-owned" : "badge-expansion"}">
          ${node.roi?.isOwned ? "Owned" : "Expansion"}
        </span>
      </td>
    </tr>
  `
    )
    .join("");
}

/**
 * Update corps UI.
 */
function updateCorpsUI(corps) {
  // Update summary
  elements.corpsTotal.textContent = corps.summary.totalCorps;
  elements.corpsActive.textContent = corps.summary.activeCorps;
  elements.corpsBalance.textContent = formatNumber(
    Math.round(corps.summary.totalBalance)
  );

  // Update table
  elements.corpsTable.innerHTML = corps.corps
    .sort((a, b) => b.profit - a.profit)
    .map(
      (corp) => `
    <tr>
      <td>${corp.id.slice(-8)}</td>
      <td>${corp.type}</td>
      <td>${corp.roomName}</td>
      <td>${formatNumber(Math.round(corp.balance))}</td>
      <td class="${corp.profit >= 0 ? "positive" : "negative"}">
        ${formatNumber(Math.round(corp.profit))}
      </td>
      <td>${(corp.roi * 100).toFixed(1)}%</td>
      <td>${corp.creepCount}</td>
      <td>
        <span class="badge ${corp.isActive ? "badge-active" : "badge-inactive"}">
          ${corp.isActive ? "Active" : "Idle"}
        </span>
      </td>
    </tr>
  `
    )
    .join("");
}

/**
 * Update intel UI.
 */
function updateIntelUI(intel) {
  elements.intelTable.innerHTML = intel.rooms
    .sort((a, b) => b.lastVisit - a.lastVisit)
    .map(
      (room) => `
    <tr>
      <td>${room.name}</td>
      <td>${room.lastVisit}</td>
      <td>${room.sourceCount}</td>
      <td>${room.mineralType || "--"}</td>
      <td>RCL ${room.controllerLevel}</td>
      <td>${room.controllerOwner || "--"}</td>
      <td>${room.hostileCreepCount + room.hostileStructureCount}</td>
      <td>
        <span class="badge ${room.isSafe ? "badge-safe" : "badge-hostile"}">
          ${room.isSafe ? "Safe" : "Hostile"}
        </span>
      </td>
    </tr>
  `
    )
    .join("");
}

/**
 * Generate distinct colors for nodes.
 */
const NODE_COLORS = [
  "#60a5fa", // blue
  "#4ade80", // green
  "#f472b6", // pink
  "#facc15", // yellow
  "#a78bfa", // purple
  "#fb923c", // orange
  "#2dd4bf", // teal
  "#f87171", // red
  "#818cf8", // indigo
  "#34d399", // emerald
];

/**
 * Parse room name to get world coordinates.
 * E.g., "W1N2" -> { wx: -1, wy: -2 }, "E3S1" -> { wx: 3, wy: 1 }
 */
function parseRoomCoords(roomName) {
  const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return { wx: 0, wy: 0 };
  const [, ew, ex, ns, ny] = match;
  return {
    wx: ew === "W" ? -parseInt(ex) - 1 : parseInt(ex),
    wy: ns === "N" ? -parseInt(ny) - 1 : parseInt(ny),
  };
}

/**
 * Draw the colony network graph showing nodes positioned on the world map.
 * Node positions are based on their actual peak coordinates in the world.
 * Node sizes are based on peak height (openness).
 */
function drawNetworkGraph(nodesData) {
  const canvas = elements.networkCanvas;
  const ctx = canvas.getContext("2d");

  // Clear canvas
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!nodesData || !nodesData.nodes || nodesData.nodes.length === 0) {
    ctx.fillStyle = "#a0a0a0";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No node data available", canvas.width / 2, canvas.height / 2);
    return;
  }

  const nodes = nodesData.nodes;
  const padding = 20;

  // Calculate world coordinates for each node based on peak position
  // World coords: roomX * 50 + peakPosition.x, roomY * 50 + peakPosition.y
  const nodeWorldCoords = new Map();
  let minWX = Infinity, maxWX = -Infinity, minWY = Infinity, maxWY = -Infinity;

  nodes.forEach((node) => {
    const roomCoords = parseRoomCoords(node.peakPosition?.roomName || node.roomName);
    const peakX = node.peakPosition?.x ?? 25;
    const peakY = node.peakPosition?.y ?? 25;

    // World coordinates (room * 50 + tile position)
    const worldX = roomCoords.wx * 50 + peakX;
    const worldY = roomCoords.wy * 50 + peakY;

    nodeWorldCoords.set(node.id, { worldX, worldY });

    minWX = Math.min(minWX, worldX);
    maxWX = Math.max(maxWX, worldX);
    minWY = Math.min(minWY, worldY);
    maxWY = Math.max(maxWY, worldY);
  });

  // Add minimal margin around the data
  const margin = 10;
  minWX -= margin;
  maxWX += margin;
  minWY -= margin;
  maxWY += margin;

  // Calculate scale to fit canvas
  const worldWidth = maxWX - minWX;
  const worldHeight = maxWY - minWY;
  const scaleX = (canvas.width - padding * 2) / Math.max(worldWidth, 1);
  const scaleY = (canvas.height - padding * 2) / Math.max(worldHeight, 1);
  const scale = Math.min(scaleX, scaleY);

  // Center offset
  const offsetX = padding + (canvas.width - padding * 2 - worldWidth * scale) / 2;
  const offsetY = padding + (canvas.height - padding * 2 - worldHeight * scale) / 2;

  // Helper to convert world coords to canvas coords
  const toCanvas = (worldX, worldY) => ({
    x: offsetX + (worldX - minWX) * scale,
    y: offsetY + (worldY - minWY) * scale,
  });

  // Get unique rooms to draw grid
  const allRooms = new Set();
  nodes.forEach((node) => {
    if (node.spansRooms) {
      node.spansRooms.forEach((r) => allRooms.add(r));
    }
    allRooms.add(node.roomName);
  });

  // Draw room grid background
  ctx.strokeStyle = "#2a2a4e";
  ctx.lineWidth = 1;
  allRooms.forEach((room) => {
    const roomCoords = parseRoomCoords(room);
    // Room boundaries in world coords
    const roomMinX = roomCoords.wx * 50;
    const roomMinY = roomCoords.wy * 50;
    const topLeft = toCanvas(roomMinX, roomMinY);
    const size = 50 * scale;

    ctx.strokeRect(topLeft.x, topLeft.y, size, size);

    // Room label at center
    ctx.fillStyle = "#3a3a5e";
    ctx.font = `${Math.max(8, Math.min(12, size / 5))}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(room, topLeft.x + size / 2, topLeft.y + size / 2);
  });

  // Calculate node positions
  const nodePositions = new Map();
  nodes.forEach((node) => {
    const wc = nodeWorldCoords.get(node.id);
    nodePositions.set(node.id, toCanvas(wc.worldX, wc.worldY));
  });

  // Draw edges for nodes that span rooms (connect to room centers)
  ctx.strokeStyle = "#4a4a6e";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  nodes.forEach((node) => {
    if (node.spansRooms && node.spansRooms.length > 1) {
      const nodePos = nodePositions.get(node.id);
      node.spansRooms.forEach((room) => {
        if (room !== node.roomName) {
          const roomCoords = parseRoomCoords(room);
          const roomCenterX = roomCoords.wx * 50 + 25;
          const roomCenterY = roomCoords.wy * 50 + 25;
          const targetPos = toCanvas(roomCenterX, roomCenterY);
          ctx.beginPath();
          ctx.moveTo(nodePos.x, nodePos.y);
          ctx.lineTo(targetPos.x, targetPos.y);
          ctx.stroke();
        }
      });
    }
  });
  ctx.setLineDash([]);

  // Draw nodes - size based on peak height (openness)
  const minNodeRadius = 6;
  const maxNodeRadius = 20;

  // Find min/max openness for scaling
  let minOpenness = Infinity, maxOpenness = -Infinity;
  nodes.forEach((node) => {
    const openness = node.roi?.openness || 5;
    minOpenness = Math.min(minOpenness, openness);
    maxOpenness = Math.max(maxOpenness, openness);
  });

  nodes.forEach((node, idx) => {
    const pos = nodePositions.get(node.id);
    const isOwned = node.roi?.isOwned;
    const colorIdx = idx % NODE_COLORS.length;

    // Calculate radius based on openness (peak height)
    const openness = node.roi?.openness || 5;
    const opennessRange = Math.max(maxOpenness - minOpenness, 1);
    const normalizedOpenness = (openness - minOpenness) / opennessRange;
    const nodeRadius = minNodeRadius + normalizedOpenness * (maxNodeRadius - minNodeRadius);

    // Node circle
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, nodeRadius, 0, Math.PI * 2);
    ctx.fillStyle = isOwned ? "#60a5fa" : "#facc15";
    ctx.fill();
    ctx.strokeStyle = NODE_COLORS[colorIdx];
    ctx.lineWidth = 2;
    ctx.stroke();

    // Source count inside node (if it fits)
    const sourceCount = node.roi?.sourceCount || node.resources?.filter(r => r.type === "source").length || 0;
    if (nodeRadius >= 10) {
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${Math.max(8, nodeRadius * 0.7)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(sourceCount), pos.x, pos.y);
    }

    // Draw controller indicator (diamond above node)
    const hasController = node.roi?.hasController || node.resources?.some(r => r.type === "controller");
    if (hasController) {
      ctx.beginPath();
      const cx = pos.x;
      const cy = pos.y - nodeRadius - 6;
      ctx.moveTo(cx, cy - 4);
      ctx.lineTo(cx + 4, cy);
      ctx.lineTo(cx, cy + 4);
      ctx.lineTo(cx - 4, cy);
      ctx.closePath();
      ctx.fillStyle = "#e94560";
      ctx.fill();
    }
  });

  // Draw legend
  ctx.fillStyle = "#eaeaea";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`Nodes: ${nodesData.summary?.totalNodes || nodes.length}`, 10, 10);
  ctx.fillText(`Owned: ${nodesData.summary?.ownedNodes || 0}`, 10, 24);
  ctx.fillText(`Expansion: ${nodesData.summary?.expansionCandidates || 0}`, 10, 38);

  // Size legend
  ctx.fillStyle = "#888";
  ctx.font = "10px sans-serif";
  ctx.fillText("Size = Peak Height", 10, canvas.height - 20);
}

/**
 * Setup tab switching.
 */
function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  const contents = document.querySelectorAll(".tab-content");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = tab.dataset.tab;

      // Update tabs
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      // Update content
      contents.forEach((c) => c.classList.remove("active"));
      document.getElementById(targetId).classList.add("active");
    });
  });
}

/**
 * Refresh telemetry data from server.
 */
async function refreshTelemetry() {
  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = "Refreshing...";

  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    const data = await response.json();
    if (data.ok) {
      console.log("Refreshed, tick:", data.tick);
    }
  } catch (e) {
    console.error("Failed to refresh:", e);
  } finally {
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = "Refresh";
  }
}

/**
 * Setup refresh button.
 */
function setupRefreshButton() {
  elements.refreshBtn.addEventListener("click", refreshTelemetry);
}

/**
 * Initialize the dashboard.
 */
function init() {
  setupTabs();
  setupRefreshButton();
  connect();
}

// Start when DOM is ready
document.addEventListener("DOMContentLoaded", init);
