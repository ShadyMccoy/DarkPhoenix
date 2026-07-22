# 07 — Tower defense

**Status:** **LANDED 2026-07-17** (spec 13 tranche 1); **v2 focus-fire
2026-07-19**. TowerRunner fires every owned room's towers at the closest hostile; ConstructionCorp places
one tower at RCL3 beside the spawn (tower sites, like roads, do NOT hold the
one-at-a-time build queue — a pending tower site parked the storage queue
900+ ticks in a builder-less world before this was caught); the extension
tender fills towers below half charge; `toSinkKind` maps tower→spawn.
Verified: `pickTowerTarget` + tender unit tests; `tower-defense.test.ts`
(engine-driven 10xATTACK invader killed by tower fire, no friendly losses,
injected mid-run — an invader entering a creep-less owned room SUICIDES by
engine rule); storage-depot regression green.
The spec-13 engine survey confirms sufficiency for NPCs: owned rooms below
RCL4 only ever face 10-part "small" raids, and 50-part "big" raids begin
exactly at RCL4 — after the RCL3 tower exists.

## v2 — focus-fire vs pre-emptive healing (2026-07-19)

Closest-hostile fire is optimal against the lone healer-less invaders below
RCL4, but it loses to a HEALER: heal and tower damage resolve in the same tick
and net out, so one healer cancels one tower's damage on one creep — spreading
fire thin (or predictably focusing) nets zero kills. `assignTowerFire`
(`execution/TowerRunner.ts`) beats this with a pursuit game keyed on
tick-over-tick HP (`Memory.towerTargeting`, per room, staleness-gated to the
immediately preceding tick):

- **Dropping** (`hits < lastTick`) — took NET damage → the healer isn't
  covering them → collapse all towers here (this is the kill).
- **Wounded** (`hits < hitsMax`, nobody dropping) — keep pressure on the
  damaged ones rather than poking full creeps.
- **Probe** (everyone full — first contact or heals topping all) — spread
  across the creeps we have no history on to force a wound and reveal the
  healer.

As the healer covers one target per tick, the uncovered set narrows 3→2→1 and
fire collapses onto the survivor. The unpredictability the enemy sees is
adaptive tracking, NOT randomness — targeting stays fully deterministic (ties
to the lower id) so the grid (spec 08) stays pinned. Ported from the bonzAI
defense sauce. Range/damage weighting of the kill accounting is a noted future
refinement (v2 keys on realized HP, which already discounts low-DPS far shots
since they don't produce "dropping").

### v2 acceptance — unit: `test/unit/execution/towerFocusFire.test.ts`

`assignTowerFire(hostiles, towerCount, prevHits)` (pure): no hostiles → all
null; probe spreads across distinct full hostiles on first contact; collapses
on the creep the healer isn't covering; narrows to a single survivor;
keeps pressure on the wounded; treats a newcomer (no history) as fair to probe;
deterministic tie-break to the lower id.

## Current state

Towers exist in the codebase only as a flow `SinkType`, a PriorityManager rule
("tower-under-attack"), and a FlowGraph sink factory — none of which is on the
live CorpPlanner path (`flowAdapter.toSinkKind` returns null for towers). No
code ever PLACES a tower or FIRES one. A single hostile creep currently
dismantles a colony uncontested.

## Design (deliberately tiny)

1. **Fire** — `execution/TowerRunner.ts`, pattern of `LinkRunner`: every tick,
   for each owned room, each tower with ≥ 10 energy attacks
   `pos.findClosestByRange(FIND_HOSTILE_CREEPS)`. No target prioritization, no
   heal/repair logic — closest hostile, that's the whole v1. Called from
   `main.ts` next to `runLinks()`.
2. **Place** — ConstructionCorp: at RCL3+ (1 tower allowed), placement step
   between the core depot and extensions: `bestAdjacentTile(room, spawn.pos,
   3, spawn.pos)` — near the core so the tender can reach it. Pattern:
   `findMissingStorage`.
3. **Feed** — extend the ExtensionTenderCorp's `fillTargets` to include towers
   below 50% energy (they're beside the spawn by construction). Add `"tower"`
   to `flowAdapter.toSinkKind` mapping to `"spawn"` kind (it's spawn-network
   demand, ~10 e/tick) so the planner accounts for the draw.

Total estated new code: < 120 lines.

## Acceptance tests

### Unit: tower fire decision (pure helper)

Extract `pickTowerTarget(hostiles: {pos, range}[]): index | null`:
1. No hostiles → null (no intent, no energy spent).
2. Two hostiles → the closer one's index; tie → lower index (determinism).

### Unit: tender feeds towers — extend `extensionTender.test.ts`

1. Tower at 40% energy in `fillTargets` mock → included, AND sorted by range
   like any other target.
2. Tower at 80% → excluded (don't top off mid-fight trickle).

### Integration: `test/integration/tower-defense.test.ts`

World: storage-depot RCL4 layout + a tower pre-placed (db insert) with 500
energy. Inject one hostile creep (db insert, user "invader", 10×ATTACK body)
at the room edge. Run ≤ 200 ticks:

1. The hostile creep object disappears (killed — not walked away: assert its
   ticksToLive on insert was > 200).
2. Tower energy decreased (it actually fired; the kill wasn't a despawn).
3. No friendly creep died in the same window (creep count by workType at end
   ≥ at start) — the colony defended without casualties in the trivial case.

### Regression gate

Unit suite + `storage-depot` green (tower feeding must not starve the
extension refill path).
