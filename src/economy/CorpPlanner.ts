/**
 * @fileoverview CorpPlanner - GOAP-style exploratory economy planner whose
 * operators are corps.
 *
 * This is the SINGLE economy authority the colony is being consolidated onto. It
 * replaces two overlapping solvers - FlowSolver (which sources to mine) and the
 * shadow EconomyPlanner (how to value-route energy) - with one pure function over
 * a clean world description.
 *
 * The plan is built in two phases, each a GOAP operator class:
 *
 *   1. PRODUCER SELECTION - commission HarvestCorps. Each source is assigned to
 *      its nearest spawn; unprofitable sources (netEnergy <= 0) are never mined;
 *      per spawn, sources are taken in net-energy-per-build-part order until the
 *      spawn's mining build-time budget is spent (the best source is always
 *      staffed even if it alone exceeds budget). This is the corp-atomic rule -
 *      complete the highest-value income corp before opening the next - per spawn.
 *
 *   2. VALUE ROUTING - commission CarryCorps and size the consumer sinks. The
 *      gross energy the selected sources produce is routed to sinks by value:
 *      a reserve pre-pass guarantees critical floors (anti-downgrade), then a
 *      value-descending pass fills each sink up to its capacity, pulling from the
 *      nearest sources first. Each source->sink flow becomes a hauler.
 *
 * Everything economic comes from economy/primitives. The planner is deterministic
 * (ties broken by id) and free of Screeps globals, so it is fully unit-testable
 * from first principles and generalises from 1 spawn/source to N by construction.
 *
 * @module economy/CorpPlanner
 */

import { Position } from "../types/Position";
import {
  netEnergy,
  spawnPartsFor,
  carryPartsFor,
  constructionWorkSpawnLoad,
  controllerWorkSpawnLoad,
  effectiveLife,
  minerOverhead,
  haulerOverhead,
  miningBudgetPerSpawn,
  MINER_PARTS,
  SPAWN_PARTS_PER_TICK
} from "./primitives";
import { effectiveOneWayTiles } from "./roadEconomics";

// =============================================================================
// INPUT - a clean description of the world the planner reasons over
// =============================================================================

export interface PlannerSpawn {
  id: string;
  pos: Position;
}

export interface PlannerSource {
  id: string;
  nodeId: string;
  pos: Position;
  /** Gross energy/tick the source yields (capacity/300, <=10 standard). */
  rate: number;
  /** Walkable mining spots adjacent to the source. */
  maxMiners: number;
  /**
   * Where the source's OUTPUT is picked up, when not at the source itself: a
   * link-served source's energy emerges at the core link beside the storage, so
   * its hauling is priced (and routed) from there while the miner's own distance
   * stays the real walk to the source. Defaults to `pos`.
   */
  haulPos?: Position;
  /**
   * A transient source - a ground energy stock (dropped pile / tombstone / ruin)
   * that is ALREADY harvested. It needs no miner: only a scavenger hauls it home.
   * Its `rate` is a bounded drain rate; it lasts only until the stock is gone, at
   * which point re-detection drops it from the world and scavenging demobilises.
   */
  transient?: boolean;
  /**
   * The source's haul route fields the 2:1 road body - 1.5 spawn parts per
   * CARRY instead of 2 - which the routing pass prices in. Set from
   * ConstructionCorp's receipts via roadEconomics.partialPaveRatio: fully
   * paved, or a trunk verifiably >= 1/2 built (owner 2026-07-20: "32 out of
   * 38 - we could still optimize the body parts").
   */
  paved?: boolean;
  /**
   * Verified paved fraction of the route (present with `paved`; absent means
   * 1). Below 1 the 2:1 body's loaded leg crawls the unpaved stretch, so
   * CARRY sizes at the EFFECTIVE distance (roadEconomics.effectiveOneWayTiles)
   * - the fleet must cover the true round-trip time until the last tile lands.
   */
  pavedFraction?: number;
  /**
   * Strategic pin (spec 18): the searcher assigns this source to a SPECIFIC
   * spawn instead of the nearest-spawn default - the v0 restructuring
   * operator (a source the nearest spawn's budget dropped can be worked by
   * another spawn with slack). Absent = nearest, the pinned behavior.
   */
  assignedSpawnId?: string;
  /**
   * Expected NPC-invader cost per unit harvested (spec 13 phase 5): raids
   * fire as a function of energy harvested, so their defense cost is a
   * per-energy tax. Set by the adapter for sources outside spawn rooms
   * (towers make the home tax ~0); subtracted from the source's net in
   * producer selection so both the profitability gate and the
   * net-per-build-part ranking price the raid reality.
   */
  invaderTax?: number;
}

