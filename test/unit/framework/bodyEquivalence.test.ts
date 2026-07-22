/**
 * Body-dispatch equivalence (spec 17 acceptance test 3).
 *
 * The live body path used to be SpawningCorp.buildBodyForRole - a 12-role
 * string switch - while every kind's CorpKind.body() sat unexercised (and four
 * had silently drifted: harvest lost the linkFed CARRY, carry built a tanker
 * shape, upgrade defaulted WORK 10 vs the live 5 and dropped the strategy,
 * construction defaulted WORK 5 vs the live hard 2 and ignored its tankers).
 *
 * This suite freezes the switch AS THE REFERENCE (verbatim copy below) and
 * sweeps every registered kind's body() against it across roles, budgets,
 * bodyParams, and hints. It is the license to route SpawningCorp.executeSpawn
 * through kind.body() and delete the switch: any future kind body change must
 * consciously edit the reference here, not drift.
 */

import { expect } from "chai";
import { setupGlobals } from "../mock";
import { BodyHints, CorpKind } from "../../../src/economy/CorpKind";
import {
  UpgraderStrategy,
  buildGuardBody,
  buildMinerBody,
  buildReserverBody,
  buildTankerBody,
  buildUpgraderBody
} from "../../../src/spawn/BodyBuilder";
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

setupGlobals();

/**
 * THE REFERENCE: the pre-spec-17 SpawningCorp.buildBodyForRole switch (plus its
 * getPartRatios helper), copied verbatim. Deliberately NOT imported from src -
 * the whole point is that src can now delete it.
 */
function referenceBody(
  role: string,
  energyBudget: number,
  bodyParam?: number,
  haulerRatio?: "2:1" | "1:1" | "1:2",
  bodyStrategy?: string
): BodyPartConstant[] {
  switch (role) {
    case "miner":
      return buildMinerBody(bodyParam ?? 5, energyBudget, bodyStrategy === "linkFed").body;
    case "upgrader":
      return buildUpgraderBody(energyBudget, bodyParam ?? 5, bodyStrategy as UpgraderStrategy | undefined).body;
    case "builder":
      return buildUpgraderBody(energyBudget, 2).body;
    case "tanker":
      return buildTankerBody(bodyParam ?? 4, energyBudget, false).body;
    case "feeder": {
      const carry = Math.max(1, Math.min(bodyParam ?? 4, Math.floor(energyBudget / 100), 25));
      const feederBody: BodyPartConstant[] = [];
      for (let i = 0; i < carry; i++) feederBody.push(CARRY);
      for (let i = 0; i < carry; i++) feederBody.push(MOVE);
      return feederBody;
    }
    case "scout":
      return [MOVE];
    case "reserver":
      return buildReserverBody(energyBudget, bodyParam ?? 2).body;
    case "claimer":
      return buildReserverBody(energyBudget, bodyParam ?? 1).body;
    case "guard":
      return buildGuardBody(energyBudget, bodyParam ?? 5).body;
    case "buster":
      return buildGuardBody(energyBudget, bodyParam ?? 10).body;
    case "striker":
      return buildReserverBody(energyBudget, bodyParam ?? 2).body;
    case "hauler": {
      const [carryRatio, moveRatio] =
        haulerRatio === "2:1" ? [2, 1] : haulerRatio === "1:2" ? [1, 2] : [1, 1];
      const costPerUnit = 50 * carryRatio + 50 * moveRatio;
      const partsPerUnit = carryRatio + moveRatio;
      const maxByBudget = Math.floor(energyBudget / costPerUnit);
      const maxBySize = Math.floor(50 / partsPerUnit);
      const desiredUnits = bodyParam ? Math.ceil(bodyParam / carryRatio) : maxByBudget;
      const units = Math.max(1, Math.min(desiredUnits, maxByBudget, maxBySize));
      if (units < 1) return [];
      const body: BodyPartConstant[] = [];
      for (let i = 0; i < units * carryRatio; i++) body.push(CARRY);
      for (let i = 0; i < units * moveRatio; i++) body.push(MOVE);
      return body;
    }
  }
  return [];
}

const BUDGETS = [100, 200, 300, 550, 800, 1300, 1800, 3000];
const PARAMS: (number | undefined)[] = [undefined, 1, 2, 3, 5, 10, 25, 40];

interface Case {
  kind: CorpKind;
  role: string;
  hints?: BodyHints;
}

const CASES: Case[] = [
  { kind: harvestKind as CorpKind, role: "miner" },
  { kind: harvestKind as CorpKind, role: "miner", hints: { bodyStrategy: "linkFed" } },
  { kind: carryKind as CorpKind, role: "hauler" },
  { kind: carryKind as CorpKind, role: "hauler", hints: { haulerRatio: "2:1" } },
  { kind: carryKind as CorpKind, role: "hauler", hints: { haulerRatio: "1:1" } },
  { kind: carryKind as CorpKind, role: "hauler", hints: { haulerRatio: "1:2" } },
  { kind: upgradeKind as CorpKind, role: "upgrader" },
  { kind: upgradeKind as CorpKind, role: "upgrader", hints: { bodyStrategy: "mobile" } },
  { kind: upgradeKind as CorpKind, role: "upgrader", hints: { bodyStrategy: "containerFed" } },
  { kind: constructionKind as CorpKind, role: "builder" },
  { kind: constructionKind as CorpKind, role: "tanker" },
  { kind: extensionTenderKind as CorpKind, role: "tanker" },
  { kind: controllerFeederKind as CorpKind, role: "feeder" },
  { kind: scoutKind as CorpKind, role: "scout" },
  { kind: reservationKind as CorpKind, role: "reserver" },
  { kind: claimKind as CorpKind, role: "claimer" },
  { kind: raidGuardKind as CorpKind, role: "guard" },
  { kind: coreBusterKind as CorpKind, role: "buster" },
  { kind: coreBusterKind as CorpKind, role: "striker" }
];

describe("CorpKind.body equals the retired SpawningCorp role switch (spec 17)", () => {
  for (const c of CASES) {
    const hintLabel = c.hints ? ` ${JSON.stringify(c.hints)}` : "";
    it(`${c.kind.kind}.body("${c.role}")${hintLabel} matches the reference across the sweep`, () => {
      for (const budget of BUDGETS) {
        for (const param of PARAMS) {
          const expected = referenceBody(c.role, budget, param, c.hints?.haulerRatio, c.hints?.bodyStrategy);
          const actual = c.kind.body(c.role, param, budget, c.hints);
          expect(actual, `budget=${budget} bodyParam=${String(param)}`).to.deep.equal(expected);
        }
      }
    });
  }

  it("every declared role of every kind is covered by this sweep", () => {
    const covered = new Set(CASES.map(c => `${c.kind.kind}:${c.role}`));
    const kinds = [
      harvestKind, carryKind, upgradeKind, constructionKind, scoutKind, reservationKind,
      extensionTenderKind, controllerFeederKind, raidGuardKind, coreBusterKind, claimKind
    ] as CorpKind[];
    for (const kind of kinds) {
      for (const role of Object.keys(kind.roles)) {
        expect(covered.has(`${kind.kind}:${role}`), `${kind.kind}:${role} missing from sweep`).to.equal(true);
      }
    }
  });
});
