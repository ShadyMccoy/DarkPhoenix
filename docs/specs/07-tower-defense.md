# 07 — Tower defense (minimal)

**Status:** DEFERRED by owner decision — the strategy is respawn-tolerant
("we spread like a disease; losing a room is fine"). Specced now so it's a
~1-hour task whenever it's picked up.
**Priority:** P3 / backlog.

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
