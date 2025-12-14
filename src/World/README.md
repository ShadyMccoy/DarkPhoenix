# World Graph System

A **room-atheist** graph representation of the game world that abstracts the complex spatial layout into a simple network of nodes and edges.

## Overview

The world is "skeletonized" into:
- **Nodes**: Regions of strategic importance (bases, control points, clusters of resources)
- **Edges**: Connections between adjacent regions
- **Territories**: The area of influence for each node (Voronoi-like regions)

This enables:
- Cleaner game logic that reasons about the colony at an abstract level
- Room boundaries as just an implementation detail (not a design concern)
- Operations to be routed through the node network
- Empirical refinement of the graph structure through metrics and testing

## Architecture

### Core Components

```
RoomMap (existing)
    ↓
PeakClusterer (merges nearby peaks)
    ↓
NodeBuilder (creates nodes from clusters)
    ↓
EdgeBuilder (connects adjacent nodes)
    ↓
GraphBuilder (assembles complete world graph)
    ↓
WorldGraph (room-atheist network representation)
```

### Analysis & Visualization

```
WorldGraph
    ├─→ GraphAnalyzer (metrics, health checks, weakness detection)
    └─→ GraphVisualizer (room visuals for debugging)
```

## Design Principles

### 1. Room-Atheism
The graph treats all terrain as one seamless space. Room boundaries are invisible to the graph logic:
- A node can span multiple rooms
- Edges automatically connect adjacent rooms
- All algorithms treat the world as a unified space

### 2. Territory-Based Connectivity (Delaunay-Inspired)
Nodes are connected if their territories share a boundary:
- Avoids redundant "diagonal" edges
- Sparse but well-connected graph
- Matches natural geographic divisions
- Mathematically optimal (Delaunay triangulation)

### 3. Peak Clustering
Nearby peaks are merged into single nodes:
- Distance-based: peaks < 12 spaces apart merge
- Territory-based: adjacent territories merge
- Produces 2-5 nodes per typical room
- Clustered but spaced far enough to be distinct

## Usage

### 1. Build a Graph from a Room

```typescript
import { GraphBuilder } from "./src/World";

const graph = GraphBuilder.buildRoomGraph("W5N3");
console.log(`Nodes: ${graph.nodes.size}, Edges: ${graph.edges.size}`);
```

### 2. Analyze the Graph

```typescript
import { GraphAnalyzer } from "./src/World";

const metrics = GraphAnalyzer.analyzeGraph(graph);
console.log(`Connected: ${metrics.isConnected}`);
console.log(`Balance: ${(metrics.territoryBalance * 100).toFixed(1)}%`);

// Find problems
if (metrics.hasProblems) {
  metrics.problems.forEach(p => console.log(`Problem: ${p}`));
}

// Find critical nodes
const articulations = GraphAnalyzer.findArticulationPoints(graph);
const weak = GraphAnalyzer.findWeakNodes(graph);
```

### 3. Visualize for Debugging

```typescript
import { GraphVisualizer } from "./src/World";

// Simple nodes + edges
GraphVisualizer.visualize(room, graph, {
  showNodes: true,
  showEdges: true,
  showLabels: true,
});

// Full debug view
GraphVisualizer.visualize(room, graph, {
  showNodes: true,
  showEdges: true,
  showTerritories: true,
  showDebug: true,
  colorScheme: "temperature",
});
```

### 4. Store and Monitor

```typescript
// Store graph metadata in room memory
room.memory.world = {
  nodeCount: graph.nodes.size,
  edgeCount: graph.edges.size,
  lastUpdate: Game.time,
};

// Monitor health over time
const metrics = GraphAnalyzer.analyzeGraph(graph);
if (metrics.hasProblems) {
  console.log(`Issues in ${room.name}: ${metrics.problems.join(", ")}`);
}
```

See `example.ts` for more detailed usage examples.

## Empirical Refinement Process

The graph algorithms use simple heuristics that are refined through **empirical testing**:

### Current Heuristics

1. **Peak Clustering Threshold**: 12 spaces
   - Peaks closer than this merge into one node
   - Adjust up/down to get more/fewer nodes

2. **Territory Adjacency**: Share a boundary
   - Determines which nodes connect with edges
   - No redundant "long-distance" connections

### Refinement Cycle

1. **Measure**: Run `GraphAnalyzer` on multiple maps
   - Collect metrics (balance, connectivity, node count)
   - Identify patterns and problems

2. **Hypothesize**: Form a theory
   - "Threshold too low → too many nodes → poor balance"
   - "Threshold too high → too few nodes → connectivity issues"

3. **Test**: Adjust heuristic parameters
   - Modify `MERGE_THRESHOLD` in `PeakClusterer`
   - Test on 5-10 real maps

4. **Evaluate**: Compare metrics
   - Graph should have good balance (0.6-0.9 is healthy)
   - All nodes should be reachable (connected = true)
   - No isolated nodes (degree > 0 for all)
   - Few weak nodes

5. **Repeat**: Iterate until satisfied