export type SinkKind = "spawn" | "controller" | "construction" | "storage";

export interface PlannerSink {
  id: string;
  kind: SinkKind;
  pos: Position;
  /** Colony value per energy/tick delivered here. Higher = filled first. */
  value: number;
  /** Max energy/tick the sink wants and can absorb. */
  capacity: number;
  /** Guaranteed floor filled before the value pass (e.g. anti-downgrade). */
  reserve?: number;
}

export interface ColonyProblem {
  /** Assembly counts (flow v5): how many sources each layer contributed. */
  assembly?: { graphSources: number; mined: number; transient: number; bank: number };
  spawns: PlannerSpawn[];
  sources: PlannerSource[];
  sinks: PlannerSink[];
  /** Real walking distance between two positions (e.g. cached pathDistance). */
  dist: (a: Position, b: Position) => number;
  /**
   * Spawn build-time (parts/tick) of standing infrastructure the plan implies
   * but does not commission here (feeder shuttle, tender detail, reservers) -
   * primitives.infraSpawnLoad, computed by the flow adapter. Deducted from
   * the spawn-parts ledger before the sink fill spends the rest (spec 15 P4).
   */
  infraPartsPerTick?: number;
  /**
   * Execution-context facts for auxiliary propose() triggers, assembled by
   * the HOST (spec 17 P3): propose is a pure function of (problem, draft), so
   * anything a trigger used to steal from Game/Memory/execution state rides
   * on the problem instead. Absent = the fact is false/unknown.
   */
  /** A live expansion campaign (claimKind's trigger). Host: Memory.expansion. */
  expansion?: { roomName: string };
  /** CPU-governor degradation freezes (scoutKind's gate). Host: CpuGovernor. */
  freezes?: { scouting?: boolean };
  /** Rooms marked hostile by the vision-free defense lens (RoomDiscovery). */
  hostileRooms?: readonly string[];
}

/** Canonical single value model (replaces mintValue/net-energy/effectiveNet/sink.value). */
export const DEFAULT_SINK_VALUE: Record<SinkKind, number> = {
  spawn: 100, // keeping creeps alive - mandatory
  construction: 70, // building raises capacity - worth more than raw upgrade
  controller: 50, // upgrading - mops up the remainder
  storage: 1 // buffer - soaks excess only
};

// =============================================================================
// OUTPUT - the commissioned corps (the plan)
// =============================================================================

export interface CommissionedMiner {
  sourceId: string;
  nodeId: string;
  spawnId: string;
  distance: number;
  rate: number;
  spawnParts: number;
  netEnergy: number;
  efficiency: number;
  maxMiners: number;
}

export interface CommissionedHauler {
  sourceId: string;
  sinkId: string;
  spawnId: string;
  distance: number;
  flowRate: number;
  carryParts: number;
  spawnParts: number;
  /** Route is paved: spawn the haulers at the 2:1 road CARRY:MOVE ratio. */
  paved?: boolean;
}

export interface CommissionedSink {
  sinkId: string;
  kind: SinkKind;
  value: number;
  demand: number;
  allocated: number;
  sources: { sourceId: string; amount: number; distance: number }[];
  /** Spawn-parts ledger remaining when this sink's fill ENDED (spec 15 P4
   * trace - why did filling stop: capacity met, pool dry, or ledger dry). */
  partsLeft?: number;
}

/**
 * The pricing verdict for one non-transient mining candidate (spec 14 phase 5
 * - decision symmetry for the planner). selectProducers was the last silent
 * decision in the economy: a source absent from the plan was indistinguishable
 * from one priced out by the invader tax or dropped for build-time budget.
 * `net` and `tax` are the exact terms the funding decision compared;
 * `tax` is the invader-tax TERM in energy/tick (invaderTax * rate).
 */
