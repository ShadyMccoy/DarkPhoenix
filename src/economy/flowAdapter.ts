/**
 * @fileoverview Adapter: run the GOAP CorpPlanner over a live FlowGraph and emit
 * the FlowSolution shape the materialiser already consumes.
 *
 * This is the drop-in seam. FlowEconomy.solve() can call solveWithCorpPlanner()
 * in place of the old FlowSolver (solveIteratively) and the downstream materialiser,
 * corps and scheduler are untouched - the planner just produces better-reasoned
 * miner/hauler/sink assignments from one model.
 *
 * @module economy/flowAdapter
 */

import "../types/Memory"; // RoomMemory.roadRoutes augmentation (paved receipts)
import { roomLinearDistance } from "../utils/RoomDiscovery";
import { FlowGraph } from "../flow/FlowGraph";
import {
  FlowSolution,
  HaulerAssignment,
  MinerAssignment,
  SinkAllocation,
  SinkType
} from "../flow/FlowTypes";
import { pathDistance } from "../nodes/NodeNavigator";
import { Position } from "../types/Position";
import { controllerLink, coreLink, sourceLink, controllerInputSpot, controllerParkingTiles } from "../corps/nodeEnergy";
import { buildUpgraderBody } from "../spawn/BodyBuilder";
import {
  INVADER_TAX_PER_ENERGY,
  UPGRADE_ENERGY_PER_WORK,
  infraSpawnLoad,
  minerOverhead,
  projectAbsorbRate
} from "./primitives";
import { detectRoomStocks, SCAVENGE_RATE_FLOOR, stockToTransientSource } from "./scavenge";
import { partialPaveRatio } from "./roadEconomics";
import {
  ColonyProblem,
  DEFAULT_SINK_VALUE,
  DepositPort,
  PlannerSink,
  PlannerSource,
  PlannerSpawn,
  SinkKind,
  planColony
} from "./CorpPlanner";
import { Commission } from "./Commission";
import { DEFAULT_VALUATION, Goal, SinkValuation, compileGoal } from "./goals";
import { searchStructure } from "./strategy";
import { commissionsFromPlan } from "./commissionPlan";
import { haulerAssignmentFromCommissioned } from "../flow/haulerAssignment";

/** Guaranteed controller trickle (energy/tick) so it never downgrades / stalls. */
export const ANTI_DOWNGRADE_RESERVE = 2;

/**
 * The save-regime controller cap lives in economy/bank.ts with the rest of the
 * warchest primitives (the feeder and upgrader sizing derive from the same
 * module); re-exported here for the existing import sites.
 */
export { STORAGE_UPGRADE_TARGET } from "./bank";
import { STORAGE_UPGRADE_TARGET, bankToTransientSource, bankSourceId, feederRelayRate } from "./bank";

/**
 * Routing capacity for a controller sink. Uncapped (mops up the remainder) until
 * the controller's room has a storage bank that is still FILLING, then bounded to
 * {@link STORAGE_UPGRADE_TARGET} so the surplus banks in storage. Once the bank
 * passes the warchest target (the room appears in `surplusRooms` because a bank
 * source was emitted for it - see detectBankSources), the cap lifts and the
 * controller reverts to mopping up: the warchest is full, so there is nothing
 * left to save for and the surplus draw needs somewhere to land. Pure over the
 * two room sets so it is unit-testable without Game.
 */
export function controllerRoutingCapacity(
  sink: { position: Position },
  totalSupply: number,
  roomsWithStorage: ReadonlySet<string>,
  surplusRooms: ReadonlySet<string> = new Set(),
  physicalUpgradeCap: number = Infinity
): number {
  if (roomsWithStorage.has(sink.position.roomName) && !surplusRooms.has(sink.position.roomName)) {
    return Math.max(STORAGE_UPGRADE_TARGET, ANTI_DOWNGRADE_RESERVE);
  }
  // #21 (owner 2026-07-19): in surplus the controller mops up the warchest, but
  // no faster than the upgrader fleet can PHYSICALLY burn it (parking tiles x
  // affordable WORK - see controllerUpgradeCap). Surplus beyond the cap has no
  // upgrader to consume it, so it overflows into the storage sink instead of
  // publishing an infeasible upgrade plan that out-competes remote mining
  // (live t72429680: uncapped 137 e/t against a ~4-upgrader fleet).
  return Math.min(Math.max(totalSupply, 1), physicalUpgradeCap);
}

/** UpgradingCorp's hard upgrader-count cap, mirrored (parking tiles are few). */
const CONTROLLER_UPGRADER_CAP = 8;

/**
 * The controller's PHYSICAL upgrade capacity (energy/tick) for the #21 sink
 * cap: how much the upgrader fleet can actually burn, bounded by the parking
 * tiles ringing the controller input spot and each body's affordable WORK at
 * the room's energy capacity (mirrors UpgradingCorp.upgraderTargetCount's
 * parking bound so the sink and the fleet agree). Infinity when Game or the
 * controller is unavailable, so unit/harness paths keep the uncapped default
 * unless a cap is passed explicitly.
 */
