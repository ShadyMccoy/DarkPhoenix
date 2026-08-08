/**
 * @fileoverview censusLens - the ONE home for cross-kind "who is fielded in
 * this room" creep lookups (spec 35 phase C; audit findings corps-heavy/5,
 * corps-rest/6).
 *
 * Corps used to sniff EACH OTHER'S corp-id prefixes inline ("mining-",
 * "hauling-", includes("tender")) - the exact "read another kind's naming
 * conventions instead of a shared lens" violation ONTOLOGY §5 forbids. The
 * predicates are centralized here VERBATIM, not redesigned:
 *
 * - The prefixes are LEGACY-STABLE (trap list: "Corp id prefixes - a rename
 *   silently orphans live creeps"), which is precisely why they are safe to
 *   key on - and precisely why only ONE module may spell them out.
 * - Each lens keeps the exact COMPOUND (workType + id prefix) its call sites
 *   had. A pure-workType check would also match bootstrap jacks (workType
 *   "harvest"/"haul" with corpId "bootstrap-...") and change cold-start
 *   behavior - see each lens's rationale.
 *
 * @module corps/censusLens
 */

/**
 * True for a FLOW miner's creep (a HarvestCorp creep, corpId "mining-..."),
 * NOT a bootstrap jack - jacks also carry workType "harvest" but corpId
 * "bootstrap-...". Counting jacks made every flow miner non-blocking while
 * jacks were alive, so the blocking upgrader/haulers always outranked it and
 * no flow miner ever spawned: the colony could never hand off from bootstrap
 * to the flow economy (HarvestCorp's runt-floor incident).
 */
export function isFlowMinerCreep(memory: CreepMemory): boolean {
  return memory.workType === "harvest" && (memory.corpId ?? "").startsWith("mining-");
}

/**
 * True once a flow miner is producing in the room (income before
 * infrastructure) - the tender/feeder no-miner gate: neither mover may
 * front-run the room's first real income. Verbatim re-home of the
 * ExtensionTenderCorp/LinkCorp private roomHasMiner helpers.
 */
export function roomHasFlowMiner(roomName: string): boolean {
  for (const name in Game.creeps) {
    const c = Game.creeps[name];
    if (c.room.name === roomName && isFlowMinerCreep(c.memory)) return true;
  }
  return false;
}

/**
 * HarvestCorp's runt-floor variant of the miner census: does the corp's SPAWN
 * room field a flow miner? Room-scoped so a remote miner does not satisfy a
 * home room's floor - but UNKNOWN rooms (unit-harness mocks with no creep.room)
 * count as local, the old colony-wide behavior, so only a KNOWN remote miner
 * is excluded from the floor gate. Verbatim re-home of
 * HarvestCorp.spawnRoomHasMiner's loop.
 */
export function spawnRoomHasFlowMiner(spawnRoom: string | undefined): boolean {
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (!isFlowMinerCreep(creep.memory)) continue;
    if (!spawnRoom || creep.room?.name === undefined || creep.room.name === spawnRoom) return true;
  }
  return false;
}

/**
 * True if the room already has a real flow hauler in the field, i.e. the
 * mining->spawn delivery loop is closed. Two legitimate id families (spec 34
 * D5): a MINER OPERATION's internal haul squad stamps the operation's own id
 * ("mining-..."), while the standalone carry path (minerless scavenge
 * stocks) keeps "hauling-...". Bootstrap jacks (which also move energy,
 * corpId "bootstrap-...") are deliberately excluded: this is UpgradingCorp's
 * supply-before-demand gate against the cold-start delivery deadlock
 * (upgraders draining the spawn's starting energy before the first hauler is
 * ever eligible - the full incident rationale lives at the getSpawnDemand
 * call site). Verbatim re-home of UpgradingCorp.roomHasHauler, widened for
 * the operation id family.
 */
export function roomHasFlowHauler(room: Room): boolean {
  for (const creep of room.find(FIND_MY_CREEPS)) {
    const memory = creep.memory;
    if (memory.workType !== "haul") continue;
    const corpId = memory.corpId ?? "";
    if (corpId.startsWith("hauling-") || corpId.startsWith("mining-")) return true;
  }
  return false;
}

/**
 * True for the room tender's creep (an ExtensionTenderCorp creep: workType
 * "tank" with "tender" in its corpId - the workType alone would also match
 * construction TANKERS, which share workType "tank"). Verbatim re-home of
 * CarryCorp's deliverToSpawn tender lookup; load/capacity filtering stays at
 * the call site (it is trip state, not identity).
 */
export function isTenderCreep(memory: CreepMemory): boolean {
  return memory.workType === "tank" && String(memory.corpId ?? "").includes("tender");
}
