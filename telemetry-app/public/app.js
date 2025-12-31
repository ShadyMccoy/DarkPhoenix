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
  edges: null,  // Compressed edge data from segment 2
  intel: null,
  corps: null,
  chains: null,
  flow: null,    // Flow economy: sources, sinks, allocations
  lastUpdate: 0,
};

// Cached hydrated nodes (with edges merged in)
let hydratedNodesCache = null;
let hydratedNodesTick = null;

// Economic analysis constants
const ECON = {
  SOURCE_ENERGY_PER_TICK: 10,
  CREEP_LIFESPAN: 1500,
  BODY_COSTS: { move: 50, work: 100, carry: 50 },
  MIN_EFFICIENCY: 0.3,
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

  // Flow
  flowHarvest: document.getElementById("flow-harvest"),
  flowOverhead: document.getElementById("flow-overhead"),
  flowNet: document.getElementById("flow-net"),
  flowEfficiency: document.getElementById("flow-efficiency"),
  flowSustainable: document.getElementById("flow-sustainable"),
  flowSourcesTable: document.querySelector("#flow-sources-table tbody"),
  flowSinksTable: document.querySelector("#flow-sinks-table tbody"),
  flowMiners: document.getElementById("flow-miners"),
  flowHaulers: document.getElementById("flow-haulers"),
  flowWarningsSection: document.getElementById("flow-warnings-section"),
  flowWarnings: document.getElementById("flow-warnings"),

  // Network
  networkCanvas: document.getElementById("network-canvas"),
  networkType: document.getElementById("network-type"),
  networkViz: document.getElementById("network-viz"),

  // Node details modal
  nodeDetailsOverlay: document.getElementById("node-details-overlay"),
  nodeDetails: document.getElementById("node-details"),
  detailsTitle: document.getElementById("details-title"),
  detailsContent: document.getElementById("details-content"),
  detailsClose: document.getElementById("details-close"),
};

// Current network view type
let currentNetworkType = "spatial";

// Current visualization mode for node coloring
let currentVizMode = "status";

// Network canvas state for zoom/pan
let networkState = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  isDragging: false,
  didDrag: false,           // Track if mouse actually moved during drag
  lastMouseX: 0,
  lastMouseY: 0,
  nodePositions: new Map(),  // Cache node canvas positions
  nodes: [],                  // Current nodes data
  hoveredNode: null,         // Currently hovered node
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
        // Clear hydration cache when new data arrives
        hydratedNodesCache = null;
        hydratedNodesTick = null;
        // Log segment availability
        const hasEdgesSegment = telemetry.edges && telemetry.edges.nodeIndex;
        console.log(`[Telemetry] Received tick ${telemetry.core?.tick}, edges segment: ${hasEdgesSegment ? 'yes' : 'no'}`);
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
 * Decompress edges from segment 2 format.
 * Converts numeric index pairs back to string edge keys.
 * @param {Object} edgesData - The edges telemetry from segment 2
 * @returns {Object} Object with { edges: string[], economicEdges: { [key: string]: number } }
 */
function decompressEdges(edgesData) {
  if (!edgesData || !edgesData.nodeIndex) {
    return { edges: [], economicEdges: {} };
  }

  const { nodeIndex, edges, economicEdges } = edgesData;

  // Convert spatial edges: [idx1, idx2] -> "nodeId1|nodeId2"
  const decompressedEdges = (edges || []).map(([idx1, idx2]) => {
    const id1 = nodeIndex[idx1];
    const id2 = nodeIndex[idx2];
    // Sort to ensure consistent edge key ordering
    return id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
  });

  // Convert economic edges: [idx1, idx2, distance] -> { "nodeId1|nodeId2": distance }
  const decompressedEconEdges = {};
  for (const [idx1, idx2, distance] of (economicEdges || [])) {
    const id1 = nodeIndex[idx1];
    const id2 = nodeIndex[idx2];
    const key = id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
    decompressedEconEdges[key] = distance;
  }

  return {
    edges: decompressedEdges,
    economicEdges: decompressedEconEdges,
  };
}

/**
 * Get nodes data with edges merged from segment 2.
 * Falls back to edges on nodes object for backwards compatibility.
 * Results are cached per tick to avoid re-hydrating on every call.
 */
