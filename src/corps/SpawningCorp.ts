/**
 * @fileoverview SpawningCorp - Manages spawn structures.
 *
 * SpawningCorp handles creep spawning based on demand from other corps.
 * Includes self-sustaining logic for energy starvation recovery.
 *
 * @module corps/SpawningCorp
 */

import { CREEP_LIFETIME, bodyEnergyCost } from "../economy/primitives";
import { Corp, SerializedCorp } from "./Corp";
import { contractSpawn } from "./spawnContract";
import { drawOrder } from "./refillCircuit";
import { HaulerRatio } from "../framework/EdgeVariant";
import { getCorpKind } from "../economy/CorpKind";
import { Position } from "../types/Position";

/**
 * All 8 spawn exit directions ordered so the tile FACING `to` comes FIRST, then
 * its neighbours by angular distance out to the opposite side. Passed to
 * spawnCreep({ directions }) so a newborn emerges on the side toward its post
 * (owner 2026-07-24: "spawn the feeder using the spawn directions right into the
 * feeder spot") - but the full ring is included as fallback so a blocked
 * preferred tile never PREVENTS the spawn. Pure: uses the Screeps direction
 * numbering (TOP=1 clockwise to TOP_LEFT=8, y growing downward) directly, so it
 * needs no globals and is unit-testable. Returns undefined when from === to.
 */
export function spawnDirectionsToward(
  from: { x: number; y: number },
  to: { x: number; y: number }
): DirectionConstant[] | undefined {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (dx === 0 && dy === 0) return undefined;
  const dirOf: Record<string, number> = {
    "0,-1": 1, // TOP
    "1,-1": 2, // TOP_RIGHT
    "1,0": 3, // RIGHT
    "1,1": 4, // BOTTOM_RIGHT
    "0,1": 5, // BOTTOM
    "-1,1": 6, // BOTTOM_LEFT
    "-1,0": 7, // LEFT
    "-1,-1": 8 // TOP_LEFT
  };
  const primary = dirOf[`${dx},${dy}`];
  const order: number[] = [];
  for (let d = 0; d <= 4; d++) {
    order.push(((primary - 1 + d) % 8) + 1);
    if (d !== 0 && d !== 4) order.push(((primary - 1 - d + 8) % 8) + 1);
  }
  return order as DirectionConstant[];
}

/**
 * Serialized state specific to SpawningCorp
 */
/**
 * What one successful executeSpawn actually bought: the parts count and the
 * energy DEBITED for the body (never the budget granted - the two differ
 * whenever the built body rounds under the grant, and booking the grant put
 * +3.99 e/t of phantom spend on the evacuation line at t72734018).
 */
export interface SpawnPurchase {
  parts: number;
  cost: number;
}

export interface SerializedSpawningCorp extends SerializedCorp {
  spawnId: string;
}

/**
 * SpawningCorp manages a spawn structure.
 */
