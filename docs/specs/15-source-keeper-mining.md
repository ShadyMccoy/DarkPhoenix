# 15 — Source-Keeper mining: garrison the ring, mine the 4000s

**Status:** design overview only — NOT started, NOT scheduled. This note exists
to name the shape of the work and pin the economics so that when it is picked up
the acceptance tests are already the contract. "A lot of the other bots do this
and we don't" is the motivation, not a commitment.

**Priority:** P3 (behind the economy specs and expansion). SK mining is a
*late-game income multiplier*, not a survival need: it only pays once a room can
sustain a standing military body, i.e. RCL7+ with real extension capacity. An SK
op opened before the economy can garrison it just feeds miners to keepers.

---

## Why this is worth a spec

Source-Keeper rooms ring every sector's center (the 6-room band at grid coords
`mod 10 ∈ [4,6]`, excluding the `(5,5)` crossroads — `isSourceKeeperRoom`,
`utils/RoomDiscovery.ts:284`). Each SK room holds **2–3 sources plus a mineral,
each guarded by a Keeper Lair**, and — critically — **no controller**. The
sources are `SOURCE_ENERGY_KEEPER = 4000` capacity, regenerating over the same
`ENERGY_REGEN_TIME = 300`, so:

    SK source rate = 4000 / 300 ≈ 13.3 e/tick   (vs 3000/300 = 10 unreserved,
                                                  = 10 reserved-remote today)

A 3-source SK room is **~40 e/tick of gross producer capacity** sitting one or
two rooms outside most mature colonies — more than a second owned room's worth
of sources, with no GCL cost and no claim campaign. That is the payoff, and it
is why the mature bots all take the ring.

We take **none of it today**. SK sources are excluded at two seams, on purpose:

- **Planner blindness** — `FlowGraph.discoverSources` skips any source whose
  room `isSourceKeeperRoom` (`flow/FlowGraph.ts:114`), so the CorpPlanner never
  sees an SK source as a producer. (`getMinableSources` /
  `isSourceKeeperSource` in `analysis/SourceAnalysis.ts` is the in-vision
  equivalent — a lair within 5 tiles of the source.)
