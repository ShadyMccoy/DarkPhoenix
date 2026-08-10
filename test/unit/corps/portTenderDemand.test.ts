/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { LinkCorp } from "../../../src/corps/LinkCorp";
import { agendaWhy, planAcquisitions, SpawnDemand, SpawnDemandContext } from "../../../src/spawn/SpawnScheduler";
import { PORT_TENDER_PARTS } from "../../../src/economy/primitives";

/**
 * THE PORT TENDER'S DEMAND MUST BE FUNDABLE (incident t72865978).
 *
 * `portDemands` built its SpawnDemand through an `as SpawnDemand` cast and
 * omitted BOTH required cost fields. Every funding comparison in the scheduler
 * is a numeric `>=` against them, and `x >= undefined` is false, so:
 *
 *   - `energyAvailable >= minCost` never fires -> the demand never buys;
 *   - `canEverAfford = energyCapacity >= minCost` is false -> the walk records
 *     gate "impossible", the verdict reserved for a body the RCL can NEVER
 *     build;
 *   - `minCost > energyAvailable` is ALSO false, so `buildAgendaQueue` publishes
 *     no `bank>=N` precondition - which is what blinded the two instruments
 *     built to catch a wedged spawn. S3 printed "(holding/funding - not a
 *     stall)" and `classifySpawnIdle` booked every idle tick as "hold", a
 *     CHOSEN wait.
 *
 * Measured live: the demand sat at the head of BOTH spawn queues for 1804+
 * ticks, the flight recorder fired on it 16/16 times (twice at bank 5600 =
 * the room's full capacity), and no port tender ever spawned - while the plan
 * routed 80 e/t through the two ports it was supposed to drain and priced its
 * body via `portTenderSpawnLoad`.
 */

const ROOM = "W1N1";
const CAPACITY = 5600;

function mkLink(id: string, x: number, y: number): any {
  return {
    id,
    structureType: "link",
    room: undefined as any,
    pos: {
      x,
      y,
      roomName: ROOM,
      getRangeTo: (o: any) => Math.max(Math.abs(o.x - x), Math.abs(o.y - y)),
      findInRange: (_t: number, _r: number, _o?: any) => [] as any[]
    }
  };
}

function mkContainer(x: number, y: number): any {
  return {
    id: `container-${x}-${y}`,
    structureType: "container",
    pos: {
      x,
      y,
      roomName: ROOM,
      getRangeTo: (o: any) => Math.max(Math.abs(o.x - x), Math.abs(o.y - y))
    },
    store: { energy: 0, getFreeCapacity: () => 2000 }
  };
}

/** A room with ONE deposit port: a link with a buffer container beside it, and
 *  no storage/controller so the feeder half of the demand surface stays out of
 *  the way (its gates return early - the port half is independent by design). */
function mkPortedRoom(): any {
  const link = mkLink("port-link", 25, 25);
  const buffer = mkContainer(26, 25);
  link.pos.findInRange = (_t: number, range: number, o?: any) => {
    const near = link.pos.getRangeTo(buffer.pos) <= range ? [buffer] : [];
    return o?.filter ? near.filter(o.filter) : near;
  };
  const room: any = {
    name: ROOM,
    controller: undefined,
    storage: undefined,
    energyCapacityAvailable: CAPACITY,
    getTerrain: () => ({ get: () => 0 }),
    find: (_t: number, o?: any) => (o?.filter ? [link].filter(o.filter) : [link])
  };
  link.room = room;
  return room;
}

describe("port tender demand (incident t72865978)", () => {
  let demands: SpawnDemand[];
  const ctx: SpawnDemandContext = { energyCapacity: CAPACITY, tick: 1000 };

  beforeEach(() => {
    (global as any).FIND_MY_STRUCTURES = 108;
    (global as any).FIND_STRUCTURES = 107;
    (global as any).STRUCTURE_LINK = "link";
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).STRUCTURE_ROAD = "road";
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).TERRAIN_MASK_WALL = 1;
    const room = mkPortedRoom();
    const spawn: any = { id: "spawn1", room, pos: { x: 20, y: 20, roomName: ROOM } };
    (global as any).Game = {
      time: 1000,
      creeps: {},
      rooms: { [ROOM]: room },
      getObjectById: (id: string) => (id === "spawn1" ? spawn : null)
    };
    (global as any).Memory = { rooms: {} };
    const corp = new LinkCorp(`${ROOM}-controllerFeeder`, "spawn1");
    demands = corp.getSpawnDemand(ctx).filter(d => d.role === "porttender");
  });

  it("emits one port tender demand for an unstaffed port", () => {
    expect(demands).to.have.length(1);
  });

  it("carries FINITE costs - the funding comparison must be evaluable", () => {
    const d = demands[0];
    expect(Number.isFinite(d.minCost), `minCost was ${String(d.minCost)}`).to.equal(true);
    expect(Number.isFinite(d.desiredCost), `desiredCost was ${String(d.desiredCost)}`).to.equal(true);
    expect(d.minCost).to.be.greaterThan(0);
  });

  it("is affordable at the room's capacity - never gate 'impossible'", () => {
    const plan = planAcquisitions(demands, {
      energyAvailable: CAPACITY,
      energyCapacity: CAPACITY,
      energyIncome: 10,
      tick: 1000
    });
    const head = plan.agenda[0];
    expect(head.gate, "the port tender was unbuildable at FULL capacity").to.not.equal("impossible");
    expect(head.gate).to.equal("buy");
  });

  it("publishes a bank>=N precondition when the bank is short, so the idle classifier sees 'bank'", () => {
    const plan = planAcquisitions(demands, {
      energyAvailable: 50,
      energyCapacity: CAPACITY,
      energyIncome: 10,
      tick: 1000
    });
    expect(plan.agenda[0].precondition, "no precondition => idle books as a CHOSEN wait").to.equal(
      `bank>=${demands[0].minCost}`
    );
  });

  it("asks for the body the plan prices (PORT_TENDER_PARTS at the tanker gait)", () => {
    // desiredCost buys exactly the priced standing body - F1/F2 compare the
    // plan's port-tender line against what this demand actually builds.
    expect(demands[0].desiredCost).to.equal(PORT_TENDER_PARTS * 50);
  });

  it("declares why='infra' rather than falling through to 'consume' (spec 35 phase D)", () => {
    expect(agendaWhy(demands[0])).to.equal("infra");
  });
});
