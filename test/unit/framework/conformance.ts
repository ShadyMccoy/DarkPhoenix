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