export function controllerUpgradeCap(roomName: string): number {
  if (typeof Game === "undefined" || !Game.rooms) return Infinity;
  const controller = Game.rooms[roomName]?.controller;
  if (!controller) return Infinity;
  try {
    // Best-effort physical estimate: any incomplete Game state (partial test
    // mock, room we cannot fully resolve) falls back to the uncapped default
    // rather than throwing - a missing cap is safe, it only reverts to old
    // behavior; the parking lens needs the live pos/room lookForAt API.
    const parking = controllerParkingTiles(controller, controllerInputSpot(controller).pos).length;
    const spots = Math.min(parking || CONTROLLER_UPGRADER_CAP, CONTROLLER_UPGRADER_CAP);
    const capacity = Game.rooms[roomName]?.energyCapacityAvailable ?? 300;
    const affordableWork = Math.max(1, buildUpgraderBody(capacity, 99, "containerFed").workParts);
    return spots * affordableWork * UPGRADE_ENERGY_PER_WORK;
  } catch {
    return Infinity;
  }
}

/** Ticks over which the agenda's funding need amortizes into a flow rate. */
export const FUND_HORIZON = 50;

/**
 * The spawn's outstanding must-fund bodies (Memory.spawnAgenda.fundingNeed,
 * spec 11) as an energy/tick rate: bank the queued bodies within roughly one
 * re-solve horizon. Stale agendas (spawn busy/skipped > 100 ticks) decay to
 * zero so a dead table entry cannot siphon flow forever.
 */
export function agendaFundingRate(sinkId: string): number {
  if (typeof Memory === "undefined" || typeof Game === "undefined") return 0;
  const spawnId = sinkId.replace("spawn-", "");
  const entry = Memory.spawnAgenda?.[spawnId];
  if (!entry || Game.time - entry.tick > 100) return 0;
  return entry.fundingNeed / FUND_HORIZON;
}

/**
 * A NEW SPAWN's construction site (spec 06 expansion): above ordinary
 * construction so every room funnels its surplus to the founding, below the
 * live spawn network so keeping existing creeps alive still wins. Since
 * spec 18 the anchor lives in the goal's valuation (economy/goals - the
 * measured incident rationale is recorded there); this export is the default
 * profile's value, kept for its doc-reference role.
 */
export const NEW_SPAWN_SITE_VALUE = DEFAULT_VALUATION.newSpawnSite;

/** Controller-curve remaining-progress anchors (fresh L1 / L8-scale grind). */
const CONTROLLER_REMAINING_MIN = 200;
const CONTROLLER_REMAINING_MAX = 10_400_000;

/**
 * Value of a controller sink as a function of PROGRESS REMAINING to the next
 * level (owner directive 2026-07-09): remaining is what prices the marginal
 * energy, so a fresh L1 (200 to go) and a 99%-done level both price high,
 * while a mid-level grind sits near the old flat 50. Anchors: 200 -> 80,
 * 10.4M -> 40, log-interpolated and clamped. At RCL2 (45k) this yields ~60 -
 * still below construction's 70, so "build supersedes upgrade" is preserved
 * until a level is nearly done, exactly the crossover the owner asked for
 * ("if something is 99% to the next RCL level, those marginal points are
 * valuable").
 */
export function controllerValue(remaining: number, val: SinkValuation = DEFAULT_VALUATION): number {
  const k = (val.controllerMax - val.controllerMin) / Math.log(CONTROLLER_REMAINING_MAX / CONTROLLER_REMAINING_MIN);
  const v = val.controllerMax - k * Math.log(Math.max(1, remaining) / CONTROLLER_REMAINING_MIN);
  return Math.min(val.controllerMax, Math.max(val.controllerMin, v));
}

/**
 * Per-INSTANCE sink value (spec 06: "the ONE missing piece"). The planner's
 * DEFAULT_SINK_VALUE stays the kind-level baseline; this differentiates the
 * two cases the expansion economics need: a new-spawn site outprices ordinary
 * construction, and each controller prices by its remaining progress. Live
 * Game lookups are guarded so harness/unit paths fall back to the defaults.
 */
function perInstanceSinkValue(
  kind: SinkKind,
  sink: { gameId?: string; position: Position },
  val: SinkValuation = DEFAULT_VALUATION
): number {
  if (kind === "construction" && typeof Game !== "undefined" && Game.getObjectById && sink.gameId) {
    const site = Game.getObjectById(sink.gameId as Id<ConstructionSite>);
    if (site && site.structureType === "spawn") return val.newSpawnSite;
  }
  if (kind === "controller" && typeof Game !== "undefined" && Game.rooms) {
    const controller = Game.rooms[sink.position.roomName]?.controller;
    if (controller && controller.progressTotal) {
      return controllerValue(controller.progressTotal - controller.progress, val);
    }
  }
  // Kind-level fallback from the goal's valuation (controllerStatic is the
  // no-vision controller anchor - the pre-goal DEFAULT_SINK_VALUE numbers).
  return kind === "spawn"
    ? val.spawn
    : kind === "construction"
    ? val.construction
    : kind === "controller"
    ? val.controllerStatic
    : val.storage;
}

/** Map a FlowGraph sink type to the planner's coarser sink kind. */
function toSinkKind(type: SinkType): SinkKind | null {
  switch (type) {
    case "spawn":
    case "extension":
      return "spawn";
    case "construction":
      return "construction";
    case "controller":
      return "controller";
    case "storage":
      return "storage";
    case "tower":
      // Spawn-network demand (~10 e/t refill through the tender) - spec 07.
      // No tower sinks are DISCOVERED yet (FlowGraph doesn't emit them); this
      // mapping prices the draw the moment they are.
      return "spawn";
    default:
      return null; // terminal/link/lab/factory not modelled as energy sinks yet
  }
}

