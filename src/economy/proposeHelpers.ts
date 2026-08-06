/**
 * @fileoverview proposeHelpers - the shared PLAN-layer building blocks for
 * corp kinds' propose() (spec 35 phase D, audit finding kinds/3).
 *
 * Seven kinds copy-pasted the same first-spawn-per-room loop and six of them
 * the same auxiliary commission envelope; two kinds duplicated the
 * nearest-spawn scan. This module is the one home, so a NEW per-room
 * auxiliary kind's propose() is a single expression:
 *
 *   return [...homeSpawnsByRoom(problem)].map(([roomName, spawnId]) =>
 *     perRoomAuxiliaryCommission("myKind", roomName, spawnId));
 *
 * Every helper is a pure function of its arguments (no Game/Memory) and is
 * enforced on the purity ratchet's PURE list
 * (test/unit/economy/purity.test.ts). Outputs are byte-identical to the
 * historical per-kind copies - pinned by each kind's propose tests and the
 * conformance suite.
 *
 * @module economy/proposeHelpers
 */

import { Commission, corpIdFor } from "./Commission";
import { ColonyProblem, PlannerSpawn } from "./CorpPlanner";
import { roomLinearDistance } from "../utils/RoomDiscovery";

/**
 * One home spawn per room that has a spawn, FIRST-spawn-wins over
 * problem.spawns order (the ordering every kind's propose() historically
 * relied on - preserved exactly). Returns roomName -> spawn game id.
 */
export function homeSpawnsByRoom(problem: ColonyProblem): Map<string, string> {
  const homeSpawnByRoom = new Map<string, string>();
  for (const s of problem.spawns) {
    if (!homeSpawnByRoom.has(s.pos.roomName)) {
      homeSpawnByRoom.set(s.pos.roomName, s.id);
    }
  }
  return homeSpawnByRoom;
}

/**
 * The spawn whose room is nearest (roomLinearDistance) to `roomName`, ties
 * broken by problem.spawns order (first strict improvement wins - identical
 * to the historical inline scans in claimKind/constructionKind). Undefined
 * when the problem has no spawns.
 */
export function nearestSpawnTo(problem: ColonyProblem, roomName: string): PlannerSpawn | undefined {
  let best: PlannerSpawn | undefined;
  let bestDist = Infinity;
  for (const s of problem.spawns) {
    const d = roomLinearDistance(s.pos.roomName, roomName);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

/**
 * The standard per-room auxiliary commission envelope: off the income budget
 * (zero consumes/produces - the SpawnDirector's value ranking prices the
 * bodies, not the flow planner; each kind's WHY comment lives at its propose
 * call site). corpId is the planner-pure `${kind}-${roomName}`. `assignment`
 * defaults to the plain { roomName, spawnId } binding; kinds with extra
 * commission-owned state (reservation targetRooms, feeder allocation) pass
 * their full assignment object so its shape stays byte-identical.
 */
export function perRoomAuxiliaryCommission(
  kind: string,
  roomName: string,
  spawnId: string,
  assignment?: unknown,
  /**
   * THE CORP'S BUDGET (spec 39 phase 4 / spec 47): spawn build-time this corp
   * commits, parts/tick.
   *
   * Defaults to 0 - the historical behaviour - so an un-migrated kind is
   * UNCHANGED rather than silently mispriced. But 0 is not "free": the colony's
   * parts ledger still deducts this fleet as `infraPartsPerTick`, so a corp
   * declaring 0 is one the colony pays for and no row owns. That hole is
   * precisely what `waste-ledger.planSpawnLoad` was written to re-derive, and
   * closing it is what makes the colony budget the SUM of the corps.
   *
   * Price it with the matching per-corp primitive (economy/primitives:
   * `roomReserverSpawnLoad`, `tenderSpawnLoad`, `feederSpawnLoad`) - never a
   * fresh formula, or the sum stops reconciling with the deduction.
   */
  spawnPartsPerTick = 0
): Commission {
  return {
    corpId: corpIdFor(kind, roomName),
    kind,
    shape: "auxiliary",
    consumes: { spawnPartsPerTick },
    produces: { valuePerTick: 0 },
    assignment: assignment ?? { roomName, spawnId }
  };
}
