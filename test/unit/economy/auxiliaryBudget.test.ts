import { expect } from "chai";
import { ColonyProblem, PlannerSpawn } from "../../../src/economy/CorpPlanner";
import { Commission } from "../../../src/economy/Commission";
import { reservationKind } from "../../../src/corps/kinds/reservationKind";
import { extensionTenderKind } from "../../../src/corps/kinds/extensionTenderKind";
import { controllerFeederKind } from "../../../src/corps/kinds/controllerFeederKind";
import {
  feederSpawnLoad,
  infraSpawnLoad,
  roomReserverSpawnLoad,
  tenderSpawnLoad
} from "../../../src/economy/primitives";
import { Position } from "../../../src/types/Position";

/**
 * SPEC 39 PHASE 4 - the auxiliary corps come onto the budget.
 *
 * Before this, every auxiliary commission declared `spawnPartsPerTick: 0`. That
 * did not make them free: the colony's parts ledger deducts the SAME fleet as
 * `infraPartsPerTick` before the sink fill spends anything. So the colony paid
 * for a fleet no corp row owned - and `waste-ledger.planSpawnLoad` had to
 * re-derive the hole, which is the second book spec 51 is dismantling.
 *
 * THE INVARIANT UNDER TEST: the auxiliary corps' summed budget equals the
 * aggregate the solve deducts, EXACTLY - because both now compose the same three
 * per-corp primitives (`roomReserverSpawnLoad`, `tenderSpawnLoad`,
 * `feederSpawnLoad`). One derivation in two shapes, not two books.
 *
 * The aggregate cannot simply be replaced by the sum: the solve needs the number
 * before any auxiliary commission exists (propose() reads the draft, so it cannot
 * run first). That circularity is real and is why `infraSpawnLoad` stays. What
 * changes is that it is now composed from the corps' own prices, so a drift
 * between them fails here instead of surfacing as a mystery variance.
 */
const at = (x: number, y: number, roomName: string): Position => ({ x, y, roomName });
const spawn = (id: string, roomName: string): PlannerSpawn => ({ id, pos: at(25, 25, roomName) });

/** A harvest commission targeting `room` - the durable signal reservation reads. */
const harvestIn = (room: string, id: string): Commission => ({
  corpId: `harvest-${id}`,
  kind: "harvest",
  shape: "produce",
  consumes: { spawnPartsPerTick: 0.01 },
  produces: { energyRate: 10, at: at(20, 20, room) },
  assignment: {}
});

/** An upgrade commission in `room` drawing `rate` - what the feeder sizes to. */
const upgradeIn = (room: string, rate: number): Commission => ({
  corpId: `upgrade-${room}`,
  kind: "upgrade",
  shape: "consume",
  consumes: { spawnPartsPerTick: 0.05, energyRate: rate },
  produces: { valuePerTick: rate * 80, at: at(30, 30, room) },
  assignment: {}
});

/** Run every auxiliary kind that has migrated, and sum what they declare. */
function auxiliaryBudget(problem: ColonyProblem, draft: Commission[]): { total: number; byKind: Map<string, number> } {
  const all = [
    ...reservationKind.propose(problem, draft),
    ...extensionTenderKind.propose(problem, draft),
    ...controllerFeederKind.propose(problem, draft)
  ];
  const byKind = new Map<string, number>();
  let total = 0;
  for (const c of all) {
    const load = c.consumes.spawnPartsPerTick || 0;
    total += load;
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + load);
  }
  return { total, byKind };
}

