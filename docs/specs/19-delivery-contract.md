# 19 — The delivery contract: spawning delivers, corps declare where

**Status:** PROPOSED (owner design 2026-07-20). Spec first, build next.
**Priority:** P2 — the execution half of the "simple work functions" vision.
**Depends on:** spec 17 (kind declarations, registration-only plumbing).

## The thesis (owner, 2026-07-20)

> A source miner's one function is insanely simple: it harvests the source.
> The spawn corp is responsible for putting it into position. The corp has a
> delivery location — at the mine for miners, or elsewhere, even next to the
> spawn for others; it's an internal corp concern. A scout moves on its own;
> the miner is just the extreme example.

Today every work corp embeds its own travel logic — `HarvestCorp.work()` is
hundreds of lines largely because deployment (walk to post, position on the
container, yield rules) lives inside the work function. The target split:

- **The corp declares WHERE** its creeps must be handed over — a
  `delivery` declaration per role: a position (the mining post; a rally point
  beside the spawn; the controller's feed tile) or `"self"` (the creep
  deploys itself — scouts, military).
- **Spawning owns getting them there.** The spawning corp's responsibility
  extends past `spawnCreep` to HANDOVER: the newborn is walked to the
  declared delivery location and only then marked delivered
  (`creep.memory.delivered = true` or equivalent).
- **Work functions assume on-post.** A miner's run loop degenerates toward
  `harvest(source)` — everything it references (source id, post) is
  commission data, not a Game lookup it has to plan around.

## Contract addition (sketch)

```ts
// CorpKind.roles[role] gains:
delivery?: "self";              // this role deploys itself (default: delivered)
// Commission assignment (or corp accessor) gains:
deliveryPos?: Position;         // where newborns of this corp are handed over
```

`SpawningCorp.executeSpawn` records the buyer's delivery target; a deployment
behavior (owned by the spawning/execution side, reusing `corps/movement.ts`)
drives undelivered creeps each tick until handover. Kinds whose roles declare
`"self"` are untouched.

## Cautions (measured history — do not regress)

- **One staffing lens.** `staffsPost`/`deliveryLeadTime` price the walk on
  the DEMAND side; the delivery mechanism must consume the same distances, or
  replacement timing drifts and the newborn-recycled-at-the-door churn loop
  returns (trap list). Conformance must pin: declared deliveryPos distance ==
  the distance the demand side amortized.
- **Recycling counts as staffing** (trap list) — handover state must not
  change creep-count lenses.
- **Delivery is not creeps-as-cargo yet.** `creep.pull()` convoys and
  zero-MOVE worker bodies are the natural end state (huge body-economics
  win) but change `primitives` (MOVE-less costs, convoy pricing). Explicitly
  out of scope until this contract is live and measured; the delivery
  MECHANISM (walk vs pull) is deliberately swappable behind the handover
  event.

## Acceptance tests (sketch — finalize before building)

1. **Conformance:** every kind's roles either declare `delivery: "self"` or
   its corps expose a delivery position consistent with the commission's
   post data; the declared distance matches the demand side's amortized
   distance (the one-lens rule).
2. **Handover pin (fleet harness):** a newborn miner is walked to its post by
   the deployment behavior and mines with a work body containing zero travel
   branches; the fleet harness measures identical staffing cadence to the
   pre-split baseline (delivery lead unchanged).
3. **Simplification (structural):** `HarvestCorp.work()` contains no
   movement/pathing calls (the ratchet-style scan, like the purity suite).
4. **Regression gate:** full unit + flow-handoff + runt-economy +
   storage-depot + grid, per migrated kind (miner first — the extreme case;
   then upgrader/builder; scout stays self).
