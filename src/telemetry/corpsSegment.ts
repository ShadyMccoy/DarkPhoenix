/**
 * @fileoverview Corps telemetry writer - segment 4 (per-corp census, bodies,
 * sizing records).
 *
 * Charter: the `CorpsTelemetry` segment shape and its ONE writer - one row per
 * census corp with its kind/type/room, its MEASURED aggregate body (from the
 * shared telemetry/bodyCensus pass, never a reconstruction from planned
 * rates), and the verbatim sizing stamp from the corp's last sizing decision
 * (spec 14 phase 2). The emitted bytes are a frozen external contract
 * (versioned; an external app parses them) - field order and version numbers
 * never change in a refactor.
 *
 * Layer: telemetry writer (Game-coupled; writes RawMemory segment 4).
 *
 * @module telemetry/corpsSegment
 */

import { CorpSizingRecord } from "../corps/Corp";
import { CommissionFleet } from "../economy/Commission";
import { categoryOfKind } from "../economy/accountCategory";
import { BodyAggregate, CorpCensusEntry, corpCreepCount, corpRoomName, emptyBody } from "./bodyCensus";
import { TELEMETRY_SEGMENTS } from "./segmentIds";

/**
 * Corps telemetry data structure (Segment 4).
 */
export interface CorpsTelemetry {
  version: number;
  tick: number;
  corps: {
    id: string;
    /** Commission kind (harvest/carry/reservation/tender/...) - the precise operator */
    kind: string;
    /** CorpType (mining/hauling/moving/...) - note tender & feeder share "moving" */
    type: string;
    nodeId: string;
    roomName: string;
    creepCount: number;
    /** Total ACTUAL body parts across this corp's live creeps (measured, 0 if none). */
    bodyParts: number;
    /** ACTUAL body parts by type for this corp's live creeps; {} when it has none. */
    body: { [part: string]: number };
    /**
     * The commission's PLANNED fleet per role (v15, spec 39 phase 1), verbatim
     * from the envelope - the PLAN side of this row. Sits next to the measured
     * `body`/`bodyParts` so per-commission plan-vs-actual (the F1
     * decomposition) is a single-segment read. Absent when the commission
     * declares none (aux kinds until spec 39 phase 4).
     */
    fleet?: CommissionFleet;
    /**
     * THE CORP BUDGET (v17, spec 47): the commission's declared inputs and
     * outputs, and the statement line it reports on.
     *
     * Owner 2026-08-06: *"Every corp plan is essentially a list of inputs and
     * outputs. Thats the corp budget. The colony budget is the sum of the
     * corps."* Published so the statement can SUM these rows instead of
     * re-deriving what it thinks each corp costs - the reporting layer's
     * parallel reconstruction (waste-ledger.planSpawnLoad) is a second book.
     *
     * `account` is the reporting category the KIND declares
     * (economy/accountCategory), so a row aggregates by corp and drills back
     * down to it. Absent = the kind is unclassified, which must stay VISIBLE:
     * folding an unknown into a residual is how the `jack` role hid.
     */
    shape?: string;
    consumes?: { energyRate?: number; spawnPartsPerTick: number };
    produces?: { energyRate?: number; valuePerTick?: number };
    account?: string;
    /**
     * Inputs of the corp's last sizing decision, exported verbatim from the
     * decision-site stamp (spec 14 phase 2). Absent for corps that don't stamp.
     */
    sizing?: CorpSizingRecord;
    /**
     * Sizing stamps of this corp's INTERNAL ENGINES (`Corp.innerCorps`, spec 34
     * D5) - sub-corps that run inside the operation and are never censused on
     * their own. Absent when the corp has none, or none of them stamp.
     *
     * Added 2026-07-31 (production audit t72695674) because the biggest spender
     * in the colony was also the only one with no decision record. The miner
     * operation owns its evacuation haulers, so `mining-*` rows carried 85% of
     * hauler spawn spend (59,150e of 69,750e over one window) while exporting
     * only the MINER's stamp - the rich hauler stamp (routes/carryNeeded/staged/
     * duty) existed at the decision site and died there. Every hauler diagnosis
     * (E6's "read the carry pickup stamps", H1 duty, F1's hauler class) was
     * blind on exactly the corps that dominate the spend, so the route-sizing
     * churn loop had to be reconstructed from the blackbox ring instead of read.
     */
    innerSizing?: { type: string; nodeId: string; sizing: CorpSizingRecord }[];
    /**
     * CUMULATIVE units produced (v14, phase 2 of the income-statement
     * program): Corp.unitsProduced verbatim - harvested energy for mining
     * corps, upgrade points for upgrading, build progress for construction.
     * Reset-surviving (it rides the commission store's serialize), so the
     * ledger differences two captures per corp - measured PER-SOURCE inflow
     * over exactly the capture window, the number the revenue line and the
     * E6 haul-deficit diagnosis never had. Absent when the corp never
     * counted (a zero would fabricate "measured nothing" on aux kinds).
     */
    produced?: number;
    /**
     * CUMULATIVE energy the corp's INTERNAL squads landed in sinks (v14):
     * the summed unitsProduced of its inner CarryCorps, whose recording unit
     * is "energy delivered". On a mining operation, `produced` is the
     * miner's harvest and `delivered` its evacuation - the pair separates
     * idle-fleet / wrong-route / insufficient-carry, spec 32's anti-sweep
     * prerequisite. Absent for corps without counting inner squads.
     */
    delivered?: number;
    createdAt: number;
    lastActivityTick: number;
  }[];
  summary: {
    totalCorps: number;
    /** Corps with at least one live creep */
    activeCorps: number;
    /** Count of corps by commission kind (every kind, including aux kinds) */
    corpsByKind: { [kind: string]: number };
  };
}

