/**
 * FlowEconomy - the thin façade over the world-translation layer.
 *
 * Builds the FlowGraph from spatial nodes and drives the ONE economy solve
 * (economy/flowAdapter.solveColony -> planColony). One solve yields both the
 * FlowSolution (legacy telemetry DTO) and the Commission envelopes the corp
 * kinds materialize from (execution/CommissionHost).
 *
 * Spec 17 P5 trimmed this class to its live seam: the pre-cleanup façade
 * carried a dead query/metrics/preset API (~two-thirds of the class, zero
 * callers) and the retired PriorityManager second sink ladder - sinks are
 * valued by the planner's ladder (perInstanceSinkValue over
 * DEFAULT_SINK_VALUE), nowhere else.
 */

import { FlowSolution, Position } from "./FlowTypes";
import { FlowGraph, createFlowGraph } from "./FlowGraph";
import { Node } from "../nodes/Node";
import { NodeNavigator } from "../nodes/NodeNavigator";
import { solveColony } from "../economy/flowAdapter";
import { Goal } from "../economy/goals";
import { Commission } from "../economy/Commission";

export class FlowEconomy {
  /** Flow graph built from nodes */
  private graph: FlowGraph;

  /** Current solution (null if not yet solved) */
  private solution: FlowSolution | null = null;

  /**
   * The current solve's commissions (the framework seam). Same plan as
   * `solution`, wrapped as Commission envelopes for the corp kinds to
   * materialize. Empty until the first solve.
   */
  private commissions: Commission[] = [];

  /** Node navigator reference */
  private navigator: NodeNavigator;

  public constructor(nodes: Node[], navigator: NodeNavigator) {
    this.navigator = navigator;
    this.graph = createFlowGraph(nodes, navigator);
  }

  /**
   * Re-solve the economy. The caller (main.ts) owns the cadence - the CPU
   * governor's solve interval and the bootstrap eager-solve gate - so this
   * always solves when called.
   */
  public update(tick: number): void {
    // The goal is EXECUTION-owned state (Memory.goal, set by the operator via
    // global.setGoal); the pure layers only ever receive it as an argument.
    const goal: Goal | undefined = typeof Memory !== "undefined" ? Memory.goal : undefined;
    // The previous solve's realized bank draw (consumer allocations drawn
    // from the hub) - the feeder-pricing signal that breaks the starvation
    // loop (see buildColonyProblem). PERSISTED in Memory, not on `this`:
    // main.ts replaces the FlowEconomy instance on every graph rebuild, so
    // instance-held history died before it was ever read (prod t72447816:
    // infra pinned at 0.1874 across every post-deploy solve - the fix was
    // deployed and dormant). Memory survives rebuilds and global resets.
    const prevBankDraw = typeof Memory !== "undefined" ? Memory.lastBankDraw : undefined;
    const result = solveColony(this.graph, tick, undefined, undefined, undefined, goal, prevBankDraw);
    if (typeof Memory !== "undefined") {
      Memory.lastBankDraw = result.solution.sinkAllocations
        .filter(a => a.sinkType === "controller" || a.sinkType === "construction")
        .reduce((sum, a) => sum + a.allocated, 0);
    }
    this.solution = result.solution;
    this.commissions = result.commissions;
    if (result.adopted.length > 0) {
      console.log(
        `[Strategy] adopted ${result.adopted.length} restructuring(s): ` +
          result.adopted.map(a => `${a.sourceId}->${a.spawnId} (+${(a.gain * 100).toFixed(1)}%)`).join(", ")
      );
    }
  }

  /** Get current solution (or null if not solved). */
  public getSolution(): FlowSolution | null {
    return this.solution;
  }

  /**
   * The current solve's commissions (the framework seam). Same plan as
   * getSolution(), wrapped as Commission envelopes. Empty until the first solve.
   */
  public getCommissions(): Commission[] {
    return this.commissions;
  }

  /** Get the flow graph for direct access. */
  public getFlowGraph(): FlowGraph {
    return this.graph;
  }

  /**
   * Add a construction site dynamically (main.ts feeds newly-placed sites in
   * between full graph rebuilds) and rebuild edges for the new sink.
   */
  public addConstructionSite(id: string, nodeId: string, position: Position, progressRemaining: number): void {
    this.graph.addConstructionSite(id, nodeId, position, progressRemaining);
    this.graph.buildEdges();
  }
}
