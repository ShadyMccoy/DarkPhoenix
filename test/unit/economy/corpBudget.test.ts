import { expect } from "chai";
import {
  ColonyProblem,
  CommissionedSink,
  PlannerSink,
  PlannerSource,
  PlannerSpawn,
  planColony
} from "../../../src/economy/CorpPlanner";
import { commissionsFromPlan } from "../../../src/economy/commissionPlan";
import { consumerUnitSpawnLoad } from "../../../src/economy/roadEconomics";
import {
  constructionWorkSpawnLoad,
  controllerWorkSpawnLoad,
  effectiveLife,
  vectorSupplyParts
} from "../../../src/economy/primitives";
import { Commission } from "../../../src/economy/Commission";
import { AccountCategory, categoryOfKind } from "../../../src/economy/accountCategory";
import { Position } from "../../../src/types/Position";
// The kind roster, imported DIRECTLY (bodyEquivalence.test.ts's convention).
// `listCorpKinds()` reads the live registry, which CommissionHost populates at
// runtime and a bare unit context leaves EMPTY - so asserting over it passes
// vacuously. Measured: it returned [] here before this import list existed.
import { harvestKind } from "../../../src/corps/kinds/harvestKind";
import { carryKind } from "../../../src/corps/kinds/carryKind";
import { upgradeKind } from "../../../src/corps/kinds/upgradeKind";
import { constructionKind } from "../../../src/corps/kinds/constructionKind";
import { scoutKind } from "../../../src/corps/kinds/scoutKind";
import { reservationKind } from "../../../src/corps/kinds/reservationKind";
import { extensionTenderKind } from "../../../src/corps/kinds/extensionTenderKind";
import { controllerFeederKind } from "../../../src/corps/kinds/controllerFeederKind";
import { raidGuardKind } from "../../../src/corps/kinds/raidGuardKind";
import { coreBusterKind } from "../../../src/corps/kinds/coreBusterKind";
import { claimKind } from "../../../src/corps/kinds/claimKind";

/** Every registered kind, plus the two legacy-registry kinds CommissionHost
 *  folds in by hand (bootstrap, spawning - see completeCensus). */
const ALL_KINDS: string[] = [
  harvestKind.kind,
  carryKind.kind,
  upgradeKind.kind,
  constructionKind.kind,
  scoutKind.kind,
  reservationKind.kind,
  extensionTenderKind.kind,
  controllerFeederKind.kind,
  raidGuardKind.kind,
  coreBusterKind.kind,
  claimKind.kind,
  "bootstrap",
  "spawning"
];

/**
 * THE COLONY BUDGET IS THE SUM OF THE CORP BUDGETS (spec 51, owner 2026-08-06:
 * *"Every corp plan is essentially a list of inputs and outputs. Thats the corp
 * budget. The colony budget is the sum of the corps."*).
 *
 * This is a SCENARIO suite over the pure planner - `ColonyProblem` ->
 * `planColony` -> `commissionsFromPlan` - so the identity is checked on staged
 * worlds in milliseconds, with no mockup and no live capture.
 *
 * What it establishes, and why each half matters:
 *
 *  1. For PRODUCE and TRANSPORT the identity ALREADY HOLDS, exactly. That is the
 *     proof the owner's model is the right one: it is not aspirational, it is
 *     how two thirds of the plan already works.
 *  2. For CONSUME and AUXILIARY it does not, and the suite pins BOTH gaps with
 *     their measured size so they cannot silently widen and so the fix flips a
 *     red assertion green rather than being argued.
 *
 * The gaps are the whole reason the statement re-derives its budget column in
 * `scripts/waste-ledger.ts` instead of summing the corps: a sum that is known to
 * be incomplete cannot be the book.
 */

// 1-D world: one room, manhattan distance, so every economic quantity is
// hand-derivable. Same staging vocabulary as CorpPlanner.test.ts.
const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const spawn = (id: string, x: number): PlannerSpawn => ({ id, pos: at(x) });
const source = (id: string, x: number, rate = 10, maxMiners = 1): PlannerSource => ({
  id,
  nodeId: `node-${id}`,
  pos: at(x),
  rate,
  maxMiners
});
const sink = (id: string, kind: PlannerSink["kind"], x: number, value: number, capacity: number): PlannerSink => ({
  id,
  kind,
  pos: at(x),
  value,
  capacity
});
const problem = (p: Partial<ColonyProblem> & Pick<ColonyProblem, "spawns" | "sources" | "sinks">): ColonyProblem => ({
  dist: manhattan,
  ...p
});

