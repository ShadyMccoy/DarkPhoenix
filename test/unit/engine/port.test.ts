import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView } from "../../../src/engine/view";
import { CONTAINER_HOLD_ET, LINK_LOSS, upkeepEt } from "../../../src/primitives";
import { hubServiceBody, portTenderBody } from "../../../src/sizing";

/**
 * The port anatomy at the plan level (REBOOT Addendum 4, ratified
 * 2026-08-24): a haul-fed wire is one machine — container (mouth), tender
 * (throat), link (pipe) — owned by the link corp. The trunk hires its
 * throat as a real body, the hub-side service and the standing buffer's
 * holding ride as fees, the buffer approves as the standing trunk's
 * OBLIGATION, and a miner-fed direct wire carries none of it but the hub
 * service — the trigger rule, pinned.
 */

function view(over: Partial<EconomyView> = {}): EconomyView {
  return {
    tick: 100,
    bank: "bank",
    bankStock: 20000,
    bankBranch: "storage",
    bodyBudget: 550,
    spawnIds: ["sp1"],
    estateRadius: 1,
    sources: [],
    controller: { id: "ctrl", distFromBank: 1 },
    creeps: [],
    links: [],
    outposts: [],
    sites: [],
    roads: [],
    wireOptions: [],
    stationOptions: [],
    ...over
  };
}

/** The trunk-test tree: three members short-hauling into one station. */
function treeView(over: Partial<EconomyView> = {}): EconomyView {
  return view({
    links: [
      { id: "hubE", at: "bank", room: "R1_1", x: 52, y: 83 },
      { id: "st", at: "outpost:st", room: "R1_1", x: 75, y: 61 }
    ],
    outposts: [{ place: "outpost:st", distToSource: { a: 2, b: 2, c: 4 } }],
    sources: [
      { id: "a", spots: 3, distToBank: 26 },
      { id: "b", spots: 3, distToBank: 27 },
      { id: "c", spots: 3, distToBank: 19 }
    ],
    ...over
  });
}

const HUB_FEE = upkeepEt(hubServiceBody());

describe("engine/port — the anatomy on the trunk", () => {
  it("a haul-fed trunk hires its THROAT: one tender body, sized to the trunk's flow", () => {
    const plan = replan(treeView());
    const trunk = plan.corps.find(c => c.id === "link:outpost:st->bank");
    assert.isOk(trunk, "the trunk funds");
    assert.equal(trunk?.target, 4, "the throat plus one slice per member");
    assert.deepEqual(trunk?.hires, [portTenderBody(30)], "exactly one throat, flow-sized — never one per member");
    // The throat's parts bill joins the heartbeat; the hub service rides
    // as a fee; three slices pay the tax on their own share.
    const expectCost = upkeepEt(portTenderBody(30)) + HUB_FEE + 3 * LINK_LOSS * 10;
    assert.closeTo(trunk?.pnl.costEt ?? 0, expectCost, 1e-9);
    assert.isEmpty(plan.violations, "the anatomy trades no phantom energy");
  });

  it("a live tender re-hands and the throat quotes backed: sunk body, standing fees", () => {
    const plan = replan(
      treeView({
        creeps: [{ id: "t1", corp: "link:outpost:st->bank", body: portTenderBody(30), ttl: 900 }]
      })
    );
    const trunk = plan.corps.find(c => c.id === "link:outpost:st->bank");
    assert.equal(trunk?.backed, 4, "throat and slices all backed");
    assert.deepEqual(trunk?.hires, [], "nothing left to hire");
    const expectCost = HUB_FEE + 3 * LINK_LOSS * 10;
    assert.closeTo(trunk?.pnl.costEt ?? 0, expectCost, 1e-9, "the live throat prices sunk; its replacement is standingBills");
  });

  it("the standing buffer's holding rides the trunk's fee — only once it stands", () => {
    const bare = replan(treeView());
    const buffered = replan(
      treeView({ outposts: [{ place: "outpost:st", distToSource: { a: 2, b: 2, c: 4 }, hasContainer: true }] })
    );
    const cost = (p: typeof bare): number => p.corps.find(c => c.id === "link:outpost:st->bank")?.pnl.costEt ?? 0;
    assert.closeTo(cost(buffered) - cost(bare), CONTAINER_HOLD_ET, 1e-9);
  });

  it("a funded trunk with a bare outpost draws its buffer as an OBLIGATION, ahead of the merit spend", () => {
    const plan = replan(treeView());
    const buffer = plan.approvals.find(a => a.structure === "container" && a.at === "outpost:st");
    assert.isOk(buffer, "the port buffer approves — kit, never ROI");
    const served = replan(
      treeView({ outposts: [{ place: "outpost:st", distToSource: { a: 2, b: 2, c: 4 }, hasContainer: true }] })
    );
    assert.isUndefined(
      served.approvals.find(a => a.structure === "container" && a.at === "outpost:st"),
      "a served port asks for nothing"
    );
  });

  it("a miner-fed direct wire carries NO throat and no buffer — only the per-sender hub service", () => {
    const plan = replan(
      view({
        links: [
          { id: "hubE", at: "bank", room: "R1_1", x: 52, y: 83 },
          { id: "mouth", at: "wired", room: "R1_1", x: 90, y: 60 }
        ],
        sources: [{ id: "wired", spots: 3, distToBank: 26 }]
      })
    );
    const wire = plan.corps.find(c => c.id === "link:wired->bank");
    assert.isOk(wire, "the standing wire holds its edge");
    assert.equal(wire?.target, 1, "one step: the pair itself — the trigger rule is HAUL-FED");
    assert.deepEqual(wire?.hires, [], "no throat for a miner-loaded mouth");
    assert.closeTo(wire?.pnl.costEt ?? 0, LINK_LOSS * 10 + HUB_FEE, 1e-9);
    assert.isUndefined(
      plan.approvals.find(a => a.structure === "container" && a.at === "wired"),
      "no buffer either"
    );
  });
});