/**
 * Build the planner's clean world description from the live flow graph.
 *
 * The spawn sink gets its *demand* as capacity (≈10), not 0: unlike the old shadow
 * planner - which only re-sized haulers while FlowSolver still fed the spawn - the
 * CorpPlanner IS the routing authority, so it must deliver the spawn its overhead
 * energy itself. Capacity = demand keeps the spawn fed without letting it (value
 * 100) starve the controller of the surplus.
 */
/**
 * Detect scavengeable ground stocks across visible rooms and turn them into
 * transient sources. Live default for buildColonyProblem; injectable for tests.
 */
export function detectTransientSources(): PlannerSource[] {
  if (typeof Game === "undefined" || !Game.rooms) return [];
  const out: PlannerSource[] = [];
  for (const roomName in Game.rooms) {
    // REMOTE SCAVENGE IS SPILL-ONLY (refining the 2026-07-19 ruling): the
    // original incident was detectRoomStocks summing a remote CONTAINER into
    // the pile, so scavengers siphoned the route's own supply and the colony
    // burned its warchest while the remote "delivered" a trickle. The
    // container stays structurally un-scavengeable here (includeContainers
    // false) - but DROPPED piles in remote rooms are energy nobody's route
    // will ever haul (a demoted source has no route at all; a funded route's
    // spill exceeds its flow-sized haulers) and they DECAY at
    // ceil(amount/1000)/t: measured t72446738, 25k standing at four remote
    // mouths bleeding ~19 e/t - the colony's largest live leak. Threshold
    // 1000 keeps the fleet off harvest jitter; only real spills qualify.
    const owned = !!Game.rooms[roomName].controller?.my;
    const stocks = owned
      ? detectRoomStocks(Game.rooms[roomName])
      : detectRoomStocks(Game.rooms[roomName], REMOTE_SPILL_THRESHOLD, false);
    for (const stock of stocks) {
      const src = stockToTransientSource(stock, `${roomName}-scavenge`, stockSpawnDistance(stock.pos));
      // Micro-route floor (owner 2026-07-20): a sub-floor rate plans a
      // sub-1-CARRY route whose corp lifecycle costs more than it recovers
      // (the E2/E5 churn loop) - leave those piles to opportunistic pickup.
      if (src.rate >= SCAVENGE_RATE_FLOOR) out.push(src);
    }
  }
  return out;
}

/** Remote dropped piles must exceed this to field a scavenger (real spills
 * decay ~1+/t at this size; harvest jitter stays below it). */
export const REMOTE_SPILL_THRESHOLD = 1000;

/** Walking distance estimate from a stock to its nearest spawn (linear-room
 * approximation cross-room) - the effective-ttl input to scavengeRate. */
function stockSpawnDistance(pos: Position): number {
  if (typeof Game === "undefined" || !Game.spawns) return 0;
  let best = Infinity;
  for (const name in Game.spawns) {
    const sp = Game.spawns[name].pos;
    const d =
      sp.roomName === pos.roomName
        ? Math.abs(sp.x - pos.x) + Math.abs(sp.y - pos.y)
        : roomLinearDistance(sp.roomName, pos.roomName) * 50;
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

/**
 * Detect link-served sources across visible rooms: a source with its own link
 * within feeding range, in a room whose core link (beside the storage) exists.
 * Such a source's output emerges at the CORE, so the planner prices and routes
 * its hauling from there (haulPos) while the miner keeps the real distance.
 * Live default for buildColonyProblem; injectable for tests.
 */
export function detectLinkHaulPositions(graph: FlowGraph): Map<string, Position> {
  const out = new Map<string, Position>();
  if (typeof Game === "undefined" || !Game.rooms) return out;
  for (const s of graph.getSources()) {
    const room = Game.rooms[s.position.roomName];
    if (!room) continue;
    const core = coreLink(room);
    if (!core) continue;
    const pos = new RoomPosition(s.position.x, s.position.y, s.position.roomName);
    if (sourceLink(pos, core.id)) {
      out.set(s.id, { x: core.pos.x, y: core.pos.y, roomName: core.pos.roomName });
    }
  }
  return out;
}

/**
 * Detect DEPOSIT PORTS (spec 26, deposit-side mirror of detectLinkHaulPositions):
 * links a mined deposit may turn around at instead of walking to its storage hub.
 * v1 emits CONTROLLER links only - energy dropped there is consumed IN PLACE by
 * the upgraders, which by the LinkRunner backpressure displaces an equal bank->
 * controller relay (bank-neutral), so no drain hauler and no transit toll are
 * needed. (Source links FORWARD to the core, whose core->storage drain is staffed
 * only for the home source's own rate - an unstaffed leg the plan cannot honestly
 * price yet, so they are a follow-up.) The port's headroom is the controller's
 * bank-fed consumption rate (feederRelayRate) - what a mined drop can displace and
 * what the link can drain - a FINITE, plan-computable bound the pricing shares.
 * Requires a storage hub (the port is a shortcut TO that hub). Live default for
 * buildColonyProblem; injectable for tests.
 */
export function detectLinkDepositPorts(): DepositPort[] {
  const out: DepositPort[] = [];
  if (typeof Game === "undefined" || !Game.rooms) return out;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller?.my) continue;
    if (!(room.storage && room.storage.my)) continue; // the hub the port shortcuts to
    const link = controllerLink(room);
    if (!link) continue;
    const banked = room.storage.store.energy ?? 0;
    out.push({ pos: { x: link.pos.x, y: link.pos.y, roomName }, headroom: feederRelayRate(banked) });
  }
  return out;
}

