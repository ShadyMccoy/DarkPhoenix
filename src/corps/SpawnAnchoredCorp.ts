/**
 * @fileoverview SpawnAnchoredCorp - the shared base of the auxiliary corps
 * that operate OUT OF one home spawn (scout, reservation, claim, raidGuard,
 * coreBuster, extension tender, controller feeder). Spec 32 phase D (audit
 * finding corps-rest/10): each of the seven repeated ~30 lines of spawnId
 * plumbing, the spawn-position-with-fallback, and the Game.creeps corp-roster
 * loop. The fold is mechanical - no corp's behavior, serialized shape, or
 * creep filter changed.
 *
 * The roster helper makes the include-spawning choice EXPLICIT and REQUIRED:
 * demand lenses generally count spawning newborns ("the demand lens must see
 * the newborns its own purchases create" - the reserver purchase-loop trap,
 * live t72401489+), while work lenses don't (a spawning creep cannot move) -
 * the staffsPost-symmetry trap family. A corp with a subtler filter (the
 * tender's staffsPost lead-window staffing) applies it on top at its own
 * call site, where the incident rationale lives.
 *
 * @module corps/SpawnAnchoredCorp
 */

import { Corp, CorpType, SerializedCorp } from "./Corp";
import { Position } from "../types/Position";

/** Serialized state shared by every spawn-anchored auxiliary corp. */
export interface SerializedSpawnAnchoredCorp extends SerializedCorp {
  spawnId: string;
}

export abstract class SpawnAnchoredCorp extends Corp {
  protected spawnId: string;

  public constructor(type: CorpType, nodeId: string, spawnId: string, customId?: string) {
    super(type, nodeId, customId);
    this.spawnId = spawnId;
  }

  /** The home spawn this corp is anchored to (kind dispatch reads it). */
  public getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Rebind to the commission's CURRENT spawn. The spawn id is commission-owned
   * state: a persisted corp outlives spawns (measured live: an immortal
   * upgrade/construction corp carried a dead spawn's id for good, so
   * collectDemands dropped its demands forever - 0 upgraders/builders while
   * the plan begged for them). Every kind's materialize() refreshes this
   * (conformance-enforced).
   */
  public setSpawnId(spawnId: string): void {
    this.spawnId = spawnId;
  }

  /** The home spawn's position; center-of-node fallback while the spawn is gone. */
  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * This corp's creeps of one workType. `includeSpawning` is deliberately
   * REQUIRED (no default): picking the wrong lens silently is exactly the
   * double-order/purchase-loop trap class, so every call site states which
   * side of the staffsPost symmetry it is on.
   */
  protected creepsOfWorkType(workType: string, opts: { includeSpawning: boolean }): Creep[] {
    const creeps: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (creep.memory.corpId !== this.id || creep.memory.workType !== workType) continue;
      if (!opts.includeSpawning && creep.spawning) continue;
      creeps.push(creep);
    }
    return creeps;
  }

  public serialize(): SerializedSpawnAnchoredCorp {
    return { ...super.serialize(), spawnId: this.spawnId };
  }

  public deserialize(data: SerializedSpawnAnchoredCorp): void {
    super.deserialize(data);
    this.spawnId = data.spawnId ?? this.spawnId;
  }
}
