/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { setupGlobals, Game as MockGame, STRUCTURE_CONTAINER, WORK } from "../mock";
import { UpgradingCorp } from "../../../src/corps/UpgradingCorp";

/**
 * Per-tick behaviour of a PARKED, container-fed upgrader - the "does the WORK
 * part actually fire every tick" question the fleet-sizing tests don't touch.
 *
 * The regression this pins: the parked upgrader used a collect/deposit
 * oscillation (working ? upgrade : draw), so when its buffer drained to 0 it
 * spent one whole tick WITHDRAWING with the WORK parts idle before resuming.
 * That is one wasted WORK tick per drain cycle - ~11% of throughput on a
 * WORK-heavy body whose tiny buffer drains in a handful of ticks (the live
 * 2026-07-17 sighting). A container-fed upgrader must top up AND upgrade in the
 * same tick (the canonical static-upgrader idiom: withdraw and upgradeController
 * are independent intents), so the buffer never goes dry and every tick upgrades.
 *
 * The mock reproduces Screeps intent semantics: reads see the START-of-tick
 * store, and withdraw/upgrade are applied together at tick end. That is what
 * lets the oscillation strand a WORK tick, and what the fix must survive.
 */

const ROOM = "W1N1";
const SPAWN_ID = "spawn1";
const CORP_ID = "upgrading-W1N1";

/** Chebyshev distance, as Screeps' getRangeTo uses. */
const cheb = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A store-bearing container the parked upgrader draws from. */
interface Box {
  structureType: string;
  pos: { x: number; y: number; roomName: string };
  store: { [r: string]: number };
}

/**
 * A parked upgrader with queued-intent accounting: upgradeController and
 * withdraw both read the start-of-tick store and record their effect; commit()
 * applies them together and reports whether the WORK part fired this tick.
 */
class MockUpgrader {
  public name = "u1";
  public spawning = false;
  public memory: any;
  public store: { [r: string]: number } & { getFreeCapacity: () => number; getCapacity: () => number };
  public pos: any;
  private readonly capacity: number;
  private readonly workParts: number;
  private pendingUpgrade = 0;
  private pendingWithdraw = 0;
  /** True on ticks upgradeController(OK) fired - the throughput signal under test. */
  public upgradedThisTick = false;
  /** Count of withdraw/pickup intents issued - the CPU signal (0.2 CPU each). */
  public drawCount = 0;

  public constructor(x: number, y: number, energy: number, capacity: number, workParts: number) {
    this.capacity = capacity;
    this.workParts = workParts;
    this.memory = { corpId: CORP_ID, workType: "upgrade", working: true, upgradeSpot: { x, y } };
    const self = this;
    this.store = {
      energy,
      getFreeCapacity: () => self.capacity - self.store.energy,
      getCapacity: () => self.capacity
    } as any;
    this.pos = {
      x,
      y,
      roomName: ROOM,
      isEqualTo: (t: { x: number; y: number }) => t.x === self.pos.x && t.y === self.pos.y,
      getRangeTo: (t: { x: number; y: number }) => cheb(self.pos, t),
      findInRange: () => [] // no scattered ground piles in this scenario
    };
  }

  public getActiveBodyparts(part: string): number {
    return part === WORK ? this.workParts : 1;
  }

  public upgradeController(controller: any): number {
    if (this.pos.getRangeTo(controller.pos) > 3) return (global as any).ERR_NOT_IN_RANGE;
    if (this.workParts === 0) return -12; // ERR_NO_BODYPART
    if (this.store.energy <= 0) return -6; // ERR_NOT_ENOUGH_RESOURCES
    this.pendingUpgrade = Math.min(this.workParts, this.store.energy);
    return (global as any).OK;
  }

  public withdraw(target: Box, resource: string): number {
    const free = this.capacity - this.store.energy;
    if (free <= 0) return -8; // ERR_FULL
    const avail = target.store[resource] ?? 0;
    if (avail <= 0) return -6; // ERR_NOT_ENOUGH_RESOURCES
    this.pendingWithdraw = Math.min(free, avail);
    (target as any).__debit = this.pendingWithdraw;
    this.drawCount += 1;
    return (global as any).OK;
  }

  public pickup(): number {
    this.drawCount += 1;
    return (global as any).OK;
  }

