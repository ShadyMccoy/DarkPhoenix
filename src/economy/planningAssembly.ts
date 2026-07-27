/**
 * @fileoverview The solve-input assembly (spec 35 phase G): the adapter-side
 * seam between "the colony's current nodes" and "a solved FlowEconomy".
 *
 * The construction sink-ADMISSION policy (which ledger projects become flow
 * sinks, the trunk A/Z aggregation, the nearest-node anchoring) lives HERE,
 * beside the rest of the world-translation layer — main.ts's runPlanningPhase
 * just invokes the seam. Moved verbatim from main.ts, which used to own it.
 *
 * @module economy/planningAssembly
 */

import { FlowEconomy } from "./flowAdapter";
import { Node } from "../nodes/Node";
import { constructionProjectLedger } from "../corps/constructionLedger";
import { aggregateTrunkRoadSinks } from "./roadSegments";
import { collectTrunkRoutes, homeBankSupply } from "./roadSegmentsGame";
import { roomLinearDistance } from "../utils/RoomDiscovery";

/**
 * Feed the room's live construction sites into the flow economy as construction
 * sinks, each mapped to the nearest node in its room. This makes construction a
 * first-class consumer in the flow solve (with hauler routes), so the local
 * mover delivers energy to builders per the solver's allocation.
 */
export function addConstructionSitesToFlow(economy: FlowEconomy, nodes: Node[]): void {
  // PROJECT LEDGER admission (owner 2026-07-22: "construction sites should
  // be part of the corps memory so it can rehydrate and bypass Vision") -
  // the sink set comes from the construction corps' durable ledger, NOT a
  // Game.rooms scan. The scan was the measured cluster flap (t72489078:
  // 15 sinks -> 0 across two captures, the solve keyed to which room
  // happened to be sighted). Vision reconciles the ledger
  // (ConstructionCorp.reconcileProjects); decisions read it here. Spec 25's
  // admission rule is unchanged (any of OUR sites, per-site capacity
  // pool-absorb/cluster bounded in the adapter) - only the data source
  // moved from eyesight to the ledger.
  // TRUNK A/Z AGGREGATION (owner 2026-07-22): collapse each trunk road's
  // per-tile sites into TWO aggregate sinks - Z (source end, the source's
  // builder+hauler) and A (home end, the pool crew) - split proportional to
  // energy flow. A 20-tile trunk was 20 sinks -> 20 micro hauler-edges from
  // one source (t72505602: P2 34/44, P4 +18%); now it is 2 sinks -> one
  // source->Z edge and one home A project. Non-trunk construction
  // (extensions, containers, in-room roads) passes through per-site.
  const graph = economy.getFlowGraph();
  const routes = collectTrunkRoutes(id => graph.getSource(`source-${id}`)?.capacity);
  const admitted = aggregateTrunkRoadSinks(constructionProjectLedger(), routes, homeBankSupply());

  for (const rec of admitted) {
    const roomName = rec.roomName;
    // A room with no analyzed nodes yet (a freshly claimed founding, or a
    // remote road room) still needs its sites in the graph (spec 06 audit) -
    // anchor on the nearest node by room distance until the room's own
    // analysis lands. The anchor only shapes graph topology; haul pricing
    // uses the site's real position either way.
    let roomNodes = nodes.filter(n => n.roomName === roomName);
    if (roomNodes.length === 0) {
      let nearest: Node | undefined;
      let nearestDist = Infinity;
      for (const node of nodes) {
        // Adapter discipline (purity ratchet): Game only behind a typeof
        // guard. roomLinearDistance is the pure port of the same lattice
        // math, so Game-less harnesses take an identical-valued branch.
        const d =
          typeof Game !== "undefined" && Game.map
            ? Game.map.getRoomLinearDistance(node.roomName, roomName)
            : roomLinearDistance(node.roomName, roomName);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = node;
        }
      }
      if (nearest) roomNodes = [nearest];
    }
    if (roomNodes.length === 0) continue;

    // Map the site to the nearest node in the same room.
    let best: Node | undefined;
    let bestDist = Infinity;
    for (const node of roomNodes) {
      const dx = node.peakPosition.x - rec.x;
      const dy = node.peakPosition.y - rec.y;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    if (!best) continue;

    economy.addConstructionSite(rec.id, best.id, { x: rec.x, y: rec.y, roomName }, rec.remaining);
  }
}

/**
 * The ONE solve-input assembly (spec 35 phase G): rebuild source/sink
 * discovery from the current nodes, admit the construction-project ledger's
 * sinks, and solve. BOTH planning paths — the scheduled cadence in main.ts's
 * runPlanningPhase and the console-forced `global.plan()` — run this exact
 * sequence, so the pre-G bug (a forced plan skipping sink admission and
 * publishing a plan that zeroed construction colony-wide until the next
 * scheduled solve) cannot recur without deleting the seam. Pinned by
 * test/unit/economy/planningAssembly.test.ts.
 */
export function assembleEconomyForSolve(nodes: Node[], tick: number): FlowEconomy {
  const economy = new FlowEconomy(nodes);
  addConstructionSitesToFlow(economy, nodes);
  economy.update(tick);
  return economy;
}
