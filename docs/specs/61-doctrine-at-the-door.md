# Spec 61 — Doctrine at the door: the trap list becomes enforcement

**Status: BACKLOG (2026-08-11, session follow-up to spec 60).** Same owner
mandate as spec 60 (*"We want to create guard rails for future developers"*),
applied beyond the books: the CLAUDE.md **trap list** is institutional memory
encoded as prose — every entry is a real incident a future developer must
read, remember, and re-apply under pressure. This spec converts each trap
into a DOOR where that is possible, names the successor spec where the trap
dies by deletion instead, and leaves the genuinely-prose residue explicitly
marked — so the reading burden shrinks to what enforcement cannot carry.

**Doctrine:** a rule a test enforces is a rule nobody has to be told. The
spawn contract proved it (a naked `spawnCreep` throws with directions); spec
60 B extended it to the statement (a kind cannot register without its line).
The trap list is the remaining inventory of rules that still live only in
the reader's memory.

Three outcomes per trap, all acceptable — silence is the only failure:

1. **A door** — a cop, conformance probe, or throwing helper at the one seam
   the mistake must pass through.
2. **Dies by deletion** — the trap guards a surface a scheduled migration
   removes; the row points at the successor spec and dies with the surface.
3. **Stays prose** — genuinely un-enforceable; the row is marked
   `(enforced: nothing — prose)` so the residue is visible and audited,
   never assumed covered.

## The shared instrument: staffing fixtures for conformance

Spec 60 phase D already needs it; this spec's probes reuse it — build ONCE.

`KindFixtures` (test/unit/framework/conformance.ts) gains an optional
staffing fixture:

```ts
staffing?: {
  /** The role whose staffing lens the probes exercise. */
  role: string;
  /**
   * Stage the world (Game.creeps + whatever room state this kind's demand
   * lens reads) with EXACTLY ONE incumbent of `role`, in the given
   * lifecycle state, owned by the fixture commission's corp. Returns the
   * materialized corp ready for getSpawnDemand / the demand path.
   */
  stage(state: "spawning" | "recycling" | "live"): Corp;
}
```

Kinds without demand paths omit it. Enrollment is tracked by a shrink-only
`UNSTAFFED` debt list in the conformance module (the purity-ratchet idiom):
a demand-exposing kind without a staffing fixture is VISIBLE debt with a
pointer here, never silently unprobed. Fixture cost is real (each kind's
demand lens reads different world state) — the debt list is what makes the
roll-out honest instead of claiming coverage the suite does not have.

## The inventory (trap → door)

Each row lands as its own small PR slice; the table is the program.

### 1. Recycling counts as staffing → conformance probe

**Trap (measured):** excluding `recycling` creeps from staffing counts
double-orders — the pounce-recycle path orders its own successor; the
exclusion collapsed the fleet to 7 runts.

**Door:** probe over the staffing fixture, `state: "recycling"` — the kind
must NOT demand a second body of the role while its recycling incumbent
stands (the recycle path itself owns the successor order). Enrolled for
every fixture-carrying kind automatically.

**Acceptance:** the probe, in the conformance describe-block; a mutation
check in the landing PR (filter `memory.recycling` out of one kind's lens →
probe red).

### 2. Double-buy while the replacement is in the spawn → spec 60 phase D

Owned there (three strikes: feeder t72811290, hub tender, port tender).
Listed here only because it consumes the same instrument: `state:
"spawning"` → no second demand. Land D and this row together.

### 3. staffsPost symmetry → symptom probe now, deletion later

**Trap (measured):** any consumer of "how many creeps does this post have"
using a different lens than the demand side recycles newborns at the spawn
door (~25t churn loop).

**Door (symptom-level):** probe with `state: "live"` staging the incumbent
AT its post the tick after arrival: the kind must neither demand a
replacement nor (for kinds with recycle paths) mark the newborn recyclable.
This catches the churn signature, not the root — the root (two lenses
existing at all) **dies with spec 39 phases 4–5**, which delete the
corp-side lens entirely. Row points there; the probe is the interim fence.

### 4. Corp-id round-trip → conformance probe (and spec 63's prerequisite)

**Trap:** planner ids are pure (`harvest-{flowSourceId}`); kinds strip flow
prefixes; a rename silently orphans live creeps.

**Door:** for every kind: materialize the fixture commission → take
`corp.id` → stamp a creep `memory.corpId = corp.id, memory.workType =
roles[r].workType` → assert OrphanRescue's resolution (readoptKindsFor +
claimsOrphan/default rule) claims exactly that corp. The id the commission
mints, the id the corp answers to, the id the newborn carries, and the id
rescue resolves must be ONE id. This is the instrument that would have
caught the rename-orphans class, and **spec 63 must not start until it is
green** — it is the regression net under the wire migration.

