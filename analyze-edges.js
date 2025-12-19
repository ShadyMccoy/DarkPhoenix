const http = require('http');

// Can also pass edges via command line for testing
const testEdges = process.argv[2] ? JSON.parse(process.argv[2]) : null;

http.get('http://localhost:3000/api/telemetry/nodes', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    // Use test edges if provided, otherwise use edges from API
    if (testEdges) {
      json.edges = testEdges;
      console.log('Using', testEdges.length, 'edges from command line\n');
    }
    analyzeEdges(json);
  });
}).on('error', err => console.error('Error:', err.message));

function analyzeEdges(data) {
  console.log('=== EDGE ANALYSIS ===');
  console.log('Edge count:', (data.edges || []).length);
  console.log('Node count:', data.nodes.length);

  if (!data.edges || data.edges.length === 0) {
    console.log('No edges found in data');
    return;
  }

  const nodeIds = new Set(data.nodes.map(n => n.id));
  console.log('Unique node IDs:', nodeIds.size);

  const invalidEdges = [];
  const validEdges = [];

  for (const edge of data.edges) {
    const [a, b] = edge.split('|');
    const aValid = nodeIds.has(a);
    const bValid = nodeIds.has(b);

    if (!aValid || !bValid) {
      invalidEdges.push({ edge, aValid, bValid, a, b });
    } else {
      validEdges.push({ edge, a, b });
    }
  }

  console.log('\nValid edges:', validEdges.length);
  console.log('Invalid edges:', invalidEdges.length);

  if (invalidEdges.length > 0) {
    console.log('\n=== INVALID EDGES (referencing non-existent nodes) ===');
    invalidEdges.slice(0, 15).forEach(inv => {
      console.log('Edge:', inv.edge);
      console.log('  ' + inv.a + ':', inv.aValid ? 'EXISTS' : 'MISSING');
      console.log('  ' + inv.b + ':', inv.bValid ? 'EXISTS' : 'MISSING');
    });
    if (invalidEdges.length > 15) {
      console.log('... and', invalidEdges.length - 15, 'more invalid edges');
    }
  }

  // Check for far-away connections
  console.log('\n=== DISTANCE ANALYSIS ===');
  analyzeDistances(data, validEdges);
}

function analyzeDistances(data, validEdges) {
  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));

  // Parse room coordinates
  function parseRoom(roomName) {
    const match = roomName.match(/^([EW])(\d+)([NS])(\d+)$/);
    if (!match) return null;
    const x = match[1] === 'E' ? parseInt(match[2]) : -parseInt(match[2]) - 1;
    const y = match[3] === 'N' ? -parseInt(match[4]) - 1 : parseInt(match[4]);
    return { x, y };
  }

  // Calculate room distance
  function roomDistance(room1, room2) {
    const c1 = parseRoom(room1);
    const c2 = parseRoom(room2);
    if (!c1 || !c2) return Infinity;
    return Math.abs(c1.x - c2.x) + Math.abs(c1.y - c2.y);
  }

  const suspiciousEdges = [];

  for (const { edge, a, b } of validEdges) {
    const nodeA = nodeMap.get(a);
    const nodeB = nodeMap.get(b);

    if (!nodeA || !nodeB) continue;

    const roomDist = roomDistance(nodeA.roomName, nodeB.roomName);

    // Check if nodes share any rooms
    const sharedRooms = nodeA.spansRooms.filter(r => nodeB.spansRooms.includes(r));

    // Suspicious if: different rooms AND no shared spans AND room distance > 1
    if (roomDist > 1 && sharedRooms.length === 0) {
      suspiciousEdges.push({
        edge,
        nodeA: nodeA.id,
        nodeB: nodeB.id,
        roomA: nodeA.roomName,
        roomB: nodeB.roomName,
        roomDist,
        spansA: nodeA.spansRooms,
        spansB: nodeB.spansRooms,
        sharedRooms
      });
    }
  }

  console.log('Suspicious far-away connections:', suspiciousEdges.length);

  if (suspiciousEdges.length > 0) {
    console.log('\n=== SUSPICIOUS FAR-AWAY EDGES ===');
    suspiciousEdges.slice(0, 10).forEach(s => {
      console.log('Edge:', s.edge);
      console.log('  Room A:', s.roomA, '| Room B:', s.roomB, '| Distance:', s.roomDist);
      console.log('  Node A spans:', s.spansA.join(', '));
      console.log('  Node B spans:', s.spansB.join(', '));
    });
    if (suspiciousEdges.length > 10) {
      console.log('... and', suspiciousEdges.length - 10, 'more suspicious edges');
    }
  }

  // Additional anomaly detection
  console.log('\n=== OTHER ANOMALIES ===');

  // Check for self-loops
  const selfLoops = validEdges.filter(e => e.a === e.b);
  console.log('Self-loops:', selfLoops.length);
  if (selfLoops.length > 0) {
    selfLoops.forEach(e => console.log('  Self-loop:', e.edge));
  }

  // Check for duplicate edges
  const edgeSet = new Set();
  const duplicates = [];
  for (const { edge, a, b } of validEdges) {
    const normalized = [a, b].sort().join('|');
    if (edgeSet.has(normalized)) {
      duplicates.push(edge);
    }
    edgeSet.add(normalized);
  }
  console.log('Duplicate edges:', duplicates.length);
  if (duplicates.length > 0) {
    duplicates.slice(0, 5).forEach(e => console.log('  Duplicate:', e));
  }

  // Check node connectivity
  const connectedNodes = new Set();
  for (const { a, b } of validEdges) {
    connectedNodes.add(a);
    connectedNodes.add(b);
  }
  const isolatedNodes = data.nodes.filter(n => !connectedNodes.has(n.id));
  console.log('Isolated nodes (no edges):', isolatedNodes.length);
  if (isolatedNodes.length > 0 && isolatedNodes.length <= 10) {
    isolatedNodes.forEach(n => console.log('  Isolated:', n.id));
  }
}
