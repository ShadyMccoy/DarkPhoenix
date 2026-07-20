/**
 * describeCorpKindConformance - rung 1 of the proof ladder
 * (docs/specs/00-corp-framework.md): every corp kind must pass these checks IN
 * ISOLATION before it composes with anything. Ported and new kinds alike call
 * this once from their test file; a kind that can't pass conformance has no
 * business in the registry.
 */

import { expect } from "chai";
import { Commission } from "../../../src/economy/Commission";
import { CorpKind } from "../../../src/economy/CorpKind";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";

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

    it("run() never throws on an empty world (ErrorMapper contract)", () => {
      const corp = kind.materialize(fx.commission, undefined);
      expect(() => kind.run(corp, 1)).to.not.throw();
      expect(() => kind.run(corp, 2)).to.not.throw();
    });

    const expectedParts = fx.expectedSpawnPartsPerTick;
    if (expectedParts !== undefined) {
      it("commission economics derive from economy/primitives (no private formulas)", () => {
        expect(fx.commission.consumes.spawnPartsPerTick).to.be.closeTo(expectedParts, 1e-9);
      });
    }
  });
}