function getNodesWithEdges() {
  if (!telemetry.nodes) return null;

  const currentTick = telemetry.nodes.tick;

  // Return cached result if available for this tick
  if (hydratedNodesCache && hydratedNodesTick === currentTick) {
    return hydratedNodesCache;
  }

  // If edges segment is available, decompress and merge
  if (telemetry.edges && telemetry.edges.nodeIndex) {
    const { edges, economicEdges } = decompressEdges(telemetry.edges);
    console.log(`[Edges] Hydrated ${edges.length} spatial edges, ${Object.keys(economicEdges).length} economic edges from segment 2`);
    hydratedNodesCache = {
      ...telemetry.nodes,
      edges,
      economicEdges,
    };
    hydratedNodesTick = currentTick;
    return hydratedNodesCache;
  }

  // Fallback to edges on nodes object (backwards compatibility with v4 and earlier)
  if (telemetry.nodes.edges) {
    console.log(`[Edges] Using legacy edges from nodes segment: ${telemetry.nodes.edges.length} edges`);
  }
  hydratedNodesCache = telemetry.nodes;
  hydratedNodesTick = currentTick;
  return hydratedNodesCache;
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

  // Update Flow
  if (telemetry.flow) {
    updateFlowUI(telemetry.flow);
  }

  // Update Network graph
  if (telemetry.nodes) {
    drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
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

  // Build economic adjacency map with distance-weighted neighbor counts
  // Weight formula: (1500 - distance) / 1500 (closer nodes count more)
  const econNeighbors = new Map();
  if (nodes.economicEdges) {
    if (Array.isArray(nodes.economicEdges)) {
      // Legacy array format - count without weighting
      for (const edge of nodes.economicEdges) {
        const [a, b] = edge.split('|');
        econNeighbors.set(a, (econNeighbors.get(a) || 0) + 1);
        econNeighbors.set(b, (econNeighbors.get(b) || 0) + 1);
      }
    } else {
      // New object format with distances
      for (const [edge, distance] of Object.entries(nodes.economicEdges)) {
        const [a, b] = edge.split('|');
        const weight = (1500 - distance) / 1500;
        econNeighbors.set(a, (econNeighbors.get(a) || 0) + weight);
        econNeighbors.set(b, (econNeighbors.get(b) || 0) + weight);
      }
    }
  }

  // Update table - sort by controller nodes first, then by score
  const sortedNodes = [...nodes.nodes].sort((a, b) => {
    // Controller nodes first
    const aHasCtrl = a.roi?.hasController ? 1 : 0;
    const bHasCtrl = b.roi?.hasController ? 1 : 0;
    if (aHasCtrl !== bHasCtrl) return bHasCtrl - aHasCtrl;
    // Then by score
    return (b.roi?.score || 0) - (a.roi?.score || 0);
  });

  elements.nodesTable.innerHTML = sortedNodes
    .map((node) => {
      const neighbors = econNeighbors.get(node.id) || 0;
      const sourceCount = node.roi?.sourceCount || node.resources?.filter(r => r.type === 'source').length || 0;
      const isEcon = node.econ;

      // Calculate local sources (in this node)
      const localSources = node.resources?.filter(r => r.type === 'source').length || 0;

      return `
    <tr class="clickable-row ${node.roi?.hasController ? 'controller-node' : ''}" data-node-id="${node.id}">
      <td title="${node.id}">${node.id.length > 15 ? node.id.slice(0, 15) + '...' : node.id}</td>
      <td>${node.roomName}</td>
      <td>${node.territorySize}</td>
      <td>
        <span class="${localSources > 0 ? 'has-sources' : ''}">${localSources}</span>
        ${neighbors > 0 ? `<span class="remote-sources">+${neighbors.toFixed(1)} adj</span>` : ''}
      </td>
      <td>${node.roi?.hasController ? '<span class="controller-icon">◆</span>' : ''}</td>
      <td class="score-cell">${node.roi?.score?.toFixed(1) || "--"}</td>
      <td class="score-cell">${node.roi?.expansionScore?.toFixed(1) || "--"}</td>
      <td>${node.roi?.openness?.toFixed(1) || "--"}</td>
      <td>
        ${isEcon ? '<span class="badge badge-econ">Econ</span>' : ''}
        <span class="badge ${node.roi?.isOwned ? "badge-owned" : "badge-expansion"}">
          ${node.roi?.isOwned ? "Owned" : "Exp"}
        </span>
      </td>
    </tr>
  `;
    })
    .join("");

  // Add click handlers to table rows
  elements.nodesTable.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const nodeId = row.dataset.nodeId;
      const node = nodes.nodes.find(n => n.id === nodeId);
      if (node) {
        showNodeDetails(node);
      }
    });
  });
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
 * Update flow economy UI.
 */
