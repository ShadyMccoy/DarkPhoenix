/**
 * @fileoverview haulPolicy - the hauler fleet's pure routing/banking POLICY
 * (spec 35 phase H: CarryCorp's exported pure-policy head, moved verbatim).
 *
 * Layer: corps-side policy, Game/Memory-free by construction (pinned by the
 * purity ratchet, test/unit/economy/purity.test.ts). Every decider here is a
 * pure function of its arguments so it can be unit tested directly: which
 * local sink a load commits to, when a controller-bound hauler banks in
 * storage vs feeds the controller directly, where a storage deposit lands
 * (port / hub / wait), when a spawn-circuit hauler refills from the core
 * depot, when a dedicated build source's surplus is drained, and how a
 * hauler alive-tick is classified for the duty meter.
 *
 * CarryCorp (the corp RUNTIME: work loops, delivery legs, recycling) supplies
 * the world state and reads these deciders; UpgradingCorp reads
 * CONTROLLER_STARVE_FLOOR so the upgrader's starvation gauge agrees with the
 * haulers' banking rule. Economic FORMULAS do not live here - they stay in
 * economy/primitives.ts (the one-home rule).
 *
 * @module corps/haulPolicy
 */

import { CoreDepot } from "./nodeEnergy";
import { Position } from "../types/Position";

/** Transport fee per energy unit (base cost before margin) */

/**
 * Decide which local sink a CarryCorp should deliver its next load to, balancing
 * deliveries across the node's sinks in proportion to the flow solver's
 * allocations (each assignment's flowRate). `delivered` is the running count of
 * loads sent to each sink so far. Pure so it can be unit tested directly.
 *
 * Sinks are classified by their flow `toId`: a "controller-*" destination is the
 * controller; anything else (spawn/extension network) is treated as the spawn.
 */
export type LocalSink = "spawn" | "controller" | "founding" | "storage";

/**
 * Free capacity (energy) in the spawn network at or above which a hauler diverts
 * to refill it before anything else. The spawn + extensions are the colony's
 * most important sink - nothing can be spawned without them - but their flow
 * allocation is only the small staffing overhead, so a purely proportional split
 * lets the high-volume controller starve them. One extension's worth of free
 * space is enough to act on; smaller dribbles are left to the proportional split.
 */
export const SPAWN_PRIORITY_FREE_CAPACITY = 50;

/**
 * Fill fraction below which a controller-bound hauler abandons its route to
 * refill the spawn network. The spawn keeps priority when it is seriously
 * depleted (would soon block spawning), but once it is at least this full the
 * controller gets its allocated share. Without this gate the controller hauler
 * diverted on a single empty extension (free >= 50, i.e. anything short of 100%
 * full) every trip, so the controller never received energy and RCL2 stalled.
 */
const SPAWN_DIVERT_FILL = 0.5;

/**
 * Energy staged at the controller input below which a controller-bound hauler
 * feeds the controller DIRECTLY instead of banking in storage. While the input
 * holds at least this much buffer, the feeder (or the residual buffer itself)
 * keeps the upgraders fed, so haulers bank; only when the buffer runs low is the
 * controller genuinely at risk and a hauler steps in with a direct delivery.
 * Sized as a working buffer, not a full container - well under the feeder's
 * CONTROLLER_FEED_TARGET so normal feeder operation never trips it.
 */
export const CONTROLLER_STARVE_FLOOR = 200;

/**
 * Should a controller-bound hauler BANK its load in storage rather than haul it
 * to the controller drop-off tile? Yes whenever a storage bank has room AND
 * either a feeder is actively relaying the bank to the controller OR the
 * controller input still holds a working buffer.
 *
 * This is the fix for the recurring RCL-drop-off jam: the redirect used to be
 * gated SOLELY on `controllerFeederActive`, so the instant the single, non-blocking
 * feeder died (or before it first spawned) every controller-bound hauler in the
 * fleet reverted to the ONE drop tile at once - the measured pile-up. Keying the
 * redirect off the input buffer instead means a transient feeder gap no longer
 * stampedes the fleet onto the tile: haulers keep banking while the buffer lasts
 * (giving the feeder time to respawn), and only step in directly if the buffer
 * actually runs down with no feeder servicing it (genuine starvation - the
 * anti-downgrade fallback). Pure so the routing rule is unit-testable.
 */
