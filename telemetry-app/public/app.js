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

  // Terrain
  terrainCanvas: document.getElementById("terrain-canvas"),
  terrainRoomSelect: document.getElementById("terrain-room-select"),
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

  // Update Terrain room select
  if (telemetry.terrain) {
    updateTerrainRoomSelect(telemetry.terrain);
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
 * Update terrain room select.
 */
function updateTerrainRoomSelect(terrain) {
  const currentValue = elements.terrainRoomSelect.value;
  const rooms = terrain.rooms.map((r) => r.name).sort();

  // Only update if rooms changed
  const existingRooms = Array.from(elements.terrainRoomSelect.options)
    .slice(1)
    .map((o) => o.value);

  if (JSON.stringify(rooms) !== JSON.stringify(existingRooms)) {
    elements.terrainRoomSelect.innerHTML = '<option value="">Select a room...</option>';
    rooms.forEach((room) => {
      const option = document.createElement("option");
      option.value = room;
      option.textContent = room;
      elements.terrainRoomSelect.appendChild(option);
    });

    if (currentValue && rooms.includes(currentValue)) {
      elements.terrainRoomSelect.value = currentValue;
    }
  }
}

/**
 * Draw terrain on canvas.
 */
function drawTerrain(roomName) {
  if (!telemetry.terrain) return;

  const room = telemetry.terrain.rooms.find((r) => r.name === roomName);
  if (!room) return;

  const canvas = elements.terrainCanvas;
  const ctx = canvas.getContext("2d");

  const tileSize = 10;
  canvas.width = 50 * tileSize;
  canvas.height = 50 * tileSize;

  // Parse terrain string
  const terrain = room.terrain;

  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const idx = y * 50 + x;
      const t = terrain[idx];

      // Set color based on terrain type
      if (t === "1") {
        ctx.fillStyle = "#111111"; // Wall
      } else if (t === "2") {
        ctx.fillStyle = "#4a6741"; // Swamp
      } else {
        ctx.fillStyle = "#2b2b2b"; // Plain
      }

      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }

  // Draw grid
  ctx.strokeStyle = "#333333";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 50; i++) {
    ctx.beginPath();
    ctx.moveTo(i * tileSize, 0);
    ctx.lineTo(i * tileSize, 50 * tileSize);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * tileSize);
    ctx.lineTo(50 * tileSize, i * tileSize);
    ctx.stroke();
  }

  // Draw nodes if available
  if (telemetry.nodes) {
    const nodesInRoom = telemetry.nodes.nodes.filter(
      (n) => n.roomName === roomName
    );

    for (const node of nodesInRoom) {
      // Draw peak position
      const px = node.peakPosition.x * tileSize + tileSize / 2;
      const py = node.peakPosition.y * tileSize + tileSize / 2;

      ctx.beginPath();
      ctx.arc(px, py, tileSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = node.roi?.isOwned ? "#60a5fa" : "#fbbf24";
      ctx.fill();

      // Draw sources
      for (const res of node.resources) {
        if (res.type === "source") {
          const sx = res.position.x * tileSize + tileSize / 2;
          const sy = res.position.y * tileSize + tileSize / 2;
          ctx.beginPath();
          ctx.arc(sx, sy, tileSize / 3, 0, Math.PI * 2);
          ctx.fillStyle = "#fbbf24";
          ctx.fill();
        } else if (res.type === "controller") {
          const cx = res.position.x * tileSize + tileSize / 2;
          const cy = res.position.y * tileSize + tileSize / 2;
          ctx.beginPath();
          ctx.arc(cx, cy, tileSize / 3, 0, Math.PI * 2);
          ctx.fillStyle = "#e94560";
          ctx.fill();
        }
      }
    }
  }
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
 * Setup terrain room select.
 */
function setupTerrainSelect() {
  elements.terrainRoomSelect.addEventListener("change", (e) => {
    if (e.target.value) {
      drawTerrain(e.target.value);
    }
  });
}

/**
 * Initialize the dashboard.
 */
function init() {
  setupTabs();
  setupTerrainSelect();
  connect();
}

// Start when DOM is ready
document.addEventListener("DOMContentLoaded", init);