function updateFlowUI(flow) {
  // Update summary stats
  const summary = flow.summary || {};
  elements.flowHarvest.textContent = formatNumber(Math.round(summary.totalHarvest || 0));
  elements.flowOverhead.textContent = formatNumber(Math.round(summary.totalOverhead || 0));
  elements.flowNet.textContent = formatNumber(Math.round(summary.netEnergy || 0));
  elements.flowEfficiency.textContent = (summary.efficiency || 0).toFixed(1);

  // Update sustainable badge
  if (summary.isSustainable) {
    elements.flowSustainable.textContent = "Sustainable";
    elements.flowSustainable.className = "status-badge status-active";
  } else {
    elements.flowSustainable.textContent = "Unsustainable";
    elements.flowSustainable.className = "status-badge status-inactive";
  }

  // Update creep counts
  elements.flowMiners.textContent = summary.minerCount || 0;
  elements.flowHaulers.textContent = summary.haulerCount || 0;

  // Update sources table - sort by efficiency descending
  const sources = flow.sources || [];
  elements.flowSourcesTable.innerHTML = sources
    .sort((a, b) => (b.efficiency || 0) - (a.efficiency || 0))
    .map(
      (source) => {
        const eff = source.efficiency ?? 0;
        const effClass = eff >= 80 ? 'positive' : eff >= 70 ? '' : 'status-warning';
        return `
    <tr>
      <td title="${source.id}">${source.id.slice(-12)}</td>
      <td title="${source.nodeId}">${source.nodeId ? source.nodeId.slice(-8) : "--"}</td>
      <td>${source.harvestRate.toFixed(1)}/tick</td>
      <td>${source.spawnDistance ?? "--"}</td>
      <td class="${effClass}">${eff.toFixed(1)}%</td>
    </tr>
  `;
      }
    )
    .join("") || '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No sources</td></tr>';

  // Update sinks table
  const sinks = flow.sinks || [];
  elements.flowSinksTable.innerHTML = sinks
    .sort((a, b) => b.priority - a.priority)
    .map(
      (sink) => `
    <tr>
      <td title="${sink.id}">${sink.id.slice(-12)}</td>
      <td>${sink.type}</td>
      <td>${formatNumber(Math.round(sink.demand))}</td>
      <td>${formatNumber(Math.round(sink.allocated))}</td>
      <td class="${sink.unmet > 0 ? 'status-warning' : ''}">${formatNumber(Math.round(sink.unmet))}</td>
      <td>${sink.priority}</td>
    </tr>
  `
    )
    .join("") || '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No sinks</td></tr>';

  // Update warnings
  const warnings = flow.warnings || [];
  if (warnings.length > 0) {
    elements.flowWarningsSection.style.display = "block";
    elements.flowWarnings.innerHTML = warnings
      .map((w) => `<li>${w}</li>`)
      .join("");
  } else {
    elements.flowWarningsSection.style.display = "none";
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
 * Interpolate between red -> yellow -> green based on normalized value (0-1).
 */
function interpolateColor(t) {
  t = Math.max(0, Math.min(1, t));
  if (t < 0.5) {
    // Red to Yellow (0 -> 0.5)
    const r = 239;
    const g = Math.round(68 + (204 - 68) * (t * 2));
    const b = 68;
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // Yellow to Green (0.5 -> 1)
    const r = Math.round(239 - (239 - 74) * ((t - 0.5) * 2));
    const g = Math.round(204 + (222 - 204) * ((t - 0.5) * 2));
    const b = Math.round(68 + (128 - 68) * ((t - 0.5) * 2));
    return `rgb(${r}, ${g}, ${b})`;
  }
}

/**
 * Compute visualization stats for color normalization.
 */
function computeVizStats(nodes) {
  let minRoi = Infinity, maxRoi = -Infinity;
  let minSources = Infinity, maxSources = -Infinity;
  let minOpenness = Infinity, maxOpenness = -Infinity;

  nodes.forEach((node) => {
    const score = node.roi?.score ?? 0;
    minRoi = Math.min(minRoi, score);
    maxRoi = Math.max(maxRoi, score);

    const sources = node.roi?.sourceCount || node.resources?.filter(r => r.type === "source").length || 0;
    minSources = Math.min(minSources, sources);
    maxSources = Math.max(maxSources, sources);

    const openness = node.roi?.openness ?? 0;
    minOpenness = Math.min(minOpenness, openness);
    maxOpenness = Math.max(maxOpenness, openness);
  });

  return {
    minRoi, maxRoi, roiRange: maxRoi - minRoi,
    minSources, maxSources, sourceRange: maxSources - minSources,
    minOpenness, maxOpenness, opennessRange: maxOpenness - minOpenness,
  };
}

/**
 * Get node fill color based on current visualization mode.
 */
function getNodeVizColor(node, vizStats) {
  switch (currentVizMode) {
    case "roi": {
      const score = node.roi?.score ?? 0;
      const normalized = vizStats.roiRange > 0
        ? (score - vizStats.minRoi) / vizStats.roiRange
        : 0.5;
      return interpolateColor(normalized);
    }
    case "sources": {
      const count = node.roi?.sourceCount || node.resources?.filter(r => r.type === "source").length || 0;
      const normalized = vizStats.sourceRange > 0
        ? (count - vizStats.minSources) / vizStats.sourceRange
        : 0.5;
      return interpolateColor(normalized);
    }
    case "openness": {
      const openness = node.roi?.openness ?? 0;
      const normalized = vizStats.opennessRange > 0
        ? (openness - vizStats.minOpenness) / vizStats.opennessRange
        : 0.5;
      return interpolateColor(normalized);
    }
    case "status":
    default:
      return node.roi?.isOwned ? "#60a5fa" : "#facc15";
  }
}

/**
 * Get label for current visualization mode.
 */
function getVizModeLabel() {
  switch (currentVizMode) {
    case "roi": return "ROI Estimate";
    case "sources": return "Source Count";
    case "openness": return "Openness";
    case "status":
    default: return "Status";
  }
}

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
 * Compute economic edges from corps data.
 * Economic edges connect all nodes that have active corps.
 * Returns an array of edge strings in format "nodeId1|nodeId2"
 */
function computeEconomicEdges(nodesData, corpsData) {
  if (!corpsData || !corpsData.corps) return [];

  // Find all unique nodeIds with corps
  const nodeIdsWithCorps = new Set();
  for (const corp of corpsData.corps) {
    if (corp.nodeId) {
      nodeIdsWithCorps.add(corp.nodeId);
    }
  }

  // Also check nodes directly for ownership
  const nodeIdSet = new Set(nodesData.nodes.map(n => n.id));

  // Create edges between all pairs of corp-hosting nodes
  const edges = [];
  const corpNodeIds = Array.from(nodeIdsWithCorps).filter(id => nodeIdSet.has(id));

  for (let i = 0; i < corpNodeIds.length; i++) {
    for (let j = i + 1; j < corpNodeIds.length; j++) {
      const [id1, id2] = [corpNodeIds[i], corpNodeIds[j]].sort();
      edges.push(`${id1}|${id2}`);
    }
  }

  return edges;
}

/**
 * Draw the colony network graph showing nodes positioned on the world map.
 * Node positions are based on their actual peak coordinates in the world.
 * Node sizes are based on peak height (openness).
 * @param {Object} nodesData - Node telemetry data
 * @param {Object} corpsData - Corps telemetry data (optional)
 * @param {string} networkType - "spatial" or "economic"
 */
function drawNetworkGraph(nodesData, corpsData, networkType = "spatial") {
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
  networkState.nodes = nodes;  // Cache for hover detection
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

  // Calculate base scale to fit canvas
  const worldWidth = maxWX - minWX;
  const worldHeight = maxWY - minWY;
  const scaleX = (canvas.width - padding * 2) / Math.max(worldWidth, 1);
  const scaleY = (canvas.height - padding * 2) / Math.max(worldHeight, 1);
  const baseScale = Math.min(scaleX, scaleY);

  // Apply user zoom/pan
  const scale = baseScale * networkState.scale;

  // Center offset with user pan
  const baseCenterX = padding + (canvas.width - padding * 2 - worldWidth * baseScale) / 2;
  const baseCenterY = padding + (canvas.height - padding * 2 - worldHeight * baseScale) / 2;
  const offsetX = baseCenterX * networkState.scale + networkState.offsetX;
  const offsetY = baseCenterY * networkState.scale + networkState.offsetY;

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

  // Calculate node positions and cache for hover detection
  const nodePositions = new Map();
  nodes.forEach((node) => {
    const wc = nodeWorldCoords.get(node.id);
    nodePositions.set(node.id, toCanvas(wc.worldX, wc.worldY));
  });
  networkState.nodePositions = nodePositions;

  // Get edges based on network type
  let edges;
  let edgeColor;
  let edgeLabel;

  if (networkType === "economic") {
    // Economic network: compute edges between corp-hosting nodes
    const econEdges = nodesData.economicEdges || computeEconomicEdges(nodesData, corpsData);
    // Handle both object format (new) and array format (legacy/computed)
    edges = Array.isArray(econEdges) ? econEdges : Object.keys(econEdges);
    edgeColor = "#4ade80";  // Green for economic connections
    edgeLabel = "Economic";
  } else {
    // Spatial network: use spatial adjacency edges
    edges = nodesData.edges || [];
    edgeColor = "#88aaff";  // Blue for spatial connections
    edgeLabel = "Spatial";
  }

  // Draw edges between nodes
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  edges.forEach((edgeKey) => {
    const [nodeId1, nodeId2] = edgeKey.split("|");
    const pos1 = nodePositions.get(nodeId1);
    const pos2 = nodePositions.get(nodeId2);
    if (pos1 && pos2) {
      ctx.beginPath();
      ctx.moveTo(pos1.x, pos1.y);
      ctx.lineTo(pos2.x, pos2.y);
      ctx.stroke();
    }
  });

  // Draw lighter dashed lines for nodes that span rooms (connect to room centers)
  ctx.strokeStyle = "#4a4a6e";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  nodes.forEach((node) => {
    if (node.spansRooms && node.spansRooms.length > 1) {
      // Fade room-spanning lines for non-economic nodes in economic view
      const isEconNode = networkType !== "economic" || node.econ;
      ctx.globalAlpha = isEconNode ? 1.0 : 0.15;

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
  ctx.globalAlpha = 1.0;

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

  // Compute visualization stats for color mapping
  const vizStats = computeVizStats(nodes);

  nodes.forEach((node, idx) => {
    const pos = nodePositions.get(node.id);
    const colorIdx = idx % NODE_COLORS.length;

    // Check if this node should be faded (economic view, not in economic network)
    const isEconNode = networkType !== "economic" || node.econ;
    const alpha = isEconNode ? 1.0 : 0.15;

    // Calculate radius based on openness (peak height)
    const openness = node.roi?.openness || 5;
    const opennessRange = Math.max(maxOpenness - minOpenness, 1);
    const normalizedOpenness = (openness - minOpenness) / opennessRange;
    const nodeRadius = minNodeRadius + normalizedOpenness * (maxNodeRadius - minNodeRadius);

    ctx.globalAlpha = alpha;

    // Node circle - use visualization mode for fill color
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, nodeRadius, 0, Math.PI * 2);
    ctx.fillStyle = getNodeVizColor(node, vizStats);
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

    ctx.globalAlpha = 1.0;
  });

  // Draw legend
  ctx.fillStyle = "#eaeaea";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`${edgeLabel} Network`, 10, 10);
  ctx.fillText(`Nodes: ${nodesData.summary?.totalNodes || nodes.length}`, 10, 24);
  ctx.fillText(`Edges: ${edges.length}`, 10, 38);
  ctx.fillText(`Owned: ${nodesData.summary?.ownedNodes || 0}`, 10, 52);
  ctx.fillText(`Expansion: ${nodesData.summary?.expansionCandidates || 0}`, 10, 66);

  // Visualization mode legend
  const vizLabel = getVizModeLabel();
  ctx.fillStyle = "#888";
  ctx.font = "10px sans-serif";

  if (currentVizMode === "status") {
    // Status mode: show owned/expansion colors
    ctx.fillText("Color = " + vizLabel, 10, canvas.height - 60);
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(10, canvas.height - 48, 12, 12);
    ctx.fillStyle = "#888";
    ctx.fillText("Owned", 26, canvas.height - 46);
    ctx.fillStyle = "#facc15";
    ctx.fillRect(70, canvas.height - 48, 12, 12);
    ctx.fillStyle = "#888";
    ctx.fillText("Expansion", 86, canvas.height - 46);
  } else {
    // Gradient modes: draw a gradient legend
    ctx.fillText("Color = " + vizLabel, 10, canvas.height - 60);
    const gradientWidth = 80;
    for (let i = 0; i < gradientWidth; i++) {
      ctx.fillStyle = interpolateColor(i / gradientWidth);
      ctx.fillRect(10 + i, canvas.height - 48, 1, 12);
    }
    ctx.fillStyle = "#888";
    ctx.fillText("Low", 10, canvas.height - 33);
    ctx.fillText("High", 10 + gradientWidth - 20, canvas.height - 33);
  }

  // Size legend
  ctx.fillStyle = "#888";
  ctx.fillText("Size = Peak Height", 10, canvas.height - 20);

  // Edge color legend (right side bottom)
  ctx.fillStyle = edgeColor;
  ctx.fillRect(canvas.width - 100, canvas.height - 20, 12, 12);
  ctx.fillStyle = "#888";
  ctx.fillText(`${edgeLabel} edges`, canvas.width - 84, canvas.height - 18);

  // Zoom level indicator
  if (networkState.scale !== 1) {
    ctx.fillStyle = "#888";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`Zoom: ${(networkState.scale * 100).toFixed(0)}%`, canvas.width - 10, canvas.height - 10);
    ctx.fillText("Double-click to reset", canvas.width - 10, canvas.height - 22);
  }

  // Draw tooltip for hovered node (last, so it's on top)
  if (networkState.hoveredNode) {
    drawNodeTooltip(ctx, networkState.hoveredNode, canvas.width);
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
 * Setup network type selector.
 */
function setupNetworkTypeSelector() {
  elements.networkType.addEventListener("change", (e) => {
    currentNetworkType = e.target.value;
    // Redraw the network with the new type
    if (telemetry.nodes) {
      drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
    }
  });
}

/**
 * Setup network visualization mode selector.
 */
function setupNetworkVizSelector() {
  elements.networkViz.addEventListener("change", (e) => {
    currentVizMode = e.target.value;
    // Redraw the network with the new visualization mode
    if (telemetry.nodes) {
      drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
    }
  });
}

/**
 * Setup network canvas mouse events for hover/zoom/pan.
 */
function setupNetworkCanvas() {
  const canvas = elements.networkCanvas;

  // Mouse wheel for zoom
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.5, Math.min(5, networkState.scale * zoomFactor));

    // Adjust offset to zoom toward mouse position
    const scaleChange = newScale / networkState.scale;
    networkState.offsetX = mouseX - (mouseX - networkState.offsetX) * scaleChange;
    networkState.offsetY = mouseY - (mouseY - networkState.offsetY) * scaleChange;
    networkState.scale = newScale;

    // Redraw
    if (telemetry.nodes) {
      drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
    }
  });

  // Mouse down for pan start
  canvas.addEventListener("mousedown", (e) => {
    networkState.isDragging = true;
    networkState.didDrag = false;  // Reset drag tracking
    networkState.lastMouseX = e.clientX;
    networkState.lastMouseY = e.clientY;
    canvas.style.cursor = "grabbing";
  });

  // Mouse move for pan and hover detection
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (networkState.isDragging) {
      // Pan
      const dx = e.clientX - networkState.lastMouseX;
      const dy = e.clientY - networkState.lastMouseY;

      // Track if we actually moved (threshold of 3px to avoid accidental micro-movements)
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        networkState.didDrag = true;
      }

      networkState.offsetX += dx;
      networkState.offsetY += dy;
      networkState.lastMouseX = e.clientX;
      networkState.lastMouseY = e.clientY;

      // Redraw
      if (telemetry.nodes) {
        drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
      }
    } else {
      // Check for node hover
      const hoveredNode = findNodeAtPosition(mouseX, mouseY);
      if (hoveredNode !== networkState.hoveredNode) {
        networkState.hoveredNode = hoveredNode;
        canvas.style.cursor = hoveredNode ? "pointer" : "grab";
        // Redraw to show/hide tooltip
        if (telemetry.nodes) {
          drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
        }
      }
    }
  });

  // Mouse up for pan end
  canvas.addEventListener("mouseup", () => {
    networkState.isDragging = false;
    elements.networkCanvas.style.cursor = networkState.hoveredNode ? "pointer" : "grab";
  });

  // Mouse leave
  canvas.addEventListener("mouseleave", () => {
    networkState.isDragging = false;
    networkState.hoveredNode = null;
    canvas.style.cursor = "grab";
    if (telemetry.nodes) {
      drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
    }
  });

  // Double click to reset zoom
  canvas.addEventListener("dblclick", () => {
    networkState.scale = 1;
    networkState.offsetX = 0;
    networkState.offsetY = 0;
    if (telemetry.nodes) {
      drawNetworkGraph(getNodesWithEdges(), telemetry.corps, currentNetworkType);
    }
  });

  // Click to show node details
  canvas.addEventListener("click", (e) => {
    // Don't trigger click if we actually dragged
    if (networkState.didDrag) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const clickedNode = findNodeAtPosition(mouseX, mouseY);

    if (clickedNode) {
      showNodeDetails(clickedNode);
    }
  });

  // Set initial cursor
  canvas.style.cursor = "grab";

  // Setup close button for details modal
  if (elements.detailsClose) {
    elements.detailsClose.addEventListener("click", () => {
      elements.nodeDetailsOverlay.classList.add("hidden");
    });
  }

  // Close modal when clicking overlay background
  if (elements.nodeDetailsOverlay) {
    elements.nodeDetailsOverlay.addEventListener("click", (e) => {
      if (e.target === elements.nodeDetailsOverlay) {
        elements.nodeDetailsOverlay.classList.add("hidden");
      }
    });
  }
}

