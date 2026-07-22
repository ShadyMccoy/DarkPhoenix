/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import {
  ConstructionCorp,
  PROJECT_LEDGER_DECAY,
  ProjectRecord,
  constructionProjectLedger
} from "../../../src/corps/ConstructionCorp";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

/**
 * THE PROJECT-LEDGER PATTERN (owner 2026-07-22: "The construction sites
 * should be part of the corps memory so it can rehydrate and bypass Vision.
 * That's a general pattern we should work towards - similar to staffsPost").
 * Three rules pinned here:
 * 1. A corp's decisions-facing world state lives in its SERIALIZED memory.
 * 2. Vision only RECONCILES the ledger (ground truth wins on sight; blind
 *    rooms persist; long-blind records decay - hostiles stomp sites).
 * 3. ONE LENS: constructionProjectLedger reads the serialized store in
 *    Memory - never Game.rooms - so the plan's sink set cannot flap with
 *    whichever room happened to be sighted at solve time (measured
 *    t72489078: 15 sinks -> 0 across two captures).
 */
describe("ConstructionCorp project ledger (observe-and-remember)", () => {
  beforeEach(() => {
    setupGlobals();
    resetGovernor();
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    Game.creeps = {};
    Game.rooms = {} as any;
    Game.getObjectById = () => null;
    (Memory as any).commissionedCorps = undefined;
  });

  afterEach(() => {
    Game.rooms = {} as any;
    (Memory as any).commissionedCorps = undefined;
  });

  const site = (id: string, x: number, y: number, remaining: number): any => ({
    id,
    pos: { x, y },
    structureType: "road",
    progressTotal: 300,
    progress: 300 - remaining
  });

  const mkRoom = (name: string, sites: any[]): any => ({
    name,
    find: (t: number) => (t === 114 ? sites : [])
  });

  it("records sighted sites, keeps blind rooms' records, and lets ground truth remove gone sites", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    Game.rooms = { W1N0: mkRoom("W1N0", [site("a", 5, 5, 300), site("b", 6, 5, 100)]) } as any;
    corp.reconcileProjects(1000);
    expect((corp as any).projects).to.have.length(2);

    // The room goes BLIND: records persist verbatim.
    Game.rooms = {} as any;
    corp.reconcileProjects(1500);
    expect((corp as any).projects, "blind room keeps its records").to.have.length(2);

    // Sight returns with one site built away: ground truth wins.
    Game.rooms = { W1N0: mkRoom("W1N0", [site("b", 6, 5, 40)]) } as any;
    corp.reconcileProjects(2000);
    const recs = (corp as any).projects as ProjectRecord[];
    expect(recs).to.have.length(1);
    expect(recs[0].id).to.equal("b");
    expect(recs[0].remaining, "progress refreshed on sight").to.equal(40);
  });

  it("retires records unseen for PROJECT_LEDGER_DECAY (hostiles stomp sites while we are blind)", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    Game.rooms = { W1N0: mkRoom("W1N0", [site("a", 5, 5, 300)]) } as any;
    corp.reconcileProjects(1000);
    Game.rooms = {} as any;
    corp.reconcileProjects(1000 + PROJECT_LEDGER_DECAY);
    expect((corp as any).projects).to.have.length(1);
    corp.reconcileProjects(1001 + PROJECT_LEDGER_DECAY);
    expect((corp as any).projects, "one tick past decay: retired").to.have.length(0);
  });

  it("THE ONE LENS: constructionProjectLedger reads the serialized store from Memory, dedupes, and needs NO vision", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    Game.rooms = { W1N0: mkRoom("W1N0", [site("a", 5, 5, 300), site("done", 7, 5, 0)]) } as any;
    corp.reconcileProjects(1000);

    // Serialize into the store shape CommissionHost persists, then go BLIND.
    (Memory as any).commissionedCorps = {
      "construction-W1N1": { kind: "construction", commission: {}, corp: corp.serialize() },
      "construction-W9N9": {
        kind: "construction",
        commission: {},
        corp: { ...corp.serialize(), projects: [{ id: "a", x: 5, y: 5, roomName: "W1N0", structureType: "road", remaining: 300, seen: 900 }] }
      },
      "upgrade-W1N1": { kind: "upgrade", commission: {}, corp: {} }
    };
    Game.rooms = {} as any;

    const ledger = constructionProjectLedger();
    expect(ledger, "deduped by site id across corps; zero-remaining filtered").to.have.length(1);
    expect(ledger[0].id).to.equal("a");
    expect(ledger[0].roomName).to.equal("W1N0");
    expect(ledger[0].remaining).to.equal(300);
  });

  it("round-trips through serialize/deserialize (rehydrates after a global reset)", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    Game.rooms = { W1N0: mkRoom("W1N0", [site("a", 5, 5, 250)]) } as any;
    corp.reconcileProjects(1000);
    const back = new ConstructionCorp("W1N1-construction", "spawn1");
    back.deserialize(JSON.parse(JSON.stringify(corp.serialize())));
    expect((back as any).projects).to.have.length(1);
    expect((back as any).projects[0].remaining).to.equal(250);
  });
});