export interface SourceVerdict {
  sourceId: string;
  rate: number;
  distance: number;
  net: number;
  tax: number;
  parts: number;
  verdict: "funded" | "unprofitable" | "over-budget" | "no-spawn" | "unreachable" | "no-sink" | "unrouted";
}

export interface ColonyPlan {
  miners: CommissionedMiner[];
  haulers: CommissionedHauler[];
  sinks: CommissionedSink[];
  /** Per-candidate funding verdicts for every non-transient source. */
  sourceVerdicts: SourceVerdict[];
  /** Gross energy/tick produced by selected sources. */
  totalProduced: number;
  /** Energy/tick actually delivered to sinks. */
  totalDelivered: number;
  /** Miner + hauler spawn overhead (energy/tick). */
  totalOverhead: number;
  /** Build-time (parts/tick) committed per spawn. */
  spawnPartsUsed: Map<string, number>;
  /** The fill's spawn-parts ledger, traced (spec 15 P4): what the budget was,
   * what standing deductions took, what routing had to work with. */
  partsLedger: { capacity: number; minerLoad: number; infra: number; budget: number };
  /** Sum of delivered energy weighted by sink value - the objective. */
  valueDelivered: number;
  /** delivered >= overhead: the income covers the creeps that earn it. */
  sustainable: boolean;
}

// =============================================================================
// PLANNER
// =============================================================================

interface SourceCandidate {
  source: PlannerSource;
  spawn: PlannerSpawn;
  distance: number;
  rate: number;
  net: number;
  parts: number;
}

/** Nearest spawn to a position; ties broken by spawn id for determinism. */
function nearestSpawn(pos: Position, spawns: PlannerSpawn[], dist: ColonyProblem["dist"]): { spawn: PlannerSpawn; distance: number } | null {
  let best: { spawn: PlannerSpawn; distance: number } | null = null;
  for (const spawn of spawns) {
    const d = dist(pos, spawn.pos);
    // A non-finite distance is a failed path lens, not a far spawn: letting
    // it through produced an "unprofitable at distance Infinity" verdict with
    // garbage per-part math. Unreachable spawns simply don't compete.
    if (!Number.isFinite(d)) continue;
    if (!best || d < best.distance || (d === best.distance && spawn.id < best.spawn.id)) {
      best = { spawn, distance: d };
    }
  }
  return best;
}

/**
 * Phase 1 - PRODUCER SELECTION. Assign each source to its nearest spawn, drop the
 * unprofitable ones, and per spawn keep sources by net-energy-per-build-part until
 * the spawn's mining budget is spent.
 */
