/**
 * @fileoverview constructionKind - ConstructionCorp as a registered CorpKind:
 * the last legacy creation path leaves FlowMaterializer (docs/specs/00-corp-
 * framework.md). Construction is a HYBRID:
 *
 * - It must exist per OWNED ROOM regardless of construction work, because it
 *   also maintains decaying containers (the legacy runConstructionCorps created
 *   one for every owned room). So propose() emits one commission per spawn room,
 *   like an auxiliary.
 * - It self-drives its building from live construction sites, BUT sizes its
 *   builders from the flow's construction-energy allocation (getTotalAllocatedEnergy).
 *   So the commission must carry that allocation. propose() reads it from the
 *   solver's "build" commissions already in the DRAFT (the first kind to use the
 *   draft for preconditions), grouped by room.
 *
 * The raw "build" commissions themselves stay unregistered and are skipped by
 * materializeCommissions; this kind subsumes them into per-room corps.
 *
 * @module corps/kinds/constructionKind
 */

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem, CommissionedSink } from "../../economy/CorpPlanner";
import { Position } from "../../types/Position";
import { ConsumeAssignment } from "../../economy/commissionPlan";
import { SinkAllocation } from "../../flow/FlowTypes";
import { buildUpgraderBody } from "../../spawn/BodyBuilder";
import { SerializedCorp } from "../Corp";
import { ConstructionCorp, SerializedConstructionCorp } from "../ConstructionCorp";
import { hostileRooms } from "../../utils/RoomDiscovery";

/** The construction commission's binding: the room, its spawn, and the flow's
 * construction-energy allocations for that room (for builder sizing). */
export interface ConstructionAssignment {
  roomName: string;
  spawnId: string;
  allocations: SinkAllocation[];
  /**
   * Remote trunk candidates (owner 2026-07-19: a route is a string of sites,
   * not a room): the draft's FUNDED remote harvests staffed from this room's
   * spawn. The corp judges each with roadEconomics and paves the winners
   * cross-room; the paved receipt reprices that source's haulers at 2:1.
   */
  remoteTrunks?: { sourceId: string; pos: Position; flow: number }[];
}

/**
 * Rooms our miners currently work that nobody owns (mirrors
 * ReservationCorp.targetRooms): candidates for the remote source-container
 * rung. Hostile-marked rooms are excluded (defense economics) and SK /
 * controller-less rooms are skipped - we only invest where we can hold the
 * ground with a reservation.
 */
function remoteMinedRooms(): Set<string> {
  const out = new Set<string>();
  if (typeof Game === "undefined" || !Game.creeps) return out;
  const danger = hostileRooms();
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.memory.workType !== "harvest") continue;
    const controller = creep.room?.controller;
    if (!controller || controller.my || controller.owner) continue;
    if (danger.has(creep.room.name)) continue;
    out.add(creep.room.name);
  }
  return out;
}

/** Reconstruct a construction SinkAllocation from a build commission's sink. */
function constructionAllocation(k: CommissionedSink): SinkAllocation {
  return {
    sinkId: k.sinkId,
    sinkType: "construction",
    allocated: k.allocated,
    demand: k.demand,
    unmet: Math.max(0, k.demand - k.allocated),
    priority: k.value,
    sourceFlows: k.sources.map(sf => ({ sourceId: sf.sourceId, amount: sf.amount, distance: sf.distance }))
  };
}