/**
 * Find node at canvas position.
 */
function findNodeAtPosition(x, y) {
  for (const [nodeId, pos] of networkState.nodePositions) {
    const node = networkState.nodes.find(n => n.id === nodeId);
    if (!node) continue;

    const radius = getNodeRadius(node);
    const dx = x - pos.x;
    const dy = y - pos.y;
    if (dx * dx + dy * dy <= radius * radius) {
      return node;
    }
  }
  return null;
}

/**
 * Get node radius based on openness.
 */
function getNodeRadius(node) {
  const minNodeRadius = 6;
  const maxNodeRadius = 20;
  const openness = node.roi?.openness || 5;

  // Use cached min/max if available
  let minOpenness = 5, maxOpenness = 20;
  if (networkState.nodes.length > 0) {
    minOpenness = Math.min(...networkState.nodes.map(n => n.roi?.openness || 5));
    maxOpenness = Math.max(...networkState.nodes.map(n => n.roi?.openness || 5));
  }

  const opennessRange = Math.max(maxOpenness - minOpenness, 1);
  const normalizedOpenness = (openness - minOpenness) / opennessRange;
  return minNodeRadius + normalizedOpenness * (maxNodeRadius - minNodeRadius);
}

/**
 * Draw tooltip for hovered node.
 */