## Metrics Reference

### Graph-Level Metrics (`GraphMetrics`)

| Metric | Meaning | Target |
|--------|---------|--------|
| `nodeCount` | Number of nodes | 2-5 per room |
| `edgeCount` | Number of edges | ~1.5-2x nodes |
| `averageDegree` | Avg connections per node | 2.5-3.5 |
| `isConnected` | All nodes reachable? | `true` |
| `territoryBalance` | Even territory sizes? | 0.6-0.9 |
| `averageTerritorySize` | Avg positions per node | 500+ in big rooms |

### Node-Level Metrics (`NodeMetrics`)

| Metric | Meaning | Use |
|--------|---------|-----|
| `degree` | Number of connections | Connectivity |
| `territorySize` | Positions in territory | Coverage |
| `closeness` | Avg distance to other nodes | Centrality |
| `betweenness` | Paths through this node | Importance |
| `importance` | hub/branch/leaf | Strategic role |
| `redundancy` | Edge deletions to isolation | Failure tolerance |

## Common Issues & Fixes

### Problem: Too Many Nodes (Imbalanced)
- Symptom: `nodeCount` > 10 per room, balance < 0.3
- **Fix**: Increase `MERGE_THRESHOLD` in `PeakClusterer` (try 15-20)

### Problem: Too Few Nodes (Coarse)
- Symptom: `nodeCount` < 2 per room
- **Fix**: Decrease `MERGE_THRESHOLD` (try 8-10)

### Problem: Isolated Nodes
- Symptom: `isolatedNodeCount` > 0
- **Fix**: These are nodes with no adjacent territories - might need to lower threshold

### Problem: Disconnected Regions
- Symptom: `isConnected = false`, `largestComponentSize < nodeCount`
- **Fix**: Check for walls/obstacles separating regions, or adjust threshold

### Problem: Unbalanced Territories
- Symptom: `territoryBalance` < 0.3, some nodes have 10x larger territory
- **Fix**: Peaks are too far apart; this is often a map feature, not a bug

## Architecture Decisions

### Why Territory Adjacency (Not Distance)?
- **Distance-based**: "Connect all nodes < 15 spaces apart"
  - Can create redundant edges (A-B-C all connected)
  - No geometric meaning

- **Territory-based (chosen)**: "Connect if territories touch"
  - Sparse graph (fewer edges)
  - Eliminates redundancy naturally
  - Corresponds to Delaunay triangulation (mathematically optimal)

### Why Union-Find for Clustering?
- Simple O(n²) algorithm
- Easy to modify (add more merge criteria)
- Deterministic and debuggable
- Easy to test in isolation

### Why Store Nodes in Memory (vs. Recompute)?
- Not yet storing full graph (future optimization)
- Currently recomputing each tick from RoomMap
- Can cache for 100+ ticks if CPU becomes issue

## Future Enhancements

### Phase 2: Integration with Routines
- Adapt existing routines to use node coordinates
- Route creeps through node network
- Spawn planning based on node capabilities

### Phase 3: Multi-Room Operations
- Cross-room edges working
- Scouting new rooms
- Resource flow across rooms

### Phase 4: Dynamic Updates
- Graph changes as structures built/destroyed
- Incremental updates (not full rebuild)
- Persistent graph in memory

## Testing & Validation

Current validation approach:
1. **Visual inspection**: Use `GraphVisualizer` to check graphs look reasonable
2. **Metric checks**: Verify territories balanced, graph connected
3. **Empirical tuning**: Run on 10+ maps, compare metrics
4. **Edge cases**: Test single-peak rooms, maze-like rooms, split regions

No unit tests yet (would require mocking RoomMap). Recommend:
- Create TestRoomMap with known peak positions
- Snapshot graphs from real maps for regression testing
- Compare metrics before/after changes

## Files

- `interfaces.ts` - Core data structures (WorldNode, WorldEdge, WorldGraph)
- `PeakClusterer.ts` - Merges peaks using distance + territory adjacency
- `NodeBuilder.ts` - Creates nodes from clusters
- `EdgeBuilder.ts` - Connects adjacent nodes
- `GraphBuilder.ts` - Orchestrates full graph construction
- `GraphAnalyzer.ts` - Metrics and health checks
- `Visualizer.ts` - Room visual rendering
- `example.ts` - Usage examples
- `README.md` - This file

## Performance Considerations

- `GraphBuilder.buildRoomGraph()`: ~5-10ms for typical room
- `GraphAnalyzer.analyzeGraph()`: ~10-20ms for 5-node graph
- `GraphVisualizer.visualize()`: ~2-5ms per room
- Total per room: ~20-40ms (call every 50-100 ticks to stay < 1% CPU)

Cache/optimize if becomes bottleneck.

## Related Systems

- **RoomMap**: Provides peaks and territories (input)
- **EnergyMining/Construction**: Will use nodes for routing (future)
- **Bootstrap**: Could use nodes for base planning (future)
- **Memory**: Stores graph metadata for persistence (future)
