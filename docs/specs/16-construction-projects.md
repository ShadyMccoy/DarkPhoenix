# 16 — Construction as projects: a builder corp is a spawn + a finite-cost project list

**Status:** proposed 2026-07-19 (owner design). Slices landed: cross-room
trunk placement (`a076f7d`), sum-of-projects sizing (`eb3f0e9`).

## The model

A construction corp is **not a room**. It has a spawn (which happens to sit in
a room) and a **list of projects**. A project is a string of construction
sites *wherever they lead*: the home build-out, a road trunk out to a remote
source, and — eventually — a spawn in a newly-claimed room.

Unlike an upgrade (open-ended: the controller is never "done"), a construction
project is a **finite tile list with a computable total cost**:

- **energy** = Σ tiles × build cost (roads: `ROAD_BUILD_COST` 300; each site
  carries its own `progressTotal`, and build progress is 1:1 with energy)
- **hauling** = the carry-parts to deliver that energy to each tile over its
  distance

So "size the builder corp by the sum total of its projects" is well-defined:
you sum **closed integrals, not open flows**.

## What's built

1. **Placement** (`a076f7d`, unit-tested): the corp paves cross-room trunks to
   the plan's funded remote sources — the *same* `roadEconomics` verdict
   machinery as home routes, over a cross-room path (`maxRooms` 4; visible
   rooms use live costs, blind rooms terrain-only via `Game.map` terrain),
   room-aware tile storage (`tiles3` + `rooms` table), progressive placement in
   whatever rooms have vision that pass, never declared paved while any room is
   blind, gate stamps at every exit.
2. **Distributed building** (by design; live-verify pending): each room a trunk
   crosses builds its own segment via that room's construction corp. Remote
   mined rooms are already commissioned (the source-container rung); their
   pile-fed builders self-scavenge and build the road tiles in their room too.
   Cross-room builders march to their work room (the vision-march fix). So
   "sum of THIS corp's projects" is exactly its room's remaining site work — no
   cross-room summing, and trunks compose with it for free.
3. **Sum-of-projects sizing** (`eb3f0e9`, unit-tested): `builderPlan` caps the
   crew's consumption at the room's remaining site work over
   `PROJECT_BUILD_HORIZON` (100t), so a near-done room fields a small crew and a
   work-heavy one a big crew *at equal allocation and fuel* — work-aware, not
   supply-blind. The allocation and fuel caps still bind for a genuinely large
   project (30k work / 100 = 300 e/t, above any real allocation — roads still
   build fast), so the cap only trims the idle-apparatus tail.

## Scoping decisions (what we deliberately did NOT build)

- **Hauling for a remote-source trunk is ~free.** The trunk parallels the
  mining haul route to that source, so the builder self-scavenges the miner's
  pile as it paves (the existing "roads lie along an existing haul route,
  scavenge locally" doctrine holds *exactly* here). No distance-sized
  construction tanker — that is only needed for a cold founding (no existing
  route), which is deferred. Building it now would be YAGNI.

## Open / forward-looking

- **Intermediate pass-through rooms.** A trunk that crosses a room we do *not*
  mine gets no construction corp there → those tiles are placed but orphaned.
  LATENT: current remotes are adjacent (no pass-through room). Fix when a
  distance-2 remote is funded — either the home corp owns the pass-through
  segments (marching its own builders), or a corp is spun per crossed room.
- **Planner-level work-awareness.** The construction *sink* capacity is still
  `minedSupply + bankRate` (supply); `progressRemaining` is computed on the
  flow graph but dropped from the `PlannerSink`. The corp-level cap (`eb3f0e9`)
  makes the *crew* work-aware; making the *sink* work-aware (cap capacity at Σ
  remaining work) is the planner side of the same idea — deferred (the
  never-nudge-a-sink-value-in-isolation rule; needs its own gate).
- **Founding as a project** (owner, forward-looking — we are NOT expanding yet,
  basics first). A spawn in a claimed room is the extreme project: the hauling
  term dominates because there is no existing route to scavenge. The *build
  execution already fits the model* — the founding room gets an ordinary
  per-room `ConstructionCorp` (`constructionKind` adds "spawnless" claimed
  rooms, staffed from the nearest parent spawn; cross-room builders march).
  What is bespoke is the *orchestration*, smeared across three hand-synchronized
  subsystems rather than owned by one project:
  1. **Claim** — `ClaimCorp` (`claimKind`), a held-funded CLAIM+MOVE gated on
     `Memory.expansion`.
  2. **Place the spawn site** — done by the campaign state machine
     (`updateExpansionCampaign`) calling `createConstructionSite` *directly*,
     **divorced from the corp that builds it**: if the tile is blocked only the
     campaign's next pass retries; the builder corp cannot recover the site.
  3. **Price the funnel** — a magic per-instance constant
     `NEW_SPAWN_SITE_VALUE = 85`, a bare rung in the fragile sink ladder (spawn
     100 > new-spawn-site 85 > controller ≤80 > construction 70). *This is the
     90-vs-85 founding incident*: nudging it to 90 let a fresh L1 controller
     outrank the site and zeroed colony-wide construction. Not derived from the
     project — a hand-held constant.

  Timeout-desync risk: claim + the founding-sink anchor are gated on
  `Memory.expansion`, but the 85 price and the construction commission are not
  (they key off `structureType==="spawn"` / live allocations). If
  `EXPAND_TIMEOUT` (20k ticks) fires before the spawn stands, the campaign is
  deleted while a half-built spawn site remains — nothing models "this spawn is
  60% built, carry it to completion regardless of the clock." Unifying founding
  as *just another project* would give the site one owner that places, prices
  (from the project's own value, not a magic rung), funds, and finishes it.
  Acceptance: `exp-t5-founding-funnels-to-completion` (a standing BOT LEVEL 5
  blocker). Deferred until the basics sing.

## Regression gate

Live-behavior (placement + sizing feed spawn demand): full gate
(`test/unit`, `flow-handoff`, `runt-economy`, `storage-depot`) plus the
construction cells. Acceptance for cross-room paving is a live capture: trunk
gate stamps naming each verdict + road sites appearing in the remote rooms +
the source's haulers repricing to 2:1 once its route is paved.
