/**
 * @fileoverview ReservationCorp - keeps the controllers of remote rooms we mine
 * reserved, so their sources regenerate the full 3000 (10 e/tick) instead of the
 * unreserved 1500 (5 e/tick).
 *
 * This is the one genuinely room-specific part of remote mining: a source in an
 * unowned room is throttled to half output unless we hold its controller. A
 * reserver (CLAIM + MOVE) parks on the controller and reserves it continuously.
 *
 * TARGETING IS COMMISSION-OWNED and vision-free. The kind's propose() derives
 * target rooms from the draft plan's remote harvest commissions ("the plan
 * mines this room" - durable across miner deaths), and materialize() refreshes
 * them here every round, exactly like spawnId. At runtime the targets are
 * gated by the shared reservability lens (isReservableRoom: live vision when
 * available, scout intel otherwise). Both work() and getSpawnDemand() read the
 * SAME reservableTargets() - the staffsPost-symmetry rule.
 *
 * NEVER key targeting to live creep positions: "a miner is standing there this
 * tick" flaps on every miner death, and the dead miner takes the room's vision
 * with it. Measured live (shard1 t72378345): an in-flight reserver's target
 * was revoked mid-route the tick its remote's miner died; the 1300-energy
 * creep idled out its CLAIM lifetime while the room's reservation decayed, and
 * the corp churned 10 reserver spawns in 2400 ticks.
 *
 * @module corps/ReservationCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { RESERVATION_REFRESH_FLOOR } from "./economics";
import { hostileRooms, isReservableRoom, myReservationTicksLeft } from "../utils/RoomDiscovery";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { Position } from "../types/Position";
import { buildReserverBody } from "../spawn/BodyBuilder";
import { travelTo } from "./movement";

/**
 * Serialized state specific to ReservationCorp.
 */
export interface SerializedReservationCorp extends SerializedCorp {
  spawnId: string;
  /** Commission-owned planned remotes; refreshed by materialize every round. */
  targetRooms?: string[];
}

/**
 * ReservationCorp manages reserver creeps that hold remote controllers.
 */