  /** Apply this tick's queued intents; return the container debit to settle. */
  public commit(box: Box): void {
    const start = this.store.energy;
    this.upgradedThisTick = this.pendingUpgrade > 0;
    box.store.energy -= this.pendingWithdraw;
    this.store.energy = start - this.pendingUpgrade + this.pendingWithdraw;
    this.pendingUpgrade = 0;
    this.pendingWithdraw = 0;
  }
}

/** A controller with a container buffer within upgrade range, on plain terrain. */
function makeWorld(box: Box, cx: number, cy: number) {
  const room: any = {
    name: ROOM,
    memory: {},
    getTerrain: () => ({ get: () => 0 })
  };
  const controller: any = {
    id: "controller-1",
    level: 2,
    room,
    pos: {
      x: cx,
      y: cy,
      roomName: ROOM,
      findInRange: (type: number, range: number, o: any) => {
        const list = type === (global as any).FIND_STRUCTURES ? [box] : [];
        const within = list.filter(s => cheb({ x: cx, y: cy }, s.pos) <= range);
        return o?.filter ? within.filter(o.filter) : within;
      }
    }
  };
  room.controller = controller;
  const spawn: any = { id: SPAWN_ID, spawning: false, room, pos: { x: cx, y: cy, roomName: ROOM } };
  return { room, controller, spawn };
}

describe("UpgradingCorp per-tick behaviour (parked, container-fed)", () => {
  let savedGame: any;

  beforeEach(() => {
    setupGlobals();
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).STRUCTURE_LINK = "link";
    (global as any).FIND_DROPPED_RESOURCES = 106;
    savedGame = (global as any).Game;
  });

  afterEach(() => {
    (global as any).Game = savedGame ?? { ...MockGame, creeps: {}, time: 100 };
  });

  it("upgrades EVERY tick across a full buffer drain - no wasted WORK tick refilling", () => {
    // Controller at (25,10); container buffer at (25,12) (range 2 => the input
    // spot). Parking tile (24,11) rings it and is within upgrade range 3.
    const box: Box = { structureType: STRUCTURE_CONTAINER, pos: { x: 25, y: 12, roomName: ROOM }, store: { energy: 4000 } };
    const { spawn, controller } = makeWorld(box, 25, 10);

    // WORK-heavy, tiny buffer (6 WORK, 50 capacity): drains in ~8 ticks, so a
    // 30-tick run crosses the empty boundary ~3 times. A 4W/4C body starting at
    // 200 (the existing grid cell) never drains here - that is why it misses this.
    const creep = new MockUpgrader(24, 11, 50, 50, 6);

    (global as any).Game = {
      ...MockGame,
      time: 100,
      creeps: { u1: creep },
      getObjectById: (id: string) => (id === SPAWN_ID ? spawn : null)
    };

    const corp = new UpgradingCorp(`${ROOM}-upgrading`, SPAWN_ID, CORP_ID);

    const fired: boolean[] = [];
    const startEnergies: number[] = [];
    for (let t = 0; t < 30; t++) {
      startEnergies.push(creep.store.energy);
      corp.work(100 + t);
      creep.commit(box);
      fired.push(creep.upgradedThisTick);
    }

    // The invariant: the creep never left its parking tile...
    expect(creep.pos.x).to.equal(24);
    expect(creep.pos.y).to.equal(11);
    // ...the buffer really did drain and refill (so we crossed the boundary the
    // bug lives on, not merely coasted on the initial fill)...
    expect(box.store.energy).to.be.lessThan(4000);
    expect(Math.min(...startEnergies)).to.be.greaterThan(0, "buffer must never start a tick empty");
    // ...and the WORK part fired on EVERY tick (the wasted-tick regression makes
    // at least one tick a pure withdraw with no upgrade).
    const missed = fired.filter(f => !f).length;
    expect(missed).to.equal(0, `upgrader wasted ${missed} WORK tick(s) refilling`);
    // ...WITHOUT withdrawing every tick: each withdraw/pickup intent costs ~0.2
    // CPU, so a container-fed upgrader must batch its draws (top up just-in-time
    // before the buffer can't cover another WORK cycle), not sip every tick.
    // Draining 6/tick from a 50 buffer it refills ~once every 7 ticks (~4 draws in
    // 30) - not the ~29 an every-tick top-up would issue.
    expect(creep.drawCount).to.be.at.least(1, "must actually refill");
    expect(creep.drawCount).to.be.at.most(8, `withdrew on ${creep.drawCount}/30 ticks - draws should batch`);
  });
});
