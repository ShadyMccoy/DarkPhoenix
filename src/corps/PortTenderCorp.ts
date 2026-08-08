/**
 * @fileoverview PortTenderCorp - the parked mover that empties a DEPOSIT PORT's
 * buffer container into the port link.
 *
 * ## Why this exists (measured t72862894)
 *
 * A deposit port (spec 26) is a home-room link that remote haulers turn around
 * at instead of walking to the storage hub; the link teleports the load the rest
 * of the way. Spec 49 gave the port a BUFFER container so a hauler arriving at a
 * full link drops and leaves instead of waiting (`pickStorageDeposit` ranks
 * `portBuffer` second, ahead of `wait`).
 *
 * Nothing ever emptied that container. Measured live: the port container at
 * (44,12) stood at 2000/2000 - completely full - while its port link served six
 * routes, and `portFallbacks` was 0 on all eight port-routed routes against
 * `portWaits` up to 602. Both of a hauler's escape hatches were shut, so it
 * queued: link full, buffer full, wait.
 *
 * The reason nothing emptied it is a gap the owner named in advance
 * (2026-08-06, quoted in `detectLinkDepositPorts`): *"Building links inside our
 * rooms near the edge for remote mining is probably a great way to go in a lot
 * of cases. And in that case there's no miner, but we still want a tender."*
 * The adjacent-source requirement was then dropped on the reasoning that "the
 * feeder is the sole core-link operator and staffs it regardless" - but the
 * feeder operates the CORE and CONTROLLER links, never a port link, and the only
 * code in the tree that transfers INTO a link is HarvestCorp (a miner). The gate
 * went; the tender it promised never arrived.
 *
 * Live geometry confirms the source-less case is the normal one: both ports sit
 * 7 and 6 tiles from the nearest home source (edge links at range 17 and ~15.5
 * from the core), so neither has a miner that could tend it.
 *
 * ## The job, and why it is PARKED
 *
 * One creep stands on a tile adjacent to BOTH the buffer container and the port
 * link, and shuttles between them without moving: `withdraw` from the container,
 * `transfer` into the link, both legal in the same tick. It never walks a route,
 * so it is CARRY-heavy with a single MOVE - it travels to its post empty (an
 * empty CARRY generates no fatigue) and then stops.
 *
 * The link's own fire rate bounds the work: a port at range r clears
 * LINK_CAPACITY/r e/t (~47 on the live ports), which a handful of CARRY covers
 * many times over. The tender exists to keep the link's 800-energy mouth OPEN,
 * not to move volume.
 *
 * Layer: runtime corp (Game-coupled). Registered by `portTenderKind`.
 *
 * @module corps/PortTenderCorp
 */

import { Corp } from "./Corp";
import { SpawnDemand, SpawnDemandContext } from "../spawn/SpawnScheduler";
import { SerializedSpawnAnchoredCorp, SpawnAnchoredCorp } from "./SpawnAnchoredCorp";
import { PORT_TENDER_CARRY } from "../economy/primitives";
import { PortPost, portPosts } from "./nodeEnergy";
import { travelToLane } from "./movement";

export interface SerializedPortTenderCorp extends SerializedSpawnAnchoredCorp {
  /** Ticks the tender actually moved energy, over ticks alive - the duty meter
   *  its own sizing is judged by (survives resets, LossMeter's pattern). */
  dutyTransfers?: number;
  dutyAlive?: number;
}

export type { PortPost };
export { portPosts };

export class PortTenderCorp extends SpawnAnchoredCorp {
  private dutyTransfers = 0;
  private dutyAlive = 0;

  public constructor(nodeId: string, spawnId: string, customId?: string) {
    super("moving", nodeId, spawnId, customId);
  }

  private getTenders(): Creep[] {
    return this.creepsOfWorkType("porttend", { includeSpawning: false });
  }

  /** The room this corp tends (its anchor spawn's room). */
  private room(): Room | null {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    return spawn ? spawn.room : null;
  }