/**
 * Detect SURPLUS storage banks across visible owned rooms and turn each into a
 * transient bank source at its storage position (spec 03 withdrawal, surplus
 * half - see economy/bank.ts). A bank still filling its warchest emits nothing:
 * the deposit half (STORAGE_UPGRADE_TARGET cap) keeps accumulating it. Live
 * default for buildColonyProblem; injectable for tests.
 */
export function detectBankSources(): PlannerSource[] {
  if (typeof Game === "undefined" || !Game.rooms) return [];
  const out: PlannerSource[] = [];
  for (const roomName in Game.rooms) {
    const storage = Game.rooms[roomName].storage;
    if (!storage || !storage.my) continue;
    const banked = storage.store.energy ?? 0;
    const source = bankToTransientSource(roomName, { x: storage.pos.x, y: storage.pos.y, roomName }, banked);
    if (source) out.push(source);
  }
  return out;
}

/**
 * Physical energy room remaining in a room's storage bank. Infinity when there
 * is no live storage to read (harness/unit paths keep the old "soak totalSupply"
 * behavior unchanged). This is the storage sink's true ceiling: while the bank
 * has room it can soak any remote surplus (storage is the hub - owner 2026-07-19
 * "consumption takes from the storage, so it IS a viable sink for remotes");
 * once it reaches ~0 the warchest is topped out and mining beyond the other
 * sinks' capacity has no home, which is exactly the owner's storage-full defund
 * trigger (selectProducers drops whole corps when mining > total sink capacity).
 */
export function storageRoomRemaining(roomName: string): number {
  if (typeof Game === "undefined" || !Game.rooms) return Infinity;
  const storage = Game.rooms[roomName]?.storage;
  if (!storage) return Infinity;
  return storage.store.getFreeCapacity(RESOURCE_ENERGY) ?? Infinity;
}

/**
 * Paved FRACTION of each source's haul route, by GAME id (the receipts in
 * room memory - see RoomMemory.roadRoutes): the binary `paved` receipt reads
 * as 1, an in-progress trunk's survey receipt as built/total (owner
 * 2026-07-20: a 32/38 trunk already fields the 2:1 body - the repricing
 * verdict is roadEconomics.partialPaveRatio, applied in buildColonyProblem).
 * Graph source ids carry a "source-" prefix, so callers match with
 * stripFlowId. Live default for buildColonyProblem; injectable for tests.
 */
export function detectPavedSources(): Map<string, number> {
  const paved = new Map<string, number>();
  if (typeof Game === "undefined" || !Game.rooms) return paved;
  for (const roomName in Game.rooms) {
    const routes = Game.rooms[roomName].memory?.roadRoutes;
    for (const sourceId in routes ?? {}) {
      const e = routes![sourceId];
      if (e.paved) paved.set(sourceId, 1);
      else if (!e.declined && e.total && e.built !== undefined) {
        paved.set(sourceId, Math.min(1, e.built / e.total));
      }
    }
  }
  return paved;
}