export class SpawningCorp extends Corp {
  /** ID of the spawn structure */
  private spawnId: string;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("spawning", nodeId, customId);
    this.spawnId = spawnId;
  }

  /**
   * Get the spawn position as the corp's location.
   */
  public getPosition(): Position {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (spawn) {
      return { x: spawn.pos.x, y: spawn.pos.y, roomName: spawn.pos.roomName };
    }
    return { x: 25, y: 25, roomName: this.nodeId.split("-")[0] };
  }

  /**
   * Per-tick work. Spawning itself is now driven externally by the demand-based
   * scheduler (SpawnDirector -> executeSpawn); this only keeps liveness
   * bookkeeping current.
   */
  public work(tick: number): void {
    this.lastActivityTick = tick;
  }

  /**
   * Execute a scheduler decision: build the body for the chosen role within the
   * granted energy budget and spawn it. Returns the number of BODY PARTS
   * spawned (0 = nothing bought, so every caller's truthiness check is
   * unchanged).
   *
   * Parts, not a boolean, because the blackbox spawn row feeds F1's per-class
   * fidelity decomposition and that comparison is in parts/tick. Energy is the
   * wrong unit and wrong in a biased direction - a CLAIM part costs 600e where
   * a CARRY part costs 50, so reservers read as 21% of spawn SPEND against 4%
   * of spawn PARTS. Inferring parts back out of cost would have the ledger
   * re-deriving a body this method already built; record it at the source.
   *
   * This is the executor half of the demand-driven spawn pipeline: the
   * SpawnScheduler decides WHAT to spawn and HOW MUCH energy to spend; this
   * dispatches to the buyer KIND's declarations - body shape via kind.body()
   * and the creep's workType stamp via kind.roles - so a new kind's creeps
   * spawn by registration alone. (The historical 12-role switch + workTypeMap
   * this replaces are frozen as the reference in
   * test/unit/framework/bodyEquivalence.test.ts.)
   */
  public executeSpawn(
    kind: string,
    role: string,
    buyerCorpId: string,
    energyBudget: number,
    tick: number,
    bodyParam?: number,
    haulerRatio?: HaulerRatio,
    bodyStrategy?: string,
    bufferCarry?: number,
    receipt?: Record<string, unknown>
  ): SpawnPurchase | null {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn || spawn.spawning) return null;

    const corpKind = getCorpKind(kind);
    const roleSpec = corpKind?.roles[role];
    if (!corpKind || !roleSpec) {
      // A wiring bug (unregistered kind / undeclared role), surfaced loudly:
      // conformance asserts every kind's demand roles are declared.
      console.log(`[Spawning] no registered kind/role for ${kind}/${role} (buyer ${buyerCorpId})`);
      return null;
    }

    const body = corpKind.body(role, bodyParam, energyBudget, { haulerRatio, bodyStrategy, bufferCarry });
    if (body.length === 0) return null;

    const bodyCost = bodyEnergyCost(body);
    if (spawn.room.energyAvailable < bodyCost) return null;

    const name = `${role}-${buyerCorpId.slice(-6)}-${tick}`;
    // Drain in refill-circuit order (owner directive): spawning empties the
    // same stops in the same sequence the refill bus tops them up, so holes
    // form one contiguous run along the tour instead of scattered potholes.
    const energyStructures = drawOrder(spawn.room);
    // Spawn placement: a kind may name the tile the newborn should face (the
    // feeder's parked relay post), so it emerges on-post instead of walking in.
    const target = corpKind.spawnTarget?.(role, spawn);
    const directions = target ? spawnDirectionsToward(spawn.pos, target) : undefined;
    // The purchase BOOKS ITSELF at the contract door (spec 60 phase A): the
    // spend ledger accrual and the forensic "spawn" row happen inside
    // contractSpawn, from the exact body bought, for EVERY buyer that crosses
    // it - the director, direct buyers like the scout corp, and bootstrap. A
    // hauler bought for a standalone scavenge corp ("hauling-" corp id prefix,
    // the same class the ring analyses read) flags the RECOVERY sub-counter -
    // the cure's cost, named (methodology #10). `receipt` is the director's
    // agenda context, merged into the row the door files.
    const result = contractSpawn(
      spawn,
      body,
      name,
      {
        memory: { corpId: buyerCorpId, workType: roleSpec.workType, spawnedBy: this.id },
        ...(energyStructures.length > 0 ? { energyStructures } : {}),
        ...(directions ? { directions } : {})
      },
      {
        role,
        scavenge: role === "hauler" && buyerCorpId.startsWith("hauling-"),
        receipt
      }
    );

    if (result === OK) {
      const workParts = body.filter(p => p === WORK).length;
      this.recordProduction(workParts * CREEP_LIFETIME);
      const carryParts = body.filter(p => p === CARRY).length;
      const partsInfo = role === "hauler" ? `${carryParts}C` : `${workParts}W`;
      console.log(`[Spawning] Spawned ${name} (${partsInfo}, ${bodyCost} energy)`);
      // The purchase record IS the receipt's source of truth (methodology #8):
      // parts AND the debit, so the caller's books record what was paid, never
      // the budget it happened to grant.
      return { parts: body.length, cost: bodyCost };
    }
    return null;
  }

  /**
   * Get the spawn ID.
   */
  public getSpawnId(): string {
    return this.spawnId;
  }

  /**
   * Serialize for persistence.
   */
  public serialize(): SerializedSpawningCorp {
    return {
      ...super.serialize(),
      spawnId: this.spawnId
    };
  }

  /**
   * Deserialize from persistence.
   */
  public deserialize(data: SerializedSpawningCorp): void {
    super.deserialize(data);
  }
}

/**
 * Create a SpawningCorp for a spawn structure.
 */
export function createSpawningCorp(spawn: StructureSpawn): SpawningCorp {
  const nodeId = `${spawn.room.name}-spawn-${spawn.id.slice(-4)}`;
  return new SpawningCorp(nodeId, spawn.id);
}
