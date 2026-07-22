/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * Remote-trunk re-judge on flow rise (owner 2026-07-20: "building roads all
 * the way to the remote sources"). A trunk's not-worth-paving verdict was
 * PERMANENT (`declined: true`, checked with a bare `continue`), so a trunk
 * judged at the pre-reservation 5 e/t was never re-judged after reservation
 * doubled the source to 10 e/t - the exact tick the road STARTS being worth
 * it. The verdict now records the flow it was judged at, and the corp voids
 * it (deletes the entry, re-plans, re-judges) when the plan's trunk flow
 * clears declinedVerdictStands' 1.5x bar. Path planning is stubbed; the
 * verdict economics are the REAL evaluateRoadRoute (pinned in
 * economy/roadEconomics.test.ts).
 */
describe("ConstructionCorp trunk verdicts re-judge when flow rises", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    Game.creeps = {};
    Game.rooms = {}; // no remote vision: site placement no-ops, judging still runs
    Game.getObjectById = () => ({ pos: { x: 25, y: 25, roomName: "W1N1" } });
    (Memory as any).creeps = {};
  });

  const mkRoom = (): any => ({ name: "W1N1", memory: {}, find: () => [] });

  /**
   * A corp with one remote trunk at `flow`, its cross-room path stubbed to 50
   * all-plain tiles in W2N1 (the mock terrain is plain everywhere). At the
   * corp's ROAD_SPAWN_PART_VALUE that path PAVES at 10 e/t and DECLINES at
   * 0.5 e/t - both regimes reachable from the same stub.
   */
  const mkCorp = (flow: number): { corp: ConstructionCorp; pathCalls: () => number } => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    corp.setRemoteTrunks([{ sourceId: "source-abc", pos: { x: 20, y: 20, roomName: "W2N1" }, flow }]);
    let calls = 0;
    (corp as any).planTrunkPath = (): any[] => {
      calls++;
      return Array.from({ length: 50 }, (_, i) => ({ x: i, y: 10, roomName: "W2N1" }));
    };
    return { corp, pathCalls: () => calls };
  };

  it("VOIDS a stale verdict: judged at 5, plan now flows 10 -> re-judged and paved", () => {
    const { corp, pathCalls } = mkCorp(10);
    const routes: any = { abc: { tiles: [], declined: true, judgedFlow: 5 } };
    (corp as any).tryPlaceTrunkRoutes(mkRoom(), routes);
    expect(pathCalls(), "the voided trunk must be re-planned").to.equal(1);
    expect(routes.abc.declined, "the stale decline is gone").to.equal(undefined);
    // 48, not 50: the stub path spans x=0..49 and the two border tiles are
    // walkable-but-never-placeable (isRoomEdgeTile) - recording them made a
    // trunk's completion unsatisfiable (prod t72483047, 36/38 forever).
    expect(routes.abc.tiles3, "48 placeable (x,y,roomIdx) triples - edge tiles excluded").to.have.length(144);
    expect(routes.abc.rooms).to.deep.equal(["W2N1"]);
  });

  it("HOLDS a standing verdict: judged at 10, plan still flows 10 -> untouched, no re-plan", () => {
    const { corp, pathCalls } = mkCorp(10);
    const routes: any = { abc: { tiles: [], declined: true, judgedFlow: 10 } };
    (corp as any).tryPlaceTrunkRoutes(mkRoom(), routes);
    expect(pathCalls(), "a standing verdict never re-plans (the cache's purpose)").to.equal(0);
    expect(routes.abc.declined).to.equal(true);
  });

  it("SELF-HEALS legacy entries: no recorded flow -> exactly one re-judge, stamped thereafter", () => {
    const { corp, pathCalls } = mkCorp(0.5); // a trickle: declines on the merits
    const routes: any = { abc: { tiles: [], declined: true } };
    (corp as any).tryPlaceTrunkRoutes(mkRoom(), routes);
    expect(pathCalls(), "legacy entry earns one re-judge").to.equal(1);
    expect(routes.abc.declined, "still not worth paving at 0.5 e/t").to.equal(true);
    expect(routes.abc.judgedFlow, "the re-judge stamps the flow").to.equal(0.5);
    (corp as any).tryPlaceTrunkRoutes(mkRoom(), routes);
    expect(pathCalls(), "the stamped verdict now stands - no churn").to.equal(1);
  });

  it("wantsRoadWork reads the SAME lens: stale declined counts as outstanding work", () => {
    // The staffsPost-symmetry trap class: if the work() gate thought a stale
    // verdict was settled while the placement path would re-judge it, work()
    // would never route there and the re-judge would never run.
    const stale = mkCorp(10).corp;
    const room: any = { name: "W1N1", find: () => [], memory: { roadRoutes: { abc: { tiles: [], declined: true, judgedFlow: 5 } } } };
    expect((stale as any).wantsRoadWork(room)).to.equal(true);
    const standing = mkCorp(10).corp;
    room.memory.roadRoutes.abc.judgedFlow = 10;
    expect((standing as any).wantsRoadWork(room)).to.equal(false);
  });
});