/** The staged worlds. Each is a scenario the identity must hold across. */
const WORLDS: { [name: string]: () => ColonyProblem } = {
  "home sources only": () =>
    problem({
      spawns: [spawn("s1", 0)],
      sources: [source("src-a", 12), source("src-b", 15)],
      sinks: [sink("ctrl", "controller", 10, 80, 1000), sink("spawn-s1", "spawn", 0, 100, 300)]
    }),
  "home + two remotes": () =>
    problem({
      spawns: [spawn("s1", 0)],
      sources: [source("src-a", 12), source("src-b", 15), source("src-r1", 60), source("src-r2", 90)],
      sinks: [
        sink("ctrl", "controller", 10, 80, 1000),
        sink("spawn-s1", "spawn", 0, 100, 300),
        sink("store", "storage", 2, 1, 100000)
      ]
    }),
  "two spawns": () =>
    problem({
      spawns: [spawn("s1", 0), spawn("s2", 40)],
      sources: [source("src-a", 12), source("src-b", 45), source("src-r1", 70)],
      sinks: [
        sink("ctrl", "controller", 10, 80, 1000),
        sink("spawn-s1", "spawn", 0, 100, 300),
        sink("spawn-s2", "spawn", 40, 100, 300),
        sink("store", "storage", 2, 1, 100000)
      ]
    }),
  "standing infra charge": () =>
    problem({
      spawns: [spawn("s1", 0)],
      sources: [source("src-a", 12), source("src-r1", 60)],
      sinks: [
        sink("ctrl", "controller", 10, 80, 1000),
        sink("spawn-s1", "spawn", 0, 100, 300),
        sink("store", "storage", 2, 1, 100000)
      ],
      infraPartsPerTick: 0.05
    })
};

/** Plan a world and return everything the identity needs. */
function budgetOf(p: ColonyProblem): {
  commissions: Commission[];
  ledger: ReturnType<typeof planColony>["partsLedger"];
  sinks: CommissionedSink[];
  haulLoad: number;
  sigma: number;
  byShape: { [shape: string]: number };
} {
  const plan = planColony(p);
  const commissions = commissionsFromPlan(p, plan);
  const byShape: { [shape: string]: number } = {};
  let sigma = 0;
  for (const c of commissions) {
    const load = c.consumes.spawnPartsPerTick || 0;
    sigma += load;
    byShape[c.shape] = (byShape[c.shape] ?? 0) + load;
  }
  return {
    commissions,
    ledger: plan.partsLedger,
    sinks: plan.sinks,
    haulLoad: plan.haulers.reduce((s, h) => s + h.spawnParts, 0),
    sigma,
    byShape
  };
}