/**
 * Updates corps telemetry (Segment 4).
 */
export function updateCorpsTelemetry(census: CorpCensusEntry[], perCorpBody: Map<string, BodyAggregate>): void {
  const corps: CorpsTelemetry["corps"] = [];
  const corpsByKind: { [kind: string]: number } = {};
  let activeCorps = 0;

  for (const { kind, corp, fleet, commissionShape, consumes, produces } of census) {
    const creepCount = corpCreepCount(corp);
    // ACTUAL body of this corp's live creeps (measured), or empty when it owns
    // none - never a reconstruction from planned rates.
    const body = perCorpBody.get(corp.id) ?? emptyBody();
    // Kind-neutral: read the framework's declared internal-engine seam, so a
    // new operation kind's engines export by declaration alone (spec 17).
    const innerSizing = (corp.innerCorps?.() ?? [])
      .filter(inner => inner.lastSizing)
      .map(inner => ({ type: inner.type, nodeId: inner.nodeId || "", sizing: inner.lastSizing as CorpSizingRecord }));
    // Delivery counter (v14): CarryCorp's recordProduction unit IS "energy
    // delivered" (every transfer path records the moved amount), so a
    // standalone carry corp's `produced` already carries its deliveries - no
    // second counter exists or should (the second-implementation trap). What
    // needs surfacing is the OPERATION shape (spec 34 D5): a mining corp's
    // own unitsProduced is the miner's HARVEST, while its internal squads'
    // unitsProduced is what actually LANDED in sinks - publish the inner sum
    // as `delivered` so produced-vs-delivered splits the haul-deficit
    // branches (idle fleet / wrong route / insufficient carry) per source.
    const delivered = (corp.innerCorps?.() ?? []).reduce((s, inner) => s + (inner.unitsProduced ?? 0), 0);
    corps.push({
      id: corp.id,
      kind,
      type: corp.type,
      nodeId: corp.nodeId || "",
      roomName: corpRoomName(corp),
      creepCount,
      bodyParts: body.total,
      body: body.byPart,
      ...(fleet ? { fleet } : {}),
      // The corp budget (v17): shape/consumes/produces verbatim off the
      // envelope, plus the kind's declared reporting category.
      ...(commissionShape ? { shape: commissionShape } : {}),
      // `at` (a Position) is deliberately dropped: the account sums rates, and
      // the corp's place is already on the row as nodeId/roomName.
      ...(consumes
        ? { consumes: { energyRate: consumes.energyRate, spawnPartsPerTick: consumes.spawnPartsPerTick } }
        : {}),
      ...(produces ? { produces: { energyRate: produces.energyRate, valuePerTick: produces.valuePerTick } } : {}),
      ...(categoryOfKind(kind) ? { account: categoryOfKind(kind) } : {}),
      sizing: corp.lastSizing,
      ...(innerSizing.length > 0 ? { innerSizing } : {}),
      ...(corp.unitsProduced > 0 ? { produced: corp.unitsProduced } : {}),
      ...(delivered > 0 ? { delivered } : {}),
      createdAt: corp.createdAt,
      lastActivityTick: corp.lastActivityTick
    });
    corpsByKind[kind] = (corpsByKind[kind] || 0) + 1;
    if (creepCount > 0) activeCorps++;
  }

  const telemetry: CorpsTelemetry = {
    version: 17, // v16 hauler departure-reason meter; v17 the CORP BUDGET (shape/consumes/produces/account, spec 47) 2026-08-06
    tick: Game.time,
    corps,
    summary: {
      totalCorps: corps.length,
      activeCorps,
      corpsByKind
    }
  };

  RawMemory.segments[TELEMETRY_SEGMENTS.CORPS] = JSON.stringify(telemetry);
}
