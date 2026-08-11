# Spec 60 — Measurement at the door: guardrails that make the corp books inherent

**Status: PHASES A + B + C-COP LANDED 2026-08-11** (the follow-on cleanup
session); **D, E, F and phase C's migration slices remain open.** Proposed in
the cleanup session that landed the spawn contract
(`corps/spawnContract.ts` + the runtime guard + the one-file spawn-authority
allowlist). This spec is the program that generalizes it.

What landed, by phase:

- **A (SHIPPED)** — `contractSpawn` takes a `PurchaseContext` and books the
  purchase itself on `OK`: spend-ledger accrual + the forensic BlackBox
  `"spawn"` row, from the body actually bought (`bodyEnergyCost` joined
  primitives as the ONE cost formula). The buyer corp is read from the
  enforced `opts.memory.corpId` — one input, never two that can disagree.
  Memory contract at the same door: missing `corpId`/`workType` throws before
  the engine is reached. The director's agenda receipt
  (declared/want/grant/fill/pri/rank/why) is built BEFORE the buy and rides
  down via `PurchaseContext.receipt` into the ONE row the door files; hand
  booking is deleted from SpawningCorp and BootstrapCorp (both sites). Cops:
  `accrueSpawnSpend(` pinned to {spawnLedger.ts, spawnContract.ts},
  `"spawn"`-row authorship pinned to the door (spawnAuthority.test.ts).
  Acceptance green including the bootstrap integration run — jack purchases
  now appear in BOTH the ledger and the ring.
- **B (SHIPPED)** — `CorpKind.account: AccountCategory` is required;
  `RoleSpec.account?` covers the split-line cases (harvest's hauler →
  evacuation, construction's tanker → infra). `accountCategory.ts` keeps the
  TYPE (`ACCOUNT_CATEGORIES` const array) and the DERIVATIONS
  (`categoryOfKind`, `accountClassOfRole`, `accountDeclarationErrors`) and
  no parallel table — the deleted kind map had already drifted (it named a
  `build` kind and an `extensionTender` kind, neither registered).
  `bootstrap`/`spawning` (+ role `jack`) are pinned in explicit LEGACY maps
  until phase C migrates them. Conformance now refuses a kind without a
  line; the registration-only proof (lantern) covers both directions; the
  waste-ledger script table survives as a CACHE pinned byte-identical to the
  derivation (kind modules are not loadable outside the engine).
- **C (cop SHIPPED, migration open)** — `legacyBoundary.test.ts` pins the 19
  main.ts bulkhead buckets and the legacy-registry roster
  ({bootstrapCorps, spawningCorps}) shrink-only with the
  integrate-as-a-kind pointer. The towers/links/terminals migration slices
  and the bootstrap/spawning close-out have not started.
- **D, E, F (OPEN)** — the double-buy conformance probe needs per-kind
  staffing fixtures (a spawning incumbent world per demand-exposing kind);
  E's differing-input/two-depot identity restaging and the waste-ledger
  second-book deletion, and F's shared window meter, are untouched.

**The owner's ask (verbatim, 2026-08-11):** *"We want to create guard rails
for future developers. I want Corp measurement and the income statement to
be very seamless and just inherent in the architecture."*

**The epigraph is already in the code** (corpsSegment, owner 2026-08-06):
*"Every corp plan is essentially a list of inputs and outputs. Thats the
corp budget. The colony budget is the sum of the corps."* This spec's job is
to make that sentence structurally true — the statement SUMS rows that
cannot fail to exist, because the measurement rides the only door each
resource passes through.

## Doctrine

The spawn contract proved the pattern: **don't document the rule — put it at
the door.** A future developer who has never read CLAUDE.md now cannot spawn
a creep outside the requisition path, because the one physical `spawnCreep`
site throws on naked callers (static ratchet + runtime guard, ONTOLOGY §8).

Every guardrail below is the same shape, applied to the books:

1. Find the ONE seam a resource already passes through (a spawn, a kind
   registration, a dispatch call, a demand probe).
2. Make the bookkeeping happen AT that seam, so skipping it is impossible
   rather than discouraged.
3. Pin the seam with a shrink-only cop (the spec 39 phase-0 machinery) or a
   conformance rule (`describeCorpKindConformance`), so the surface can only
   narrow.

Prior art this spec builds on: spec 17 (registration-only integration — the
per-kind plumbing mirrors are deleted), spec 20 (the accounting boundary:
energy, build-time and CPU attributable per corp, the residual named), spec
39 phase 0 (the cop lands first), spec 51 (corp-grained statements), and the
purity ratchet's KNOWN-debt idiom (debt is explicit and shrink-only, never
silently tolerated).

