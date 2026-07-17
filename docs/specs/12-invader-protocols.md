# 12 — Invader protocols: flight, and eventually fight

**Status:** Phase 1 (flight on invader-core reservation) **LANDED 2026-07-16**
— stays live as the fallback layer. Phase 2 (fight) is SUPERSEDED by
[spec 13](13-invader-economics.md) phase 4 (owner directive 2026-07-17:
"keep the remote flowing" — guards in remotes, towers at home): the design
below carries over with corrected engine-ground-truth economics (see the
corrections block under phase 2) as a kill **+ strip** mission.
**Priority:** was P3; now P1 via spec 13 tranche 3.

## The problem

Invader cores deploy into remote rooms and RESERVE the controller (live
sighting: "Reserved: Invader (4998)"). The core is a **structure**, not a
creep, so the v1 defense economics — `hostileRooms()` marking rooms from
sighted hostile *creeps* — never triggers. The colony keeps funding the room:
miners walk in (the source is contested and our reserver can't take the
controller back, so income is throttled at best), reservers bounce off the
reserved controller, and bodies are bought for a room we cannot hold. Up to
~5000 ticks of waste per occupation.

## Phase 1 — flight: defund invader-reserved rooms (LANDED)

The reservation itself is the observable. One new mark on `RoomIntel`, same
lifecycle as `hostileUntil`:

- **Stamp** — `hostileRooms()`'s vision pass reads
  `controller.reservation.username === "Invader"` (`INVADER_USERNAME`,
  `utils/RoomDiscovery.ts`) and stamps
  `invaderReservedUntil = Game.time + reservation.ticksToEnd`.
- **Bound** — the mark persists WITHOUT vision until that tick, then lapses
  (funding resumes on its own if we never look again). A live core renews its
  reservation, so every fresh sighting refreshes the bound.
- **All-clear** — a fresh sighting with the reservation gone lifts the mark
  early, exactly like the hostile-creep mark.
- **Effect** — `hostileRooms()` returns the union of both marks, so every
  existing consumer defunds for free: HarvestCorp (no miners), CarryCorp (no
  haulers for routes picking up there), ReservationCorp (no reservers),
  constructionKind (no remote construction), expansion (not a claim
  candidate). No consumer changed.

### Acceptance tests (all landed green)

- **Unit** `test/unit/utils/roomDiscovery.test.ts`: stamp + bound; no mark
  for our own/another player's reservation; blind persistence until the
  bound; early all-clear lift; controller-less rooms; both marks coexisting
  in one room (creeps die → creep mark lifts, reservation mark holds).
- **Grid** `def-t5-invader-reservation-defunds-remote` (tier 5, defense):
  two-room world, east remote's controller reserved by user "2" for 5000
  ticks, staged remote harvester for standing vision. The planner still
  OPENS the remote mine (non-vacuity: the defund, not the planner, holds the
  line — measured red at tick 224 on pre-change code), intel stamps the mark
  at tick 1, and no miner/hauler/reserver is ever funded for the room across
  the 300-tick window.
- **Regression gate**: unit suite + `flow-handoff`, `runt-economy`,
  `storage-depot` + `def-t3-invader-defunds-source` (the creep flavor still
  passes on the shared lens).

## Phase 2 — fight: kill the core, take the room back (SPECCED, DEFERRED)

> **Engine-ground-truth corrections (2026-07-17, see spec 13):** the payback
> math below is wrong in three ways, all verified against the vendored engine.
> (1) Income under a foreign reservation is **zero**, not throttled — the
> harvest intent returns early (`engine .../creeps/harvest.js:31`), so the
> occupation wastes the room's FULL rate. (2) Killing the core does **not**
> clear the reservation (`invader-core/destroy.js:11-23`); it decays at
> 1/tick from up to 5000, and `attackController` strips only CLAIM_parts×1
> per attack from a reservation — the mission is kill **+ strip**, and
> ReservationCorp cannot re-take until the strip completes. (3) The
> occupation bound is the parent stronghold's collapse timer (up to ~82.5k
> ticks — the core renews its 5000-tick reservation indefinitely), not 5000;
> and the stronghold replants a lesser core every 2000-4000 ticks. Net: the
> buster's benefit is larger than stated, its restoration lag is longer, and
> it is a recurring chore, not one-and-done. Use spec 13 phase 5 for the
> corrected ledger when this is picked up.

Economics first: a level-0 expansion core has 100k hits and no attack. A
~10×ATTACK melee creep (~1300 energy incl. MOVE) kills it in ~330 ticks of
contact. Payback: a reserved remote source is ~10 e/tick versus ~5
unreserved, and an occupation left alone wastes up to 5000 ticks of that
margin — the buster pays for itself if the room's remaining occupation
exceeds ~500 ticks (read `invaderReservedUntil` for exactly this number).
That is the commissioning gate, not a constant.

Design (as a CorpKind through the spec-00 framework):

1. **CoreBusterCorp** (`corps/kinds/coreBusterKind.ts`) — self-proposing
   auxiliary, pattern of `reservationKind`. Propose ONE commission per room
   that is (a) remote-mined by the current plan, (b) marked
   `invaderReservedUntil` with ≥ ~1000 ticks remaining (payback gate), and
   (c) within `MAX_SCOUT_DISTANCE` of the home spawn.
2. **Behavior** — spawn one attacker (`buildAttackerBody`, new in
   `BodyBuilder`), walk to the target room (`travelTo`), attack the invader
   core (`FIND_HOSTILE_STRUCTURES`, `structureType === STRUCTURE_INVADER_CORE`);
   handle the deploy-invulnerability effect by waiting adjacent. When the
   core dies the reservation decays on its own; the existing ReservationCorp
   re-takes the controller once `reservation` clears (its targetRooms filter
   already handles this — no change).
3. **Wiring traps** (each has burned a session — CLAUDE.md): add the kind to
   CommissionHost `KINDS`, OrphanRescue `liveCorpIds`, SpawnDirector
   `collectDemands`; `materialize` must refresh `spawnId`; run the
   kind-conformance suite.
4. **Defund interaction** — the buster is MILITARY, not economy: it must be
   exempt from the `hostileRooms()` gate for its own target room (it exists
   to enter exactly the rooms the economy flees). Spawn demand value below
   reserver (115): the fight is an income optimisation, never blocking.

### Acceptance tests (phase 2, write first when picked up)

- **Unit**: the commissioning gate (payback math: remaining occupation vs
  kill cost — table-driven off `invaderReservedUntil`); body builder caps;
  no proposal for rooms we don't mine / marks below the gate / SK rooms.
- **Grid** `def-t5-core-buster-reclaims-remote`: stage a destroyable
  `invaderCore` object + reservation in the east room (backend supports
  strongholds — `@screeps/backend/lib/strongholds.js`); assert the buster is
  fielded, the core object disappears, the reservation clears, and a miner
  works the source before window end. The phase-1 cell stays as the
  no-military baseline (it stages a reservation WITHOUT a core, which phase 2
  must not chase — that's the "core already dead, reservation decaying" case
  where fighting buys nothing).
- **Regression gate**: standard trio + both def-t* cells.

## Non-goals

- Fighting invader *creeps* (raids): TTL-bounded, self-resolving; the v1
  defund already prices them correctly.
- Strongholds (level 1-5, ramparted, in their own rooms): different weight
  class entirely; out of scope.
- Attacking other players' reservations: political, owner's call, not a
  protocol.
