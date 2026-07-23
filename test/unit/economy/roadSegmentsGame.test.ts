/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { collectTrunkRoutes, homeBankSupply } from "../../../src/economy/roadSegmentsGame";
import { aggregateTrunkRoadSinks, ConstructionRecord } from "../../../src/economy/roadSegments";
import { WARCHEST_TARGET, bankSurplusRate } from "../../../src/economy/bank";

/**
 * The receipts-gated wiring for trunk A/Z aggregation. CLAUDE.md trap: no
 * integration-trio world stages roadRoutes receipts, so this decode "can pass
 * for the wrong reason" untested. These pin the tiles3 decode (SOURCE->HOME
 * order), the active-route gate (paved/declined/in-room skipped), cross-room
 * dedup, and the source-rate resolver - with a mock Game.
 */
describe("collectTrunkRoutes (roadRoutes receipt decode)", () => {
  let saved: any;
  beforeEach(() => {
    saved = (global as any).Game;
  });
  afterEach(() => {
    (global as any).Game = saved;
  });

  /** Stage one room's memory.roadRoutes. */
  function stageGame(roadRoutesByRoom: Record<string, any>): void {
    const rooms: any = {};
    for (const roomName in roadRoutesByRoom) {
      rooms[roomName] = { memory: { roadRoutes: roadRoutesByRoom[roomName] } };
    }
    (global as any).Game = { rooms };
  }

  it("decodes tiles3 into SOURCE->HOME ordered tiles with the source's mine rate", () => {
    // tiles3 = (x,y,roomIdx) triples; rooms = ["W2N2","W1N1"]. Ordered from the
    // source end (as planTrunkPath produces: source -> depot).
    stageGame({
      W1N1: {
        cedc: {
          tiles3: [5, 10, 0, 6, 10, 0, 7, 10, 1],
          rooms: ["W2N2", "W1N1"]
        }
      }
    });
    const routes = collectTrunkRoutes(id => (id === "cedc" ? 10 : undefined));
    expect(routes).to.have.length(1);
    expect(routes[0].sourceId).to.equal("cedc");
    expect(routes[0].sourceRate).to.equal(10);
    expect(routes[0].tiles).to.deep.equal([
      { x: 5, y: 10, roomName: "W2N2" },
      { x: 6, y: 10, roomName: "W2N2" },
      { x: 7, y: 10, roomName: "W1N1" }
    ]);
  });

  it("skips paved, declined, and in-room (no tiles3) routes - only ACTIVE trunks aggregate", () => {
    stageGame({
      W1N1: {
        paved1: { tiles3: [1, 1, 0], rooms: ["W1N1"], paved: true },
        declined1: { tiles3: [2, 2, 0], rooms: ["W1N1"], declined: true },
        inroom1: { tiles: [3, 3, 4, 4] }, // legacy in-room format, no tiles3
        active1: { tiles3: [8, 8, 0, 9, 9, 0], rooms: ["W1N1"] }
      }
    });
    const routes = collectTrunkRoutes(() => 10);
    expect(routes.map(r => r.sourceId)).to.deep.equal(["active1"]);
  });

  it("dedups a route keyed in two rooms' memory (built once, attributed once)", () => {
    const entry = { tiles3: [1, 1, 0, 2, 2, 0], rooms: ["W1N1"] };
    stageGame({ W1N1: { shared: entry }, W2N2: { shared: entry } });
    const routes = collectTrunkRoutes(() => 10);
    expect(routes).to.have.length(1);
  });

  it("falls back to 10 e/t for an unknown source (still-analyzing remote)", () => {
    stageGame({ W1N1: { newbie: { tiles3: [1, 1, 0], rooms: ["W1N1"] } } });
    const routes = collectTrunkRoutes(() => undefined);
    expect(routes[0].sourceRate).to.equal(10);
  });

  it("no Game / no rooms -> empty (harness safety)", () => {
    (global as any).Game = undefined;
    expect(collectTrunkRoutes(() => 10)).to.deep.equal([]);
    (global as any).Game = { rooms: {} };
    expect(collectTrunkRoutes(() => 10)).to.deep.equal([]);
  });
});