**Acceptance:** the probe for all kinds; mutation check (prefix-strip logic
inverted in one kind → red).

### 5. Grid staging lore → a helper that throws

**Trap (measured, three entries):** the mockup db's `$set` with dotted paths
(`"store.energy"`) silently NO-OPS; staged storage needs the OWNED schema
(user + storeCapacityResource); `addBot`'s `gcl` is POINTS not level
(1e6 = GCL 2).

**Door:** `test/grid/stage.ts` — the one staging vocabulary:
- `dbPatch(db, id, wholeObject)` — throws on any dotted key in the patch
  ("the mockup $set silently no-ops dotted paths — write whole objects");
- `stagedStorage(room, energy, user)` — emits the OWNED schema, complete;
- `gclPoints(level)` — the level→points conversion, so cells say
  `gcl: gclPoints(2)` and the unit mismatch is unwritable.

Plus a source cop over `test/grid/cells/*`: raw `$set` payloads containing
a dotted string key fail with the pointer. Existing offenders migrate in
the landing PR (mechanical).

**Acceptance:** helper unit tests (dotted-key throw; schema shape); the
cop; grid cells that used raw staging re-run green at baseline.

### 6. CPU governor arming → harness refusal

**Trap (measured):** an armed governor couples cell behavior to HOST load —
one full grid run drained heavy worlds' buckets and failed six
baseline-green cells.

**Door:** the grid harness inspects each cell's staged memory before
launch: `Memory.cpuGovernor === "on"` fails the cell immediately with the
trap text unless the cell declares `expectsGovernor: true` (a governor test
saying so on purpose).

**Acceptance:** harness unit test with a synthetic offending cell; the
governor's own cells declare the flag and stay green.

### 7. Sink-value ladder ordering → a pin over the goals table

**Trap (measured):** sink values are a strict ladder (spawn 100 >
new-spawn-site 85 > controller ≤80 > construction 70 > controller floor 40 >
storage 1); a single nudged value zeroed colony-wide construction (the
90-vs-85 founding incident).

**Door:** one unit test over `economy/goals`' value table asserting the
strict inequalities BETWEEN the named rungs — not the constants themselves
(retuning a value is legal; inverting the ladder is not). Failure message
recites the founding incident.

**Acceptance:** the pin; a mutation check (swap two rungs → red naming the
inversion).

### 8. Room state from intel → half enforced, half dies

The propose() half is ALREADY a door (conformance deletes Game/Memory and
requires identical output — the stranded-reserver class fails there). The
remaining half ("work()/getSpawnDemand must read the SAME lens") is not
mechanically pinnable at this grain and **dies with spec 39 phases 4–5**
(no corp-side demand lens, nothing to diverge). Row points there; until
then it stays prose, marked.

### 9. Bandaid-rules doctrine, multi-draw rule, tender heartbeat → prose

These are judgement doctrine, not seam mechanics — no door can hold them.
They stay in CLAUDE.md, explicitly marked `(enforced: nothing — prose)`.
The going-forward rule below is what keeps this residue from regrowing
unbounded.

## CLAUDE.md becomes an index of doors

When a row's door lands, the trap entry gains its pointer —
`(enforced: test/unit/framework/conformance.ts — recycling probe)` — and its
prose SHRINKS to one line + the pointer; the incident detail moves to the
enforcing test's docblock, which is where a developer who trips it will
actually be standing. **Going forward:** a new trap entry ships with its
door in the same PR, or with an explicit `(enforced: nothing — debt, spec
61)` marker. The trap list's unenforced residue becomes a countable,
shrink-only surface like every other debt in this codebase.

## Sequencing

Rows 5 and 6 are self-contained and cheapest — land first (pure test
tooling, no src changes). Row 7 next (one pin). Rows 1–3 land with the
staffing-fixture instrument, together with spec 60 D (one PR per kind
fixture batch, debt list shrinking). Row 4 lands before spec 63 begins.
CLAUDE.md pointer edits ride each landing PR.

## Non-goals

- No behavior changes anywhere — every door refuses only what doctrine
  already forbids. A door that requires retuning a constant to pass is a
  mis-built door.
- Not re-litigating trap content: where a trap's rule and current code
  disagree, that is a bug under the EXISTING rule (CLAUDE.md: fix the code,
  don't drift the doc) — file it, don't absorb it here.
