# 30 — RaidingCorp: haul the loot out of soft targets

**Status:** PROPOSED — backlog capture 2026-07-23 (owner: *"it basically just goes
into other players' bases and takes their resources"*). Design overview only,
NOT scheduled, NOT started. This note names the shape of the work and pins the
economics so that when it is picked up the acceptance tests are already the
contract. It also names, loudly, the two hard dependencies (typed resources,
new intel) without which raiding is either worthless or blind.

**Priority:** P3 — behind the economy specs (15/16/18), delivery (19), and
accounting (20). Raiding is an *opportunistic income multiplier*, not a survival
need; it only pays once a colony can spare a military escort's build-time.

**Lineage:** the machinery already exists in pieces. `economy/scavenge.ts` is
the *hauling-a-transient-stock* precedent; `raidGuardKind` / `coreBusterKind`
are the *military-exemption auxiliary* precedent; spec 21 (Conquest) is the
*peace-is-default, offense-is-a-priced-exception* doctrine; spec 13's guard/
buster kit is the proto-machinery. Raiding sits **below** conquest on the
commitment ladder: grab-and-go, no claim, no siege, no GCL cost.

---

## The idea

Other players' storages and terminals are already-harvested energy and refined
minerals sitting in a pile. When a base is **weakly defended** — no tower
energy, a decaying controller, dead spawns, absent defensive code — that pile is
**scavenge, made hostile**: no miner, no source, just a hauling convoy that
walks in, empties the store, and walks home. The whole corp is a big carry
operation pointed at someone else's warchest, gated on "is this actually easy?"

The value proposition over founding/mining: the energy is **already extracted
and concentrated** (a full storage is 10⁵–10⁶ energy in one tile), it costs
**zero GCL** and **zero claim campaign**, and — unlike SK mining (spec 28) or a
remote — it is a **one-off drain**, not a standing garrison. The convoy
demobilises the instant the store is empty, exactly like a scavenger whose pile
decayed below threshold.

### The canonical target: the derelict bot (owner 2026-07-23)

The archetype that motivates the whole feature is not a live, momentarily-weak
player — it is an **old bot that is still running but breaking down**:
accumulating resources for a long time (~1M in the storage) yet **energy-starved
and mis-coded**, so its defenses have **decayed past its own ability to restore
them**. The tell is a **dark tower it cannot refill** — a tower with no energy,
owned by a bot whose storage/controller is starved and whose code no longer
routes energy to defense. We can **literally walk in and take it**.

That reframes the weakness signal precisely, and it matters for the design:

- The golden condition is not "**un**defended" — it is "**can no longer defend**":
  a defense apparatus present on the map but non-functional and **un-restorable
  by the owner** (dark tower + starved storage + decaying controller + no repair/
  build activity). A momentarily-empty tower on a healthy bot refills next tick;
  a dark tower on a derelict never does. Same observation, opposite verdict —
  which is exactly why the read must be **probed over time**, not snapshotted.
- Cheap **breaches** are legitimate and may be worth it — a dark tower is a
  one-off kill (nobody refills it), a rampart may have a **hole**, a wall may be
  low. "Undefended-only" (below) is the *phase-1 conservatism*, not a permanent
  ceiling: taking down a dead tower or slipping a rampart gap is a natural
  refinement once the probe is trustworthy. Left deliberately open here so the
  idea isn't lost — refine it when picked up.

### The probe IS the feature; the hauling is straightforward (owner 2026-07-23)

Be clear about where the work is. Moving 1M energy out of a store is ordinary
CarryCorp mechanics — a big convoy, solved. **The hard, interesting, novel part
is learning to PROBE**: deciding, from durable observation over time, that a base
is genuinely a walk-in and not a trap. That judgement — reading tower energy,
owner starvation, controller decay, repair cadence, `safeMode`, and how they
*trend* — is the actual capability this spec adds. Build the probe as the
first-class deliverable; the haul rides on existing rails.

## Why this is a corp (and where it slots)

Raiding is a **guarded transient source in a hostile foreign room**. It maps
cleanly onto the existing ontology with no new solver:

- **The loot is a transient source** (`PlannerSource { transient: true,
  maxMiners: 0 }`, `economy/CorpPlanner.ts:78`). Two live precedents build
  exactly this: `scavenge.ts` turns a ground stock into a rate-bounded,
  miner-less source that demobilises when drained; and — closer still —
  `bank.ts:124` `bankToTransientSource(roomName, storagePos, banked)` makes a
  transient source **at a storage position**, drained by a hauler-shaped route
  (wired at `flowAdapter.ts:326`). An enemy storage is that same object with
  three differences — it is (a) huge, (b) in a room our creeps avoid, and (c)
  not ours to take for free.
- **The haul is CarryCorp's job structurally** — cross-room hauling from a
  pickup to a home sink is what haulers already do. But the hauler defund gate
  (`CarryCorp.ts:1220`: `if (hostileRooms().has(sourceRoom)) return []`, plus
  the `routeIsDangerous` route gate) fields **zero** haulers into a hostile
  room. So the raid haulers need the **same military exemption** the guard/
  buster carry: the exemption is simply *not calling that gate* for the held
  target (there is no positive flag — `RaidGuardCorp.ts:16-19,226`).
- **The escort is a new military auxiliary** — `RaidingCorp` (or a paired
  `RaidEscortCorp`), pattern of `coreBusterKind`: one commission per home spawn,
  the interesting trigger (an easy-pickings target in range) evaluated at
  RUNTIME off `Memory.roomIntel`, exactly like
  `CoreBusterCorp.missionTargets` (`corps/CoreBusterCorp.ts:98`).

So structurally this is **scavenge.ts's transient-stock hauling + coreBuster's
intel-scan-and-enter-hostile-room + a `netLoot` admission gate**. Almost every
part has a live precedent; the genuinely new work is the target-selection intel
and the two dependencies below.

## The two hard dependencies (name them before building)

Raiding is blocked on two things the codebase does **not** have today. Pretend
otherwise and phase 1 ships either blind or worthless.

### 1. Loot is mostly NOT energy — typed resources (ONTOLOGY §9)

An enemy storage/terminal holds energy **and** minerals, bars, and lab
compounds. The whole economy is **energy-denominated** — `primitives.ts`, the
planner, sink values, `netEnergy` all speak energy, and ONTOLOGY §9 is explicit:
*"primitives stay energy-denominated until a second resource exists."* So an
energy-only raid corp can only haul the **energy** fraction of a store, which is
typically the *least* valuable part of a raided base (the point of a raid is the
compounds and minerals you can't easily produce).

- **Phase 0/1 can be energy-only** and still prove the machinery (hauling loot
  home, the military gate, the admission math) against staged energy-filled
  storage. It just isn't worth much live.
- **The valuable version waits on the typed-resource extension** (ONTOLOGY §9:
  the Commission envelope's `consumes`/`produces` grow a `resource` field, and a
  market/terminal sink exists to *value* non-energy loot). Raiding is one of the
  strongest **motivating use-cases** for that extension — worth citing when
  spec 18/the typed-resource work is scheduled. Do NOT hard-code "energy" in the
  raid pickup/sink path (§9's rule); write it against "resource-at-place" so it
  lights up when the second resource lands.

### 2. The "easy pickings" signals are NOT recorded today

`RoomIntel` (`types/Memory.ts:18`) already stamps `controllerLevel`,
`controllerOwner`, `controllerReservation`, `hostileCreepCount`,
`hostileStructureCount`, `isSafe`, `lastVisit`. It does **NOT** record any of:

- **enemy `storage`/`terminal` contents** (the loot amount — the whole target
  signal),
- **tower count / positions / tower energy** (the dominant defense signal —
  a tower with energy is a raid-killer; a *dark* tower is a green light **only
  if the owner can't refill it** — see the derelict archetype above: read tower
  energy as a TREND, not a snapshot),
- **controller downgrade / decay state** (`controller.ticksToDowngrade`,
  progress — a decaying controller is the strongest "owner has quit / code is
  down" signal),
- **spawn count / hits** (dead or downgraded spawns = can't rebuild defense),
- **last-owner-activity cadence** (construction sites appearing? repairs
  happening? — proxies for "is the code even running").

These are **new intel fields** the scout (and any raid hauler's own vision)
must stamp — the natural extension point is `ScoutCorp.recordRoomIntel()`
(`corps/ScoutCorp.ts:222`), which today reads sources/mineral/controller and a
bare `FIND_HOSTILE_STRUCTURES.length` (`:250`) but **never** touches
`room.storage` / `room.terminal` or breaks structures out by type. Every
storage read in the tree is gated on `.my` ownership (`flowAdapter.ts:325`,
`IncrementalAnalysis.ts:651`), so reading a *foreign* store is genuinely new
surface. These marks are the load-bearing input — which makes the trap below
the central risk of the whole spec.

## "Easy pickings" as a MEASURED, DURABLE signal (the central trap)

*(CLAUDE.md trap list, applied doubly against a reactive opponent — this is the
same class as the stranded-reserver incident and spec 28's held-signal.)*

The temptation is to key the raid trigger on live vision: *"we can see their
towers are empty right now, go."* That is the **room-state-from-creep-positions
/ vision** trap. A trigger keyed to what one creep sees this tick **flaps on
every death and goes blind with the vision the dead creep provided** — precisely
when a raid convoy is deepest in a hostile room and most needs a stable read.
It is also the *wrong measurement*: a snapshot cannot distinguish a
momentarily-empty tower on a healthy bot (refills next tick — a trap) from a
dark tower on a derelict (never refills — a walk-in). **The verdict lives in the
TREND, not the snapshot** — did the tower stay dark across several sightings
while the owner's storage/controller stayed starved and nothing got repaired?
That is what "learning to probe" means, and it is the feature.

The rules, non-negotiable:

- **Weakness is PROBED, never judged** (spec 21 rung 1): a cheap MOVE-only
  scout measures tower trigger-happiness, response latency, repair reflexes, and
  reads store contents — *information is the product*. The raid convoy commits
  only against probed data, never a guess from a map glance.
- **Every raid decision reads ONE durable lens off `Memory.roomIntel`**, stamped
  with an absolute tick bound (the `hostileUntil` / `reservedUntil` /
  `keeperHeldUntil` pattern), and **both the admission gate and the escort's
  demand read the SAME lens** (the `staffsPost`/same-lens symmetry rule).
  Proposed marks: `lootSeen` (store contents + tick), `defenseScore` (tower
  energy + hostile military, tick-bounded), `ownerActivity` (decay/activity
  cadence). The convoy commits against the *mark*, not against vision.
- **The mark decays honestly** while blind (like `reservedUntil` counting
  down) — an old `lootSeen` is worth less because they may have refilled or
  fled; a re-sight corrects it. Long-blind marks expire and the target drops.

## The economic model

### Admission: netLoot, priced with the escort tax

Raiding slots in as an ordinary transient producer behind a precondition, the
same shape as spec 28's `netEnergy_SK`. The loot is free (already extracted), so
the gate is dominated by the **escort tax** — the military body that must live
long enough to hold the room open for the drain:

    raidEscortOverhead(d) = ESCORT_BODY_COST / effectiveLife(d)    // one-off-ish:
                                              amortised over the RAID, not forever

    netLoot(store, d) = lootValue(store)                    // energy today; +typed later
                      − haulerOverhead(carry, d)            // the convoy
                      − raidEscortOverhead(d) / drainTicks  // escort held over the drain
                      − distance/decay risk discount        // blind-mark haircut

A target is admitted **iff** netLoot is positive AND an escort is sustainable
AND the room is in range AND the durable weakness mark holds. Unlike SK mining,
the escort is **NOT a standing forever-garrison** — it is held only for the
`drainTicks` of one raid (grab-and-go), so it amortises over the raid, not over
`effectiveLife`. That is the whole economic difference from spec 28: raiding is
CAPEX-light because it does not commit to a place.

Crucially, target preference must **fall out of the costing**, never a flag
(spec 28's whole bet, spec 06's "price it and let behavior fall out"): a fat
undefended store clears the bar easily; a thin or well-towered one goes
negative on the escort tax and is skipped **on the math**. No `isRaidTarget`
boolean anywhere.

### New primitive — one home for the escort tax

Per the economics rule (CLAUDE.md; kind-conformance to 1e-9): `raidEscortOverhead`
and `lootValue` live in `economy/primitives.ts`, nowhere else. `lootValue` is
energy-only until typed resources exist, then it prices the store by resource ×
market/terminal value (the §9 extension) — a single seam to upgrade.

### Sink for the loot

Raided energy/minerals come home to storage/terminal like any hauled energy —
the existing home-sink ladder and bank/hub mechanism (spec 03) already absorb
it. No new sink model. (Non-energy loot needs a terminal/market sink to have
value at all — dependency 1 again.)

## The corp shape and wiring (registration-only — the trap checklist)

New corp kinds integrate by **registration only** (spec 17): one kind file + one
`KINDS` entry; everything else derives from declarations. A new kind is not done
until all of these are (CLAUDE.md + spec 28's checklist, copied because each has
burned a session):

1. `raidingKind` registered in `CommissionHost` `KINDS`.
2. Added to `OrphanRescue` `liveCorpIds` (else escorts/haulers orphan-recycle).
3. Added to `SpawnDirector.collectDemands` (else it never spawns).
4. `materialize` refreshes `spawnId` on the existing corp **every tick** (the
   immortal-consumer stale-spawn trap; conformance-enforced).
5. Pure planner id (`raiding-{roomName}` or per-home-spawn) vs runtime id —
   strip prefixes consistently or silently orphan live creeps.
6. **MILITARY EXEMPTION**: the escort and the raid haulers do NOT gate on
   `hostileRooms()` for their target room — they exist to enter exactly the
   room the economy avoids, like `coreBusterKind` (`CoreBusterCorp.ts:20`, the
   exemption docstring). The exemption is scoped to the *held target*, never a
   blanket lift (spec 28's rule: don't lift the avoid-gate for scouts/founders).
7. Spawn value in the **income tier but never blocking** (coreBuster's 104 band:
   above the miner band because it unblocks value, below reserver 115). A raid
   the colony can't afford waits in the queue; it never stalls the economy.
8. Bodies: `buildHaulerBody` / `buildRatioHaulerBody` (`spawn/BodyBuilder.ts:168`,
   `:233`) covers the convoy **for the undefended case only**. Note the gap
   (agent-verified): `BodyBuilder.ts` emits miner/hauler/tanker/upgrader/
   reserver/guard bodies and nothing else — `buildGuardBody` (`:531`) is
   **ATTACK/MOVE only, no HEAL/TOUGH/RANGED**, and there is **no** under-fire
   loot-hauler body (TOUGH+CARRY+MOVE) at all. A raid against anything with
   live tower fire therefore needs a **new body builder** (a self-healing or
   TOUGH-fronted escort, and/or an armored hauler), capped from the engine
   template not an estimate (spec 28 rule 7). Phase 1's undefended-target-only
   scope is partly what keeps this off the critical path.
9. Target selection: mirror `CoreBusterCorp.missionTargets` — scan
   `Memory.roomIntel`, filter on the durable weakness marks + `netLoot` +
   `Game.map.getRoomLinearDistance ≤ MAX_SCOUT_DISTANCE`, assign the fleet.

## The abort / standing-asset doctrine (mirror conquest; heed the bandaid trap)

Two CLAUDE.md rules govern the failure modes, and both cut the same way:

- **Pre-committed kill-switch** (spec 21's abort rule): the raid carries its
  abort from commit — if the probed weakness was wrong (towers refill, a real
  defender fleet arrives, the owner adapts), **stand down and re-target**. Sunk
  escort is already spent. Abort thresholds are set at admission time, before
  the convoy enters — an abort that needs a fresh decision under escalation is
  how a cheap grab becomes an expensive war.
- **Scarcity acts at the SPAWN, never by revocation** (the bandaid trap, owner
  2026-07-20): a rule whose distress response is *retire the commission / strand
  the standing convoy* is the wrong class regardless of trigger. A convoy
  already hauling a profitable store keeps hauling; scarcity means **no NEW raid
  bodies** (via spawn priority), not recall of the fleet mid-drain. If the raid
  turns unprofitable it demobilises **emergently** — the transient source drops
  out of the plan when `netLoot` goes negative or the store empties, exactly
  like a decayed scavenge pile, and the convoy retreats home on the standard
  `hostileRooms()` retreat path (reuse it; do not invent a parallel recall).

## Strategic / doctrinal framing (this is offense against real players)

Peace is the default strategy (spec 21): quiet neighborhoods are where colonies
survive, and every fight invites retaliation. Raiding is a **narrower, cheaper**
exception than conquest — you take the *loot* and leave, you don't take the
*room* — but it is still a hostile act against a real opponent who may retaliate
or adapt. Target selection must therefore weight **blowback**, not just netLoot:
prefer already-dead/abandoned bases (decaying controller, dead spawns — nobody
home to retaliate) over merely-momentarily-weak active players. An abandoned
base is pure scavenge; a sleeping active player is a fight waiting to wake up.
This is a strategy-layer weighting (spec 18), captured here so it isn't
forgotten at build time.

## Staged rollout (phases, not a schedule)

0. **Intel + economics, no combat.** Add the weakness-mark fields to `RoomIntel`
   and stamp them from scout/hauler vision (durable, tick-bounded). Add
   `lootValue` (energy-only) + `raidEscortOverhead` + the `netLoot` admission to
   `primitives.ts` (+ kind-conformance). Lift the enemy-storage exclusion in the
   producer discovery **behind the weakness mark** (an unmarked enemy room
   admits nothing). Testable with a **staged** escort (grid db insert) against a
   staged energy-filled storage — proves the plan opens the raid exactly when
   the room is marked easy and never before. No live combat.
1. **The convoy + escort.** `RaidingCorp` + `raidingKind` + the wiring
   checklist. Behavior: escort walks to the target, suppresses/tanks the weak
   defense, raid haulers empty the store into home storage, everyone retreats on
   drain/abort. Simplest viable tactic first — target **only walk-ins**: a store
   the probe marks as unreachably-defended-no-longer (dark unrefillable tower, no
   live defenders, no `safeMode`), so the escort is minimal or unneeded. This is
   the derelict-bot case, and it is the whole of phase 1.
2. **Cheap breaches.** The refinement the owner flagged (2026-07-23): when the
   probe says the defense is dead but *present* — a dark tower that won't refill,
   a rampart with a **hole**, a low wall — spend a little to breach it (one-off
   kill the dead tower, path through the gap). Priced by `netLoot` like
   everything else: the breach cost is just added overhead, and a target clears
   the bar iff the loot still beats it. Gated behind phase 1 so the probe is
   trustworthy first; **do not** let this creep into tower-*dancing* against a
   live, refilling defender (that is conquest-adjacent, spec 21).
3. **Typed loot.** Once the §9 typed-resource extension lands, `lootValue`
   prices minerals/compounds and the terminal sink absorbs them. This is where
   raiding becomes actually valuable; phases 0–1 are the plumbing.

## Acceptance tests (write first when picked up — these ARE the contract)

Sketch, to be filled at build time:

- **Unit — `netLoot` admission** (`test/unit/economy/raiding.test.ts`,
  table-driven): a fat undefended store clears the bar; a thin one and a
  well-towered one go negative on the escort tax and are skipped (economics hold
  the line, not a flag). Bar moves correctly with distance, store size, and
  escort-body cost. No proposal for an *unmarked* (un-probed) room; none beyond
  `MAX_SCOUT_DISTANCE`.
- **Unit — same-lens symmetry / durable signal**: the admission gate and the
  escort's demand read the identical weakness mark; a killed escort does NOT
  flap the mark (the stranded-reserver / spec-28 held-signal regression).
- **Unit — kind conformance**: `raidingKind.materialize` refreshes `spawnId`;
  registered in the three required places (host / orphan / director); military
  exemption scoped to the held target only.
- **Grid — `plan-t?-raid-soft-target`** (the ratcheted metric): stage an enemy
  room with a full storage, empty towers, and the weakness marks (db insert —
  the mockup runs NO enemy AI; every raid grid cell stages its target by
  insert, spec 08 blind-spot). Assert: an escort is fielded, the convoy empties
  the store, and ≥1 raid hauler delivers loot to a home sink before window end.
- **Grid — `plan-t?-raid-hard-target-skipped`** (the non-vacuity twin): an
  enemy room with charged towers / defenders → **never** raided (netLoot
  negative), mirroring spec 28's thin-room and def-t5's flight/no-military
  pairing.
- **Regression gate**: unit suite + `flow-handoff`, `runt-economy`,
  `storage-depot`, and the def-t3/def-t5 invader cells (shared `hostileRooms`
  lens must not regress).

Update `test/grid/baseline.json` in the same commit as the bot change that earns
the new cells (the workflow rule).

## Open questions / risks

- **Typed resources gate the value** (dependency 1). Energy-only raiding is
  low-value; the spec's real payoff is behind the §9 extension. Decide at
  scheduling time whether to land the plumbing early (phase 0/1) or wait for
  typed resources so the first ship is worth something.
- **Intel is the whole game** (dependency 2). Bad weakness reads send a convoy
  into a live base and lose the escort. The probe-not-judge discipline and the
  durable-mark decay are load-bearing — this is the highest-risk part.
- **Enemy stores are guarded by more than towers.** Ramparts, `safeMode`, a
  human at the keyboard. `safeMode` alone makes a store unraidable (creeps
  can't touch owned structures) — the weakness probe MUST read it, and a
  `safeMode`-active target is an instant skip.
- **Live-only blind spots** (CLAUDE.md, doubly): the mockup never runs enemy AI,
  never fires enemy towers, never triggers `safeMode`. Green sims do **NOT**
  prove live-readiness against a real defender; flag this loudly at build time.
  Every raid grid cell stages its target and its (in)defenses by db insert.
- **Escort body shape** — tank-and-drain (escort soaks tower fire while haulers
  work) vs a fast smash-and-grab before defense reacts. Decide empirically;
  phase 1 ships whichever keeps the undefended-target cell green.

## Non-goals

- Taking the ROOM (that is conquest, spec 21 — a different, heavier commitment).
  Raiding grabs loot and leaves; no claim, no siege, no GCL cost.
- Power banks, deposits, strongholds, SK rooms (spec 28) — different weight
  classes with their own producer models.
- Real tower-dancing / boosted-assault micro against *defended* bases in
  phase 1 (undefended/abandoned targets first — the pure-scavenge case).
- Reimplementing hauling or the transient-source mechanism — reuse
  `scavenge.ts` / CarryCorp / the bank sink, don't fork them.
