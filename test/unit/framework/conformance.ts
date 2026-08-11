/**
 * describeCorpKindConformance - rung 1 of the proof ladder
 * (docs/specs/00-corp-framework.md): every corp kind must pass these checks IN
 * ISOLATION before it composes with anything. Ported and new kinds alike call
 * this once from their test file; a kind that can't pass conformance has no
 * business in the registry.
 */

import { expect } from "chai";
import { Commission } from "../../../src/economy/Commission";
import { CorpKind, listCorpKinds, registerCorpKind, resetCorpKinds, runCorpTick } from "../../../src/economy/CorpKind";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
import { accountDeclarationErrors } from "../../../src/economy/accountCategory";
import { resolveReadoption } from "../../../src/execution/OrphanRescue";
import { Corp } from "../../../src/corps/Corp";

/**
 * THE STAFFING FIXTURE (specs 60 D + 61 rows 1-3, one shared instrument).
 *
 * Stages the kind's world with EXACTLY ONE incumbent of `role`, in a given
 * lifecycle state, owned by the fixture commission's corp - AND such that one
 * incumbent FULLY STAFFS the kind's ask (the probes assert "no further demand
 * for the role", so a fixture whose world wants two bodies enrolls a broken
 * probe). Returns the materialized corp ready for the demand path.
 *
 * Lifecycle states the probes exercise:
 *  - "spawning":  the incumbent is still IN the spawn (creep.spawning true,
 *                 ticksToLive undefined - the engine's shape). The kind must
 *                 not re-buy while its replacement builds (spec 60 phase D,
 *                 the t72811290 double-buy class - three strikes: feeder, hub
 *                 tender, port tender).
 *  - "recycling": the incumbent is live with memory.recycling set. It still
 *                 COUNTS as staffing - the pounce-recycle path orders its own
 *                 successor, so a lens excluding it double-orders (measured
 *                 collapse to a 7-runt fleet; spec 61 row 1).
 *  - "live":      the incumbent is on-post, the tick after arrival, full TTL.
 *                 The kind must neither demand a replacement nor churn the
 *                 newborn back into the spawn (~25t churn loop; spec 61 row 3
 *                 - symptom-level: the two-lens root dies with spec 39 4-5).
 */
export interface StaffingFixture {
  /** The demand role (a `kind.roles` key) whose staffing lens the probes exercise. */
  role: string;
  /** Demand context override (default { energyCapacity: 1300, tick: 12360 }). */
  ctx?: unknown;
  /** Stage globals + ONE incumbent of `role` in `state`; return the corp. */
  stage(state: "spawning" | "recycling" | "live"): Corp;
}

/**
 * Demand-exposing kinds NOT yet carrying a staffing fixture - the purity
 * ratchet's debt idiom (spec 61): fixture cost is real (each kind's demand
 * lens reads different world state), so un-probed kinds are VISIBLE debt with
 * this pointer, never silently unprobed coverage. SHRINK ONLY: enrolling a
 * kind's fixture removes its entry; a new demand-exposing kind ships with a
 * fixture or takes an entry here in the same PR.
 */
export const UNSTAFFED_KINDS = new Set([
  "harvest",
  "carry",
  "upgrade",
  "construction",
  "tender",
  "raidGuard",
  "coreBuster"
]);

export interface KindFixtures {
  /** A world in which the kind has something to do (auxiliaries: propose > 0). */
  problem: ColonyProblem;
  /** A valid commission for the kind (what the planner/propose would emit). */
  commission: Commission;
  /**
   * When provided, the fixture commission's consumes.spawnPartsPerTick must
   * equal this primitives-derived value (ONTOLOGY §2: no kind ships its own
   * formula). Omit only for kinds that genuinely consume no build-time.
   */
  expectedSpawnPartsPerTick?: number;
  /** Staffing world for the lifecycle probes (specs 60 D + 61 rows 1-3). */
  staffing?: StaffingFixture;
}