export class ReservationCorp extends Corp {
  private spawnId: string;
  private targetRooms: string[] = [];

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("reservation", nodeId, customId);
    this.spawnId = spawnId;
  }

  public getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Rebind to the commission's CURRENT spawn. The spawn id is commission-owned
   * state: a persisted corp outlives spawns (measured live: an immortal
   * upgrade/construction corp carried a dead spawn's id for good, so
   * collectDemands dropped its demands forever - 0 upgraders/builders while
   * the plan begged for them). Every kind's materialize() refreshes this.
   */
  public setSpawnId(spawnId: string): void {
    this.spawnId = spawnId;
  }

  /**
   * Rebind to the commission's CURRENT target rooms - the remote rooms the
   * draft plan mines. Commission-owned like spawnId: materialize() refreshes
   * this every round, so targets follow the plan (a closed mine drops out, a
   * newly opened remote joins) instead of following creep positions.
   */
  public setTargetRooms(rooms: string[]): void {
    this.targetRooms = [...rooms];
  }

  public getTargetRooms(): string[] {
    return [...this.targetRooms];
  }

  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "reserve" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * The rooms currently worth holding: the plan's remotes (targetRooms), gated
   * by the vision-free reservability lens. THE single lens for this corp -
   * work() assigns from it and getSpawnDemand() prices from it, so an
   * assignment the demand side paid for can never be revoked by a different
   * predicate on the work side (the staffsPost-symmetry rule).
   */
  private reservableTargets(myUsername: string | undefined): string[] {
    return this.targetRooms.filter(r => isReservableRoom(r, myUsername));
  }

  /**
   * Every living reserver this corp owns, INCLUDING spawning newborns and ones
   * work() has not assigned yet. The demand lens - and only the demand lens -
   * counts with this (work() correctly uses getActiveCreeps: a spawning creep
   * cannot move). Excluding newborns here was the purchase loop.
   */
  private countLivingReservers(): number {
    let n = 0;
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c.memory.corpId === this.id && c.memory.workType === "reserve") n++;
    }
    return n;
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    // Needy rooms first (lowest banked reservation) so a freed/new reserver
    // covers the room closest to losing its 3000 rate - same intel lens as
    // the demand gate (duty cycle, spec 15 P5), so assignment can never
    // prefer a room the buy side considers banked. Durable ordering: banks
    // decay 1/tick for every room alike, so this never flaps on deaths.
    const me = spawn.owner?.username;
    const targets = this.reservableTargets(me).sort(
      (a, b) => myReservationTicksLeft(a, me) - myReservationTicksLeft(b, me)
    );
    const covered = new Set<string>();

    for (const creep of this.getActiveCreeps()) {
      let target = creep.memory.targetRoom;
      // (Re)assign only when the PLAN moved: the creep has no target, its
      // target left the plan / became unreservable per intel, or another
      // reserver already covers it. A miner dying or vision dropping does NOT
      // change `targets`, so an in-flight reserver keeps its assignment.
      if (!target || !targets.includes(target) || covered.has(target)) {
        target = targets.find(r => !covered.has(r));
        creep.memory.targetRoom = target;
      }
      if (!target) continue; // nothing to reserve right now - idle until reassigned
      covered.add(target);
      this.runReserver(creep, target);
    }
  }

  /** Walk to the target room's controller and hold the reservation. */
  private runReserver(creep: Creep, targetRoom: string): void {
    if (creep.room.name !== targetRoom) {
      travelTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        visualizePathStyle: { stroke: "#88aaff" }
      });
      return;
    }
    const controller = creep.room.controller;
    if (!controller) return;
    if (creep.pos.isNearTo(controller)) {
      creep.reserveController(controller);
    } else {
      creep.moveTo(controller, { range: 1, visualizePathStyle: { stroke: "#88aaff" } });
    }
  }

  /**
   * Request one reserver while a target room lacks one. Reservers are an income
   * optimisation (they lift a remote source from 1500 to 3000), so they rank
   * below the core mining/hauling that produces the base income, and are only
   * requested for rooms the plan already mines. Gated by affordability: CLAIM
   * costs 600, so a low-capacity room asks for nothing until it can build one.
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    // DEFENSE ECONOMICS (owner 2026-07-10): don't send reservers into rooms
    // held by hostiles (sighted, or inside a sighted hostile's TTL bound).
    // Demand-side only: an already-fielded reserver runs out (v1 doctrine).
    const danger = hostileRooms();
    const targets = this.reservableTargets(spawn.owner?.username).filter(r => !danger.has(r));
    if (targets.length === 0) {
      this.lastSizing = { tick: ctx.tick, gate: "no-targets" };
      return [];
    }

    // THE DUTY CYCLE (spec 15 P5): a room whose banked reservation still sits
    // above the refresh floor needs no reserver - reservation accumulates to
    // 5000 and decays 1/tick, so the corp coasts on the bank and buys one
    // stint per ~1080 ticks (the ~0.5 duty reserverTollPerRoom always priced).
    // Read from the intel-stamped bound (exact while blind), never vision.
    const banks: { [room: string]: number } = {};
    for (const r of targets) banks[r] = myReservationTicksLeft(r, spawn.owner?.username);
    const needy = targets.filter(r => banks[r] < RESERVATION_REFRESH_FLOOR);
    if (needy.length === 0) {
      this.lastSizing = { tick: ctx.tick, gate: "reservation-banked", targets: targets.length, banks };
      return [];
    }

    // Coverage by COUNT of every LIVING corp reserver - spawning newborns and
    // not-yet-assigned ones included. work() guarantees each living reserver
    // ends up covering one distinct target (it reassigns duplicates and
    // plan-orphans), so the count IS coverage. Counting only assigned actives
    // here was the reserver purchase loop (live, t72401489+: the banked
    // mustFund demand re-fired throughout every 24-tick build, 4x1300 energy
    // in ~90t) - the staffsPost-symmetry trap: the demand lens must see the
    // newborns its own purchases create.
    const staffed = this.countLivingReservers();
    this.lastSizing = {
      tick: ctx.tick,
      gate: staffed >= needy.length ? "staffed" : "demand",
      targets: targets.length,
      needy: needy.length,
      staffed,
      banks
    };
    if (staffed >= needy.length) return [];

    const body = buildReserverBody(ctx.energyCapacity, 2);
    if (body.cost === 0) return []; // cannot afford a CLAIM yet

    return [
      {
        buyerCorpId: this.id,
        role: "reserver",
        // Reservation doubles a remote source (+~5 e/tick for a 650 claimer that
        // lasts 600 ticks), the best marginal energy investment on the board:
        // above the scaling haulers' band (90-110) - the Nth hauler moves a
        // sliver of throughput, the reserver doubles the source itself. It
        // still sits below every BLOCKING demand (first miners/haulers,
        // 1e4 tier), so income units open before their remote gets doubled.
        // Measured (grid T5 + diag-reserver): at 92 the reserver starved
        // FOREVER behind hauler churn - even inside the starved tier the
        // 110-value haulers out-ranked it and re-armed after every spawn.
        value: 115,
        blocking: false,
        producesIncome: true, // a reserved source delivers twice the energy
        // Bank for the reserver when it tops the ranking: its body is
        // indivisible (CLAIM 600 floor), so without a hold every cheaper
        // hauler eats the bank first and the ranking is moot (measured,
        // diag-reserver). Scoped to this demand - a blanket income hold
        // measurably cost ~12% mined energy in the two-source A/B.
        holdToFund: true,
        desiredCost: body.cost,
        minCost: body.cost,
        since: 0,
        bodyParam: body.claimParts
      }
    ];
  }

  public getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  public serialize(): SerializedReservationCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId,
      targetRooms: [...this.targetRooms]
    };
  }

  public deserialize(data: SerializedReservationCorp): void {
    super.deserialize(data);
    this.spawnId = data.spawnId ?? this.spawnId;
    this.targetRooms = data.targetRooms ?? [];
  }
}