describe("homeBankSupply (bank-surplus draw across owned storages)", () => {
  let saved: any;
  beforeEach(() => {
    saved = (global as any).Game;
  });
  afterEach(() => {
    (global as any).Game = saved;
  });

  it("takes the largest surplus draw across owned storages", () => {
    const banked = WARCHEST_TARGET + 100_000;
    (global as any).Game = {
      rooms: {
        W1N1: { storage: { my: true, store: { energy: banked } } },
        W2N2: { storage: { my: true, store: { energy: WARCHEST_TARGET + 10_000 } } },
        W3N3: { storage: { my: false, store: { energy: 999_999 } } } // not ours: ignored
      }
    };
    expect(homeBankSupply()).to.be.closeTo(bankSurplusRate(banked), 1e-9);
  });

  it("zero while the warchest is still filling (no surplus, source owns the road)", () => {
    (global as any).Game = { rooms: { W1N1: { storage: { my: true, store: { energy: 10_000 } } } } };
    expect(homeBankSupply()).to.equal(0);
  });

  it("no storage anywhere -> 0", () => {
    (global as any).Game = { rooms: { W1N1: {} } };
    expect(homeBankSupply()).to.equal(0);
  });
});

/**
 * END-TO-END receipt -> aggregate (the cedc incident t72505602 in miniature):
 * a staged trunk with 20 standing road sites + a bank surplus, run through the
 * REAL decode+split+aggregate pipeline, collapses to exactly 2 sinks. This is
 * the receipts-gated acceptance the integration trio structurally cannot give
 * (it stages no roadRoutes). It reproduces the shape whose plan carried 20
 * micro hauler-edges from one source.
 */
describe("receipt->aggregate pipeline (cedc micro-hauler incident, staged)", () => {
  let saved: any;
  beforeEach(() => {
    saved = (global as any).Game;
  });
  afterEach(() => {
    (global as any).Game = saved;
  });

  it("collapses a 20-tile trunk's per-site sinks to one Z + one A (no micro-haulers)", () => {
    // 20 road tiles along a corridor in W42N23 (the remote), ordered
    // SOURCE(x=5) -> HOME(x=24); index 0 nearest the mine.
    const tiles3: number[] = [];
    for (let x = 5; x < 25; x++) tiles3.push(x, 30, 0);
    (global as any).Game = {
      rooms: {
        W43N23: {
          // home room owns the route receipt + the banked surplus
          storage: { my: true, store: { energy: WARCHEST_TARGET + 100_000 } },
          memory: { roadRoutes: { cedc: { tiles3, rooms: ["W42N23"] } } }
        }
      }
    };
    // The 20 standing road construction sites (the project ledger's shape).
    const records: ConstructionRecord[] = [];
    for (let x = 5; x < 25; x++) {
      records.push({ id: `site-${x}`, x, y: 30, roomName: "W42N23", structureType: "road", remaining: 300 });
    }

    const routes = collectTrunkRoutes(() => 10); // cedc mines 10 e/t
    const admitted = aggregateTrunkRoadSinks(records, routes, homeBankSupply());

    // 20 sinks -> 2. The plan will now emit ONE source->Z edge, not 20.
    expect(admitted).to.have.length(2);
    expect(admitted.map(a => a.id).sort()).to.deep.equal(["road-A-cedc", "road-Z-cedc"]);
    const z = admitted.find(a => a.id === "road-Z-cedc")!;
    const a = admitted.find(a => a.id === "road-A-cedc")!;
    expect(z.roomName).to.equal("W42N23"); // Z sits at the mine end (source room)
    expect(z.x, "Z at the mine-most tile").to.equal(5);
    // total work conserved across the split
    expect(z.remaining + a.remaining).to.equal(20 * 300);
    // home is deep in surplus so it owns most of the road; the source owns a
    // proportional near-end slice (both crews get a segment).
    expect(z.remaining).to.be.greaterThan(0);
    expect(a.remaining).to.be.greaterThan(z.remaining);
  });
});