function drawNodeTooltip(ctx, node, canvasWidth) {
  if (!node) return;

  const pos = networkState.nodePositions.get(node.id);
  if (!pos) return;

  // Build tooltip text
  const lines = [
    `Node: ${node.id}`,
    `Room: ${node.roomName}`,
    `Territory: ${node.territorySize} tiles`,
    `Sources: ${node.roi?.sourceCount || node.resources?.filter(r => r.type === "source").length || 0}`,
    `Controller: ${node.roi?.hasController ? "Yes" : "No"}`,
    `Openness: ${node.roi?.openness?.toFixed(1) || "--"}`,
    `ROI Score: ${node.roi?.score?.toFixed(1) || "--"}`,
    `Expansion Score: ${node.roi?.expansionScore?.toFixed(1) || "--"}`,
    `Status: ${node.roi?.isOwned ? "Owned" : "Expansion"}`,
  ];

  if (node.econ !== undefined) {
    lines.push(`Economic: ${node.econ ? "Yes" : "No"}`);
  }

  // Draw tooltip box
  ctx.font = "12px monospace";
  const padding = 8;
  const lineHeight = 16;
  const maxWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
  const boxWidth = maxWidth + padding * 2;
  const boxHeight = lines.length * lineHeight + padding * 2;

  // Position tooltip to the right of node, or left if too close to edge
  let tooltipX = pos.x + 20;
  let tooltipY = pos.y - boxHeight / 2;

  if (tooltipX + boxWidth > canvasWidth - 10) {
    tooltipX = pos.x - boxWidth - 20;
  }
  if (tooltipY < 10) tooltipY = 10;

  // Background
  ctx.fillStyle = "rgba(26, 26, 46, 0.95)";
  ctx.strokeStyle = "#60a5fa";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(tooltipX, tooltipY, boxWidth, boxHeight, 4);
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.fillStyle = "#eaeaea";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    // Highlight key values
    if (line.startsWith("ROI Score:") || line.startsWith("Sources:")) {
      ctx.fillStyle = "#facc15";
    } else if (line.startsWith("Status:")) {
      ctx.fillStyle = node.roi?.isOwned ? "#60a5fa" : "#4ade80";
    } else {
      ctx.fillStyle = "#eaeaea";
    }
    ctx.fillText(line, tooltipX + padding, tooltipY + padding + i * lineHeight);
  });
}