function selectProducers(problem: ColonyProblem): { miners: CommissionedMiner[]; verdicts: SourceVerdict[] } {
  const { sources, spawns, dist } = problem;
  const verdicts: SourceVerdict[] = [];
  if (spawns.length === 0) {
    for (const source of sources) {
      if (source.transient) continue;
      verdicts.push({ sourceId: source.id, rate: source.rate, distance: 0, net: 0, tax: 0, verdict: "no-spawn", parts: 0 });
    }
    return { miners: [], verdicts };
  }

  const candidates: SourceCandidate[] = [];
  for (const source of sources) {
    if (source.transient) continue; // transient stocks need no miner (already harvested)
    // The searcher's pin overrides the nearest-spawn default (spec 18).
    const pinned = source.assignedSpawnId ? spawns.find(s => s.id === source.assignedSpawnId) : undefined;
    const near = pinned
      ? { spawn: pinned, distance: dist(pinned.pos, source.pos) }
      : nearestSpawn(source.pos, spawns, dist);
    if (!near) {
      // The formerly verdict-LESS skip (spec 14: no invisible decisions).
      // Spawns exist but none is reachable: the path lens failed for this
      // source. Measured live t72416041+: five worked, reserved, mark-free
      // remotes silently absent from candidates for 1000+ ticks while their
      // miners kept mining - without this row the drop cause was guesswork
      // between graph exclusion and path failure.
      verdicts.push({ sourceId: source.id, rate: source.rate, distance: 0, net: 0, tax: 0, verdict: "unreachable", parts: 0 });
      continue;
    }
    // Net of the invader tax (spec 13): a remote's expected raid-defense
    // cost scales with what we harvest there, so it lands here - where both
    // the mine/don't-mine gate and the ranking read it.
    const tax = (source.invaderTax ?? 0) * source.rate;
    const net = netEnergy(source.rate, near.distance) - tax;
    const parts = spawnPartsFor(source.rate, near.distance);
    if (net <= 0) {
      // never mine a source that costs more than it yields - stamped, not silent
      verdicts.push({ sourceId: source.id, rate: source.rate, distance: near.distance, net, tax, parts, verdict: "unprofitable" });
      continue;
    }
    verdicts.push({ sourceId: source.id, rate: source.rate, distance: near.distance, net, tax, parts, verdict: "over-budget" });
    candidates.push({
      source,
      spawn: near.spawn,
      distance: near.distance,
      rate: source.rate,
      net,
      parts
    });
  }

  // Per spawn, fill the mining build-time budget highest-value-first.
  const budget = miningBudgetPerSpawn();
  const bySpawn = new Map<string, SourceCandidate[]>();
  for (const c of candidates) {
    const list = bySpawn.get(c.spawn.id) ?? [];
    list.push(c);
    bySpawn.set(c.spawn.id, list);
  }

  const miners: CommissionedMiner[] = [];
  // Profitable candidates were provisionally stamped "over-budget"; funding
  // flips the stamp, so a candidate's final verdict is exactly its fate here.
  const verdictById = new Map(verdicts.map(v => [v.sourceId, v]));
  for (const [, list] of bySpawn) {
    // value per build-part, then by source id for stable ties
    list.sort((a, b) => b.net / b.parts - a.net / a.parts || (a.source.id < b.source.id ? -1 : 1));
    let spent = 0;
    for (const c of list) {
      // Always staff a spawn's best source even if it alone exceeds budget; after
      // that, only take a source if its build-time fits the remaining budget.
      if (spent > 0 && spent + c.parts > budget) continue;
      spent += c.parts;
      const v = verdictById.get(c.source.id);
      if (v) v.verdict = "funded";
      miners.push({
        sourceId: c.source.id,
        nodeId: c.source.nodeId,
        spawnId: c.spawn.id,
        distance: c.distance,
        rate: c.rate,
        spawnParts: c.parts,
        netEnergy: c.net,
        efficiency: (c.net / c.rate) * 100,
        maxMiners: c.source.maxMiners
      });
    }
  }

  // STORAGE-FULL DEFUND (owner 2026-07-19: "if we top out the storage... the
  // whole corp is defunded, not just the hauler"). The all-or-nothing rule:
  // mine a source iff its energy has a home. When total sink capacity cannot
  // absorb the funded mining, the surplus would rot at remote containers (#19),
  // so drop whole corps - removing the miner starves its hauler/reserver/
  // container downstream (supply is built from `miners`). This is naturally
  // gated by the sink capacities: with a storage sink soaking `totalSupply`
  // there is always room, so it fires only once storage tops out (flowAdapter
  // drops its capacity to physical room-remaining, ~0 when full) and the
  // controller is at its spot cap. Worst net-per-part first; keep at least one
  // so the colony never strands itself.
  const sinkCapacity = problem.sinks.reduce((sum, k) => sum + k.capacity, 0);
  let minedRate = miners.reduce((sum, m) => sum + m.rate, 0);
  if (minedRate > sinkCapacity + 1e-9) {
    const byWorst = [...miners].sort(
      (a, b) => a.netEnergy / a.spawnParts - b.netEnergy / b.spawnParts || (a.sourceId < b.sourceId ? -1 : 1)
    );
    for (const m of byWorst) {
      if (minedRate <= sinkCapacity + 1e-9 || miners.length <= 1) break;
      miners.splice(miners.indexOf(m), 1);
      minedRate -= m.rate;
      const v = verdictById.get(m.sourceId);
      if (v) v.verdict = "no-sink";
    }
  }
  return { miners, verdicts };
}

/** A unit of energy available to route: a staffed source or a scavengeable stock. */
interface SupplyPoint {
  sourceId: string;
  rate: number;
  spawnId: string;
}

/**
 * Transient supply - SCAVENGING. Each transient source (a ground stock) is free
 * energy needing no miner, so it joins the routing pool directly. It is worth
 * scavenging whenever hauling it home nets positive (no miner cost to offset), so
 * a reachable stock essentially always qualifies. The scavenger's home spawn is
 * the nearest one.
 */
