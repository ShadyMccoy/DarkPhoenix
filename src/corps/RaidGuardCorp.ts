/**
 * @fileoverview RaidGuardCorp - pre-spawned melee guards that keep remote
 * mines flowing through NPC invader raids (spec 13 phase 3).
 *
 * The raid clock makes this cheap: the engine fires a raid only after WE
 * harvest 70k-130k energy in a room (utils/raidMeter mirrors that fuse
 * tick-exactly), so the guard is commissioned at the 65k ARM floor and is
 * standing at the source when the raid walks in. Economics: a 650-energy
 * guard per ~105k harvested (<1% of gross) versus ~1500 ticks of defund
 * blackout per absorbed raid (~10k+ energy) - defense is ~15x cheaper for
 * any remote worth mining. Reactive fallback: a SIGHTED raid (fresh
 * lastRaidSeen + active hostile mark) triggers the same demand for rooms
 * whose counter history we didn't have.
 *
 * MILITARY EXEMPTION (spec 12/13 doctrine): this corp deliberately does NOT
 * gate on hostileRooms() - it exists to enter exactly the rooms the economy
 * flees. The spec-12 defund stays live underneath as the fallback layer for
 * rooms without a guard.
 *
 * Guards are refundable working capital, not a standing army (TooAngel's
 * self-liquidation + Overmind's quiet-period decommission): a guard whose
 * room is no longer targeted waits out a grace window, then recycles at the
 * home spawn, recovering the TTL remainder.
 *
 * @module corps/RaidGuardCorp
 */

import { Corp, SerializedCorp } from "./Corp";
import { INVADER_TTL } from "../economy/primitives";
import { raidMeterState } from "../utils/raidMeter";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { MAX_SCOUT_DISTANCE } from "./CorpConstants";
import { Position } from "../types/Position";
import { buildGuardBody } from "../spawn/BodyBuilder";
import { driveRecycle } from "./recycle";
import { travelTo } from "./movement";

/**
 * Ticks a guard stays posted after its room stops being targeted before it
 * recycles (Overmind decommissions defense after a 100-tick quiet window;
 * shorter windows churn on wave pauses - the 25t spawn-door lesson).
 */
export const GUARD_RECYCLE_GRACE = 100;

/**
 * Engage hostiles only inside this range of the guard; farther ones are
 * coming to us anyway (invader AI hunts creeps, and the post is where the
 * creeps are). 3 = one step outside the invader's melee reach.
 */
export const GUARD_ENGAGE_RANGE = 3;

/**
 * How recently a room must have been harvested for its armed meter to field
 * a guard: two creep lifetimes - wide enough that no single death, re-solve
 * or vision gap un-arms an active mine, narrow enough that a genuinely
 * abandoned room stands its guard down.
 */
export const GUARD_MINED_RECENCY = 3_000;

/**
 * Serialized state specific to RaidGuardCorp.
 */
export interface SerializedRaidGuardCorp extends SerializedCorp {
  spawnId: string;
}

/**
 * RaidGuardCorp manages guard creeps that defend remote mining rooms.
 */