export function buildColonyProblem(
  graph: FlowGraph,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  linkHaulPos: Map<string, Position> = detectLinkHaulPositions(graph),
  pavedSources: Map<string, number> = detectPavedSources(),
  bankSources: PlannerSource[] = detectBankSources(),
  remoteInvaderTax: number = INVADER_TAX_PER_ENERGY,
  valuation: SinkValuation = DEFAULT_VALUATION,
  prevBankDraw?: number,
  depositPorts: DepositPort[] = detectLinkDepositPorts()
): ColonyProblem {
  const spawns: PlannerSpawn[] = graph.getSinks("spawn").map(s => ({ id: s.id, pos: s.position }));

  // The invader tax (spec 13 phase 5) applies to sources OUTSIDE spawn
  // rooms: raid frequency is proportional to energy harvested, and at home
  // the tower absorbs the raid for the cost of its shots (~0).
  const spawnRooms = new Set(spawns.map(s => s.pos.roomName));

  const sources: PlannerSource[] = graph.getSources().map(s => {
    // The mid-build repricing verdict (roadEconomics): a route >= 1/2 built
    // already fields the 2:1 body; the fraction rides along so the planner
    // sizes CARRY at the effective (crawl-corrected) distance.
    const paveFrac = pavedSources.get(s.id.replace("source-", ""));
    const pave = paveFrac === undefined ? undefined : partialPaveRatio(paveFrac, 1);
    return {
      id: s.id,
      nodeId: s.nodeId,
      pos: s.position,
      rate: s.capacity,
      maxMiners: s.maxMiners,
      haulPos: linkHaulPos.get(s.id),
      ...(pave && pave.ratio === "2:1" ? { paved: true, pavedFraction: pave.fraction } : {}),
      ...(spawnRooms.has(s.position.roomName) || remoteInvaderTax <= 0 ? {} : { invaderTax: remoteInvaderTax })
    };
  });
  // Sustained income only: what mined sources yield per tick. Transient
  // stocks are real energy but ONE-OFF - sizing standing fleets or the
  // construction absorb rate to them publishes fantasy plans (measured on
  // the shard1 stress fixture: unhauled piles grew, inflating supply until
  // the plan wanted build 140 e/t / 316 CARRY against 20 e/t of mining).
  // PHANTOM GUARD (t72444684 review finding): intel-only PROSPECTS - rooms
  // scouted before their source ids were ever recorded - are not income
  // (live: 31 of 38 candidates were "source-intel-*", 285 e/t of phantom
  // inflating this valve term to 455). Prospects scouted WITH real ids
  // still count (indistinguishable from mined by id alone - an accepted
  // residual, bounded by the fill's bank-pool cap which is funded-credit
  // sized post-solve either way).
  const minedSupply = sources
    .filter(s => !s.id.startsWith("source-intel-") && !s.id.startsWith("intel-"))
    .reduce((sum, s) => sum + s.rate, 0);
  // Ground stocks join as miner-less transient sources (scavenging), and so
  // do SURPLUS storage banks (spec 03 withdrawal: a bank above its warchest
  // is a ground-stock-shaped supply at the storage position).
  sources.push(...transientSources, ...bankSources);
  // Assembly counts (flow v5): which layer dropped the remotes - the graph
  // (nodes), the problem (this assembly), or the solver (candidates) - has
  // been un-nameable in every warmup remote-drop; these three numbers plus
  // candidates[] name it in one capture.
  const assembly = {
    graphSources: graph.getSources().length,
    mined: sources.length - transientSources.length - bankSources.length,
    transient: transientSources.length,
    bank: bankSources.length
  };
  const totalSupply = sources.reduce((sum, s) => sum + s.rate, 0);
  // The warchest surplus draw (spec 03). Unlike scavenge piles this is a
  // DURABLE, tapered supply (bank.ts prices and bounds it), so standing
  // fleets may size to it - it funds the controller today and, below,
  // construction (owner 2026-07-18: "building takes priority over the
  // upgrading... use all the energy in the storage as needed, same as for
  // the upgrader" - the sink ladder already ranks construction 70 above
  // controller 50, so opening the capacity valve is the whole change).
  const bankRate = bankSources.reduce((sum, b) => sum + b.rate, 0);

  // Rooms whose bank is built: their controller stops mopping up the surplus so
  // the storage can soak it (see controllerRoutingCapacity / STORAGE_UPGRADE_TARGET).
  const roomsWithStorage = new Set<string>();
  for (const sink of graph.getSinks()) {
    if (sink.type === "storage") roomsWithStorage.add(sink.position.roomName);
  }
  // Rooms whose bank is in SURPLUS (a bank source was emitted): the warchest is
  // over its target, so the controller cap lifts. The storage sink STAYS (owner
  // 2026-07-19: consumers draw from storage, so it is a valid home for remote
  // surplus - keeping it lets excess production bank instead of rotting at remote
  // containers, #19). The anti-pump is now structural in routeToSinks: bank
  // sources never fill the storage sink, so a solve can never both withdraw the
  // warchest AND deposit to it. The storage sink's capacity is its physical room
  // remaining, so a topped-out bank presents zero room and the surplus mining is
  // defunded rather than rotted.
  const surplusRooms = new Set(bankSources.map(b => b.pos.roomName));

  // HUB-AND-SPOKE (owner 2026-07-19): the storage is the hub - mined income banks
  // to it and consumers draw it back. The bank/hub SOURCE that routeToSinks spends
  // to consumers must carry the mined THROUGHPUT plus the surplus, else at/below
  // target (surplus ~0) consumers have no source and starve. But the mined part
  // is the FUNDED income (~7 sources here), which the adapter CANNOT know - it
  // runs before selectProducers. Sizing it here from all graph sources sent
  // phantom supply (38 candidates = 380 e/t) that construction over-drew,
  // exhausting the parts ledger so real mined never banked (P9->0 live stall
  // t72437535). So the adapter ONLY guarantees a bank source EXISTS for every
  // storage room (rate = its surplus draw, or 0 while filling); planColony adds
  // the funded mined income once the funded set is known. `bankRate`/`totalSupply`
  // stay the real supply (surplus only). selectProducers ignores the bank
  // (transient, maxMiners 0).
  const storageSinkList = graph.getSinks().filter(s => s.type === "storage");
  for (const st of storageSinkList) {
    const room = st.position.roomName;
    if (sources.some(src => src.id === bankSourceId(room))) continue; // surplus bank already emitted
    sources.push({
      id: bankSourceId(room),
      nodeId: `${room}-bank`,
      pos: st.position,
      rate: 0, // filling: no surplus draw yet; planColony credits the funded mined income
      maxMiners: 0,
      transient: true
    });
  }

  // SPEC 25 / filed 2026-07-21: per-site construction capacities share ONE
  // pool absorb budget instead of each carrying the max(5,...) floor - 10
  // road sites summed to 50 e/t of priority-70 demand against a pool that
  // absorbs ~7 (measured t72480337: the freed ledger parts inflated the
  // consumer plan). Pool absorb = the SAME sum-of-projects formula the crew
  // sizes with (primitives.projectAbsorbRate over total remaining work at
  // the farthest site's travel); each site's capacity is its pro-rata share
  // by remaining work. A single site degenerates to exactly the old number.
  const constructionSites = graph
    .getSinks()
    .filter(s => toSinkKind(s.type) === "construction" && s.progressRemaining !== undefined);

  // SOURCE-LOCAL CLUSTERS (spec 25 phase 3, owner: "there shouldn't be any
  // residual - we can just make a bigger builder... consume all the energy
  // from the source mine during that time"): a site nearer to a mined source
  // than that source's hub is the source's whole economy during its build
  // window - local building is ~5x spawn-cheaper per e/t than hauling the
  // unpaved route home. Such clusters price at the SOURCE'S RATE (pro-rata
  // by remaining work), not the completion horizon; the fill's local-build
  // pre-pass then drains the source into its sites and NO residual route
  // exists until the segment's remaining work tapers below the rate (the
  // completion transition). Same nearer-than-hub rule as the fill.
  const storagePositions = graph
    .getSinks()
    .filter(s => s.type === "storage")
    .map(s => s.position);
  const clusterSources = graph
    .getSources()
    .filter(s => !s.id.startsWith("source-intel-") && !s.id.startsWith("intel-"));
  const clusters = new Map<string, { rate: number; remaining: number }>();
  const sinkClusterSource = new Map<string, string>();
  if (storagePositions.length > 0) {
    for (const cs of constructionSites) {
      // HUB-room sites are BANK-funded (G6: a home build-out may absorb the
      // full surplus valve) - source-clustering is for the road-building
      // REMOTES only (owner 2026-07-21), never a home site that merely sits
      // near a source.
      if (roomsWithStorage.has(cs.position.roomName)) continue;
      let bestId: string | null = null;
      let bestRate = 0;
      let bestD = Infinity;
      for (const src of clusterSources) {
        const dSrc = dist(src.position, cs.position);
        const hubD = Math.min(...storagePositions.map(p => dist(src.position, p)));
        if (dSrc < hubD && dSrc < bestD) {
          bestD = dSrc;
          bestId = src.id;
          bestRate = src.capacity;
        }
      }
      if (bestId) {
        sinkClusterSource.set(cs.id, bestId);
        const c = clusters.get(bestId) ?? { rate: bestRate, remaining: 0 };
        c.remaining += cs.progressRemaining ?? 0;
        clusters.set(bestId, c);
      }
    }
  }
  /** A source-local site's capacity: its share of the local source's rate. */
  const clusterCapacity = (sinkId: string, remaining: number): number | undefined => {
    const srcId = sinkClusterSource.get(sinkId);
    if (!srcId) return undefined;
    const c = clusters.get(srcId)!;
    return c.remaining > 0 ? c.rate * (remaining / c.remaining) : 0;
  };

  // The bank-funded pool budget covers only the UNclustered sites (spec 25 /
  // filed 2026-07-21: per-site floors summed to 50 e/t against a pool
  // absorbing ~7 - one horizon budget, pro-rata by remaining work).
  const pooledSites = constructionSites.filter(s => !sinkClusterSource.has(s.id));
  const poolRemaining = pooledSites.reduce((a, s) => a + (s.progressRemaining ?? 0), 0);
  const poolTravel =
    spawns.length === 0 || pooledSites.length === 0
      ? 0
      : Math.max(...pooledSites.map(s => Math.min(...spawns.map(sp => dist(sp.pos, s.position)))));
  const poolAbsorb = poolRemaining > 0 ? projectAbsorbRate(poolRemaining, poolTravel) : 0;

  const sinks: PlannerSink[] = [];
  for (const sink of graph.getSinks()) {
    const kind = toSinkKind(sink.type);
    if (!kind) continue;
    sinks.push({
      id: sink.id,
      kind,
      pos: sink.position,
      value: perInstanceSinkValue(kind, sink, valuation),
      capacity:
        kind === "spawn"
          ? // Overhead need PLUS the agenda's funding need (spec 11 phase 2,
            // owner doctrine "production over consumption"): while the spawn's
            // published queue holds must-fund bodies (blocking, replacement,
            // holdToFund), the solver routes their financing here instead of
            // spilling it to build/controller - the energy arrives exactly
            // while production has something to buy, and reverts to surplus
            // consumption when the queue drains. Measured absence: the
            // reserver waited 1800+ ticks behind chained holds because its
            // 650 never banked (task #30).
            Math.max(sink.demand, 1) + agendaFundingRate(sink.id)
          : kind === "construction"
          ? // Build-out is an INVESTMENT: extensions raise energyCapacity, which
            // raises every body size and the whole colony's energy-per-spawn-part
            // shadow price - worth more than the upgrade it displaces. While
            // sites exist, construction (value 70 > controller 50) may absorb the
            // full surplus and upgrading pauses at its anti-downgrade reserve
            // (the reserve pre-pass guarantees the floor); with no sites there is
            // no construction sink and the controller resumes mopping up. The old
            // flat 5 e/t cap was the measured RCL2->3 bottleneck: a 1-WORK
            // builder against 15k of extensions kept rooms at 300 capacity for
            // thousands of ticks (spec 10 G6, owner directive 2026-07-09).
            // Bounded by MINED supply plus the BANK draw ("within reason"):
            // scavenge piles stay excluded (one-off stocks must not size
            // standing fleets), but the warchest surplus is durable and
            // tapered, so construction may burn it - at 5 e/WORK-tick it
            // turns the bank into finished roads/structures 5x more
            // spawn-cheaply than upgrading burns the same energy.
            // AND by the project's own absorb rate (prod t72444684, E4): the
            // sink's remaining work through the SAME sum-of-projects lens
            // that sizes the crew (primitives.projectAbsorbRate) - without
            // it, one 455-energy site out-priced the controller for the
            // ENTIRE 455 e/t supply, allocated 124 e/t, burned 0.45, and
            // the warchest climbed to 8.3x target while upgrading starved.
            Math.min(
              Math.max(minedSupply + bankRate, 1),
              // Pro-rata share of the POOL absorb (spec 25 / the floor-sum
              // fix): the crew is ONE fleet sized against the whole pool, so
              // per-site demands must sum to what that fleet can eat - not
              // to N independent floors. Horizon travel = the farthest
              // site's spawn distance (the crew must finish the whole pool
              // within its buffered effective life). SOURCE-LOCAL sites
              // (owner: no residual) price at the local source's rate
              // instead - the bigger builder eats the whole mine.
              sink.progressRemaining !== undefined
                ? clusterCapacity(sink.id, sink.progressRemaining) ??
                  (poolRemaining > 0 ? poolAbsorb * (sink.progressRemaining / poolRemaining) : Number.POSITIVE_INFINITY)
                : Number.POSITIVE_INFINITY
            )
          : kind === "storage"
          ? // Soak the surplus, but only up to the bank's PHYSICAL room remaining:
            // a topped-out storage presents zero capacity, which is the owner's
            // defund trigger (mining beyond total sink capacity has no home).
            // While it has room this is min(totalSupply, huge) = totalSupply, so
            // the old "soak excess" behavior is unchanged until the bank fills.
            Math.max(0, Math.min(totalSupply, storageRoomRemaining(sink.position.roomName)))
          : controllerRoutingCapacity(
              sink,
              totalSupply,
              roomsWithStorage,
              surplusRooms,
              controllerUpgradeCap(sink.position.roomName)
            ), // controller: mops up the remainder up to the fleet's physical upgrade rate (#21); the excess banks to storage
      reserve: kind === "controller" ? ANTI_DOWNGRADE_RESERVE : undefined
    });
  }

  // Standing-infra spawn load (spec 15 P4): the feeder shuttle sized to the
  // bank relay, the tender detail, one reserver per mined remote room - real
  // bodies the plan implies but never commissions through routeToSinks.
  // Deducted from the planner's spawn-parts ledger so the sink fill spends
  // only what the spawn can truly still build.
  const remoteRooms = new Set(
    sources.filter(s => !s.transient && !spawnRooms.has(s.pos.roomName)).map(s => s.pos.roomName)
  );
  // FEEDER PRICED AT THE REALIZED DRAW (prod t72447444, the starvation
  // loop): pricing the relay at the FULL surplus (15 + bankRate = 115 live)
  // charged 64p of infra for a relay whose actual consumers - starved by
  // that very charge - drew ~2 e/t. Self-fulfilling: feeder priced for big
  // consumers is WHY consumers stay small. The relay now prices at the
  // PREVIOUS solve's realized bank draw, floored at STORAGE_UPGRADE_TARGET
  // (so it can ratchet UP from the floor: cheap feeder -> parts free ->
  // bigger consumer allocation -> next solve prices the feeder for it;
  // converges in <=2 solves both directions). No history (first solve,
  // harness, golden master) keeps the old full-surplus pricing.
  const pricedRelay =
    prevBankDraw !== undefined
      ? Math.min(STORAGE_UPGRADE_TARGET + bankRate, Math.max(STORAGE_UPGRADE_TARGET, prevBankDraw))
      : STORAGE_UPGRADE_TARGET + bankRate;
  // Link-fed depots price the feeder at the storage->core-link leg (spec 24
  // rung 3) - the SAME controllerLink lens the corp's sizing reads.
  let linkFedRooms = 0;
  if (typeof Game !== "undefined" && Game.rooms) {
    for (const roomName of roomsWithStorage) {
      const room = Game.rooms[roomName];
      if (room && controllerLink(room)) linkFedRooms++;
    }
  }
  const infraPartsPerTick = infraSpawnLoad(pricedRelay, roomsWithStorage.size, remoteRooms.size, linkFedRooms);

  return {
    assembly,
    spawns,
    sources, sinks, dist, infraPartsPerTick, depositPorts };
}

