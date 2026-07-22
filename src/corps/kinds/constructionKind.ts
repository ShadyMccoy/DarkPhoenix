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
import { buildTankerBody, buildUpgraderBody } from "../../spawn/BodyBuilder";
import { SerializedCorp } from "../Corp";
import { ConstructionCorp, SerializedConstructionCorp } from "../ConstructionCorp";
import { roomLinearDistance } from "../../utils/RoomDiscovery";

/** The construction commission's binding: the room, its spawn, and the flow's
 * construction-energy allocations for that room (for builder sizing). */
export interface ConstructionAssignment {
  roomName: string;
  spawnId: string;
  allocations: SinkAllocation[];
  /**
   * Spec 25 phase 3: the summed construction allocations of the SPAWNLESS
   * rooms this spawn staffs - remote source-local clusters priced at the
   * source's rate. The ONE pool crew (this room's corp) sizes to eat this
   * on top of its own-room allocations ("make a bigger builder").
   */
  poolAllocatedRate?: number;
  /**
   * Remote trunk candidates (owner 2026-07-19: a route is a string of sites,
   * not a room): the draft's FUNDED remote harvests staffed from this room's
   * spawn. The corp judges each with roadEconomics and paves the winners
   * cross-room; the paved receipt reprices that source's haulers at 2:1.
   */
  remoteTrunks?: { sourceId: string; pos: Position; flow: number }[];
}

/**
 * Rooms the draft plan MINES outside our spawn rooms (the same durable lens
 * reservationKind uses): candidates for the remote source-container rung.
 * Pre-spec-17 this scanned Game.creeps for standing miners - the documented
 * creep-position trap class (a dead miner made the commission set flap and
 * took the room's vision with it). The DRAFT is the durable signal: a room is
 * remote-worked exactly when a harvest commission targets one of its sources.
 * Hostile-marked rooms are excluded (defense economics) via the problem's
 * host-assembled hostileRooms fact.
 */
function remoteMinedRooms(problem: ColonyProblem, draft: readonly Commission[]): Set<string> {
  const home = new Set(problem.spawns.map(s => s.pos.roomName));
  const danger = new Set(problem.hostileRooms ?? []);
  const out = new Set<string>();
  for (const c of draft) {
    if (c.kind !== "harvest") continue;
    const room = c.produces.at?.roomName;
    if (!room || home.has(room) || danger.has(room)) continue;
    out.add(room);
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
  // Tankers are rescued by the tender kind (pre-spec-17 ROLE_KIND mapping).
  roles: { builder: { workType: "build" }, tanker: { workType: "tank", readopt: false } },
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
      // Two id spaces cross here: solver commissions carry flow-prefixed
      // spawn ids ("spawn-<gameId>"), the live problem carries raw game ids.
      // Normalize before the lookup - without this it ALWAYS missed and every
      // remote trunk fell through to the first spawn's room (audit find).
      const spawnKey = m.spawnId?.replace("spawn-", "");
      const homeRoom = (spawnKey && spawnRoomById.get(spawnKey)) ?? [...spawnRoomById.values()][0];
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
    const spawnlessRooms = new Set([...allocByRoom.keys(), ...remoteMinedRooms(problem, draft)]);
    for (const roomName of spawnlessRooms) {
      if (homeSpawnByRoom.has(roomName)) continue;
      let best = problem.spawns[0];
      if (!best) continue;
      let bestDist = Infinity;
      for (const s of problem.spawns) {
        const d = roomLinearDistance(s.pos.roomName, roomName);
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      homeSpawnByRoom.set(roomName, best.id);
    }
    // POOL ALLOCATIONS (spec 25 phase 3, owner: "make a bigger builder ...
    // consume all the energy from the source mine"): the plan now prices
    // remote source-local clusters at the SOURCE'S RATE, and the ONE pool
    // crew (the spawn's own room corp) must size to eat it - remote corps
    // field no builders. Each spawn's room corp receives the SUM of the
    // construction allocations in the spawnless rooms it staffs.
    const poolAllocBySpawnRoom = new Map<string, number>();
    for (const [roomName, spawnId] of homeSpawnByRoom) {
      const spawnRoom = spawnRoomById.get(spawnId.replace("spawn-", "")) ?? roomName;
      if (roomName === spawnRoom) continue; // own-room allocations ride `allocations`
      const sum = (allocByRoom.get(roomName) ?? []).reduce((s, a) => s + a.allocated, 0);
      if (sum > 0) poolAllocBySpawnRoom.set(spawnRoom, (poolAllocBySpawnRoom.get(spawnRoom) ?? 0) + sum);
    }

    return [...homeSpawnByRoom].map(([roomName, spawnId]) => {
      const allocations = allocByRoom.get(roomName) ?? [];
      const poolAllocatedRate = poolAllocBySpawnRoom.get(roomName) ?? 0;
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
          ...(poolAllocatedRate > 0 ? { poolAllocatedRate } : {}),
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
      existing.setPoolAllocatedRate(a.poolAllocatedRate ?? 0);
      return existing;
    }
    // liveProblem (the host's auxiliary world) carries REAL game spawn ids, so no
    // "spawn-" stripping is needed here. Legacy nodeId preserves the runtime id
    // (`building-${room}-construction`) so live builders' memory.corpId resolves.
    const corp = new ConstructionCorp(`${a.roomName}-construction`, a.spawnId);
    corp.setConstructionAllocations(a.allocations);
    corp.setRemoteTrunks(a.remoteTrunks ?? []);
    corp.setPoolAllocatedRate(a.poolAllocatedRate ?? 0);
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

  body(role: string, bodyParam: number | undefined, energyBudget: number): BodyPartConstant[] {
    // The corp fields two shapes: WORK builders (the live executor pins the
    // WORK cap at 2 - upsizing is the ConstructionCorp's own fleet logic via
    // bodyParam-less demands) and CARRY tankers ferrying build energy.
    if (role === "tanker") return buildTankerBody(bodyParam ?? 4, energyBudget, false).body;
    return buildUpgraderBody(energyBudget, 2).body;
  },

  // BUILDER HAND-OFF, adopt half (owner 2026-07-22: "they could orphan and
  // adopt creeps if necessary"): a released/orphaned BUILDER goes to the
  // nearest construction corp whose demand lens wants one (the corp's own
  // wantsAnotherBuilder probe - never a recomputation here), so a finished
  // remote stint walks straight to the next project instead of the measured
  // fresh-4p-body-per-room churn. Tankers are the tender kind's rescue
  // (roles.tanker readopt:false). No taker -> null -> grace -> recycle.
  claimsOrphan(creep: Creep, corps: { [corpId: string]: ConstructionCorp }): string | null {
    if (creep.memory.workType !== "build") return null;
    let bestId: string | null = null;
    let bestD = Infinity;
    for (const id in corps) {
      const corp = corps[id];
      if (!corp.wantsAnotherBuilder()) continue;
      const d =
        typeof Game.map?.getRoomLinearDistance === "function"
          ? Game.map.getRoomLinearDistance(creep.pos.roomName, corp.workRoomName())
          : 0;
      if (d < bestD || (d === bestD && (bestId === null || corp.id < bestId))) {
        bestD = d;
        bestId = corp.id;
      }
    }
    return bestId;
  }
};
