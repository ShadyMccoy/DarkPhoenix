# Spec 63 — The kind string is a wire format: renaming `controllerFeeder` without orphaning the heartbeat

**Status: BACKLOG (2026-08-11).** This is spec 54's open item 3 given its
own program. Spec 54 turned `ControllerFeederCorp` into `LinkCorp` — the
corp that owns the whole link network (core + controller + port tenders +
the terminal hub manager) — but deliberately FROZE the registered kind
string as `"controllerFeeder"`, because CLAUDE.md's trap is real: *a rename
silently orphans live creeps.* The freeze was correct then; it is also a
standing code/wire split every new reader trips on (this session's spec-60
phase B had to declare the LINK corp's account under the FEEDER name), and
the longer it stands the more code quotes the frozen literal.

**Prerequisite: spec 61 row 4** (the corp-id round-trip conformance probe)
lands FIRST and stays green through every stage below. It is the instrument
that detects exactly the failure class this migration risks; migrating
without it is flying the incident blind. **DISCHARGED 2026-08-11**: the probe
is landed and green for controllerFeeder (all three roles, generic
default-rule path; it drives the live `resolveReadoption`, staged with the
spawn resolvable). This spec is UNBLOCKED — the migration itself remains its
own deliberately-sequenced deploy program (stages below).

## Why a naive rename breaks (the wire inventory, from code)

The string is not a name, it is a WIRE FORMAT with at least eight readers:

1. **The registry key + `commission.kind`** — every solve emits it; the
   store binds by it.
2. **Serialized store entries in Memory** — `deserializeStore` DROPS
   entries whose kind has no registration ("a kind removed from the code:
   drop its corps"), so a bare rename deletes the live feeder corps at the
   first global reset after deploy.
3. **Corp ids embed it** — linkKind mints `${roomName}-controllerFeeder`
   (`linkKind.ts:115`, and `corpIdFor(kind, target)` = `${kind}-${target}`
   generally). Renamed minting changes the corpId, so materialize creates
   NEW corps while the old ones retire — a transient DOUBLE FLEET on the
   controller feeder, which the tender doctrine calls the heartbeat
   (non-negotiable).
4. **Creep memory** — `memory.corpId` on every live feeder/porttender/
   hubmanager embeds the old corp id. Orphan rescue resolves workType →
   kind → same-room corps of that kind; creeps survive IF a claiming corp
   still exists under the new name, but their stamped corpIds go stale.
5. **`fiscalArchive`'s kind list** (`fiscalArchive.ts:292`) — archived
   months in segments 8–9 carry the old string forever.
6. **waste-ledger lookups** — eight literal sites today (`c.kind ===
   "controllerFeeder"` finds, `HOME_ROLES`, the F1 class map, an
   id-substring match at line 507).
7. **On-disk captures and fixtures** — immutable history; every capture
   before the flip carries the old string, and the ledger differencing runs
   MUST keep reading them (a close spanning the rename reads one of each).
8. **The adjacent flag family** — `room.memory.controllerFeederActive`
   (regime stamp, read by CarryCorp/scavenge/UpgradingCorp/coreSegment) is
   a DIFFERENT wire with the same word in it. Renaming it is leg 3,
   optional, and must not ride the kind flip.

## Design: dual-read, single-write, two deploys

Target name: **`link`** (the corp is LinkCorp; roles feeder/porttender/
hubmanager are unchanged — workTypes `feed`/porttend/hubtend strings do NOT
move, so rescue's workType resolution is untouched throughout).

**Stage 1 (deploy N — read both, write old).** A single alias table, in one
place: `KIND_WIRE_ALIASES = { controllerFeeder: "link" }` exported beside
the registry. Resolution through it lands in: `deserializeStore` (store
entries of either name bind to the one registered kind),
`commissionsFromPlan` intake, and the ledger/fiscalArchive lookups (read
both names). Registration and minting still use the OLD string — this
deploy changes no wire bytes, it only makes every reader bilingual. Soak
one creep generation; the spec-61 round-trip probe and the trio pin it.

**Stage 2 (deploy N+1 — flip writes + migrate Memory once).** The registry
string, `linkKind`'s corpId minting, and the F1/HOME_ROLES canonical
entries flip to `link`. A one-shot migration runs at the first global reset
BEFORE any phase: rewrite serialized store keys/kinds/ids old→new, and
sweep every live creep's `memory.corpId` through the same mapping — same
tick, so no intermediate state is observable. The corp OBJECTS persist
under their new ids with their fleets attached: no demobilize, no double
staffing, no dark post.

**Rollback contract (stated loudly):** after stage 2's Memory rewrite, the
rollback target is the STAGE 1 bundle (bilingual reader), never the
pre-alias bundle — the old code drops `link`-kind store entries on sight.
Keep stage 1's bundle archived until the soak closes.

**Leg 3 (optional, later):** the `controllerFeederActive` regime flag
renames by the same shape (write both / read either / retire old) — its own
small PR, never bundled with the kind flip.

## Acceptance

- Unit: a store serialized with OLD strings deserializes to corps of the
  registered kind at both stages; after the stage-2 migration, ids are
  rewritten and a creep stamped with an OLD corpId is claimed by its
  (renamed) corp — the spec-61 round-trip probe extended with the alias
  case.
- Unit: waste-ledger differencing across ONE old-string capture and ONE
  new-string capture produces no UNCLASSIFIED row and no doubled feeder
  line (the F1 map and finds resolve both).
- Trio green at both stages; conformance green throughout (the kind's
  serialize fixpoint test must hold WITH the alias in play).
- Live, stage 2 window: zero orphan-recycles of workTypes
  feed/porttend/hubtend across the deploy (v29 recycled-why counters);
  heartbeat gauges flat (delivery e/t within band, coreEmptyShare in its
  healthy range, `port-untended` watchdog silent).
- The frozen-string comment in linkKind and spec 54's open item 3 are
  RETIRED in the stage-2 commit.

## Scheduling

P2 — pure debt retirement with heartbeat exposure, so: land OUTSIDE any
window where feeder behavior is under measurement (align stage 2 to a
spec-50 sweep cycle boundary, the same timing rule spec 51 uses), and not
in the same deploy as ANY feeder-behavior change, so a gauge moving blames
exactly one cause.

## Non-goals

- No behavior change to any of the three roles — bytes on the wire only.
- Captures/fixtures on disk are never rewritten (history is immutable);
  bilingual readers are the permanent accommodation for the pre-flip era.
- No general rename framework — one alias table for one migration; it is
  DELETED (with its reader hooks collapsing to the plain string) once the
  last pre-flip Memory and the archive ring have aged out, leaving only
  the capture-reading ledger bilingual.
