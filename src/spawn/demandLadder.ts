/**
 * @fileoverview demandLadder - the ONE home for the spawn-demand VALUE ladder
 * (spec 32 phase D; audit finding corps-rest/9).
 *
 * Every auxiliary corp used to hardcode its demand value inline, each with
 * prose cross-referencing OTHER kinds' numbers ("above the miner band",
 * "below the reserver's 115") - the whole ladder's shape smeared across six
 * corp files, pinned only by scattered per-corp assertions. The sink-value
 * ladder got its one home (CorpPlanner's DEFAULT_SINK_VALUE + the trap-list
 * strict-ladder rule) after the 90-vs-85 founding incident; this module is
 * the same treatment for the SPAWN value ladder: named rungs, values moved
 * VERBATIM with their incident rationale, and ONE ordering test
 * (test/unit/spawn/demandLadder.test.ts). Never nudge one rung in isolation.
 *
 * The COMPUTED bands the rungs are calibrated against are not constants here,
 * but they ARE part of the ladder's shape (the ordering test pins the rungs
 * against them):
 *  - miners  (HarvestCorp):        100 + efficiency*0.5, efficiency < 100,
 *                                  so the band is 100..just-under-150
 *  - haulers (CarryCorp):          90 + min(carryNeeded, 20) -> band 90..110
 *  - construction crew (Squads):   builders 95, tankers 94
 *  - blocking demands ride the scheduler's emergency tiers above ALL of this
 *    (value never lets a rung outbid a blocking first miner/hauler).
 *
 * PURE (no Game/Memory): consumed by the corps' demand lenses, pinned by the
 * purity ratchet alongside the NOW planner.
 *
 * @module spawn/demandLadder
 */

/**
 * The FIRST controller feeder's spawn value when energy is present. Above the
 * miner band (HarvestCorp: `100 + efficiency*0.5`, efficiency = net/rate*100
 * < 100, so miners top out just under 150) so the linchpin outranks the
 * marginal producer - it unlocks consumption of energy already mined. It
 * never WALLS (blocking stays false), so topping the ladder cannot spiral the
 * bank. (Full linchpin doctrine - the E4 idle-capital coupling, audit
 * t72553726: feeder 0 -> inflow 2 -> upgrader fleet decays 40->24 WORK ->
 * 40k stranded - lives at ControllerFeederCorp.getSpawnDemand.)
 */
export const FEEDER_LINCHPIN = 150;

/**
 * The extension tender's REFILL BOOTSTRAP emergency rank (owner 2026-07-22,
 * live incident t72490325: zero tenders, gate "demand" while endFill
 * collapsed to 0.41 and the spawn idled at 0.71): with the refill post DARK
 * and stranded depot stock, every body the spawn builds without a tender is
 * a runt bought from an unfillable room - the tender multiplies all later
 * spawn capacity, so it outbids the whole income range (miners 100-146,
 * haulers 90-110) by VALUE alone. Deliberately NOT blocking; one live tender
 * ends the emergency. (Full mechanism, including the spec-26 death-spiral
 * extension and the W2N6 blocking-stream scar, lives at
 * ExtensionTenderCorp.getSpawnDemand / tenderBootstrapPierce.)
 */
export const TENDER_BOOTSTRAP = 150;

/**
 * Reservation doubles a remote source (+~5 e/tick for a 650 claimer that
 * lasts 600 ticks), the best marginal energy investment on the board: above
 * the scaling haulers' band (90-110) - the Nth hauler moves a sliver of
 * throughput, the reserver doubles the source itself. It still sits below
 * every BLOCKING demand (first miners/haulers, 1e4 tier), so income units
 * open before their remote gets doubled. Measured (grid T5 + diag-reserver):
 * at 92 the reserver starved FOREVER behind hauler churn - even inside the
 * starved tier the 110-value haulers out-ranked it and re-armed after every
 * spawn.
 */
export const RESERVER = 115;

/**
 * The raid guard: above the miners' 100 band and the hauler floor 90 - it
 * PRESERVES a whole room's income stream the raid would zero - but below the
 * reserver's 115 and outside the income tier, so it can never outbid the
 * miners and haulers that ARE the income. Measured (def-t4 cell dev): at
 * base tier the guard starved all window (the reserver-at-92 failure
 * family). Its blocking+income+holdToFund treatment lives at
 * RaidGuardCorp.getSpawnDemand; raidGuard.test.ts pins the corp-level
 * ordering.
 */
export const GUARD = 105;

/**
 * The core-buster mission (shared by the ATTACK buster and the CLAIM
 * striker - two phases of the same mission, CoreBusterCorp): income-tier
 * treatment (ladder: miners 100 < buster 104 < guard 105 < reserver 115)
 * because the mission restores a zeroed income stream, but never BLOCKING -
 * an occupation is a long siege, not a kill window; the queue may make it
 * wait.
 */
export const BUSTER = 104;

/**
 * The extension tender's ordinary rank: above upgrading/building, below
 * mining. It is infrastructure (it tops the topmost consumption tier), not
 * core income, so it must not hold the spawn ahead of the miners/haulers
 * that produce the energy it moves.
 */
export const TENDER = 96;

/**
 * ADDITIONAL controller feeders (surplus drawdown): the old infra tier, just
 * below the tender. Only the FIRST feeder is the linchpin; fleet top-ups
 * never outrank producers.
 */
export const FEEDER = 95;

/**
 * The FIRST controller feeder while the bank is DRAINED (banked below
 * ControllerFeederCorp's FEEDER_INCOME_FIRST_FLOOR - the rare "NO energy"
 * case; owner 2026-07-24: "miners are more important than feeders if we have
 * NO energy, which is rare; the rest of the time feeder is more important"):
 * below the miner band so income rebuilds first.
 */
export const FEEDER_DRAINED = 90;

/**
 * One claimer while an expansion campaign is live. Investment-tier: below
 * every income corp (reserver 115, scaling haulers 90-110) - claiming never
 * outbids the economy that pays for it - but held-funded at the corp
 * (CLAIM 600 floor is indivisible, same reasoning as the reserver's hold).
 */
export const CLAIM = 80;

/**
 * OPPORTUNISTIC reservation top-up (owner idea, task #11): the bottom of the
 * ladder - idle spawn windows only. Banking reservation ahead cuts a future
 * refresh spawn out of a busy window; the demand is `opportunistic` (never
 * walls, never ages into the starved tier).
 */
export const RESERVATION_TOPUP = 5;
