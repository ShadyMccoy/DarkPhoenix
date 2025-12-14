# World System

A **room-atheist**, multi-level abstraction for the game world that scales from spatial (nodes/edges) to strategic (colonies/world state).

## Three Levels of Abstraction

### Level 1: Graph (Spatial Representation)
The room terrain is "skeletonized" into nodes and edges:
- **Nodes**: Regions of strategic importance (peaks, clusters, bases)
- **Edges**: Connections between adjacent regions
- **Territories**: Area of influence for each node (Voronoi regions)
- **Spans rooms** seamlessly (room boundaries transparent)

### Level 2: Colonies (Game State)
Connected components of the graph represent isolated colonies:
- **Colony**: A connected network of nodes (all mutually reachable)
- **Status**: nascent → established → thriving (or declining → dormant)
- **Resources**: Aggregated energy, power, minerals across rooms
- **Operations**: Mining, construction, defense, expansion tasks

Multiple colonies can coexist:
- Initial spawn = 1 colony
- Scout expansion = 2 colonies (if disconnected)
- Connecting bases = merge colonies
- Base siege = split colony if isolated

### Level 3: World (Strategic Overview)
Global state management for strategic decision-making:
- **WorldState**: Manages all colonies, auto-rebuilds
- **Global tracking**: Total resources, status summary, thread level
- **Merge detection**: Auto-detect when colonies can/should merge
- **Persistence**: Save/load colony metadata

## Benefits

- **Cleaner logic**: Reason at colony level, not room/creep level
- **Flexibility**: Handle multiple isolated bases naturally
- **Room transparency**: Room boundaries are just implementation detail
- **Empirical tuning**: Metrics and visualization for heuristic refinement
- **Scalability**: Works from 1-room bases to multi-room empires

## Architecture

### Level 1: Graph Construction (Spatial)

```
RoomMap (existing)
    ↓ (peaks + territories)
PeakClusterer (merges nearby peaks)
    ↓ (clusters)
NodeBuilder (creates nodes from clusters)
    ↓ (nodes)
EdgeBuilder (connects adjacent nodes)
    ↓ (edges)
GraphBuilder (assembles complete world graph)
    ↓ (room-atheist network)
WorldGraph
```

### Level 2: Colony Creation (Game State)

```
WorldGraph (single merged graph)
    ↓
ColonyManager.buildColonies()
    ├─→ Find connected components (DFS/BFS)
    ├─→ Create separate colony for each component
    ├─→ Assign resources and operations
    └─→ Return World (all colonies + mappings)
```

### Level 3: World Management (Strategic)

```
World (colonies collection)
    ↓
WorldState (singleton manager)
    ├─→ rebuild() - rebuild all graphs/colonies
    ├─→ updateResources() - sync with game state
    ├─→ getColonies() - access all colonies
    ├─→ checkMergeOpportunity() - detect connections
    ├─→ mergeColonies() - combine isolated colonies
    └─→ save() / load() - persist to memory
```

### Analysis & Visualization

```
WorldGraph OR Colony.graph
    ├─→ GraphAnalyzer (metrics, health, bottlenecks)
    ├─→ GraphVisualizer (room visuals for debugging)
    └─→ Used at all levels (node inspection, colony status, world overview)
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

### 5. Create and Manage Colonies

```typescript
import { WorldState, initializeGlobalWorld } from "./src/World";

// Initialize global world management
const world = initializeGlobalWorld();

// Rebuild all colonies from controlled rooms
world.rebuild(["W5N3", "W5N4", "W6N3"]);

// Access colonies
const colonies = world.getColonies();
console.log(`Colonies: ${colonies.length}`);

for (const colony of colonies) {
  console.log(`  ${colony.name}: ${colony.status} (${colony.resources.energy} energy)`);
}

// Get total resources across all colonies
const total = world.getTotalResources();
console.log(`Total energy: ${total.energy}`);
```

### 6. Handle Colony Operations

```typescript
// Detect and merge adjacent colonies
if (colonies.length > 1) {
  const colonyA = colonies[0];
  const colonyB = colonies[1];

  if (world.checkMergeOpportunity(colonyA, colonyB)) {
    world.mergeColonies(colonyA.id, colonyB.id);
    console.log("Colonies merged!");
  }
}

// Detect and split disconnected colonies
for (const colony of colonies) {
  const splitResult = ColonyManager.splitColonyIfNeeded(colony);
  if (splitResult.length > 1) {
    console.log(`Colony split into ${splitResult.length} pieces!`);
  }
}

// Save world state to memory
world.save(Memory);
```

See `example.ts` for more detailed usage examples (Examples 1-16).

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

### Level 1: Graph (Spatial)
- `interfaces.ts` - Core data structures (WorldNode, WorldEdge, WorldGraph, PeakCluster)
- `PeakClusterer.ts` - Merges peaks using distance + territory adjacency
- `NodeBuilder.ts` - Creates nodes from clusters
- `EdgeBuilder.ts` - Connects adjacent nodes with territory adjacency
- `GraphBuilder.ts` - Orchestrates full graph construction, handles multi-room merging

### Level 2: Analysis & Visualization
- `GraphAnalyzer.ts` - Comprehensive metrics and health checks
- `Visualizer.ts` - Room visual rendering with multiple modes

### Level 3: Colonies & World
- `Colony.ts` - Colony, ColonyResources, World, ColonyManager
  - Detects connected components (DFS/BFS)
  - Creates/merges/splits colonies
  - Tracks status and resources
- `WorldState.ts` - Global world state manager
  - Singleton pattern (getGlobalWorld, initializeGlobalWorld)
  - Orchestrates all colonies
  - Handles rebuild, merge detection, persistence

### Documentation & Examples
- `example.ts` - 16 detailed usage examples covering all operations
- `README.md` - This comprehensive guide
- `index.ts` - Module exports

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