/**
 * Solve the colony economy with the CorpPlanner and return a FlowSolution.
 * Drop-in replacement for FlowSolver.solve / solveIteratively.
 */
/** Energy/tick one WORK part consumes at each consumer (for roster sizing). */
const ENERGY_PER_WORK = { upgrade: 1, build: 5 } as const;

/**
 * Publish the commissioned roster to Memory.economyPlan so tooling (the
 * plan-vs-spawn harness, telemetry) can compare what the single planner asked
 * for against what was actually fielded. Same shape the shadow planner used to
 * write, now sourced from the live CorpPlanner.
 */
function publishRoster(plan: ReturnType<typeof planColony>): void {
  if (typeof Memory === "undefined") return;
  const corps: Record<string, unknown>[] = [];
  for (const m of plan.miners) {
    corps.push({ kind: "mine", work: Math.max(1, Math.ceil(m.rate / 2)), sourceId: m.sourceId, spawnId: m.spawnId });
  }
  for (const h of plan.haulers) {
    // Bank flows are executed by the depot movers (tender/feeder), never by a
    // spawnable CarryCorp - publishing them would be permanent phantom variance
    // for the plan-vs-fielded gauges.
    if (h.sourceId.startsWith("bank-")) continue;
    corps.push({
      kind: "haul",
      carry: Math.max(1, Math.ceil(h.carryParts)),
      fromId: h.sourceId,
      toId: h.sinkId,
      spawnId: h.spawnId,
      // Deposit port (spec 26): the link this route turns around at (shrinks
      // its carry). Present only on ported routes - the plan-vs-fielded gauge
      // and the grid read it to confirm the shortcut was priced.
      ...(h.depositPos ? { port: h.depositPos } : {})
    });
  }
  for (const k of plan.sinks) {
    if (k.allocated <= 1e-9) continue;
    if (k.kind === "controller") {
      corps.push({
        kind: "upgrade",
        work: Math.max(1, Math.ceil(k.allocated / ENERGY_PER_WORK.upgrade)),
        sinkId: k.sinkId
      });
    } else if (k.kind === "construction") {
      corps.push({
        kind: "build",
        work: Math.max(1, Math.ceil(k.allocated / ENERGY_PER_WORK.build)),
        sinkId: k.sinkId
      });
    }
  }
  (Memory as { economyPlan?: unknown }).economyPlan = {
    corps,
    overhead: Number(plan.totalOverhead.toFixed(2)),
    unrouted: Number((plan.totalProduced - plan.totalDelivered).toFixed(2))
  };
}