/**
 * Estimate distance between two positions.
 */
function estimateDistance(pos1, pos2) {
  if (pos1.roomName === pos2.roomName) {
    return Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y));
  }
  const room1 = parseRoomCoords(pos1.roomName);
  const room2 = parseRoomCoords(pos2.roomName);
  const roomDist = Math.abs(room1.wx - room2.wx) + Math.abs(room1.wy - room2.wy);
  return roomDist * 50 + Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y));
}

/**
 * Calculate mining cost per tick.
 */
function miningCostPerTick(sourcePos, spawnPos) {
  const dist = estimateDistance(sourcePos, spawnPos);
  const minerBody = 5 * ECON.BODY_COSTS.work + 1 * ECON.BODY_COSTS.carry + 3 * ECON.BODY_COSTS.move;
  const baseCost = minerBody / ECON.CREEP_LIFESPAN;
  const travelOverhead = (dist * 2) / ECON.CREEP_LIFESPAN;
  return baseCost + travelOverhead * ECON.SOURCE_ENERGY_PER_TICK;
}

/**
 * Calculate hauling cost per energy unit.
 */
function haulingCostPerEnergy(sourcePos, destPos) {
  const dist = estimateDistance(sourcePos, destPos);
  const haulerBody = 10 * ECON.BODY_COSTS.carry + 10 * ECON.BODY_COSTS.move;
  const carryCapacity = 10 * 50;
  const ticksPerTrip = Math.max(dist * 2, 1);
  const energyPerTick = carryCapacity / ticksPerTrip;
  const costPerTick = haulerBody / ECON.CREEP_LIFESPAN;
  return costPerTick / energyPerTick;
}