describe("spec 51: the colony budget is the sum of the corp budgets", () => {
  describe("the identity HOLDS today for produce + transport", () => {
    // These worlds commission only produce/transport corps. Their summed
    // `consumes.spawnPartsPerTick` equals the ledger's own committed build-rate
    // EXACTLY - the planner already keeps one book for two thirds of the plan.
    for (const name of ["home sources only", "home + two remotes", "two spawns", "standing infra charge"]) {
      it(`${name}: SIGMA(corp consumes) === minerLoad + spent`, () => {
        const b = budgetOf(WORLDS[name]());
        expect(b.byShape.consume ?? 0, "this world stages no consumer").to.equal(0);
        expect(b.sigma).to.be.closeTo(b.ledger.minerLoad + b.ledger.spent, 1e-9);
      });
    }

    it("every produce/transport corp declares a POSITIVE budget - no free corps", () => {
      const b = budgetOf(WORLDS["home + two remotes"]());
      const priced = b.commissions.filter(c => c.shape === "produce" || c.shape === "transport");
      expect(priced.length).to.be.greaterThan(0);
      for (const c of priced) {
        expect(c.consumes.spawnPartsPerTick, `${c.corpId} declares no cost`).to.be.greaterThan(0);
      }
    });
  });

  describe("GAP 1 - the consume envelope and the fill charge different numbers", () => {
    /**
     * `consumerSpawnLoad`'s docblock claims it is *"the SAME charge the planner's
     * parts ledger paid for this sink"*. It is not, measurably.
     *
     * The commission prices construction ALL-IN (spec 34 D4): builder WORK
     * bodies PLUS a tanker supply vector to fuel them. The sink FILL charges
     * `chargePerUnit = haul body + workPerUnit` per unit routed - the delivery
     * leg and the work, with no crew fuel shuttle.
     *
     * Two quantities, one name. Until they are one number the colony budget
     * cannot be the sum of the corps, because the fill spends one thing while
     * the corp declares another.
     */
    const constructionWorld = (): ColonyProblem =>
      problem({
        spawns: [spawn("s1", 0)],
        sources: [source("src-a", 12), source("src-b", 15), source("src-r1", 60)],
        sinks: [
          sink("ctrl", "controller", 10, 80, 1000),
          sink("spawn-s1", "spawn", 0, 100, 300),
          sink("site", "construction", 20, 70, 5000),
          sink("store", "storage", 2, 1, 100000)
        ]
      });

    it("the build commission declares EXACTLY what the fill spent", () => {
      const b = budgetOf(constructionWorld());
      const declared = b.byShape.consume ?? 0;
      const filled = b.ledger.spent - b.haulLoad; // the sinks' share of the fill
      expect(declared, "no consume commission was emitted - restage the world").to.be.greaterThan(0);
      expect(filled).to.be.greaterThan(0);
      // Was 1.79x (declared 0.074189 vs filled 0.041351, measured 2026-08-06).
      // Both sides now read `consumerUnitSpawnLoad`, so this is 1.0 by
      // construction - the envelope IS the per-unit law times the allocation,
      // and the fill debits the same law per unit routed.
      expect(declared / filled, "envelope and fill must be one derivation").to.be.closeTo(1, 1e-9);
    });

    /**
     * The gap was ENTIRELY the supply vector, and this pins that diagnosis so a
     * regression names its own cause instead of just moving the total. The
     * builder term was identical on both sides throughout: the envelope had
     * been moved to the 3C:1M gait the runtime really fields (spec 34
     * vector-gait follow-up B) while the fill kept the 1:1 model - the very
     * ~2x under-pricing that follow-up existed to remove, left standing on the
     * other side of the seam.
     */
    it("prices the construction supply vector at the gait the runtime FIELDS", () => {
      const d = 20;
      const builder = constructionWorkSpawnLoad(1, d);
      const unit = consumerUnitSpawnLoad("construction", d);
      const vector = unit - builder;
      // The retired 1:1 model, for the contrast that makes the number legible.
      const oldVector = vectorSupplyParts(1, d) / effectiveLife(d);
      // 98.40 parts against the 1:1 model's 50.40, at d=20 (measured).
      expect(vector / oldVector, "the 3C:1M gait costs ~2x the 1:1 model it replaced").to.be.closeTo(1.952, 0.01);
      // Linear in the rate - the property that lets ONE law serve both sides.
      expect(consumerUnitSpawnLoad("construction", d) * 30).to.be.closeTo(
        consumerUnitSpawnLoad("construction", d) * 10 * 3,
        1e-12
      );
    });

    /**
     * The controller branch carries NO supply vector: its mover is the feeder,
     * priced in `infraSpawnLoad` and declared by controllerFeeder's own corp.
     * Pinned because a "symmetry" refactor that gave the controller a vector
     * would silently double-count the feeder.
     */
    it("charges the controller for WORK only - the feeder is its mover", () => {
      const d = 10;
      expect(consumerUnitSpawnLoad("controller", d)).to.be.closeTo(controllerWorkSpawnLoad(1, d), 1e-12);
    });

    it("THE TARGET: SIGMA(corp consumes) === minerLoad + spent, consumers included", () => {
      // Green since the consume envelope and the fill share one derivation
      // (`consumerUnitSpawnLoad`), 2026-08-08.
      const b = budgetOf(constructionWorld());
      expect(b.sigma).to.be.closeTo(b.ledger.minerLoad + b.ledger.spent, 1e-9);
    });
  });

  describe("GAP 2 - auxiliary corps declare a budget of ZERO", () => {
    /**
     * `proposeHelpers.perRoomAuxiliaryCommission` hardcodes
     * `consumes: { spawnPartsPerTick: 0 }` for EVERY auxiliary kind -
     * reservation, tender, controllerFeeder, raidGuard, scout, coreBuster,
     * claim. Live at t72823437 that is 7 of 12 kinds, and reservation alone is
     * 19.52 e/t of measured spend.
     *
     * The colony's ledger DOES know the cost - it deducts `infraPartsPerTick`
     * before the fill spends anything - but no corp owns it. So the sum of the
     * corps is short by exactly the standing infrastructure, which is precisely
     * the hole `waste-ledger.planSpawnLoad` was written to fill by re-deriving
     * it. Spec 39 phase 4 is the fix.
     */
    it("the ledger deducts standing infra that NO commission accounts for", () => {
      const b = budgetOf(WORLDS["standing infra charge"]());
      expect(b.ledger.infra, "world stages 0.05 p/t of standing infra").to.be.closeTo(0.05, 1e-9);
      // Every commission in this world is produce/transport; none carries infra.
      const auxiliary = b.commissions.filter(c => c.shape === "auxiliary");
      expect(auxiliary.length, "solver commissions never include auxiliary").to.equal(0);
      // The identity holds ONLY because infra is deducted before the fill - it
      // is committed build-rate that belongs to no corp row.
      expect(b.sigma).to.be.closeTo(b.ledger.minerLoad + b.ledger.spent, 1e-9);
      expect(b.sigma + b.ledger.infra).to.be.greaterThan(b.sigma);
    });

    // CLOSED for the three DEPOT/REMOTE kinds by spec 39 phase 4 (2026-08-06):
    // reservation, tender and controllerFeeder now declare the same per-corp
    // primitives infraSpawnLoad composes, and the identity
    //     SIGMA(auxiliary corps) === infraSpawnLoad
    // is pinned to 1e-12 in test/unit/economy/auxiliaryBudget.test.ts.
    //
    // raidGuard ALSO closed, by spec 51 phase 2 (2026-08-07): it declares
    // `guardedRooms x roomGuardSpawnLoad()` off the raid-meter lens, and
    // infraSpawnLoad composes the same term.
    //
    // STILL OPEN - scout, coreBuster and claim declare 0 AND are absent from
    // infraSpawnLoad, so they sit outside BOTH books. They are not three more
    // of the same: scout needs a plan-side model that is not an actuals feed,
    // while coreBuster and claim are CAPEX and want a capex-shaped budget line
    // (total + reserve draw), not a parts-per-tick rate. See spec 51 section 3b.
    it.skip("THE REMAINING TARGET: the combat/scout kinds are budgeted too", () => {
      // Un-skip when scout/coreBuster/claim price themselves AND infraSpawnLoad
      // (or its successor) accounts for them, so no class is outside both books.
      expect(false, "scout/coreBuster/claim still declare 0").to.equal(true);
    });
  });

  describe("the reporting category is a KIND declaration (spec 17 registration-only)", () => {
    it("every corp kind in the tree declares an account category", () => {
      // The `jack`/`tanker`/`hauler` defects all came from classifying by ROLE.
      // Keyed by kind, an unclassified corp is impossible to miss: this fails.
      expect(ALL_KINDS.length, "roster went empty - the import list is the roster").to.be.greaterThan(10);
      const unclassified = ALL_KINDS.filter(k => categoryOfKind(k) === undefined);
      expect(unclassified, "classify these kinds in economy/accountCategory").to.deep.equal([]);
    });

    it("every commission the planner emits maps to a category", () => {
      const b = budgetOf(WORLDS["home + two remotes"]());
      for (const c of b.commissions) {
        expect(categoryOfKind(c.kind), `commission kind "${c.kind}" has no category`).to.not.equal(undefined);
      }
    });

    it("groups the colony budget by category, and the groups sum to the whole", () => {
      const b = budgetOf(WORLDS["home + two remotes"]());
      const byCategory = new Map<AccountCategory, number>();
      for (const c of b.commissions) {
        const cat = categoryOfKind(c.kind);
        if (!cat) continue;
        byCategory.set(cat, (byCategory.get(cat) ?? 0) + (c.consumes.spawnPartsPerTick || 0));
      }
      // This IS the statement's cost side: category rows that sum to the colony
      // budget, each drillable to its corps.
      const total = [...byCategory.values()].reduce((s, v) => s + v, 0);
      expect(total).to.be.closeTo(b.sigma, 1e-9);
      expect(byCategory.get("extraction"), "remote+home mining reports on extraction").to.be.greaterThan(0);
    });
  });
});