export function shouldBankControllerLoad(params: {
  /** A storage exists, is ours, and has free capacity for the load. */
  hasBankCapacity: boolean;
  /** A live feeder is relaying storage -> controller this tick. */
  feederActive: boolean;
  /** Energy staged at the controller input right now (container/link + piles). */
  controllerInputStock: number;
  /** Override the starvation floor (defaults to {@link CONTROLLER_STARVE_FLOOR}). */
  starveFloor?: number;
}): boolean {
  if (!params.hasBankCapacity) return false; // no bank -> the controller must be fed directly
  return params.feederActive || params.controllerInputStock >= (params.starveFloor ?? CONTROLLER_STARVE_FLOOR);
}

/**
 * Where a storage-bound (deposit) load should go THIS tick (spec 26): the plan's
 * DEPOSIT PORT (a controller link the hauler turns around at early) when one was
 * chosen and it has room, else the storage hub, else nowhere. Returning "none"
 * (port full AND storage full) lets deliverToStorage return false so deliverEnergy
 * spills the load to a hungry spawn/controller instead of camping the port - the
 * same escape valve the pre-port code relies on. Pure so it is unit-testable, and
 * the delivery reads the plan's chosen port rather than re-deriving one (delivery/
 * pricing symmetry - the staffsPost-symmetry class).
 */
export function pickStorageDeposit(params: {
  /** The port the plan priced this route to (undefined = no port, haul the hub leg). */
  depositPos?: Position;
  /** Free capacity in the port link right now (0 when full or the link is gone). */
  portFree: number;
  /** Free capacity in the storage hub right now. */
  storageFree: number;
  /** Ticks this hauler has already held at a FULL port this trip (0 = not waiting yet). */
  portWaitedTicks?: number;
}): "port" | "storage" | "wait" | "none" {
  if (params.depositPos && params.portFree > 0) return "port";
  // Port full (or no port). If the hub is ALSO full there is nowhere to bank -
  // spill to a hungry spawn/controller (the escape valve; never camp a full port).
  if (params.storageFree <= 0) return "none";
  // Port full but the plan routed us here: HOLD at the link rather than bouncing
  // to the hub (owner 2026-07-24). A source link fires to the core within its
  // cooldown, so runt-rebuild core congestion clears in a few ticks - walking to
  // storage and turning back on every transient fill is the reported bounce. The
  // wait is BOUNDED: a chronically full port (core drain stuck, not just a
  // rebuild blip) still falls back and delivers, so a hauler can never camp a
  // dead port forever - the spec-26 v1 stall guard.
  if (params.depositPos && (params.portWaitedTicks ?? 0) < PORT_WAIT_CAP) return "wait";
  return "storage";
}

/**
 * How long a port hauler holds at a FULL deposit link before giving up and
 * hauling the remainder to the hub (spec 26, owner 2026-07-24). ~2 source-link
 * cooldowns: long enough to ride out the runt-rebuild core congestion that
 * transiently blocks the link's fire, short enough that a genuinely stuck port
 * still delivers rather than stranding the load aboard a parked hauler.
 */
export const PORT_WAIT_CAP = 30;

/**
 * Small energy buffer kept in the core depot so the extension tender always has a
 * load on hand. Deliberately modest: it only needs to bridge between hauler drop-offs,
 * not bankroll the whole network - a large buffer would pull haulers off the
 * controller to keep refilling the depot (the energy split is the flow solver's job).
 */
export const DEPOT_BUFFER = 150;

/**
 * Energy the spawn-circuit haulers keep BANKED in a real storage before spilling
 * surplus to the controller. A container depot only bridges between hauler
 * drop-offs (DEPOT_BUFFER); storage is the colony's bank - hold a real reserve
 * for spawn surges and downgrade insurance. Banking only redirects haulers
 * already on the spawn circuit (deliverToSpawn), never diverts controller-bound
 * ones (spawnNetworkHungry still uses the small bridge buffer), so the flow
 * solver's spawn/controller split is preserved while the bank slowly fills.
 */
const STORAGE_BANK = 10000;

/** The fill level deliverToSpawn tops the depot to before spilling surplus on. */
export function depotBankTarget(depot: CoreDepot): number {
  return depot.structureType === STRUCTURE_STORAGE ? STORAGE_BANK : DEPOT_BUFFER;
}

