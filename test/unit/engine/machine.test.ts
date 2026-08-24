import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView, ViewCreep } from "../../../src/engine/view";
import { spawnTimeEt } from "../../../src/primitives";

/**
 * The machine currency at the executor seam (the forest stall,
 * 2026-08-24): two invariants that, broken together, oscillated a
 * saturated-spawn world into hiring and culling the same fleet forever
 * while its approved builds sat at zero progress.
 *
 * 1. HIRES ARE THE LEDGER — a quote may end in a remainder-sized runt,
 *    so the instance carries the bought bodies in step order; hiring
 *    them costs exactly the machine time the plan charged. One body
 *    field under-specified the fleet and the executor overshot by the
 *    runt difference.
 * 2. ZERO-MARGINAL MACHINE TIME NEVER BREAKS — a live body's sustain is
 *    already in the seed; when the seed alone exceeds capacity the plan
 *    keeps employing the living (backed steps, the tender first among
 *    them) and blocks only NEW bodies, printing the overshoot once.
 */

function view(over: Partial<EconomyView> = {}): EconomyView {
  return {
    tick: 100,
    bank: "bank",
    bankStock: 300,
    bankBranch: "storage",
    bodyBudget: 300,
    spawnIds: ["sp1"],
    estateRadius: 1,
    sources: [{ id: "srcA", spots: 3, distToBank: 10 }],
    controller: { id: "ctrl", distFromBank: 5 },
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

describe("engine/machine — the spawn currency at the executor seam", () => {
  it("the hire list IS the machine ledger: runt tail included, Σ sustain equals the corp's quoted spawnTime input", () => {
    // 10 e/t over 30 tiles needs 12 CARRY: two 5C bodies and a 2C runt.
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 20000,
        sources: [
          { id: "srcA", spots: 3, distToBank: 10 },
          { id: "srcC", spots: 3, distToBank: 30 }
        ]
      })
    );
    const far = plan.corps.find(c => c.id === "haul:srcC->bank");
    assert.isOk(far, "the far route funds");
    assert.equal(far?.staff.length, far?.target, "every body step is on the roster");
    assert.isTrue(far!.staff.every(st => !st.live), "nothing backed: every body is a hire");
    assert.isAbove(far!.staff.length, 1, "the route takes a fleet");
    const first = far!.staff[0].body;
    const last = far!.staff[far!.staff.length - 1].body;
    assert.isBelow(last.carry, first.carry, "the last body is the remainder runt, not a copy of the first");
    // The identity recomputes with each corp's POSTING WALK (Addendum 6,
    // corrected: a hauler's posting is its PICKUP, so the fleets pay
    // their sources' walks too).
    const commuteOf: Record<string, number> = {
      "mine:srcA": 10,
      "mine:srcC": 30,
      "haul:srcA->bank": 10,
      "haul:srcC->bank": 30,
      "upgrade:ctrl": 5
    };
    for (const corp of plan.corps) {
      const hired = corp.staff
        .filter(st => !st.live)
        .reduce((a, st) => a + spawnTimeEt(st.body, commuteOf[corp.id] ?? 0), 0);
      assert.closeTo(
        hired,
        corp.inputs.spawnTime ?? 0,
        1e-9,
        `${corp.id}: hiring the list costs exactly the machine time the plan charged`
      );
    }
  });

  it("a seed over capacity employs the living and blocks only new bodies — signalled once, never a cull", () => {
    // Ballast pushes the standing sustain past one spawn's 1/3 p/t
    // (spawnTimeEt is parts/1500 — 528 MOVE parts is 0.352); three
    // fully-fleeted sources keep the residual positive under the
    // ballast's bills. Production, tender, and upgrader are all ALIVE.
    const ballast: ViewCreep[] = Array.from({ length: 11 }, (_, i) => ({
      id: `bal${i}`,
      corp: "haul:ghost->nowhere",
      body: { work: 0, carry: 0, move: 48 },
      ttl: 900
    }));
    const fleets: ViewCreep[] = [];
    ["srcA", "srcB", "srcC"].forEach((src, i) => {
      fleets.push({ id: `m${i}`, corp: `mine:${src}`, body: { work: 5, carry: 0, move: 1 }, ttl: 900 });
      fleets.push({ id: `h${i}`, corp: `haul:${src}->bank`, body: { work: 0, carry: 4, move: 4 }, ttl: 900 });
    });
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 20000,
        controller: { id: "ctrl", distFromBank: 1 },
        sources: [
          { id: "srcA", spots: 3, distToBank: 10 },
          { id: "srcB", spots: 3, distToBank: 10 },
          { id: "srcC", spots: 3, distToBank: 10 }
        ],
        creeps: [
          ...fleets,
          { id: "t1", corp: "spawning:estate", body: { work: 0, carry: 2, move: 2 }, ttl: 900 },
          { id: "u1", corp: "upgrade:ctrl", body: { work: 4, carry: 1, move: 1 }, ttl: 900 },
          ...ballast
        ]
      })
    );
    const corps = new Map(plan.corps.map(c => [c.id, c]));
    assert.equal(corps.get("mine:srcA")?.backed, 1, "the living miner keeps mining");
    assert.equal(corps.get("haul:srcA->bank")?.backed, 1, "the living hauler keeps hauling");
    assert.isAtLeast(corps.get("spawning:estate")?.backed ?? 0, 1, "the tender survives — the heartbeat is an axiom");
    assert.isAbove(plan.expected.standingUpgradeEt, 0, "the living upgrader still drinks the residual");
    for (const corp of plan.corps) {
      assert.lengthOf(corp.staff.filter(st => !st.live), 0, `${corp.id}: no new body while the machine is oversubscribed`);
    }
    const line = plan.frontier.find(f => f.offerId === "spawning:capacity" && f.reason === "spawn capacity");
    assert.isOk(line, "the overshoot prints exactly where it lives");
  });
});