/**
 * Find reachable sources for a node via economic edges.
 */
function findReachableSources(node) {
  const sources = [];
  const nodesData = getNodesWithEdges();
  if (!nodesData) return sources;

  const nodeMap = new Map(nodesData.nodes.map(n => [n.id, n]));

  // Local sources
  if (node.resources) {
    for (const r of node.resources) {
      if (r.type === 'source') {
        sources.push({
          nodeId: node.id,
          pos: { x: r.x, y: r.y, roomName: node.roomName },
          local: true
        });
      }
    }
  }

  // Remote sources via economic edges
  const econEdgesRaw = nodesData.economicEdges || {};
  const econEdgeKeys = Array.isArray(econEdgesRaw) ? econEdgesRaw : Object.keys(econEdgesRaw);
  const neighbors = new Set();
  for (const edge of econEdgeKeys) {
    const [a, b] = edge.split('|');
    if (a === node.id) neighbors.add(b);
    if (b === node.id) neighbors.add(a);
  }

  for (const neighborId of neighbors) {
    const neighbor = nodeMap.get(neighborId);
    if (!neighbor || !neighbor.resources) continue;
    for (const r of neighbor.resources) {
      if (r.type === 'source') {
        sources.push({
          nodeId: neighbor.id,
          pos: { x: r.x, y: r.y, roomName: neighbor.roomName },
          local: false
        });
      }
    }
  }

  return sources;
}

/**
 * Show node details modal with economic analysis.
 */