describe("spec 39 phase 4: auxiliary corps carry their own budget", () => {
  const HOME = "W1N1";
  const REMOTES = ["W2N1", "W1N2", "W2N2"];
  const RELAY = 40;

  /** One home with a link-fed depot, three mined remotes - the live shape. */
  const world = (opts: { depot: boolean; linkFed: boolean }): ColonyProblem => ({
    spawns: [spawn("s1", HOME)],
    sources: [],
    sinks: [],
    dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y),
    depotRooms: opts.depot ? [HOME] : [],
    linkFedRooms: opts.linkFed ? [HOME] : []
  });
  const draft = [...REMOTES.map((r, i) => harvestIn(r, `src${i}`)), upgradeIn(HOME, RELAY)];

  it("SIGMA(auxiliary corps) === infraSpawnLoad, the aggregate the solve deducts", () => {
    // THE phase-4 invariant. Both sides compose the same three primitives, so
    // this is exact, not approximate.
    const p = world({ depot: true, linkFed: true });
    const { total } = auxiliaryBudget(p, draft);
    const aggregate = infraSpawnLoad(RELAY, 1, REMOTES.length, 1);
    expect(total).to.be.closeTo(aggregate, 1e-12);
  });

  it("holds for an UNLINKED depot too (the feeder leg is 6, not 1)", () => {
    const p = world({ depot: true, linkFed: false });
    const { total, byKind } = auxiliaryBudget(p, draft);
    expect(total).to.be.closeTo(infraSpawnLoad(RELAY, 1, REMOTES.length, 0), 1e-12);
    // The two legs must price DIFFERENTLY, or the link-fed lens is not reaching
    // the corp at all and the identity above would hold vacuously.
    //
    // Deliberately not asserting a DIRECTION: at relay 40 the link-fed feeder is
    // the DEARER one (0.0213 vs 0.0150), because its distance-1 leg falls under
    // the spec-45 volley-service floor and gets clamped up to it. The "link-fed
    // is ~1/6th the CARRY" intuition only holds once the relay is large enough
    // to clear that floor.
    const linked = auxiliaryBudget(world({ depot: true, linkFed: true }), draft);
    expect(byKind.get("controllerFeeder")!).to.not.be.closeTo(linked.byKind.get("controllerFeeder")!, 1e-9);
    expect(byKind.get("controllerFeeder")!).to.be.closeTo(feederSpawnLoad(RELAY, false), 1e-12);
  });

  it("charges NOTHING for depot movers in a room with no storage - the drift phase 4 closed", () => {
    // The tender and feeder kinds commission one corp per SPAWN room, but
    // infraSpawnLoad prices them per DEPOT room. Before the depotRooms lens, a
    // pre-storage room commissioned a tender the colony never charged for, and
    // the corps' sum EXCEEDED the deduction in exactly the early game.
    const p = world({ depot: false, linkFed: false });
    const { total, byKind } = auxiliaryBudget(p, draft);
    expect(byKind.get("tender") ?? 0, "no depot, no tender charge").to.equal(0);
    expect(byKind.get("controllerFeeder") ?? 0, "no depot, no feeder charge").to.equal(0);
    // Only the reservers remain - which is exactly what the aggregate says.
    expect(total).to.be.closeTo(infraSpawnLoad(RELAY, 0, REMOTES.length, 0), 1e-12);
  });

  it("each kind declares its OWN primitive - the per-corp decomposition", () => {
    const p = world({ depot: true, linkFed: true });
    const { byKind } = auxiliaryBudget(p, draft);
    expect(byKind.get("reservation")).to.be.closeTo(REMOTES.length * roomReserverSpawnLoad(), 1e-12);
    expect(byKind.get("tender")).to.be.closeTo(tenderSpawnLoad(), 1e-12);
    expect(byKind.get("controllerFeeder")).to.be.closeTo(feederSpawnLoad(RELAY, true), 1e-12);
  });

  it("scales with the mined remotes, because reservers are linear", () => {
    // N per-room prices must sum to reserverSpawnLoad(N * parts) exactly - that
    // linearity is what makes the identity above hold to 1e-12 rather than
    // approximately, so it is worth pinning on its own.
    const p = world({ depot: true, linkFed: true });
    const one = auxiliaryBudget(p, [harvestIn(REMOTES[0], "a"), upgradeIn(HOME, RELAY)]);
    const three = auxiliaryBudget(p, draft);
    expect(three.byKind.get("reservation")).to.be.closeTo(3 * one.byKind.get("reservation")!, 1e-12);
  });

  it("prices no reserver for a home room the plan mines - only true remotes", () => {
    const p = world({ depot: true, linkFed: true });
    const homeOnly = auxiliaryBudget(p, [harvestIn(HOME, "home"), upgradeIn(HOME, RELAY)]);
    expect(homeOnly.byKind.get("reservation") ?? 0).to.equal(0);
    expect(homeOnly.total).to.be.closeTo(infraSpawnLoad(RELAY, 1, 0, 1), 1e-12);
  });

  it("the feeder follows the PLAN's relay, not a constant", () => {
    const p = world({ depot: true, linkFed: false });
    const small = auxiliaryBudget(p, [...draft.slice(0, 3), upgradeIn(HOME, 5)]);
    const large = auxiliaryBudget(p, [...draft.slice(0, 3), upgradeIn(HOME, 120)]);
    expect(large.byKind.get("controllerFeeder")!).to.be.greaterThan(small.byKind.get("controllerFeeder")!);
    expect(large.byKind.get("controllerFeeder")!).to.be.closeTo(feederSpawnLoad(120, false), 1e-12);
  });
});

