/**
 * CommissionHost union sourcing (rung-5 Step A). The host materializes the
 * UNION of the solver's commissions (passed in, stable between solves) and the
 * auxiliary kinds' per-tick propose() output, so neither set demobilizes the
 * other. These tests pin that contract with a synthetic solver-backed kind, so
 * the live cutover rests on proven dispatch behavior.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { Corp, SerializedCorp } from "../../../src/corps/Corp";
import { Commission } from "../../../src/economy/Commission";
import { CorpKind, registerCorpKind, resetCorpKinds, getCorpKind } from "../../../src/economy/CorpKind";
import {
  runCommissionHost,
  resetCommissionHost,
  commissionedCorpsOfKind
} from "../../../src/execution/CommissionHost";
import { CorpRegistry } from "../../../src/execution/CorpRunner";

class WidgetCorp extends Corp {
  public ran = 0;
  public constructor(id: string) {
    super("mining", "widget", id);
  }
  public work(): void {
    this.ran += 1;
  }
  public getPosition(): Position {
    return { x: 0, y: 0, roomName: "W0N0" };
  }
}

/** A synthetic solver-backed kind: propose() returns [] (the "solver" emits it). */
const widgetKind: CorpKind<WidgetCorp> = {
  kind: "widget",
  roles: {},
  runOrder: 10,
  propose: () => [],
  materialize: (c: Commission, existing) => existing ?? new WidgetCorp(c.corpId),
  run: (corp: WidgetCorp) => corp.work(),
  serializeCorp: (corp: WidgetCorp) => corp.serialize(),
  deserializeCorp: (d: SerializedCorp) => {
    const w = new WidgetCorp(d.id);
    w.deserialize(d);
    return w;
  },
  body: () => []
};

const widgetCommission = (id: string): Commission => ({
  corpId: id,
  kind: "widget",
  shape: "produce",
  consumes: { spawnPartsPerTick: 0 },
  produces: { energyRate: 10 },
  assignment: { id }
});

function reset(): void {
  setupGlobals();
  Game.spawns = {};
  Game.creeps = {};
  Game.time = 100;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).commissionedCorps = undefined;
  (Memory as Record<string, unknown>).creeps = {};
  resetCommissionHost();
  resetCorpKinds();
  registerCorpKind(widgetKind as never);
}

const registry = { spawningCorps: {} } as unknown as CorpRegistry;

describe("CommissionHost union sourcing (Step A)", () => {
  beforeEach(reset);
  afterEach(() => {
    // The host serializes auxiliary corps (tender/reservation propose per spawn)
    // into Memory.commissionedCorps and the module store; clear both, and restore
    // the shared mock Game.spawns we mutated, so nothing leaks into other files.
    (Memory as Record<string, unknown>).commissionedCorps = undefined;
    Game.spawns = {};
    resetCommissionHost();
    resetCorpKinds();
  });

  it("materializes and runs a solver commission for a registered kind", () => {
    runCommissionHost(registry, [widgetCommission("widget-a")], Game.time);
    const corps = commissionedCorpsOfKind<WidgetCorp>("widget");
    expect(Object.keys(corps)).to.deep.equal(["widget-a"]);
    expect(corps["widget-a"].ran).to.equal(1);
  });

  it("re-running with the same solver commission updates (does not duplicate) and runs again", () => {
    runCommissionHost(registry, [widgetCommission("widget-a")], 1);
    const first = commissionedCorpsOfKind<WidgetCorp>("widget")["widget-a"];
    runCommissionHost(registry, [widgetCommission("widget-a")], 2);
    const second = commissionedCorpsOfKind<WidgetCorp>("widget")["widget-a"];
    expect(second).to.equal(first);
    expect(second.ran).to.equal(2);
  });

  it("demobilizes a solver corp once its commission vanishes from the union", () => {
    runCommissionHost(registry, [widgetCommission("widget-a")], 1);
    expect(Object.keys(commissionedCorpsOfKind("widget"))).to.have.length(1);
    runCommissionHost(registry, [], 2); // solver no longer commissions it
    expect(Object.keys(commissionedCorpsOfKind("widget"))).to.have.length(0);
  });

  it("commissions of UNREGISTERED kinds are skipped (the pre-flip no-op)", () => {
    resetCorpKinds(); // widget no longer registered; host re-adds only scout/reservation/tender
    runCommissionHost(registry, [widgetCommission("widget-a")], 1);
    expect(getCorpKind("widget")).to.equal(undefined);
    expect(Object.keys(commissionedCorpsOfKind("widget"))).to.have.length(0);
  });

  it("a solver corp and an auxiliary corp coexist - neither demobilizes the other", async () => {
    // Stand up one scout (auxiliary) by giving the host a spawn to propose over.
    const { scoutKind } = await import("../../../src/corps/kinds/scoutKind");
    registerCorpKind(scoutKind as never);
    Game.spawns = { Spawn1: { id: "spawn1", pos: { x: 5, y: 5, roomName: "W0N0" } } } as never;

    runCommissionHost(registry, [widgetCommission("widget-a")], 1);
    expect(Object.keys(commissionedCorpsOfKind("widget"))).to.have.length(1);
    expect(Object.keys(commissionedCorpsOfKind("scout"))).to.have.length(1);

    // Another tick: both still present (solver set + auxiliary set both honored).
    runCommissionHost(registry, [widgetCommission("widget-a")], 2);
    expect(Object.keys(commissionedCorpsOfKind("widget"))).to.have.length(1);
    expect(Object.keys(commissionedCorpsOfKind("scout"))).to.have.length(1);
  });
});