function showNodeDetails(node) {
  if (!elements.nodeDetailsOverlay) return;

  elements.nodeDetailsOverlay.classList.remove("hidden");
  elements.detailsTitle.textContent = node.id;

  const hasController = node.roi?.hasController || node.resources?.some(r => r.type === 'controller');
  const controllerRes = node.resources?.find(r => r.type === 'controller');

  let html = `
    <div class="details-section">
      <h5>Node Info</h5>
      <div class="details-row">
        <span class="label">Room</span>
        <span class="value">${node.roomName}</span>
      </div>
      <div class="details-row">
        <span class="label">Territory</span>
        <span class="value">${node.territorySize} tiles</span>
      </div>
      <div class="details-row">
        <span class="label">Openness</span>
        <span class="value">${node.roi?.openness?.toFixed(1) || "--"}</span>
      </div>
      <div class="details-row">
        <span class="label">ROI Score</span>
        <span class="value highlight">${node.roi?.score?.toFixed(1) || "--"}</span>
      </div>
      <div class="details-row">
        <span class="label">Expansion Score</span>
        <span class="value">${node.roi?.expansionScore?.toFixed(1) || "--"}</span>
      </div>
      <div class="details-row">
        <span class="label">Status</span>
        <span class="value ${node.roi?.isOwned ? 'positive' : ''}">${node.roi?.isOwned ? "Owned" : "Expansion"}</span>
      </div>
    </div>
  `;

  // Resources section
  const resources = node.resources || [];
  const localSources = resources.filter(r => r.type === 'source');
  const minerals = resources.filter(r => r.type === 'mineral');

  html += `
    <div class="details-section">
      <h5>Resources</h5>
      <div class="details-row">
        <span class="label">Local Sources</span>
        <span class="value ${localSources.length > 0 ? 'highlight' : ''}">${localSources.length}</span>
      </div>
      <div class="details-row">
        <span class="label">Controller</span>
        <span class="value">${hasController ? "Yes" : "No"}</span>
      </div>
      <div class="details-row">
        <span class="label">Minerals</span>
        <span class="value">${minerals.length}</span>
      </div>
    </div>
  `;

  // Economic analysis for controller nodes
  if (hasController) {
    const controllerPos = controllerRes
      ? { x: controllerRes.x, y: controllerRes.y, roomName: node.roomName }
      : { x: node.peakPosition?.x || 25, y: node.peakPosition?.y || 25, roomName: node.roomName };
    const spawnPos = { x: node.peakPosition?.x || 25, y: node.peakPosition?.y || 25, roomName: node.roomName };

    const reachableSources = findReachableSources(node);
    const sourceAnalysis = [];
    let totalGross = 0, totalCosts = 0;

    for (const source of reachableSources) {
      const gross = ECON.SOURCE_ENERGY_PER_TICK;
      const miningCost = miningCostPerTick(source.pos, spawnPos);
      const haulCost = haulingCostPerEnergy(source.pos, controllerPos) * gross;
      const net = gross - miningCost - haulCost;
      const efficiency = net / gross;
      const distance = estimateDistance(source.pos, controllerPos);

      if (efficiency >= ECON.MIN_EFFICIENCY) {
        totalGross += gross;
        totalCosts += miningCost + haulCost;
        sourceAnalysis.push({ source, net, efficiency, distance, miningCost, haulCost });
      }
    }

    sourceAnalysis.sort((a, b) => b.net - a.net);
    const totalNet = totalGross - totalCosts;
    const totalEfficiency = totalGross > 0 ? (totalNet / totalGross * 100).toFixed(0) : 0;

    html += `
      <div class="details-section">
        <h5>Economic Analysis</h5>
        <div class="summary-bar">
          <div class="summary-stat">
            <div class="stat-value">${totalNet.toFixed(1)}</div>
            <div class="stat-label">Net E/tick</div>
          </div>
          <div class="summary-stat">
            <div class="stat-value">${totalEfficiency}%</div>
            <div class="stat-label">Efficiency</div>
          </div>
          <div class="summary-stat">
            <div class="stat-value">${sourceAnalysis.length}</div>
            <div class="stat-label">Sources</div>
          </div>
        </div>
      </div>
    `;

    if (sourceAnalysis.length > 0) {
      html += `
        <div class="details-section">
          <h5>Source Breakdown</h5>
          <ul class="source-list">
      `;

      for (const { source, net, efficiency, distance } of sourceAnalysis.slice(0, 8)) {
        const shortId = source.nodeId.length > 12 ? source.nodeId.slice(0, 12) + '...' : source.nodeId;
        html += `
          <li class="source-item">
            <div class="source-header">
              <span class="source-name" title="${source.nodeId}">${shortId}</span>
              <span class="source-type ${source.local ? 'local' : ''}">${source.local ? 'Local' : 'Remote'}</span>
            </div>
            <div class="source-stats">
              <span>${distance} tiles</span>
              <span>${(efficiency * 100).toFixed(0)}% eff</span>
              <span class="source-net">+${net.toFixed(1)}/tick</span>
            </div>
          </li>
        `;
      }

      if (sourceAnalysis.length > 8) {
        html += `<li class="source-item" style="text-align: center; color: var(--text-secondary);">+${sourceAnalysis.length - 8} more sources</li>`;
      }

      html += `</ul></div>`;
    }

    // Show filtered sources count
    const filteredCount = reachableSources.length - sourceAnalysis.length;
    if (filteredCount > 0) {
      html += `<p style="font-size: 0.8rem; color: var(--text-secondary); text-align: center;">${filteredCount} sources filtered (< 30% efficiency)</p>`;
    }
  } else {
    // Non-controller node - show adjacent economic nodes
    const nodesData = getNodesWithEdges();
    if (nodesData && nodesData.economicEdges) {
      const econEdgeKeys = Array.isArray(nodesData.economicEdges)
        ? nodesData.economicEdges
        : Object.keys(nodesData.economicEdges);
      const neighbors = new Set();
      for (const edge of econEdgeKeys) {
        const [a, b] = edge.split('|');
        if (a === node.id) neighbors.add(b);
        if (b === node.id) neighbors.add(a);
      }

      if (neighbors.size > 0) {
        html += `
          <div class="details-section">
            <h5>Economic Neighbors</h5>
            <p style="color: var(--text-secondary); font-size: 0.85rem;">
              Connected to ${neighbors.size} economic node${neighbors.size > 1 ? 's' : ''}
            </p>
          </div>
        `;
      }
    }
  }

  elements.detailsContent.innerHTML = html;
}

/**
 * Initialize the dashboard.
 */
function init() {
  setupTabs();
  setupRefreshButton();
  setupNetworkTypeSelector();
  setupNetworkVizSelector();
  setupNetworkCanvas();
  connect();
}

// Start when DOM is ready
document.addEventListener("DOMContentLoaded", init);