  /**
   * A tile adjacent to BOTH the buffer and the link, so the creep withdraws and
   * transfers from a standstill. Prefers a tile that is not already occupied by
   * a structure; falls back to any adjacent-to-both tile, and finally to the
   * buffer's own neighbourhood (a creep at range 1 of the buffer can still
   * withdraw, and will step toward the link when it has a load).
   */
  private postTile(post: PortPost): RoomPosition | null {
    const room = post.link.room;
    const terrain = room.getTerrain();
    let fallback: RoomPosition | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = post.buffer.pos.x + dx;
        const y = post.buffer.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (pos.getRangeTo(post.link.pos) > 1) continue;
        const blocked = room.lookForAt(LOOK_STRUCTURES, x, y).some(s => s.structureType !== STRUCTURE_ROAD);
        if (!blocked) return pos;
        fallback = fallback ?? pos;
      }
    }
    return fallback;
  }

  public work(_tick: number): void {
    const room = this.room();
    if (!room) return;
    const posts = portPosts(room);
    const tenders = this.getTenders();
    if (posts.length === 0 || tenders.length === 0) return;

    tenders.forEach((creep, i) => {
      if (creep.spawning) return;
      // Round-robin so a second body (a replacement inside its lead window)
      // covers a second port rather than both crowding one.
      const post = posts[i % posts.length];
      this.dutyAlive += 1;
      const stand = this.postTile(post);
      if (stand && !creep.pos.isEqualTo(stand)) {
        travelToLane(creep, stand, { range: 0, visualizePathStyle: { stroke: "#ffaa00" } });
        // Keep working while walking in: a creep already in range can still
        // move energy this tick.
      }
      const carrying = creep.store[RESOURCE_ENERGY] ?? 0;
      const linkFree = post.link.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;
      // TRANSFER FIRST, then top up. Draining into the link is the whole point;
      // refilling a creep that has nowhere to put its load just parks energy
      // aboard a creep instead of in the container, where the haulers can at
      // least see the free capacity.
      let moved = false;
      if (carrying > 0 && linkFree > 0 && creep.pos.getRangeTo(post.link.pos) <= 1) {
        if (creep.transfer(post.link, RESOURCE_ENERGY, Math.min(carrying, linkFree)) === OK) moved = true;
      }
      const free = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0;
      const buffered = post.buffer.store[RESOURCE_ENERGY] ?? 0;
      if (free > 0 && buffered > 0 && creep.pos.getRangeTo(post.buffer.pos) <= 1) {
        if (creep.withdraw(post.buffer, RESOURCE_ENERGY, Math.min(free, buffered)) === OK) moved = true;
      }
      if (moved) this.dutyTransfers += 1;
    });
  }

  /**
   * One tender per PORT that has a buffer, and none at all without one - a port
   * with no container has nothing to drain, and a room with no port has no post.
   *
   * INFRASTRUCTURE lane: this is the spawn network's own apparatus in the same
   * sense the extension tender is - while it is missing, every port-routed
   * remote hauler queues at a full link, which is income, not overhead.
   */
  public getSpawnDemand(ctx: SpawnDemandContext): SpawnDemand[] {
    const spawn = Game.getObjectById(this.spawnId as Id<StructureSpawn>);
    if (!spawn) {
      this.lastSizing = { tick: ctx.tick, gate: "no-spawn" };
      return [];
    }
    const posts = portPosts(spawn.room);
    if (posts.length === 0) {
      this.lastSizing = { tick: ctx.tick, gate: "no-port-buffer" };
      return [];
    }
    // staffsPost symmetry: the demand side counts the SAME lens the census
    // does (CLAUDE.md - every consumer of "how many creeps does this post
    // have" uses one lens, or newborns get recycled at the spawn door).
    const staffed = this.getTenders().length;
    const bufferedTotal = posts.reduce((s, p) => s + (p.buffer.store[RESOURCE_ENERGY] ?? 0), 0);
    this.lastSizing = {
      tick: ctx.tick,
      gate: staffed >= posts.length ? "staffed" : "demand",
      posts: posts.length,
      staffing: staffed,
      target: posts.length,
      buffered: bufferedTotal
    };
    if (staffed >= posts.length) return [];
    return [
      {
        buyerCorpId: this.id,
        role: "porttender",
        value: 78,
        blocking: false,
        infrastructure: true,
        bodyParam: PORT_TENDER_CARRY
      } as SpawnDemand
    ];
  }

  public serialize(): SerializedPortTenderCorp {
    return { ...super.serialize(), dutyTransfers: this.dutyTransfers, dutyAlive: this.dutyAlive };
  }

  public deserialize(data: SerializedPortTenderCorp): void {
    super.deserialize(data);
    this.dutyTransfers = data.dutyTransfers ?? 0;
    this.dutyAlive = data.dutyAlive ?? 0;
  }
}

// Keep the abstract Corp surface honest for readers grepping the base class.
export type { Corp };