export function solveWithCorpPlanner(
  graph: FlowGraph,
  tick = 0,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  bankSources: PlannerSource[] = detectBankSources()
): FlowSolution {
  return solveColony(graph, tick, dist, transientSources, bankSources).solution;
}

/**
 * Solve the colony ONCE and return both representations of the result:
 *  - solution: the FlowSolution the live materializer/telemetry consume today;
 *  - commissions: the same plan wrapped as Commission envelopes (the framework
 *    seam - what the corp kinds materialize from).
 * Both come from a single planColony() call, so surfacing commissions for the
 * rung-5 cutover costs no extra solve. commissionsFromPlan is used (not
 * planCommissions) so the adapter stays free of kind-registry side effects -
 * auxiliary kinds propose() in the host, not here.
 */
export function solveColony(
  graph: FlowGraph,
  tick = 0,
  dist: ColonyProblem["dist"] = pathDistance,
  transientSources: PlannerSource[] = detectTransientSources(),
  bankSources: PlannerSource[] = detectBankSources(),
  goal?: Goal,
  prevBankDraw?: number
): { solution: FlowSolution; commissions: Commission[]; adopted: { sourceId: string; spawnId: string; gain: number }[] } {
  const baseProblem = buildColonyProblem(
    graph,
    dist,
    transientSources,
    detectLinkHaulPositions(graph),
    detectPavedSources(),
    bankSources,
    INVADER_TAX_PER_ENERGY,
    compileGoal(goal),
    prevBankDraw
  );
  // THE STRATEGIC SEARCH (spec 18 P1, live from day one): planColony is the
  // evaluator; the searcher may pin budget-dropped sources to spawns with
  // slack. Under the default goal on a status-quo-optimal world it adopts
  // nothing and the plan is bit-identical to the plain solve (the pin).
  const searched = searchStructure(baseProblem);
  const problem = searched.problem;
  const plan = searched.plan;
  publishRoster(plan);
  const commissions = commissionsFromPlan(problem, plan);

  const miners: MinerAssignment[] = plan.miners.map(m => ({
    sourceId: m.sourceId,
    nodeId: m.nodeId,
    spawnId: m.spawnId,
    spawnDistance: m.distance,
    harvestRate: m.rate,
    spawnCostPerTick: minerOverhead(m.distance),
    maxMiners: m.maxMiners,
    efficiency: m.efficiency
  }));

  // The ONE CommissionedHauler -> HaulerAssignment mapper, shared with
  // carryKind.materialize (solver-bridge pin): paved verdict, spawnParts, and
  // the spec-26 depositPos all ride through identically on both paths.
  const haulers: HaulerAssignment[] = plan.haulers.map(haulerAssignmentFromCommissioned);

  const sinkTypeById = new Map(graph.getSinks().map(s => [s.id, s.type]));
  const sinkAllocations: SinkAllocation[] = plan.sinks.map(k => ({
    sinkId: k.sinkId,
    sinkType: sinkTypeById.get(k.sinkId) ?? "controller",
    allocated: k.allocated,
    demand: k.demand,
    unmet: Math.max(0, k.demand - k.allocated),
    priority: k.value,
    ...(k.partsLeft !== undefined ? { partsLeft: k.partsLeft } : {}),
    sourceFlows: k.sources.map(sf => ({ sourceId: sf.sourceId, amount: sf.amount, distance: sf.distance }))
  }));

  const totalHarvest = plan.totalProduced;
  const miningOverhead = miners.reduce((s, m) => s + m.spawnCostPerTick, 0);
  const haulingOverhead = haulers.reduce((s, h) => s + h.spawnCostPerTick, 0);
  const totalOverhead = miningOverhead + haulingOverhead;
  const netEnergyTotal = totalHarvest - totalOverhead;

  const unmetDemand = new Map<string, number>();
  for (const a of sinkAllocations) if (a.unmet > 0) unmetDemand.set(a.sinkId, a.unmet);

  const solution: FlowSolution = {
    miners,
    haulers,
    sinkAllocations,
    partsLedger: plan.partsLedger,
    ...(problem.assembly ? { assembly: problem.assembly } : {}),
    totalHarvest,
    miningOverhead,
    haulingOverhead,
    totalOverhead,
    netEnergy: netEnergyTotal,
    efficiency: totalHarvest > 0 ? (netEnergyTotal / totalHarvest) * 100 : 0,
    unmetDemand,
    isSustainable: netEnergyTotal >= 0,
    warnings: [],
    computedAt: tick,
    sourceVerdicts: plan.sourceVerdicts
  };
  return { solution, commissions, adopted: searched.adopted };
}

/** Re-export for the integration site. */
export type { Position };
