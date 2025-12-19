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
 * Draw terrain on canvas with node territories.
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

  // Build territory lookup: position -> node index
  const territoryMap = new Map(); // "x,y" -> nodeIndex
  const nodesInRoom = [];

  if (telemetry.nodes) {
    telemetry.nodes.nodes.forEach((node, idx) => {
      if (node.territory && node.territory[roomName]) {
        nodesInRoom.push({ node, colorIdx: idx % NODE_COLORS.length });
        for (const pos of node.territory[roomName]) {
          territoryMap.set(`${pos.x},${pos.y}`, idx % NODE_COLORS.length);
        }
      }
    });
  }

  // Draw base terrain with territory colors
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const idx = y * 50 + x;
      const t = terrain[idx];
      const key = `${x},${y}`;
      const nodeColorIdx = territoryMap.get(key);

      if (t === "1") {
        // Wall - dark
        ctx.fillStyle = "#111111";
      } else if (nodeColorIdx !== undefined) {
        // Territory tile - use node color with transparency
        const baseColor = NODE_COLORS[nodeColorIdx];
        ctx.fillStyle = baseColor + "40"; // 25% opacity
      } else if (t === "2") {
        // Swamp without territory
        ctx.fillStyle = "#3a4a35";
      } else {
        // Plain without territory
        ctx.fillStyle = "#1a1a1a";
      }

      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }

  // Draw territory borders (optional - makes nodes more visible)
  if (telemetry.nodes) {
    nodesInRoom.forEach(({ node, colorIdx }) => {
      const positions = node.territory[roomName] || [];
      const posSet = new Set(positions.map(p => `${p.x},${p.y}`));

      ctx.strokeStyle = NODE_COLORS[colorIdx];
      ctx.lineWidth = 1;

      for (const pos of positions) {
        // Check each edge for border
        const neighbors = [
          { dx: 0, dy: -1, edge: 'top' },
          { dx: 0, dy: 1, edge: 'bottom' },
          { dx: -1, dy: 0, edge: 'left' },
          { dx: 1, dy: 0, edge: 'right' },
        ];

        for (const { dx, dy, edge } of neighbors) {
          const nx = pos.x + dx;
          const ny = pos.y + dy;
          if (!posSet.has(`${nx},${ny}`)) {
            // Draw border edge
            ctx.beginPath();
            const px = pos.x * tileSize;
            const py = pos.y * tileSize;
            if (edge === 'top') {
              ctx.moveTo(px, py);
              ctx.lineTo(px + tileSize, py);
            } else if (edge === 'bottom') {
              ctx.moveTo(px, py + tileSize);
              ctx.lineTo(px + tileSize, py + tileSize);
            } else if (edge === 'left') {
              ctx.moveTo(px, py);
              ctx.lineTo(px, py + tileSize);
            } else if (edge === 'right') {
              ctx.moveTo(px + tileSize, py);
              ctx.lineTo(px + tileSize, py + tileSize);
            }
            ctx.stroke();
          }
        }
      }
    });
  }

  // Draw resources
  if (telemetry.nodes) {
    for (const { node, colorIdx } of nodesInRoom) {
      for (const res of node.resources) {
        if (res.position.roomName !== roomName) continue;

        const rx = res.position.x * tileSize + tileSize / 2;
        const ry = res.position.y * tileSize + tileSize / 2;

        ctx.beginPath();
        if (res.type === "source") {
          // Yellow circle for sources
          ctx.arc(rx, ry, tileSize / 2.5, 0, Math.PI * 2);
          ctx.fillStyle = "#fbbf24";
          ctx.fill();
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (res.type === "controller") {
          // Red diamond for controller
          ctx.moveTo(rx, ry - tileSize / 2.5);
          ctx.lineTo(rx + tileSize / 2.5, ry);
          ctx.lineTo(rx, ry + tileSize / 2.5);
          ctx.lineTo(rx - tileSize / 2.5, ry);
          ctx.closePath();
          ctx.fillStyle = "#e94560";
          ctx.fill();
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (res.type === "mineral") {
          // Cyan square for minerals
          ctx.rect(rx - tileSize / 3, ry - tileSize / 3, tileSize / 1.5, tileSize / 1.5);
          ctx.fillStyle = "#22d3ee";
          ctx.fill();
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }

  // Draw peak centers (node labels)
  if (telemetry.nodes) {
    for (const { node, colorIdx } of nodesInRoom) {
      if (node.peakPosition.roomName !== roomName) continue;

      const px = node.peakPosition.x * tileSize + tileSize / 2;
      const py = node.peakPosition.y * tileSize + tileSize / 2;

      // Draw peak marker
      ctx.beginPath();
      ctx.arc(px, py, tileSize / 1.5, 0, Math.PI * 2);
      ctx.fillStyle = NODE_COLORS[colorIdx];
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw node index
      ctx.fillStyle = "#fff";
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(colorIdx + 1), px, py);
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