function selectTransientSupply(problem: ColonyProblem): SupplyPoint[] {
  const { sources, spawns, dist } = problem;
  if (spawns.length === 0) return [];
  const supply: SupplyPoint[] = [];
  for (const source of sources) {
    if (!source.transient) continue;
    const near = nearestSpawn(source.pos, spawns, dist);
    if (!near) continue;
    // The bank/hub (storage) is NOT a scavenge pile: it always belongs in supply
    // (planColony credits it the funded mined income), even at rate 0 while the
    // warchest fills - the net filter below is only for one-off ground stocks.
    if (!source.id.startsWith("bank-")) {
      const net = source.rate - haulerOverhead(carryPartsFor(source.rate, near.distance), near.distance);
      if (net <= 0) continue; // even free energy isn't worth a scavenger that costs more to run
    }
    supply.push({ sourceId: source.id, rate: source.rate, spawnId: near.spawn.id });
  }
  return supply;
}

/**
 * Phase 2 - VALUE ROUTING. Route the gross output of all supply (staffed sources
 * plus scavengeable stocks) to sinks: a reserve pre-pass for critical floors, then
 * a value-descending pass filling each sink to capacity from the nearest sources
 * first. Each source->sink flow becomes a hauler.
 */
function routeToSinks(
  problem: ColonyProblem,
  supply: SupplyPoint[],
  partsBudget: number
): { haulers: CommissionedHauler[]; sinks: CommissionedSink[] } {
  const { sinks, dist } = problem;
  const sourceById = new Map(problem.sources.map(s => [s.id, s]));
  const spawnBySource = new Map(supply.map(s => [s.sourceId, s.spawnId]));

  // THE SPAWN-PARTS LEDGER (spec 15 P4): every unit of energy allocated here
  // implies standing bodies - the haulers that move it and, at a controller,
  // the upgraders that burn it. The ledger starts at the spawn's physical
  // build-rate minus what miners and standing infra already claim, and each
  // allocation below spends it. When it runs dry the fill STOPS: the plan is
  // an equilibrium the spawn can actually maintain, with the value order
  // deciding who got the scarce parts (measured 2026-07-18: without this the
  // plan implied 0.56 parts/t against the 0.333 ceiling and the colony
  // self-limited via starvation queues instead of by value).
  let partsRemaining = Math.max(0, partsBudget);
  // A consumer sink's bodies walk from the spawn nearest it.
  const nearestSpawnDist = (pos: Position): number =>
    problem.spawns.length === 0 ? 0 : Math.min(...problem.spawns.map(s => dist(s.pos, pos)));

  // Remaining gross energy each supply point can still ship.
  const pool = new Map<string, number>(supply.map(s => [s.sourceId, s.rate]));

  const out = new Map<string, CommissionedSink>();
  const haulers: CommissionedHauler[] = [];

  const isBank = (id: string): boolean => id.startsWith("bank-");
  // Hub-and-spoke roles (owner 2026-07-19): when a storage HUB exists, mined and
  // scavenge are DEPOSIT sources - their only home is the hub, so each gets its
  // haul-home and the warchest becomes the true income buffer; the bank/hub is
  // the SPEND source that funds consumers. Pre-storage there is no hub, so
  // nothing is a deposit and mined feeds consumers directly (old model).
  const hasStorageSink = sinks.some(s => s.kind === "storage");
  const isDeposit = (id: string): boolean => hasStorageSink && !isBank(id);

  const fill = (sink: PlannerSink, target: number): void => {
    const acc = out.get(sink.id) ?? {
      sinkId: sink.id,
      kind: sink.kind,
      value: sink.value,
      demand: sink.capacity,
      allocated: 0,
      sources: [] as { sourceId: string; amount: number; distance: number }[]
    };
    out.set(sink.id, acc);

    // HUB-AND-SPOKE fill (owner 2026-07-19). Each sink pulls NEAREST-FIRST (ties
    // by id) from only the sources its ROLE allows:
    //   - the STORAGE hub soaks DEPOSIT sources (mined + scavenge) - their
    //     haul-home. The bank/hub is never a deposit, so it can never pump into
    //     its own store: the structural anti-pump (spec 03) now falls out of the
    //     roles instead of a special-case filter.
    //   - CONSUMERS (spawn, controller, construction, new spawn sites) draw the
    //     SPEND source (the bank/hub), which the adapter sizes to the mined
    //     throughput + surplus - so the warchest funds them and they are sized to
    //     it (owner: "size the consumers to the warchest"). Mined never routes to
    //     a consumer directly; it banks and is drawn back through the hub, which
    //     makes the warchest the true income buffer (the hybrid hauled mined
    //     straight to the controller, so storage saw ~0 income and bled feeding
    //     the spawn - t72434228->t72435669, "spending our savings").
    // Pre-storage (no hub) NOTHING is a deposit, so mined feeds consumers
    // directly - hub-and-spoke needs a hub. This REPLACES the production-first /
    // nearest-first regime gates (the bank-last experiment and its #21 partner):
    // one uniform rule, no filling-vs-surplus switch (owner: "the routing doesn't
    // change the overall energy flow balance ... probably better that way").
    // A source's output is hauled from its haulPos (the core link for a
    // link-served source), not necessarily the source tile itself.
    const order = [...pool.keys()]
      .filter(id => (pool.get(id) ?? 0) > 1e-9)
      .filter(id => (sink.kind === "storage" ? isDeposit(id) : !isDeposit(id)))
      .map(id => {
        const s = sourceById.get(id)!;
        // NEAREST-FIRST, no class ranking (owner 2026-07-20: "scavenging IS
        // better than mining. Especially if it's closer" - a stock is
        // already-extracted energy competing on plain route economics). The
        // t72447104 displacement was a SIZING bug, not an ordering one: the
        // old 150-tick drain target asked 20 e/t per pile; scavengeRate now
        // sizes waste-free (halfway amount over effective ttl), so a
        // right-sized recovery cannot crowd standing production - and when
        // a nearer stock DOES out-compete a marginal remote, that is the
        // correct trade ("we sort of lose on the capex or the room
        // reservation a bit").
        return { id, d: dist(s.haulPos ?? s.pos, sink.pos) };
      })
      .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));

    // Consumer bodies for THIS sink walk from the nearest spawn: upgraders at
    // a controller, builders at construction (5x cheaper per e/t - BUILD is
    // 5 energy per WORK-tick). Spawn/storage sinks have no standing body.
    const workPerUnit =
      sink.kind === "controller"
        ? controllerWorkSpawnLoad(1, nearestSpawnDist(sink.pos))
        : sink.kind === "construction"
        ? constructionWorkSpawnLoad(1, nearestSpawnDist(sink.pos))
        : 0;

    for (const { id, d } of order) {
      if (acc.allocated >= target - 1e-9) break;
      const avail = pool.get(id) ?? 0;
      // A paved route's 2:1 hauler needs 1.5 parts per CARRY, not 2 - the
      // spawn-budget payoff that makes roads worth building at all. A route
      // still mid-build (paved fraction < 1) already fields that body, but
      // its loaded leg crawls the unpaved stretch: CARRY sizes at the
      // EFFECTIVE distance (ticks not tiles - roadEconomics), or the fleet
      // under-carries until the last tile lands.
      const src = sourceById.get(id);
      const paved = src?.paved === true;
      const dEff = paved ? effectiveOneWayTiles(d, src?.pavedFraction ?? 1, 2) : d;
      // Parts/tick per unit of flow on this route: haul bodies + sink work bodies.
      const chargePerUnit = ((paved ? 1.5 : 2) * carryPartsFor(1, dEff)) / effectiveLife(d) + workPerUnit;
      const maxByParts = chargePerUnit > 1e-12 ? partsRemaining / chargePerUnit : Infinity;
      const take = Math.min(avail, target - acc.allocated, maxByParts);
      if (take <= 1e-9) {
        if (maxByParts <= 1e-9) {
          // Ledger dry - the fill is over for this sink. Stamp BEFORE the
          // early exit: skipping it left the sink wearing a stale pre-pass
          // remainder (live t72420516: 0.105 of a budget it had drained),
          // and the v4 trace lied about who spent the parts.
          acc.partsLeft = partsRemaining;
          return;
        }
        continue;
      }
      partsRemaining -= take * chargePerUnit;
      pool.set(id, avail - take);
      acc.allocated += take;
      acc.sources.push({ sourceId: id, amount: take, distance: d });
      haulers.push({
        sourceId: id,
        sinkId: sink.id,
        spawnId: spawnBySource.get(id) ?? "",
        distance: d,
        flowRate: take,
        carryParts: carryPartsFor(take, dEff),
        spawnParts: ((paved ? 1.5 : 2) * carryPartsFor(take, dEff)) / effectiveLife(d),
        ...(paved ? { paved } : {})
      });
    }
    acc.partsLeft = partsRemaining;
  };

  const byValueThenId = (a: PlannerSink, b: PlannerSink): number =>
    b.value - a.value || (a.id < b.id ? -1 : 1);
  // Reserve pre-pass: guarantee critical floors before value greed drains the pool.
  for (const sink of [...sinks].filter(s => (s.reserve ?? 0) > 0).sort(byValueThenId)) {
    fill(sink, Math.min(sink.reserve!, sink.capacity));
  }
  // PRODUCTION-FIRST LEDGER ORDER (macro doctrine; prod t72445337): the pure
  // value pass filled consumers first, and because deposits (mined -> hub)
  // sit at storage's value 1 they were LAST - one solve's consumer routes +
  // upgrade WORK charges drained the ledger to partsLeft 0.0 and all SEVEN
  // funded sources got zero haul routes: 70 e/t of funded mining, 0 routed,
  // income rotting at the containers while the plan read as feasible. The
  // energy pools were never the conflict (consumers draw the bank, deposits
  // fill the hub - disjoint by role); the PARTS ledger was. So parts now
  // follow the doctrine: spawn overhead first (production's own financing),
  // then the funded income's haul-home, then consumers burn the residual.
  // Consumer ALLOCATIONS shrink when parts bind - execution already sizes
  // real consumers from actual stock (sustainableConsumptionRate), so the
  // burn continues from standing stock while the plan stops promising
  // routes the spawn cannot maintain.
  for (const sink of [...sinks].filter(s => s.kind === "spawn").sort(byValueThenId)) {
    fill(sink, sink.capacity);
  }
  for (const sink of [...sinks].filter(s => s.kind === "storage").sort(byValueThenId)) {
    fill(sink, sink.capacity);
  }
  // Value pass: highest value first, up to capacity (spawn/storage are
  // already at target - their re-fill is a no-op).
  for (const sink of [...sinks].sort(byValueThenId)) {
    fill(sink, sink.capacity);
  }

  return { haulers, sinks: [...out.values()] };
}