- **Creep exclusion** — `isSourceKeeperRoom` also keeps our *other* creeps out
  (scouts wandered into `W44N24` and died to keepers — measured 4 dead on the
  shard1 fixture; see the function's docstring).

Both exclusions are correct **until we can fight**. This spec is the plan for
lifting the first one behind a garrison, without lifting the second one for
anything but the garrison itself.

## The world facts that shape the mission (engine ground-truth — VERIFY before building the gate)

The repo culture is measured-not-vibes (CLAUDE.md epistemics) and spec 12's
payback math was wrong three ways until checked against the vendored engine.
The SK combat numbers below are from community consensus and MUST be re-derived
from the vendored engine (`SOURCE_ENERGY_KEEPER`, the keeper body template, lair
respawn constant, `attack`/`rangedAttack`/`heal` intents) before any body
builder or gate constant is committed. Treat every number here as a placeholder
pending that pass.

| Fact | Value (verify) | Why it matters |
|---|---|---|
| SK source capacity | `SOURCE_ENERGY_KEEPER` = 4000 | 13.3 e/tick — needs **7 WORK** to saturate (7·2=14 ≥ 13.3), not the 5-WORK standard miner. Body builder must size for the higher rate or leave energy on the floor. |
| Controller | **none** | No reservation, ever. SK sources are *intrinsically* 4000 — there is no reserve-to-double step and **no ReservationCorp involvement**. Simpler than a remote in this one way. |
| Keeper Lair | 1 per source + 1 per mineral, ≤5 tiles away | Respawns a keeper ~300 ticks after its death; `lair.ticksToSpawn` counts down while the keeper is dead. The guardian must be **adjacent and ready** when it hits 0 or the fresh keeper frees-fires on the miner. |
| Source Keeper | ~5000 hits, melee + ranged + self-heal, aggro radius small (~5) | A *persistent* threat, not TTL-bounded. Killing one buys ~300 ticks; then it respawns. The garrison is **standing overhead forever**, not a one-off CAPEX. This is the whole economic difference from spec 12's core-buster. |
| Mineral | 1 per SK room | **Out of scope** — mineral/extractor/deposit economy is a separate producer class. This spec is energy-only; the mineral's lair is still a threat the guardian must suppress if it shares the miner's path. |

## The economic model (the real content)

SK mining slots into the existing ontology as a **guarded producer**. The corp
framework already has the vocabulary; what is new is one primitive and one
military auxiliary that is a *precondition*, not a bystander.

### One new primitive: the garrison tax

`economy/primitives.ts` is the single home for economic math (kind-conformance
enforces it to 1e-9 — no module may reimplement). SK mining adds exactly one
per-tick quantity, mirroring `minerOverhead`:

    keeperGuardOverhead(d) = GUARD_BODY_COST / effectiveLife(d)

A guardian is a big body (attack/heal or ranged/heal, ~2500–4500 energy) that
must be **continuously renewed** for as long as the room is mined. Unlike the
core-buster's one-off, it amortizes like a miner does — over `effectiveLife`,
forever. One guardian covers a whole SK room (it walks lair to lair suppressing
keepers), so the tax is **per room**, spread across that room's 2–3 sources.

The producer admission test then extends `netEnergy` (`primitives.ts:73`) with
the room-shared garrison cost:

    netEnergy_SK(source, d) = rate                       (~13.3)
                            − minerOverhead(d)
                            − haulerOverhead(carry, d)
                            − keeperGuardOverhead(d) / sourcesInRoom

An SK source is admitted **iff** that net is positive AND a guardian is
sustainable AND the room is in range. Because the garrison cost is divided
across the room's sources, **a 1-source SK room rarely clears the bar and a
3-source room clears it easily** — the economics correctly say "take the rich
rings, skip the thin ones," with no special-case flag. That is the design's
whole bet, same as expansion (spec 06): price it and let the behavior fall out.

This also gives the natural gate for *when* a colony starts: the garrison body
only fits above a certain extension capacity, so a low-RCL colony's
`keeperGuardOverhead` is effectively infinite (can't build the body → no
guardian → net stays negative) and SK sources stay excluded on the math, not on
an RCL constant.

### The precondition: garrison before miner (GOAP + the durable-signal trap)

In GOAP terms (ONTOLOGY §5) SK mining adds a **precondition edge**: *mine SK
source S* requires *room(S) is held*. "Held" must be a **durable signal**, never
"a guardian creep is standing there this tick" — that is exactly the
stranded-reserver / room-state-from-intel trap in CLAUDE.md (a trigger keyed to a
live creep flaps on every death and goes blind with the vision the dead creep
provided). The held-signal must live on `Memory.roomIntel` (a `keeperHeldUntil`
mark, or "guardian alive AND all lairs' keepers dead/low", stamped by the
guardian's own vision), read by BOTH the miner's admission gate and the
guardian's demand — the same-lens symmetry rule.

Concretely:

- **HarvestCorp / CarryCorp change: none structurally.** They already mine and
  haul cross-room. They only need the SK source to appear in the plan, which it
  does once `discoverSources` admits it (below). But they MUST gate on the
  held-signal the same way they gate on `hostileRooms()` today — an ungarrisoned
  SK room is a defunded room until the mark says otherwise. Reuse the existing
  defund plumbing; do not invent a parallel one.
- **KeeperGuardCorp (new CorpKind)** — the garrison. Pattern is
  `coreBusterKind` / `raidGuardKind`: a self-proposing auxiliary, one commission
  per home spawn, the commissioning gate at runtime. It proposes a guardian for
  every SK room the plan wants to mine and that is in range. It is **MILITARY**:
  exempt from the `hostileRooms()`/held gate for its own target room (it exists
  to enter the room the economy won't), exactly like the core-buster's exemption.

### Wiring traps (each has burned a session — CLAUDE.md, copy the checklist)

A new corp kind is not done until all of these are done:

1. Register `keeperGuardKind` in `CommissionHost` `KINDS`.
2. Add it to `OrphanRescue` `liveCorpIds` (else its guardians get orphan-recycled).
3. Add it to `SpawnDirector.collectDemands` (else it never spawns).
4. `materialize` must refresh `spawnId` on the existing corp every tick (the
   immortal-consumer stale-spawn trap; conformance test enforces).
5. Pure planner id (`keeperGuard-{roomName}`) vs runtime id — strip prefixes
   consistently or silently orphan live guardians.
6. Guardian spawn value sits in the **income tier but never blocking** (compare
   core-buster's 104: above miners' 100 band because it unblocks a zeroed income
   stream, below reserver 115). A garrison the economy can't yet afford must
   wait in the queue, not stall the colony.
7. Body builder: a new `buildKeeperGuardBody` (attack/heal or ranged/heal). Cap
   it from the engine keeper template, not an estimate — `buildGuardBody`
   (`spawn/BodyBuilder.ts:500`) sized raid guards straight off the engine's raid
   table; do the same here.

### What does NOT change

- No new solver, no new value model. SK sources are ordinary producers behind a
  precondition; `selectProducers` / `routeToSinks` rank them by
  net-energy-per-build-part like everything else.
- No ReservationCorp involvement (no controller).
- `isSourceKeeperRoom`'s **creep-exclusion** stays live for every non-garrison
  role — scouts, reservers, expansion candidates still avoid SK rooms. Only
  miners/haulers into a *held* room and the guardian itself are exempted.

## Staged rollout (design overview — phases, not a schedule)

1. **Phase 0 — economics + gate, no combat.** Add `keeperGuardOverhead` and the
   `netEnergy_SK` admission to `primitives.ts` (+ kind-conformance). Add the
   `keeperHeldUntil` intel mark and the same-lens gate on HarvestCorp/CarryCorp.
   Lift `discoverSources`' SK skip *behind the held-signal* (an unheld SK room
   still admits nothing). Testable with a **staged** guardian (grid db insert),
   no live combat — proves the plan opens the mine exactly when the room is
   marked held and never before.
2. **Phase 1 — the garrison.** `KeeperGuardCorp` + `keeperGuardKind` +
   `buildKeeperGuardBody`, wired per the trap checklist. Behavior: walk to the
   SK room, patrol lairs, kill/suppress keepers, stamp `keeperHeldUntil` from
   its own vision. Simplest viable tactic first — **park-and-kill** (guardian
   camps the lair, kills the keeper as it spawns); leave **kiting** (ranged
   hit-and-run to avoid melee return fire) as an optimization once park-and-kill
   is green and measured.
3. **Phase 2 — tuning.** Boosts, guardian body shape (melee vs ranged), one
   guardian covering multiple lairs' timing, and the mineral-lair interaction.
   Only after phases 0–1 are grid-pinned.

## Acceptance tests (write first when picked up — these ARE the contract)

Sketch, to be filled in at build time:

- **Unit — the admission gate** (`test/unit/economy/keeperMining.test.ts`):
  table-driven `netEnergy_SK`. A 3-source room clears the bar; a 1-source room
  does not; the bar moves correctly with distance and with guard-body cost
  (extension capacity). No proposal for an *unheld* room; no proposal beyond
  `MAX_SCOUT_DISTANCE`.
- **Unit — same-lens symmetry**: the miner's admission gate and the guardian's
  demand read the identical held-signal; a killed guardian does NOT flap the
  mark (durable-signal regression, the stranded-reserver pin).
- **Unit — kind conformance**: `keeperGuardKind.materialize` refreshes
  `spawnId`; registered in the three required places (host/orphan/director).
- **Grid — `plan-t7-sk-room-mined`** (tier 7, the ratcheted metric): stage an
  SK room (2–3 sources at 4000, keeper lairs, a stageable keeper via db insert —
  the mockup does not run raid/keeper crons, spec 08 blind-spot; grid cells
  stage their threats by insert). Assert: a guardian is fielded, keepers stay
  suppressed, and ≥1 miner works an SK source with delivered energy reaching a
  home sink before window end.
- **Grid — `plan-t7-sk-thin-room-skipped`** (the non-vacuity twin): a
  1-source SK room whose net is negative → **never** garrisoned or mined (the
  economics hold the line, not a flag), mirroring def-t5's flight/no-military
  baseline pairing.
- **Regression gate**: unit suite + `flow-handoff`, `runt-economy`,
  `storage-depot`, and the def-t3/def-t5 invader cells (shared `isSourceKeeperRoom`
  / `hostileRooms` lenses must not regress).

Update `test/grid/baseline.json` in the same commit as the bot change that
earns the new cells (the workflow rule).

## Open questions / risks

- **Guardian body: melee vs ranged.** Melee (attack/heal) is cheaper per damage
  but eats keeper return fire; ranged (rangedAttack/heal) kites but costs more
  and needs the park-and-kill tactic reworked. Decide empirically in phase 2;
  phase 1 should ship whichever is simplest to keep green.
- **Timing coupling across lairs.** One guardian covering 2–3 lairs must be at
  the right lair when each keeper respawns (~300-tick cycles, out of phase). If
  one guardian can't cover the walk, the room needs two — which the
  per-room-divided garrison tax must then price. Measure before assuming one
  suffices.
- **Miner survivability during the hold-gap.** Between "keeper dead" and "keeper
  respawns," the miner is safe; the risk is the guardian dying and the mark
  going stale before miners retreat. The defund must retreat miners promptly on
  mark loss — reuse the `hostileRooms` retreat path, don't invent a new one.
- **Live-only blind spots (CLAUDE.md).** The mockup never spawns keepers on its
  own — every SK grid cell stages them by insert, and green sims do **not**
  prove live-readiness against real keeper AI. Flag this loudly at build time.

## Natural follow-up: mineral harvesting rides the same garrison

Out of scope for *this* spec (energy-only), but the design makes it the obvious
next step, and cheaply so. The expensive part of an SK room — the standing
guardian — is a **sunk cost the moment the room is held for energy**. A mineral
op in an already-garrisoned room therefore pays a *marginal* cost of only an
extractor + a mineral-hauler, with **no new military**: the guardian already
suppresses the mineral's lair on its patrol. So the sequencing is deliberate —
land energy SK mining first, and mineral harvesting becomes a near-free rider on
the garrison it already funds (its own spec, its own producer class, but gated
on the same `keeperHeldUntil` mark and reusing the same guardian). Worth pricing
that shared-garrison discount when the mineral spec is written: the mineral's
admission bar is far lower in a room we already hold than in one we don't.

## Non-goals

- Mineral / extractor / deposit harvesting in SK rooms (separate producer class,
  but a cheap follow-up on a held room — see above).
- Center `(5,5)` rooms, portals, power banks, strongholds (levels 1–5) — all
  different weight classes.
- Kiting/boost micro in phase 1 (park-and-kill first).
- Lifting `isSourceKeeperRoom`'s creep-exclusion for anything but the guardian
  and held-room miners/haulers.