export class RaidGuardCorp extends Corp {
  private spawnId: string;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("raidGuard", nodeId, customId);
    this.spawnId = spawnId;
  }

  public getSpawnId(): string {
    return this.spawnId;
  }

  /** Commission-owned state: every materialize() refreshes this (the stale-spawnId trap). */
  public setSpawnId(spawnId: string): void {
    this.spawnId = spawnId;
  }

  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /** All claimed creeps - INCLUDING recycling ones (recycling counts as staffing). */
  private getActiveCreeps(): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId === this.id && creep.memory.workType === "guard" && !creep.spawning) {
        creeps.push(creep);
      }
    }
    return creeps;
  }

  /**
   * Rooms that currently want a guard, from intel alone - the durable-signal
   * doctrine (the stranded-reserver trap), taken all the way down: NOT live
   * creep positions (flap on every miner death, blind without the dead
   * miner's vision) and NOT the GOAL plan's remote content (measured in
   * def-t4 dev: remotes flap in and out of the plan with home-saturation
   * churn, idling the guard into its recycle grace mid-mission). The signal
   * is the meter's own harvest stamp: raidDebt only grows while we ACTUALLY
   * mine a room, and `lastHarvested` records when we last did.
   *
   * - ARMED (predictive): raidDebt crossed the 65k arm floor and the room
   *   was harvested within GUARD_MINED_RECENCY - the raid can fire any time
   *   after 70k, so commissioning here pre-positions the guard ahead of the
   *   crossing. OVERDUE rooms (>130k, no raid ever seen) disarm - raids
   *   provably don't fire there. A truly abandoned room disarms when its
   *   harvest stamp ages out.
   * - RAID IN PROGRESS (reactive): Invader creeps were sighted within their
   *   1500-tick lifetime and the hostile mark is still live - covers rooms
   *   whose counter history we didn't have (first raid after moving in).
   *
   * Owned rooms are never targeted (towers are the home answer, spec 07),
   * and targets stay inside scouting range of this corp's home.
   */
  public guardTargets(homeRoom: string): string[] {
    if (typeof Memory === "undefined" || !Memory.roomIntel) return [];

    const targets: string[] = [];
    for (const roomName in Memory.roomIntel) {
      if (roomName === homeRoom) continue;
      const intel = Memory.roomIntel[roomName];
      if (!intel) continue;
      if (intel.controllerOwner) continue; // owned rooms never receive raids for us to guard
      if (Game.map.getRoomLinearDistance(homeRoom, roomName) > MAX_SCOUT_DISTANCE) continue;

      const minedRecently =
        intel.lastHarvested !== undefined && Game.time - intel.lastHarvested < GUARD_MINED_RECENCY;
      const armed = raidMeterState(intel.raidDebt) === "armed" && minedRecently;
      const raidInProgress =
        intel.lastRaidSeen !== undefined &&
        Game.time - intel.lastRaidSeen < INVADER_TTL &&
        (intel.hostileUntil ?? 0) > Game.time;

      if (armed || raidInProgress) targets.push(roomName);
    }
    return targets.sort(); // determinism: stable assignment across ticks
  }

  public work(tick: number): void {
    this.lastActivityTick = tick;

    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return;

    const targets = this.guardTargets(spawn.room.name);
    const covered = new Set<string>();

    for (const creep of this.getActiveCreeps()) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
        continue;
      }

      let target = creep.memory.targetRoom;
      if (!target || !targets.includes(target) || covered.has(target)) {
        target = targets.find(r => !covered.has(r));
        creep.memory.targetRoom = target;
      }

      if (!target) {
        // Unassigned: hold the post through a grace window (a raid pause is
        // not a stand-down), then liquidate back into the spawn.
        creep.memory.idleSince = creep.memory.idleSince ?? tick;
        if (tick - creep.memory.idleSince >= GUARD_RECYCLE_GRACE) {
          creep.memory.recycling = true;
        }
        continue;
      }

      delete creep.memory.idleSince;
      covered.add(target);
      this.runGuard(creep, target);
    }
  }

  /**
   * Walk to the target room, then BODYGUARD the post: hold beside the source
   * and engage hostiles only at short range. Never chase across the room -
   * invaders move at guard speed and hunt OUR creeps, so a cross-room chase
   * is an unwinnable stern-chase (measured in the def-t4 cell: kill at the
   * window's literal last tick in one draw, timeout in the next), while
   * holding the post guarantees the fight happens HERE, adjacent, where the
   * guard's 150 dps ends it in ~7 ticks.
   */
  private runGuard(creep: Creep, targetRoom: string): void {
    if (creep.room.name !== targetRoom) {
      travelTo(creep, new RoomPosition(25, 25, targetRoom), {
        range: 20,
        visualizePathStyle: { stroke: "#ff6666" }
      });
      return;
    }

    const hostile = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (hostile && creep.pos.getRangeTo(hostile) <= GUARD_ENGAGE_RANGE) {
      if (creep.attack(hostile) === ERR_NOT_IN_RANGE) {
        travelTo(creep, hostile.pos, { range: 1, visualizePathStyle: { stroke: "#ff6666" } });
      }
      return;
    }

    // Hold the post beside the room's first source (where the raid's damage
    // would land) without standing ON the miner's tile.
    const post = Memory.roomIntel?.[targetRoom]?.sourcePositions?.[0];
    const anchor = post ? new RoomPosition(post.x, post.y, targetRoom) : new RoomPosition(25, 25, targetRoom);
    if (!creep.pos.inRangeTo(anchor, 2)) {
      travelTo(creep, anchor, { range: 2, visualizePathStyle: { stroke: "#ff6666" } });
    }
  }

  /**
   * One guard per targeted room. Deliberately NOT gated on hostileRooms()
   * (military exemption). Value 105: above the scaling-hauler band's floor
   * (90-110) - it protects a whole room's income stream - but below the
   * reserver's 115 and outside the income tier, so it can never outbid the
   * miners and haulers that ARE the income (ladder test pins the ordering).
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) return [];

    // Sizing stamp (spec 14 / the raid post-mortem question): what the guard
    // decision read, verbatim - per-armed-room raid meters and coverage. A
    // wave's aftermath is answerable from one capture: was the meter armed,
    // was a guard demanded, was the room covered when it hit.
    const debts: { [room: string]: number } = {};
    const targets = this.guardTargets(spawn.room.name);
    for (const r of targets) debts[r] = Memory.roomIntel?.[r]?.raidDebt ?? 0;
    if (targets.length === 0) {
      this.lastSizing = { tick: ctx.tick, gate: "no-targets" };
      return [];
    }

    const covered = new Set(
      this.getActiveCreeps()
        .map(c => c.memory.targetRoom)
        .filter((r): r is string => !!r)
    );
    const uncovered = targets.filter(t => !covered.has(t));
    if (uncovered.length === 0) {
      this.lastSizing = { tick: ctx.tick, gate: "covered", targets: targets.length, debts };
      return [];
    }

    const body = buildGuardBody(ctx.energyCapacity);
    if (body.cost === 0) {
      this.lastSizing = { tick: ctx.tick, gate: "no-body", targets: targets.length, debts };
      return []; // cannot field a viable guard yet
    }
    this.lastSizing = {
      tick: ctx.tick,
      gate: "demand",
      targets: targets.length,
      uncovered: uncovered.length,
      debts
    };
    const floor = buildGuardBody(390); // the 3-pair viable floor

    return uncovered.map(() => ({
      buyerCorpId: this.id,
      role: "guard" as const,
      // Ladder: above the miners' 100 band, below the reserver's 115.
      // producesIncome because the guard PRESERVES an income stream the raid
      // would zero, and BLOCKING because while the meter is armed the guard
      // is the PRECONDITION for every further body sent to that room -
      // spawning income units into a known kill window is buying the raid
      // its victims. Measured (def-t4 cell dev): at base tier the guard
      // starved all window (the reserver-at-92 failure family); as a
      // non-blocking income unit it raced the room's own openers and funded
      // at tick 50 or 186 across identical draws. Blocking+income (1e6+1e4
      // +105) pins it one slot ahead of the 100-value openers, determinism
      // the cell ratchets.
      value: 105,
      blocking: true,
      producesIncome: true,
      // Bank toward the full 5-pair body when the guard tops the ranking
      // (reserver precedent); under pressure the scheduler may fund the
      // 3-pair floor and buildGuardBody sizes to the granted budget.
      holdToFund: true,
      desiredCost: body.cost,
      minCost: floor.cost > 0 ? floor.cost : body.cost,
      since: 0,
      bodyParam: body.attackParts
    }));
  }

  public getCreepCount(): number {
    return this.getActiveCreeps().length;
  }

  public serialize(): SerializedRaidGuardCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId
    };
  }

  public deserialize(data: SerializedRaidGuardCorp): void {
    super.deserialize(data);
    this.spawnId = data.spawnId ?? this.spawnId;
  }
}