/**
 * Fill fraction at which a dedicated build source's container marks the crew as
 * NOT KEEPING PACE. This is the consumption-lag lens, not a fallback (first
 * retired 2026-07-28 on the owner's "fallback we don't need", RESTORED the same
 * day after the grid voted twice): standing bodies overstate real burn - a
 * 2x1-WORK crew walking between sites reads as 10 e/t of capability and
 * measures ~5 e/t of throughput (haul-t4-refill-sla-under-churn breached its
 * SLA deterministically @211 and fid-t5-real-maze's gross collapsed 50->16%
 * when the stand-down went unconditional) - while stock backing up at the
 * source is the macro doctrine's own actual-capability signal (the same
 * stock-grounded lens as sustainableConsumptionRate). Above this the source's
 * haulers keep their routes and the un-eaten output flows home. The clean
 * retirement path is a MEASURED-burn reservation gauge - spec 34 open item,
 * owner-gated.
 */
const DEDICATED_SOURCE_DRAIN_FILL = 0.5;

/**
 * Dropped energy (within range 1 of a dedicated build source) above which the
 * source's haulers keep hauling instead of yielding - the ground-pile analogue
 * of DEDICATED_SOURCE_DRAIN_FILL for a container-less source, where the miner
 * drops straight on the ground and the pile decays while it waits.
 */
const DEDICATED_SOURCE_DRAIN_PILE = 300;

/**
 * Whether a hauler on the dedicated build source should keep hauling (drain the
 * surplus) rather than yield: true when energy is backing up - a container past
 * the drain fill, OR a ground pile past the drain threshold - meaning the crew
 * is not consuming the source's full output whatever its body count says. Pure
 * so it can be unit tested directly.
 */
export function shouldDrainDedicatedSource(
  containerEnergy: number | null,
  containerCapacity: number,
  groundPile: number
): boolean {
  if (containerEnergy !== null && containerCapacity > 0) {
    if (containerEnergy >= containerCapacity * DEDICATED_SOURCE_DRAIN_FILL) return true;
  }
  return groundPile >= DEDICATED_SOURCE_DRAIN_PILE;
}

/**
 * Should an empty spawn-circuit hauler REFILL from the core depot (the degraded,
 * tender-less bridge) instead of trekking to its own source this tick? Only when
 * the depot is a real, NEARBY bank that is at least as close as the hauler's own
 * source pickup.
 *
 * The depot short-circuit (see pickupEnergy) exists to save a spawn-side hauler a
 * full source round-trip when the bank sits one tile from the spawn. Without a
 * sense of distance it had none: an empty hauler out at - or walking toward - a
 * far or remote source was hauled all the way back to the core depot every tick
 * the home network was short, delivering already-home energy to the spawn while
 * its source's pile stranded, and U-turning across the room border mid-route.
 * That is the observed "empty hauler heading back home" symptom.
 *
 * `rangeToDepot` is Infinity when the depot is a room away (it lives beside the
 * home spawn, so off-room it is never the near bank); `rangeToPickup` is Infinity
 * when the source is out of the creep's room this tick, so a hauler AT HOME still
 * tops up from the depot rather than run a whole remote round-trip. Pure so the
 * locality rule is unit-testable.
 */
export function shouldRefillFromDepot(params: {
  /** Energy banked in the core depot right now. */
  depotEnergy: number;
  /** Free energy capacity across the spawn network (capacity - available). */
  networkNeed: number;
  /** Tiles from the hauler to the depot, or Infinity when the depot is off-room. */
  rangeToDepot: number;
  /** Tiles from the hauler to its source pickup, or Infinity when off-room/unknown. */
  rangeToPickup: number;
}): boolean {
  if (params.depotEnergy <= 0) return false; // nothing banked to lend
  if (params.networkNeed <= 0) return false; // spawn network already full
  // The depot must be a real, nearby bank (finite range) AND no farther than the
  // source - otherwise the hauler just heads to its source and picks up as usual.
  return Number.isFinite(params.rangeToDepot) && params.rangeToDepot <= params.rangeToPickup;
}