/**
 * THE OTHER HALF OF THE SAME INVARIANT - and the half that actually broke.
 *
 * Every test above holds the remote count fixed and checks that both books price
 * it the same way. Live they were priced the same way from DIFFERENT counts:
 * `infraSpawnLoad` reads `prevFundedRemoteRooms` (the previous solve's answer,
 * because the charge is deducted before this solve decides), while the
 * reservation corps are proposed off THIS solve's draft.
 *
 * Measured t72828763: 9 reservation corps, 8 of them priced (the 9th a retained
 * corp for a room that had just dropped out), against `infraInputs.remoteRooms:
 * 9`. Sigma(auxiliary) 0.082977 vs `partsLedger.infra` 0.086681 - short by
 * exactly one `roomReserverSpawnLoad`, 0.003704 p/t.
 *
 * Small, and it would have stayed small at a 50-tick solve cadence. At the fiscal
 * month term (spec 46 phase A) the plan built here IS the month's budget, so a
 * remote that leaves at a boundary is charged for the whole month after it stops
 * being worked - and remotes leave exactly when the handicap sweep steps, which
 * is the one effect the experiment is trying to measure.
 */
describe("spec 51: the solve prices reservers for the remotes it FUNDS", () => {
  const g = globalThis as unknown as { Game?: unknown };
  let savedGame: unknown;
  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  const pos = (x: number, roomName: string): Position => ({ x, y: 25, roomName });
  const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  /** Home room with spawn + controller, and one source per remote room. */
  async function world(): Promise<InstanceType<(typeof import("../../../src/economy/flowAdapter"))["FlowGraph"]>> {
    const { createNode } = await import("../../../src/nodes/Node");
    const { FlowGraph } = await import("../../../src/economy/flowAdapter");
    const home = createNode("home", "W0N0", pos(5, "W0N0"), 100, ["W0N0"], 0);
    home.resources = [
      { type: "spawn", id: "spawn-0", position: pos(5, "W0N0") },
      { type: "controller", id: "ctrl-0", position: pos(5, "W0N0"), isOwned: true }
    ] as typeof home.resources;
    const remote = (id: string, room: string, x: number): typeof home => {
      const n = createNode(id, room, pos(x, room), 50, [room], 0);
      n.resources = [{ type: "source", id, position: pos(x, room), capacity: 3000 }] as typeof n.resources;
      return n;
    };
    return new FlowGraph([home, remote("r1", "W1N0", 15), remote("r2", "W2N0", 20)]);
  }

  /** The stamp the solve publishes for its infra pricing. */
  async function solveWithHistory(prevFunded?: readonly string[]) {
    const { solveColony } = await import("../../../src/economy/flowAdapter");
    const { solution } = solveColony(await world(), 0, manhattan, [], [], undefined, undefined, undefined, prevFunded);
    return {
      priced: solution.fleetCharge?.infraInputs?.remoteRooms,
      funded: solution.fleetCharge?.infraInputs?.remoteRoomsFunded,
      fundedRooms: solution.fundedRemoteRooms,
      solution
    };
  }

  it("re-prices when handed a STALE remote set - the t72828763 divergence", async () => {
    // History says four remotes were worked; this world can only fund the two it
    // has sources in. Before the corrective pass the plan charged for all four.
    const stale = await solveWithHistory(["W1N0", "W2N0", "W8N8", "W9N9"]);
    expect(stale.fundedRooms, "the world only has two remote sources").to.deep.equal(["W1N0", "W2N0"]);
    expect(stale.priced, "priced for the set it funded, not the set it was handed").to.equal(2);
    expect(stale.funded).to.equal(2);
  });

  it("lands on the same plan as if the history had been right all along", async () => {
    // The correction is not merely "a smaller number on the stamp" - the plan
    // must be the one that number belongs to, or the ledger and the sinks
    // disagree again a level down.
    const stale = await solveWithHistory(["W1N0", "W2N0", "W8N8", "W9N9"]);
    const clean = await solveWithHistory(["W1N0", "W2N0"]);
    expect(stale.solution.partsLedger?.infra).to.be.closeTo(clean.solution.partsLedger!.infra, 1e-12);
    expect(stale.solution.sinkAllocations.map(a => [a.sinkId, a.allocated])).to.deep.equal(
      clean.solution.sinkAllocations.map(a => [a.sinkId, a.allocated])
    );
  });

  it("costs nothing in steady state: priced already equals funded", async () => {
    const steady = await solveWithHistory(["W1N0", "W2N0"]);
    expect(steady.priced).to.equal(2);
    expect(steady.funded).to.equal(2);
    expect(steady.fundedRooms).to.deep.equal(["W1N0", "W2N0"]);
  });

  it("keeps the fleet charge priced off the plan it SHIPS, after re-pricing", async () => {
    // The re-price has to sit OUTSIDE the damped charge iteration and re-run it,
    // not after it. Dropping a reserver lowers infraEnergyPerTick, which is a
    // TERM OF THE CHARGE - so a correction bolted on afterwards leaves the spawn
    // sink demanding a charge for a fleet the shipped plan no longer has, which
    // is the same over-charge moved from the parts ledger into the energy one.
    //
    // `charge * spawnCount == fleetEnergy` is exactly the identity the decision
    // stamp exists to make checkable from a capture; it must survive a re-price.
    const stale = await solveWithHistory(["W1N0", "W2N0", "W8N8", "W9N9"]);
    const fc = stale.solution.fleetCharge!;
    const TOLERANCE = 0.25; // FLEET_CHARGE_TOLERANCE, per spawn
    expect(stale.solution.spawnMaintenance! * fc.spawnCount).to.be.closeTo(
      fc.fleetEnergy,
      TOLERANCE * fc.spawnCount
    );
    // And the infra the stamp reports is the SHIPPED problem's, not pass 1's.
    expect(fc.infraInputs!.remoteRooms).to.equal(fc.infraInputs!.remoteRoomsFunded);
  });

  it("publishes BOTH counts, so a residual is readable instead of silent", async () => {
    // The pass is bounded (a room its own freed charge funds back can oscillate),
    // so the stamp has to carry priced AND funded - one number cannot say whether
    // the books agree.
    const s = await solveWithHistory(["W1N0", "W2N0", "W9N9"]);
    expect(s.priced, "priced count published").to.be.a("number");
    expect(s.funded, "funded count published alongside it").to.be.a("number");
  });
});