/**
 * Plan the whole colony economy: which corps to commission and at what size.
 * Pure and deterministic; see the module doc for the GOAP framing.
 */
export function planColony(problem: ColonyProblem): ColonyPlan {
  const { miners, verdicts: sourceVerdicts } = selectProducers(problem);
  // HUB-AND-SPOKE hub sizing: the storage hub's bank source carries the FUNDED
  // mined income (what actually banks) so consumers draw the real income through
  // the hub. Sizing it from ALL candidate graph sources - which is all the
  // pre-selection adapter can see - sent phantom supply (38 candidates -> 380 e/t
  // hub) that construction over-drew, exhausting the parts ledger so real mined
  // never reached storage (P9->0, controller starved, live stall t72437535). Here
  // the funded set IS known: each funded source's rate is credited to its nearest
  // storage hub's bank source. Filling-regime hubs start at rate 0 (adapter) and
  // get exactly this income; surplus hubs get income + the surplus draw.
  const isBankSource = (id: string): boolean => id.startsWith("bank-");
  const sourceById = new Map(problem.sources.map(s => [s.id, s]));
  const storageSinks = problem.sinks.filter(s => s.kind === "storage");
  const fundedByHubRoom = new Map<string, number>();
  for (const m of miners) {
    if (storageSinks.length === 0) break;
    const src = sourceById.get(m.sourceId);
    const from = src?.haulPos ?? src?.pos;
    if (!from) continue;
    let best = storageSinks[0];
    let bestD = Infinity;
    for (const st of storageSinks) {
      const d = problem.dist(from, st.pos);
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    fundedByHubRoom.set(best.pos.roomName, (fundedByHubRoom.get(best.pos.roomName) ?? 0) + m.rate);
  }
  // Supply = staffed sources + scavengeable transient stocks (no miner needed);
  // each hub's bank source additionally carries the funded mined income banking there.
  const supply: SupplyPoint[] = [
    ...miners.map(m => ({ sourceId: m.sourceId, rate: m.rate, spawnId: m.spawnId })),
    ...selectTransientSupply(problem).map(t =>
      isBankSource(t.sourceId)
        ? { ...t, rate: t.rate + (fundedByHubRoom.get(t.sourceId.slice("bank-".length)) ?? 0) }
        : t
    )
  ];
  // The spawn-parts ledger for the sink fill: physical build-rate minus the
  // committed miners and the standing infra (feeder/tender/reservers - see
  // ColonyProblem.infraPartsPerTick). Production is funded first in BOTH
  // currencies; routing and consumers spend what remains.
  const minerLoad = miners.reduce((s, m) => s + MINER_PARTS / effectiveLife(m.distance), 0);
  const partsBudget = problem.spawns.length * SPAWN_PARTS_PER_TICK - minerLoad - (problem.infraPartsPerTick ?? 0);
  const partsLedger = {
    capacity: problem.spawns.length * SPAWN_PARTS_PER_TICK,
    minerLoad,
    infra: problem.infraPartsPerTick ?? 0,
    budget: partsBudget
  };
  const { haulers, sinks } = routeToSinks(problem, supply, partsBudget);

  // FUNDED => ROUTED (leak #19 in plan form): in the hub era a funded source
  // whose deposit routing got ZERO parts would field a miner for pure rot -
  // the exact fantasy the fill order above exists to prevent, surviving only
  // on the tail when even production-first parts run out. Demote it to an
  // "unrouted" verdict and drop its miner; the freed build-time re-enters
  // the equilibrium next solve. (Partial routing stays funded - a source
  // shipping some of its rate is income, not rot.) NOTE: the hub bank credit
  // above was computed pre-routing, so a demoted source's rate inflates the
  // consumer spend pool by its rate for THIS solve - bounded to the demoted
  // tail and visible via the verdict.
  const hasHub = storageSinks.length > 0;
  let plannedMiners = miners;
  if (hasHub) {
    const routedSources = new Set<string>();
    for (const k of sinks) {
      for (const sf of k.sources) {
        if (sf.amount > 1e-9) routedSources.add(sf.sourceId);
      }
    }
    const unroutedIds = new Set(miners.filter(m => !routedSources.has(m.sourceId)).map(m => m.sourceId));
    if (unroutedIds.size > 0) {
      plannedMiners = miners.filter(m => !unroutedIds.has(m.sourceId));
      for (const v of sourceVerdicts) {
        if (unroutedIds.has(v.sourceId) && v.verdict === "funded") v.verdict = "unrouted";
      }
    }
  }

  const demotedRate = miners.reduce((s, m) => s + m.rate, 0) - plannedMiners.reduce((s, m) => s + m.rate, 0);
  const totalProduced = supply.reduce((s, p) => s + p.rate, 0) - demotedRate;
  const totalDelivered = sinks.reduce((s, k) => s + k.allocated, 0);
  const miningOverhead = plannedMiners.reduce((s, m) => s + minerOverhead(m.distance), 0);
  const haulOverhead = haulers.reduce((s, h) => s + haulerOverhead(h.carryParts, h.distance), 0);
  const totalOverhead = miningOverhead + haulOverhead;
  const valueDelivered = sinks.reduce((s, k) => s + k.allocated * k.value, 0);

  const spawnPartsUsed = new Map<string, number>();
  for (const m of plannedMiners) {
    spawnPartsUsed.set(m.spawnId, (spawnPartsUsed.get(m.spawnId) ?? 0) + MINER_PARTS / effectiveLife(m.distance));
  }
  for (const h of haulers) {
    spawnPartsUsed.set(h.spawnId, (spawnPartsUsed.get(h.spawnId) ?? 0) + h.spawnParts);
  }

  return {
    miners: plannedMiners,
    haulers,
    sinks,
    sourceVerdicts,
    partsLedger,
    totalProduced,
    totalDelivered,
    totalOverhead,
    spawnPartsUsed,
    valueDelivered,
    sustainable: totalDelivered >= totalOverhead
  };
}