---

## Phase A — Book the purchase at the contract door

**Problem (measured).** `contractSpawn` is a pass-through; each caller books
its own accounting. `SpawningCorp.executeSpawn` calls `accrueSpawnSpend`;
`BootstrapCorp` re-calls it by hand *because* it bypasses the executor (its
comment: "it must feed the cumulative spend ledger itself or cold-start
bodies vanish from the account") — and books **no BlackBox spawn row**, so
the forensic ring and the spend ledger cover different creep populations.
That directly violates `accrueSpawnSpend`'s own docblock contract: *"Call
beside the blackbox 'spawn' receipt - same tick, same numbers, so the
forensic ring and the account can never disagree about what was bought."*
The 2026-08 audit found the disagreement is population-shaped, not
window-shaped as the docblock assumes.

**Mechanism.**
- `contractSpawn` grows a purchase context (`role`, `buyerCorpId`,
  `scavenge?`) and, on `OK`, itself accrues the spend ledger and files a
  minimal BlackBox spawn row. Callers stop hand-booking. A body that is not
  on the books becomes impossible to buy — the runtime guard already forces
  every spawn through this exact line.
- The SpawnDirector's agenda receipt (budget-vs-debit context the seam
  cannot know) stays with the director; only the LEDGER accrual and the
  forensic row move down.
- **The memory contract, enforced at the same door:** `opts.memory` missing
  `corpId` or `workType` throws. OrphanRescue skips creeps with no corpId,
  so an unclaimed newborn freezes until it dies — enforcing the shape at
  birth makes the census (the foundation of every per-corp number) complete
  by construction.

**Acceptance tests.**
- Unit: a `contractSpawn` returning `OK` increments `Memory.spawnLedger`
  for the role with the body's true cost/parts, and a BlackBox `spawn` row
  exists for the same purchase; a failed spawn books nothing.
- Unit: `contractSpawn` with memory missing `corpId` (or `workType`) throws
  the contract message; nothing reaches the engine.
- Cop (ratchet, spawn-authority style): `accrueSpawnSpend(` call sites ==
  {`telemetry/spawnLedger.ts` (definition), `corps/spawnContract.ts`}.
  Shrink-only.
- Integration (bootstrap run): jack purchases appear in BOTH the ledger and
  the ring — the population gap is closed.

## Phase B — The statement line is a kind DECLARATION (registration-only accounting)

**Problem.** `economy/accountCategory.ts` holds a kind→line map beside the
KINDS registry, and the reporting layer holds a role→line map
(`ACCOUNT_CLASS_OF_ROLE`, `scripts/waste-ledger.ts`) — two tables mirroring
knowledge the kinds already own, reconciled only by a test. That is exactly
the "per-kind plumbing mirror" class spec 17 deleted everywhere else, and
the gap has burned before: bootstrap jacks printed as **UNCLASSIFIED** on
the statement until hand-named. `categoryOfKind` returns
`AccountCategory | undefined` — unclassified is representable today, and
corpsSegment's `account` field documents the consequence ("folding an
unknown into a residual is how the `jack` role hid").

**Mechanism.**
- The CorpKind contract gains `account: AccountCategory` (and, where roles
  split lines — harvest's miner/hauler decomposition — a per-role class on
  the `roles` declaration).