export const constructionKind: CorpKind<ConstructionCorp> = {
  kind: "construction",
  runOrder: 30, // consume tier, alongside upgrade

  /**
   * One commission per owned room with a spawn (so the corp always exists for
   * container maintenance), carrying that room's construction allocations read
   * from the solver's "build" commissions in the draft.
   */
  propose(problem: ColonyProblem, draft: readonly Commission[]): Commission[] {
    // Group the draft's build allocations by the sink's room.
    const allocByRoom = new Map<string, SinkAllocation[]>();
    for (const c of draft) {
      if (c.kind !== "build") continue;
      const roomName = c.produces.at?.roomName;
      if (!roomName) continue;
      const { sink } = c.assignment as ConsumeAssignment;
      const list = allocByRoom.get(roomName) ?? [];
      list.push(constructionAllocation(sink));
      allocByRoom.set(roomName, list);
    }

    const homeSpawnByRoom = new Map<string, string>();
    for (const s of problem.spawns) {
      if (!homeSpawnByRoom.has(s.pos.roomName)) homeSpawnByRoom.set(s.pos.roomName, s.id);
    }
    // Remote trunk candidates (owner 2026-07-19): each FUNDED harvest whose
    // source lies OUTSIDE its staffing spawn's room. The trunk belongs to the
    // spawn's room corp - the home end of the route.
    const spawnRoomById = new Map(problem.spawns.map(s => [s.id, s.pos.roomName]));
    const trunksByRoom = new Map<string, { sourceId: string; pos: Position; flow: number }[]>();
    for (const c of draft) {
      if (c.kind !== "harvest") continue;
      const at = c.produces.at;
      if (!at) continue;
      const m = c.assignment as { sourceId?: string; spawnId?: string; rate?: number };
      const homeRoom = (m.spawnId && spawnRoomById.get(m.spawnId)) ?? [...spawnRoomById.values()][0];
      if (!homeRoom || at.roomName === homeRoom) continue; // home sources: the in-room scan covers them
      const list = trunksByRoom.get(homeRoom) ?? [];
      list.push({ sourceId: m.sourceId ?? c.corpId.replace(/^harvest-/, ""), pos: at, flow: c.produces.energyRate ?? 0 });
      trunksByRoom.set(homeRoom, list);
    }
    // A room with build allocations but NO spawn of its own (the expansion
    // founding: spec 06 audit "attribute the new room's corps to the PARENT
    // spawn until the new spawn stands") still gets its construction corp,
    // staffed from the nearest spawn - builders walk over, exactly like a
    // remote miner walks to its post. REMOTELY-MINED rooms join the same
    // path (remote source containers): the corp's remote rung is pile-gated
    // and pile-funded, so commissioning one for every room our miners work
    // costs nothing until a source is measurably bleeding on the ground.
    const spawnlessRooms = new Set([...allocByRoom.keys(), ...remoteMinedRooms()]);
    for (const roomName of spawnlessRooms) {
      if (homeSpawnByRoom.has(roomName)) continue;
      let best = problem.spawns[0];
      if (!best) continue;
      if (typeof Game !== "undefined" && Game.map?.getRoomLinearDistance) {
        let bestDist = Infinity;
        for (const s of problem.spawns) {
          const d = Game.map.getRoomLinearDistance(s.pos.roomName, roomName);
          if (d < bestDist) {
            bestDist = d;
            best = s;
          }
        }
      }
      homeSpawnByRoom.set(roomName, best.id);
    }
    return [...homeSpawnByRoom].map(([roomName, spawnId]) => {
      const allocations = allocByRoom.get(roomName) ?? [];
      return {
        corpId: corpIdFor("construction", roomName),
        kind: "construction",
        shape: "consume",
        consumes: {
          energyRate: allocations.reduce((s, a) => s + a.allocated, 0),
          spawnPartsPerTick: 0
        },
        produces: { valuePerTick: 0 },
        assignment: {
          roomName,
          spawnId,
          allocations,
          ...(trunksByRoom.has(roomName) ? { remoteTrunks: trunksByRoom.get(roomName) } : {})
        } as ConstructionAssignment
      };
    });
  },

  materialize(c: Commission, existing: ConstructionCorp | undefined): ConstructionCorp {
    const a = c.assignment as ConstructionAssignment;
    if (existing) {
      existing.setConstructionAllocations(a.allocations);
      existing.setSpawnId(a.spawnId); // commission-owned: never let it go stale
      existing.setRemoteTrunks(a.remoteTrunks ?? []);
      return existing;
    }
    // liveProblem (the host's auxiliary world) carries REAL game spawn ids, so no
    // "spawn-" stripping is needed here. Legacy nodeId preserves the runtime id
    // (`building-${room}-construction`) so live builders' memory.corpId resolves.
    const corp = new ConstructionCorp(`${a.roomName}-construction`, a.spawnId);
    corp.setConstructionAllocations(a.allocations);
    corp.setRemoteTrunks(a.remoteTrunks ?? []);
    return corp;
  },

  run(corp: ConstructionCorp, tick: number): void {
    // Replicate the legacy runConstructionCorps cadence: plan periodically, work
    // every tick.
    if (corp.shouldPlan(tick)) corp.plan(tick);
    corp.work(tick);
  },

  serializeCorp(corp: ConstructionCorp): SerializedConstructionCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): ConstructionCorp {
    const d = data as SerializedConstructionCorp;
    const corp = new ConstructionCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(_role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // Builders are WORK creeps; bodyParam caps the WORK parts.
    return buildUpgraderBody(energyBudget, bodyParam ?? 5).body;
  }
};
