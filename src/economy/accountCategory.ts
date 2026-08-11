/**
 * @fileoverview ACCOUNT CATEGORIES - the reporting bucket every corp declares
 * (spec 51, owner 2026-08-06).
 *
 * Charter: the ONE mapping from a corp KIND to the line it reports on. Pure
 * constants and a lookup - no Game, no Memory, no arithmetic.
 *
 * ## Why this exists
 *
 * Owner: *"Every corp plan is essentially a list of inputs and outputs. Thats
 * the corp budget. The colony budget is the sum of the corps. Each corps is
 * assigned a reporting category for aggregate overview and presentation but the
 * row can be drilled down to the corp level."*
 *
 * The statement today groups by ROLE (`ACCOUNT_CLASS_OF_ROLE` in
 * scripts/waste-ledger.ts) because role is the only key `Memory.spawnLedger`
 * carries. Role is a lossy proxy for corp in three measured places:
 *
 *  - `tanker` is bought by BOTH extensionTender (infra) and construction (a
 *    build cost). Both land in infra, so the line over-states infra for the
 *    whole of a build campaign - conceded in the mapping's own comment.
 *  - `hauler` spans source-route evacuation AND standalone scavenge corps; the
 *    SOURCE P&L has to disclaim the difference in prose.
 *  - `jack` (bootstrap) had no class at all and printed as a dangling
 *    `UNCLASSIFIED` line. FIXED 2026-08-08 without waiting for corp grain: the
 *    role map now points it at the `bootstrap` category declared below, and
 *    both tables are typed to `AccountCategory` so they cannot name the same
 *    line differently. It was the one defect of the three that role grain CAN
 *    resolve - it was a missing entry, not an ambiguity.
 *
 * Keyed by KIND instead, all three disappear: a corp is exactly one kind, and a
 * kind reports on exactly one line. The category also travels ON the commission,
 * so a statement row is the sum of its corps and drills down to them.
 *
 * ## Registration-only (spec 17)
 *
 * A new corp kind classifies itself by appearing here, exactly as it registers
 * its roles and body. `categoryOfKind` returns `undefined` for an unregistered
 * kind rather than guessing - an unclassified corp must be VISIBLE, not folded
 * into a residual, because that is how `jack` hid.
 *
 * Layer: pure economy constant (leaf module - imports nothing).
 *
 * @module economy/accountCategory
 */

/**
 * The statement's cost lines. Ordered as the income statement prints them:
 * direct cost of mining first (they net against gross mining to give NET MINING
 * MARGIN), then overhead, then capital.
 */
export type AccountCategory =
  /** DIRECT COST OF MINING - the three lines that net against gross mining. */
  | "extraction"
  | "evacuation"
  | "reservation"
  /** OVERHEAD. */
  | "infra"
  | "defense"
  | "consumers"
  /** CAPITAL - funded from the expansion reserve, not operating margin. */
  | "expansion"
  | "incursion"
  /** Cold-start bodies, before the economy exists to classify them. */
  | "bootstrap";

/**
 * KIND -> the line it reports on.
 *
 * `harvest` is deliberately `extraction` even though its envelope is the
 * all-in MINER OPERATION (spec 34 D5: the harvest node AND its routed
 * evacuation vector in one price). Splitting that envelope back into two lines
 * would need the commission to publish the decomposition, which `fleet` already
 * does per role - so the statement can report extraction/evacuation from
 * `fleet.miner` / `fleet.hauler` while the CORP belongs to one category. Stated
 * because it is the one place a category is coarser than the fleet beneath it.
 */
const CATEGORY_OF_KIND: { [kind: string]: AccountCategory } = {
  harvest: "extraction",
  carry: "evacuation",
  reservation: "reservation",
  // Infrastructure: the spawn network's own logistics.
  tender: "infra",
  extensionTender: "infra",
  controllerFeeder: "infra",
  scout: "infra",
  spawning: "infra",
  raidGuard: "defense",
  upgrade: "consumers",
  construction: "consumers",
  build: "consumers",
  claim: "expansion",
  coreBuster: "incursion",
  bootstrap: "bootstrap"
};

/**
 * The category a kind reports on, or undefined when the kind is not registered
 * here. Undefined is a SIGNAL - the statement must show it as unclassified, not
 * absorb it.
 */
export function categoryOfKind(kind: string): AccountCategory | undefined {
  return CATEGORY_OF_KIND[kind];
}

/** Every kind that has declared a category - the conformance suite's roster. */
export function classifiedKinds(): string[] {
  return Object.keys(CATEGORY_OF_KIND);
}