- `categoryOfKind` / `classifiedKinds` derive from the registry;
  `accountCategory.ts` keeps the TYPE and the derivation, never a parallel
  table. `ACCOUNT_CLASS_OF_ROLE` derives from the kinds' role declarations.
- Conformance: every registered kind resolves a defined category; every
  declared role resolves a line. A kind cannot register without knowing
  where it reports — the income statement gains its line the moment the
  KINDS entry lands, with zero further edits.

**Acceptance tests.**
- Conformance (all kinds, automatic): `kind.account` defined and a member
  of `AccountCategory`; every `roles` key resolves a line.
- Registration-only proof extended: the toy kind declares its line and the
  statement aggregation picks it up with zero core edits; a toy kind
  WITHOUT a line fails conformance with a message naming this spec.
- The existing kind↔role agreement pin (wasteLedger.test) survives as a
  derivation identity instead of a two-table reconciliation.
- `categoryOfKind` no longer returns `undefined` for any registered kind
  (the unclassified branch stays only for legacy-registry rows until
  phase C retires them).

## Phase C — Everything becomes a corp: pin the legacy boundary, then shrink it

**Problem.** What runs OUTSIDE the CommissionHost is invisible to per-corp
measurement: bootstrap + spawning live in the legacy registry; towers,
links and terminals are named infra CPU buckets (spec 20 P2) rather than
corp rows with envelopes. Spec 20 phase 3 already schedules the migration;
nothing currently STOPS a future developer from adding a new hand-wired
actor outside the framework — the census, the statement and the CPU ledger
would all silently under-count it.

**Mechanism.**
- **The cop lands first** (spec 39 sequencing): a unit test pins the
  outside-the-framework surface — the legacy registry roster
  ({bootstrap, spawning}) and main.ts's bulkhead-name set — as SHRINK-ONLY
  lists. A new bulkhead name or registry kind fails with "new
  infrastructure integrates as a corp kind (spec 20 phase 3), not a new
  bucket".
- Then migrate in slices, cheapest first: **towers** and **links** are
  already intent-only runners with clean seams. The moment something is a
  kind, the dispatch meters its CPU (`Memory.corpCpu`), its commission
  carries the envelope, conformance enrolls it, and the statement gets its
  row via phase B — measurement is automatic, which is the point.
- Bootstrap/spawning close the program (spec 35 phase F overlap); the
  legacy-roster list shrinks to empty and the cop becomes a permanent
  invariant.

**Acceptance tests.**
- Cop: bulkhead-name set and legacy-registry roster pinned, shrink-only,
  with the pointer message.
- Per migration slice: the runner's infra bucket disappears from
  `disjointInfra` input; its CPU appears under the corp half of
  `Memory.corpCpu`; conformance passes for the new kind; the grid stays at
  baseline.

## Phase D — The double-buy probe joins conformance (the t72811290 class)

**Problem (three strikes).** The staffing-lens bug — the demand side counts
only LIVE bodies, so it re-buys while the replacement is still in the spawn
— has now occurred three times: the feeder (measured t72811290: two 1600e
feeders 48t apart, F1 feeder class 12× plan), pre-empted on the hub tender,
and fixed on the port tender in the 2026-08-11 cleanup. Three incidents of
one class means the lesson belongs to the FRAMEWORK, not to three
docblocks.

**Mechanism.** `describeCorpKindConformance` gains a probe: for every kind
that exposes spawn demands, stage its fixture world where the only
incumbent of the demanded role is still in the spawn (spawning, full TTL),
and assert the kind does not demand a second body. Kinds without demand
paths skip. Every current and future kind inherits the t72811290 lesson by
registration alone.

**Shared instrument (2026-08-11):** the staffing fixture this needs
(`KindFixtures.staffing` — stage ONE incumbent in a given lifecycle state)
is specified in **spec 61**, which reuses it for the recycling-counts-as-
staffing and staffsPost-symmetry probes. Build the fixture once; land this
phase and spec 61 rows 1–3 together, with the shrink-only UNSTAFFED debt
list making per-kind fixture coverage visible.