/**
 * Is the spawn network critically low ENOUGH to steal a controller-bound
 * hauler's trip, given the energy already aboard fleet-mates committed to the
 * spawn this trip? "Critical" must mean "and help is not already on the way":
 * during buildout the bank sits below the raw {@link SPAWN_DIVERT_FILL} gate
 * almost continuously (every spawn drains 200-500 from a 300-550 pool), so a
 * store-only test diverts the controller hauler on EVERY flip and the flow
 * solver's controller allocation - including the anti-downgrade reserve - is
 * never physically delivered (controller progress measured at zero for 700+
 * ticks; grid cells haul-t1-circuit-split / plan-t1-single-source-loop).
 * Counting inbound committed cargo keeps the true emergency behavior (nothing
 * inbound -> divert) while letting the controller keep its share whenever the
 * deficit is already covered. Pure so it can be unit tested directly.
 */
export function isSpawnNetworkCritical(used: number, capacity: number, inboundCommitted: number): boolean {
  if (capacity <= 0) return false;
  return (used + inboundCommitted) / capacity < SPAWN_DIVERT_FILL;
}

/**
 * Choose which local sink to commit a load to. The spawn network has strict
 * priority: whenever it has real free capacity, fill it first regardless of the
 * proportional allocation (the spawn is critical but small, so it tops up fast
 * and the surplus then flows on to construction/controller). Otherwise fall back
 * to the flow-proportional split. Pure so it can be unit tested directly.
 */
export function pickDeliverySink(
  spawnFreeCapacity: number,
  assignments: { toId: string; flowRate: number }[],
  delivered: { [sink: string]: number }
): LocalSink {
  if (spawnFreeCapacity >= SPAWN_PRIORITY_FREE_CAPACITY) return "spawn";
  return pickSinkByAllocation(assignments, delivered);
}

export function pickSinkByAllocation(
  assignments: { toId: string; flowRate: number }[],
  delivered: { [sink: string]: number },
  foundingSinks: ReadonlySet<string> = new Set()
): LocalSink {
  // Haulers serve the spawn network and the controller. IN-ROOM construction is
  // deliberately excluded - feeding builders is the construction tankers' job, not
  // the haulers' - so a local construction route never pulls a hauler off its
  // circuit. CROSS-ROOM construction (the expansion FOUNDING, spec 06) is the
  // exception: tankers are intra-room apparatus, so a route that crosses a border
  // has no tanker shortcut and the hauler runs it like any other circuit.
  const flows: Record<LocalSink, number> = { spawn: 0, controller: 0, founding: 0, storage: 0 };
  for (const a of assignments) {
    if (a.toId.startsWith("controller-")) flows.controller += a.flowRate;
    else if (a.toId.startsWith("storage-")) flows.storage += a.flowRate;
    else if (a.toId.startsWith("construction-")) {
      if (foundingSinks.has(a.toId)) flows.founding += a.flowRate;
    } else flows.spawn += a.flowRate;
  }

  // Pick whichever sink with positive allocated flow is furthest behind its
  // share so far, distributing loads in proportion to the flow solver's per-sink
  // allocations.
  let best: LocalSink = "spawn";
  let bestScore = Infinity;
  let anyPositive = false;
  for (const sink of ["spawn", "controller", "founding", "storage"] as const) {
    if (flows[sink] <= 0) continue;
    anyPositive = true;
    const score = (delivered[sink] ?? 0) / flows[sink];
    if (score < bestScore) {
      bestScore = score;
      best = sink;
    }
  }
  return anyPositive ? best : "spawn";
}

/** How a hauler spent one alive-tick (owner 2026-07-25 execution meter). */
export type HaulerDutyClass = "active" | "idleSource" | "idleSink";

/**
 * Classify one hauler alive-tick from realized state changes since last tick.
 * "Are fielded haulers executing efficiently, or waiting?" - the read that
 * disambiguates a plan under-ask (a: high duty, buffers still grow because the
 * carry is inflow-sized) from an execution loss (c: haulers idle/blocked).
 *
 *   - active:     moved OR transacted (withdrew/transferred) - real progress.
 *   - idleSource: stationary AND no transaction while EMPTY - waiting or
 *                 blocked on the load leg. High + a full source buffer is the
 *                 execution smoking gun (energy is right there, unhauled).
 *   - idleSink:   stationary AND no transaction while LOADED - waiting or
 *                 blocked on the deliver leg (sink full / port clamped /
 *                 traffic). A backpressure signal.
 *
 * Realized (moved = position actually changed), so a blocked creep that issued
 * a move intent counts as idle, not active. Pure.
 */
export function classifyHaulerTick(moved: boolean, transacted: boolean, loaded: boolean): HaulerDutyClass {
  if (moved || transacted) return "active";
  return loaded ? "idleSink" : "idleSource";
}
