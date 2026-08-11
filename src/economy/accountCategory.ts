/**
 * @fileoverview ACCOUNT CATEGORIES - the reporting line every corp KIND
 * declares (spec 51, owner 2026-08-06; spec 60 phase B).
 *
 * Charter: the TYPE of the statement's cost lines, and the DERIVATIONS that
 * read each kind's own `account` declaration back out of the registry. No
 * parallel table: the kind file is the single point of declaration, exactly
 * as it declares its roles and body (spec 17 registration-only), and
 * conformance refuses a kind that registers without one.
 *
 * ## Why this exists
 *
 * Owner: *"Every corp plan is essentially a list of inputs and outputs. Thats
 * the corp budget. The colony budget is the sum of the corps. Each corps is
 * assigned a reporting category for aggregate overview and presentation but the
 * row can be drilled down to the corp level."*
 *
 * This module used to hold a kind -> line map of its own - knowledge the kinds
 * already own, mirrored here and reconciled only by a test. That is the exact
 * "per-kind plumbing mirror" class spec 17 deleted everywhere else, and it had
 * drifted the way mirrors do: the table still named a `tender` kind and a
 * `build` kind, neither of which is registered. Since spec 60 phase B the kind
 * declares `account` on its own CorpKind object (with an optional per-role
 * override where roles split lines - harvest's hauler evacuates while its
 * miner extracts), and this module DERIVES:
 *
 *  - `categoryOfKind(kind)` - the registry's declaration for one kind;
 *  - `accountClassOfRole()` - the role -> line join the spend ledger's
 *    role-grained totals report through (scripts/waste-ledger.ts pins its
 *    script-side copy byte-identical to this derivation, because kind modules
 *    are not loadable outside the engine);
 *  - `accountDeclarationErrors(kind)` - the conformance predicate.
 *
 * ## The legacy boundary (spec 60 phase C)
 *
 * `bootstrap` and `spawning` live in the LEGACY registry, not the KINDS
 * roster, so they cannot declare anything - their lines are pinned in
 * `LEGACY_CATEGORY_OF_KIND` below, SHRINK-ONLY: when spec 20 phase 3 migrates
 * them to kinds, their rows move to declarations and the table empties.
 * `categoryOfKind` still returns `undefined` for a genuinely unknown kind -
 * an unclassified corp must be VISIBLE, not folded into a residual, because
 * that is how `jack` hid.
 *
 * Layer: pure economy derivation - reads the kind REGISTRY (economy/CorpKind),
 * never Game or Memory.
 *
 * @module economy/accountCategory
 */

import { getCorpKind, listCorpKinds } from "./CorpKind";

/**
 * The statement's cost lines. Ordered as the income statement prints them:
 * direct cost of mining first (they net against gross mining to give NET MINING
 * MARGIN), then overhead, then capital. The const array IS the declaration -
 * the type derives from it, so runtime checks (conformance) and the compiler
 * enforce the same roster.
 */
export const ACCOUNT_CATEGORIES = [
  /** DIRECT COST OF MINING - the three lines that net against gross mining. */
  "extraction",
  "evacuation",
  "reservation",
  /** OVERHEAD. */
  "infra",
  "defense",
  "consumers",
  /** CAPITAL - funded from the expansion reserve, not operating margin. */
  "expansion",
  "incursion",
  /** Cold-start bodies, before the economy exists to classify them. */
  "bootstrap"
] as const;

export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

/**
 * The two actors that run OUTSIDE the kind registry (the legacy registry -
 * spec 60 phase C pins this boundary shrink-only). They cannot declare an
 * account, so their lines live here until spec 20 phase 3 migrates them to
 * kinds; a row leaving this table must reappear as a kind's declaration.
 */
const LEGACY_CATEGORY_OF_KIND: { [kind: string]: AccountCategory } = {
  spawning: "infra",
  bootstrap: "bootstrap"
};

/**
 * Roles bought outside the kind registry, joined to their line the same way.
 * `jack` is BootstrapCorp's cold-start body: no kind declares the role, but
 * the spend is real and lands in the account (it printed as a dangling
 * UNCLASSIFIED line until 2026-08-08).
 */
const LEGACY_ACCOUNT_OF_ROLE: { [role: string]: AccountCategory } = {
  jack: "bootstrap"
};

/**
 * The category a kind reports on: its own registered declaration, or the
 * legacy pin for the two pre-framework actors. Undefined for an unknown kind
 * is a SIGNAL - the statement must show it as unclassified, not absorb it.
 */
export function categoryOfKind(kind: string): AccountCategory | undefined {
  return getCorpKind(kind)?.account ?? LEGACY_CATEGORY_OF_KIND[kind];
}

/** Every kind that resolves a category - registered declarations + the legacy pins. */
export function classifiedKinds(): string[] {
  const fromRegistry = listCorpKinds().map(k => k.kind);
  const legacy = Object.keys(LEGACY_CATEGORY_OF_KIND).filter(k => !fromRegistry.includes(k));
  return [...fromRegistry, ...legacy];
}

/**
 * The role -> statement line join, derived from the registered kinds' own
 * declarations: a role reports on its RoleSpec.account when declared (the
 * split-line case) and its kind's account otherwise, plus the legacy roles.
 *
 * Two kinds may buy the same role (tanker: extensionTender AND construction)
 * - the derivation THROWS if their declarations disagree, because the spend
 * ledger is role-grained and a role cannot report on two lines. That makes a
 * conflicting declaration a wiring bug the unit suite catches, never a silent
 * "last registration wins".
 */
export function accountClassOfRole(): { [role: string]: AccountCategory } {
  const out: { [role: string]: AccountCategory } = { ...LEGACY_ACCOUNT_OF_ROLE };
  const declaredBy: { [role: string]: string } = {};
  for (const kind of listCorpKinds()) {
    for (const role of Object.keys(kind.roles ?? {})) {
      const line = kind.roles[role].account ?? kind.account;
      if (out[role] !== undefined && out[role] !== line) {
        throw new Error(
          `role "${role}" reports on two lines: "${out[role]}" (${declaredBy[role] ?? "legacy"}) vs ` +
            `"${line}" (${kind.kind}) - the spend ledger is role-grained, so the declaring kinds must agree ` +
            `(docs/specs/60-measurement-at-the-door.md phase B)`
        );
      }
      out[role] = line;
      declaredBy[role] = kind.kind;
    }
  }
  return out;
}

/**
 * Conformance predicate (spec 60 phase B): the declaration errors of one
 * kind-shaped object, [] when clean. Checked at registration grain so a kind
 * cannot join the roster without knowing where it reports - the income
 * statement gains its line the moment the KINDS entry lands.
 */
export function accountDeclarationErrors(kind: {
  kind: string;
  account?: string;
  roles?: { [role: string]: { account?: string } };
}): string[] {
  const errors: string[] = [];
  const categories: readonly string[] = ACCOUNT_CATEGORIES;
  if (kind.account === undefined) {
    errors.push(
      `kind "${kind.kind}" declares no account category - every kind reports on a statement line ` +
        `(docs/specs/60-measurement-at-the-door.md phase B)`
    );
  } else if (!categories.includes(kind.account)) {
    errors.push(`kind "${kind.kind}" declares unknown account "${kind.account}" (not an AccountCategory)`);
  }
  for (const role of Object.keys(kind.roles ?? {})) {
    const override = kind.roles?.[role]?.account;
    if (override !== undefined && !categories.includes(override)) {
      errors.push(`kind "${kind.kind}" role "${role}" declares unknown account "${override}"`);
    }
  }
  return errors;
}