**Acceptance tests.**
- The probe, enrolled for all kinds via the conformance describe-block.
- Mutation check (one-off, in the PR that lands it): reverting the port
  tender's demand lens to `includeSpawning: false` turns the probe red.

## Phase E — The budget identities must be able to FAIL

**Problem (audit findings, 2026-08-11).** The reconciliation tests that
should catch book drift are tautologies today:
- `auxiliaryBudget.test.ts` asserts Σ(corp declarations) ==
  `infraSpawnLoad` but feeds the SAME `RELAY = 40` to both sides — it pins
  formula composition and says nothing about the inputs, which are
  different by construction live (previous-solve draw vs this-draft
  allocation; the flowAdapter's own "KNOWN DRIFT 2026-08-03, deferred
  deliberately" comment).
- It stages exactly ONE depot room, so the per-depot feeder shape mismatch
  (`infraSpawnLoad` charges one feeder colony-wide; `linkKind` charges one
  per depot room) is invisible until the first second-storage room breaks
  the identity live.
- `waste-ledger.planSpawnLoad` re-derives what corpsSegment already
  publishes per corp — the segment's own comment names it "a second book",
  published precisely "so the statement can SUM these rows instead".

**Mechanism.**
- Stage the identity tests with DIFFERING inputs and a two-depot world. The
  known drift surfaces as entries in an explicit KNOWN_DRIFT list (the
  purity ratchet's debt idiom): visible, named, shrink-only — the owner's
  deferral stays a decision, never a silence.
- The statement consumes corpsSegment's published `spawnPartsPerTick` /
  `account` rows for its plan side; the parallel reconstruction in
  waste-ledger is deleted, and with it its private input bugs (the
  `BASE_RESERVE`-instead-of-`resolveReserveTarget` relay, the actuals-fed
  budgets the same file condemns for the tender).

**Acceptance tests.**
- auxiliaryBudget: a case where plan-side and corp-side inputs differ fails
  unless routed through the ONE shared input; the two-depot case is staged
  (green after the F3 fix, or a named KNOWN_DRIFT entry until then).
- Statement-vs-segment identity on a captured fixture: statement plan
  totals == Σ(published corp rows) to 1e-9; the "second book" comment in
  corpsSegment is retired because the second book is gone.

## Phase F — One generation-window meter, inherited

**Problem.** CarryCorp (duty + port), ExtensionTenderCorp (duty) and
LinkCorp (move) each hand-roll the same rolling-window meter: a `since`
tick, counters, a roll at one creep generation, serialization so the window
survives resets. Copy-paste meters drift in semantics (the 2026-08-11
cleanup found them agreeing only by luck on the literal 1500), and every
NEW corp that wants measurement re-writes the boilerplate.

**Mechanism.** One window-meter helper homed with `Corp` (or
`corps/meterWindow.ts`): construct with named counters, `roll(tick)` at
`CREEP_LIFETIME`, serialize/deserialize round-trip. The three existing
meters migrate; new kinds get measurement plumbing by inheritance. Meters
FEED the audit layer only (ONTOLOGY §1 — passive, pullable; never a
decision input).

**Acceptance tests.**
- The helper's unit suite: roll semantics, reset-on-deploy behavior,
  round-trip.
- The three migrated meters keep their existing behavior pins green.
- (Optional cop) new `>= CREEP_LIFETIME` window-roll expressions outside
  the helper are flagged.

---

## Sequencing

**A** first (small; completes the seam the spawn contract opened). **B**
next (highest leverage for the statement; touches the CorpKind contract +
conformance). **D** and **E** are test-only and can ride along with either.
**C** is the program — cop immediately, then towers/links as the proof
slice, bootstrap/spawning last (with spec 35 phase F). **F** whenever a
meter-owning corp is next touched.

## Non-goals

- The feeder relay-rate/body pricing drift (the F1/F2 family) stays
  **owner-deferred** — phase E makes it VISIBLE as named debt; repricing it
  is its own measured change with grid evidence, not a guardrail.
- No new decision inputs: every book here is audit-layer (passive,
  pullable). Nothing in this spec feeds back into planning.