export function describeCorpKindConformance(kind: CorpKind, fx: KindFixtures): void {
  describe(`CorpKind conformance: ${kind.kind}`, () => {
    it("proposes deterministically, with unique well-formed corpIds of its own kind", () => {
      const a = kind.propose(fx.problem, []);
      const b = kind.propose(fx.problem, []);
      expect(a).to.deep.equal(b);
      // PURITY (spec 17 P3): propose is a function of (problem, draft) ONLY.
      // With the Screeps globals removed it must return the same commissions -
      // triggers that steal facts from Game/Memory (the stranded-reserver
      // class) fail here instead of flapping live.
      const g = global as { Game?: unknown; Memory?: unknown };
      const savedGame = g.Game;
      const savedMemory = g.Memory;
      delete g.Game;
      delete g.Memory;
      try {
        expect(kind.propose(fx.problem, []), "propose must not read Game/Memory").to.deep.equal(a);
      } finally {
        g.Game = savedGame;
        g.Memory = savedMemory;
      }
      const ids = a.map(c => c.corpId);
      expect(new Set(ids).size).to.equal(ids.length);
      for (const c of a) {
        expect(c.kind).to.equal(kind.kind);
        expect(c.corpId).to.match(/^[a-z][\w-]*-[\w-]+$/i);
      }
    });

    it("round-trips serialize -> deserialize -> serialize to a fixpoint", () => {
      const corp = kind.materialize(fx.commission, undefined);
      const once = kind.serializeCorp(corp);
      const twice = kind.serializeCorp(kind.deserializeCorp(once, fx.commission));
      expect(twice).to.deep.equal(once);
    });

    it("materialize is idempotent: re-binding the same commission updates, not duplicates", () => {
      const first = kind.materialize(fx.commission, undefined);
      const second = kind.materialize(fx.commission, first);
      expect(second.id).to.equal(first.id);
    });

    it("materialize refreshes the spawn binding on an existing corp (stale-spawnId regression)", () => {
      // A persisted corp outlives spawns; the commission carries the CURRENT
      // spawn id every solve, and materialize must adopt it. Measured live: the
      // immortal upgrade/construction corps kept a dead spawn's id, so
      // collectDemands dropped their demands forever (0 upgraders/builders
      // while the plan asked for 117 WORK). The check rewrites every embedded
      // occurrence of the corp's spawn id in the commission to a fresh value -
      // covering both raw and "spawn-"-prefixed conventions - and asserts the
      // re-materialized corp follows.
      const corp = kind.materialize(fx.commission, undefined);
      const oldId = (corp as { getSpawnId?: () => string }).getSpawnId?.();
      if (!oldId) return; // kind has no spawn binding
      const json = JSON.stringify(fx.commission);
      if (!json.includes(oldId)) return; // commission does not embed the id
      const freshId = `${oldId}-fresh`;
      const rebound = JSON.parse(json.split(oldId).join(freshId)) as Commission;
      const updated = kind.materialize(rebound, corp);
      expect((updated as { getSpawnId?: () => string }).getSpawnId?.()).to.equal(freshId);
    });

    it("run (custom or the dispatch's default cadence) never throws on an empty world (ErrorMapper contract)", () => {
      // runCorpTick is THE dispatch path: the kind's own run() when declared,
      // else the default plan/work cadence (run is optional since spec 35 D).
      const corp = kind.materialize(fx.commission, undefined);
      expect(() => runCorpTick(kind, corp, 1)).to.not.throw();
      expect(() => runCorpTick(kind, corp, 2)).to.not.throw();
    });

    const expectedParts = fx.expectedSpawnPartsPerTick;
    if (expectedParts !== undefined) {
      it("commission economics derive from economy/primitives (no private formulas)", () => {
        expect(fx.commission.consumes.spawnPartsPerTick).to.be.closeTo(expectedParts, 1e-9);
      });
    }

    it("declares its statement line - kind and every role resolve an AccountCategory (spec 60 B)", () => {
      // Registration-only accounting: the income statement SUMS rows that
      // cannot fail to exist, because a kind cannot pass conformance without
      // naming the line it (and each of its roles) reports on.
      expect(accountDeclarationErrors(kind)).to.deep.equal([]);
    });

    it("staffing-fixture enrollment is HONEST: a demand-exposing kind carries a fixture or a visible debt entry (specs 60 D / 61)", () => {
      const corp = kind.materialize(fx.commission, undefined) as unknown as Record<string, unknown>;
      const demanding = typeof corp.getSpawnDemand === "function" && typeof corp.getSpawnId === "function";
      if (fx.staffing) {
        expect(demanding, "a staffing fixture on a kind with no demand path probes nothing").to.equal(true);
        expect(
          UNSTAFFED_KINDS.has(kind.kind),
          `${kind.kind} carries a staffing fixture - remove it from UNSTAFFED_KINDS so the debt list stays a ratchet`
        ).to.equal(false);
      } else if (demanding) {
        expect(
          UNSTAFFED_KINDS.has(kind.kind),
          `${kind.kind} exposes spawn demands but has no staffing fixture - add one (KindFixtures.staffing) or ` +
            `take a visible debt entry in UNSTAFFED_KINDS (test/unit/framework/conformance.ts, specs 60 D / 61)`
        ).to.equal(true);
      } else {
        expect(
          UNSTAFFED_KINDS.has(kind.kind),
          `${kind.kind} has no demand path - it does not belong on the UNSTAFFED_KINDS debt list`
        ).to.equal(false);
      }
    });

    const staffing = fx.staffing;
    if (staffing) {
      const demandCtx = staffing.ctx ?? { energyCapacity: 1300, tick: 12360 };
      const demandsForRole = (corp: Corp): unknown[] => {
        const demands = (corp as unknown as { getSpawnDemand(c: unknown): Array<{ role: string }> }).getSpawnDemand(
          demandCtx
        );
        return demands.filter(d => d.role === staffing.role);
      };
      /** The staged lone incumbent (by the role's declared workType). */
      const incumbent = (): Creep => {
        const workType = kind.roles[staffing.role]?.workType;
        expect(workType, `staffing.role "${staffing.role}" must be a declared role of ${kind.kind}`).to.be.a("string");
        const matches = Object.keys(Game.creeps).filter(n => Game.creeps[n].memory?.workType === workType);
        expect(matches, `the staffing fixture must stage EXACTLY ONE ${workType} incumbent`).to.have.length(1);
        return Game.creeps[matches[0]];
      };

      it(`no double-buy while the ${staffing.role} replacement is IN THE SPAWN (spec 60 D - the t72811290 class)`, () => {
        // Three strikes of one class: the feeder (two 1600e feeders 48t apart,
        // F1 feeder line 12x plan), the hub tender (pre-empted), the port
        // tender (fixed in the 2026-08-11 cleanup). A demand lens that counts
        // only LIVE bodies re-arms while its own purchase builds - one body in
        // the pipe IS one body staffed.
        const corp = staffing.stage("spawning");
        expect(incumbent().spawning, "fixture must stage the incumbent IN the spawn").to.equal(true);
        expect(
          demandsForRole(corp),
          `${kind.kind} re-buys "${staffing.role}" while its only incumbent is still in the spawn - ` +
            `the demand lens must count spawning newborns (includeSpawning: true)`
        ).to.deep.equal([]);
      });

      it(`a recycling ${staffing.role} still COUNTS as staffing (spec 61 row 1 - the double-order trap)`, () => {
        // The pounce-recycle path orders its own successor; a lens excluding
        // `recycling` creeps double-orders (measured collapse to a 7-runt
        // fleet, CLAUDE.md "Recycling counts as staffing").
        const corp = staffing.stage("recycling");
        expect(incumbent().memory.recycling, "fixture must stage a recycling incumbent").to.equal(true);
        expect(
          demandsForRole(corp),
          `${kind.kind} re-buys "${staffing.role}" while its recycling incumbent stands - ` +
            `the recycle path owns the successor order; never filter memory.recycling out of a staffing count`
        ).to.deep.equal([]);
      });

      it(`a ${staffing.role} newborn AT ITS POST is neither replaced nor churned (spec 61 row 3 - the ~25t churn signature)`, () => {
        // staffsPost symmetry, symptom-level: a consumer of "how many creeps
        // does this post have" using a different lens than the demand side
        // recycles newborns at the spawn door. The root (two lenses existing
        // at all) dies with spec 39 phases 4-5; this fence holds until then.
        const corp = staffing.stage("live");
        const creep = incumbent();
        expect(creep.spawning, "fixture must stage the incumbent LIVE").to.equal(false);
        expect(demandsForRole(corp), `${kind.kind} demands a replacement for its just-arrived "${staffing.role}"`).to.deep.equal(
          []
        );
        expect(() => runCorpTick(kind, corp as never, 12361)).to.not.throw();
        expect(
          creep.memory.recycling,
          `${kind.kind} marked its just-arrived "${staffing.role}" recyclable - the churn half of the trap`
        ).to.not.equal(true);
      });
    }

    it("corp-id ROUND-TRIP: the id the commission mints, the corp answers to, the newborn carries and rescue resolves is ONE id (spec 61 row 4)", () => {
      // The rename-orphans door, and spec 63's regression net: planner ids are
      // pure ("harvest-{flowSourceId}"), kinds strip flow prefixes, and a
      // rename anywhere on that chain silently orphans live creeps (CLAUDE.md
      // "Corp id prefixes"). The probe drives the LIVE resolution rule
      // (resolveReadoption - never a re-implementation) over each declared
      // readoptable role.
      //
      // Kinds with a custom claimsOrphan need real world staging (assignment
      // ids, latch rooms), which the staffing fixture provides - a
      // claimsOrphan kind without one is skipped here and already visible on
      // UNSTAFFED_KINDS; its round-trip enrolls with its fixture.
      const probeRole = (corp: Corp, creep: Creep, role: string): void => {
        const prior = listCorpKinds();
        resetCorpKinds();
        registerCorpKind(kind as CorpKind);
        try {
          const resolved = resolveReadoption(creep, kindName =>
            kindName === kind.kind ? { [fx.commission.corpId]: corp } : {}
          );
          expect(
            resolved,
            `role "${role}": rescue resolved "${resolved}" for a creep stamped corpId="${creep.memory.corpId}" - ` +
              `the commission id, the corp id, the newborn's stamp and the rescue target must round-trip to ONE id`
          ).to.equal(corp.id);
        } finally {
          resetCorpKinds();
          for (const k of prior) registerCorpKind(k);
        }
      };

      if (kind.claimsOrphan) {
        if (!staffing) return; // visible on UNSTAFFED_KINDS - enrolls with the fixture
        const corp = staffing.stage("live");
        const workType = kind.roles[staffing.role]?.workType;
        const name = Object.keys(Game.creeps).find(n => Game.creeps[n].memory?.workType === workType);
        expect(name, "staffing fixture staged no incumbent").to.be.a("string");
        probeRole(corp, Game.creeps[name as string], staffing.role);
        return;
      }

      const corp = kind.materialize(fx.commission, undefined);
      for (const role of Object.keys(kind.roles)) {
        if (kind.roles[role].readopt === false) continue; // rescue ceded to another kind
        const creep = {
          name: `roundtrip-${role}`,
          spawning: false,
          ticksToLive: 1400,
          pos: { x: 25, y: 25, roomName: corp.getPosition().roomName },
          memory: { corpId: corp.id, workType: kind.roles[role].workType }
        } as unknown as Creep;
        probeRole(corp, creep, role);
      }
    });
  });
}
