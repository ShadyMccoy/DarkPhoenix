# 56 — The link container for remote sources: one lens, and a rung that can fire

**Status: SHIPPED 2026-08-08, LIVE-UNVERIFIED.** Owner direction: *"it's
important to build the container where it's best accessible to incoming hauling
routes as well as adjacent to the link of course"* (2026-08-06), and *"start
building the deposit container buffer in anticipation"*.

Follows spec 49 (which gave the port a buffer) and spec 54 (which gave it a
tender). This spec is about the third leg: the container itself, which **has
never once been built**.

## 1. The defect

A deposit port is the home-room link a remote hauler turns around at instead of
walking the full hub leg — the *link container for remote sources*. Spec 49
sized its buffer, spec 54 gave the buffer a tender, and
`bestPortContainerTile` has been unit-pinned since 2026-08-06.

`constructionPlacement` states the outcome in its own docblock:

> *"which is why the deposit-port rung has never placed anything and 22.4% of
> port arrivals still HOLD at a full link."*

The docblock blames the container cap. The cap is real, but it is not the
binding constraint, and the reclaim rung spec 54 shipped was aimed at it. Two
other mechanisms sat underneath, and either one alone is sufficient to explain
zero placements.

### D1 — the gate never opened on the port rung's account

`placementGateOpen` takes a `wantsMore` term. A false `wantsMore`
short-circuits **before `tryPlaceNextSite` runs at all**, so every rung inside
it is unreachable. The term was composed in `work()` as:

```ts
const wantsContainer =
  containersUnlocked(...) &&
  (this.findMissingSourceContainer(room) !== null ||
   this.findMissingCoreDepot(room) !== null ||
   this.findMissingControllerContainer(room) !== null);   // <- three of four rungs
```

Rung 1.6 — the deposit-port buffer — is not in that list. So the port rung
could only ever run as a **passenger**: it needed some *other* container rung,
or an extension/storage/link/tower/spawn/road rung, to want something in the
same tick.

The room that has deposit ports is a mature room: extensions at cap, storage
and links built, tower up, no second spawn wanted, roads surveyed. That is
exactly the room where nothing else wants anything. **The rung was gated on the
absence of the condition it needs.**

### D2 — four answers to "which container is this port's buffer"

The question was implemented four times, and the three wrong copies agree with
each other, which is why nothing ever surfaced it:

| reader | range | controller guard | verdict on the live (41,36) |
|---|---|---|---|
| `portPosts` (the TENDER) | 2 | **yes**, `CONTROLLER_CONTAINER_RANGE` | not a buffer — correct |
| `findMissingPortContainer` (PLACEMENT) | 2 | no | "port already served" |
| `classifyContainers` (the CENSUS) | 2 | no | `hasContainer: true` |
| `resolvePortBuffer` (DELIVERY) | 2 | no | drops loads into it |

Measured t72862894/t72869702: the superseded controller container at (41,36)
sits at chebyshev **2** from the deposit port at (43,38) — exactly the range
every reader searches. The result is not a wrong answer, it is a **deadlock**:

- placement sees a container within 2, calls the port served, and skips it
  **permanently**;
- the census reports that same port `hasContainer: true`, so
  `reclaimableContainer`'s `wanted` term (`full && ports.some(p =>
  !p.hasContainer)`) never fires and no slot is ever freed for it;
- delivery drops loads into the controller's feed store;
- the tender refuses that container — correctly; it will not pump the
  controller's supply back out through a link — so the port has **no post**,
  and the loads delivery just dropped have no drain.

Every reader is locally defensible. Together they guarantee the port never gets
a buffer. This is CLAUDE.md's **`staffsPost` symmetry trap** with the question
changed from *"how many creeps does this post have"* to *"which container is
this port's"*.

`portPosts`' own docblock had already stated the invariant it was violating:

> *"Mirrors `CarryCorp.resolvePortBuffer` deliberately … Two lenses reading one
> fact; a second definition here would be the staffsPost-symmetry trap."*

It stopped mirroring the moment the controller guard was added to one side.

There was a **fifth** number too. The census classified a container as role
`"controller"` at range **4**, while the tender's guard is 3. A container 4
tiles from the controller is a genuine port buffer to every other reader — and
`supersededControllerContainer` (role `"controller"` + a controller link) is
what `reclaimableContainer` **destroys**. The census could therefore mark a
live, tended port buffer for demolition.

### D3 — the fight loop (spec 54 open item 4, which went backwards)

Nothing stopped `findMissingControllerContainer` from siting a container inside
a port's buffer range, and `reclaimableContainer` demolishes exactly that
container. Measured in the t72869702 window: containers 3→4 with the new one at
(41,36), which the census immediately flagged `supersededControllerContainer`.

> The colony spent a 5,000e site placing the exact container this spec ships a
> reclaim path to remove, and it is the one thing blocking the second post.

Two subsystems fighting over one tile is one lens short, and each round costs a
builder.

## 2. The fix

**ONE predicate, four readers.** `isPortBuffer(container, link, controller?)`
in `corps/nodeEnergy` — pure, positions only, so the census (which never
touches `Game`) calls the identical function the live rungs call.
`pickPortBuffer` ranks nearest-first over it. `PORT_BUFFER_RANGE` moves next to
`CONTROLLER_CONTAINER_RANGE` (they are a pair) and `constructionPlacement`
re-exports rather than re-declares it.

The guard is stated once, where the number lives: *a container inside
`CONTROLLER_CONTAINER_RANGE` of the controller is the upgraders' feed store,
whatever else it is near.*

Then, in order:

- `portPosts`, `classifyContainers`, `resolvePortBuffer` and
  `findMissingPortContainer` all resolve the buffer through `pickPortBuffer`.
  The placement rung additionally counts pending **sites**, so a placed-but-
  unbuilt buffer is not re-placed every cooldown.
- the census's controller role reads `CONTROLLER_CONTAINER_RANGE`, not a local
  4, so a real buffer can never be classified as dead controller plumbing and
  demolished under a standing tender.
- `wantsAnyContainer` is **extracted from `work()`** and gains the port rung.
  Extracted deliberately: the omission was a line of an inline boolean nobody
  re-reads when a rung is added, and it is now a testable fact with a docblock
  that says *"when you add a container rung, add it here too."*
- `findMissingControllerContainer` refuses a tile inside a port's buffer range,
  through the same `isPortBuffer` predicate. The port needs the slot more than
  the controller does — the owner's call: *"the controller link should not have
  a container."*

One cost was introduced and paid down in the same change: putting the port rung
in the gate moves `detectLinkDepositPorts` — a walk of every owned room's
structures — onto the EVERY-TICK path, where before it only ran once the gate
was already open, and two callers now want it. `roomDepositPorts` memoises it
per tick (heap only; a global reset just re-scans). A corp that runs beside the
heartbeat does not get to add a global scan per caller per tick.

## 3. Acceptance tests

`test/unit/corps/portBufferLens.test.ts` — the predicate and the census:

- accepts a container in range; rejects one beyond it;
- **rejects the controller's feed store even when it is inside the range**, and
  even when it is the NEAREST thing to the link;
- draws the guard at `CONTROLLER_CONTAINER_RANGE`, verified either side of it;
- with no controller in view it is pure distance — a partial room must not
  invent a guard;
- the census does not report a port buffered off the controller's store, **so
  `reclaimableContainer` frees the dead slot on a capped table** (the end-to-end
  consequence, not just the predicate);
- a container 4 from the controller classifies as `"port"`, and
  `supersededControllerContainer` stays absent — the demolition hazard.

`test/unit/corps/portContainerRung.test.ts` — the rung, on live W43N23 geometry
(port (43,38), controller container (41,36), controller (39,34)):

- wants a buffer for a bare port, sited within a parked tender's reach;
- **still wants one when the controller's feed store sits inside the port's
  range** (red pre-fix: returned `null`);
- is satisfied by a real buffer — no re-placement loop;
- **the gate**: in a mature room where every other container rung is satisfied,
  `wantsAnyContainer` is still true;
- the controller rung refuses a tile inside a port's buffer range (red pre-fix:
  returned (41,36) at chebyshev 2), **and is unaffected where no port is near**
  — the anti-overreach pin.

Red-first evidence recorded: with `containerCensus.ts` stashed the census pin
fails `true` vs `false`; with `ConstructionCorp.ts` stashed the placement pin
fails.

Regression gate: `npm run test-unit` (2402 passing), `npm run build`,
`npx tsc --noEmit` clean, plus the `flow-handoff` / `runt-economy` /
`storage-depot` integration trio, all three re-run against the FINAL bundle
(the memo below landed after the first pass and a stale bundle has cost this
project full false-red runs before).

**Grid, construction avenue (23 cells): 20 green, 3 red — and the 3 are
ACQUITTED by attribution.** `cons-link-core-first`, `cons-link-farthest-source`
and `cons-t3-build-and-repair-concurrent` fail with byte-identical assertion
messages on unmodified master in this container, so they are an ENVIRONMENT
failure, not this change. The check was run the only way it means anything:
stash, rebuild master, re-run those three cells, compare. Baseline still lists
all three as `pass`, so the environment is what disagrees with the ratchet —
which is worth someone's attention, and is not this spec's to fix. The avenue
was chosen because the container rungs and the placement gate are what this
change moves; a FULL grid run has not been made.

## 4. Open

1. **LIVE-UNVERIFIED.** The predicted deltas, in order: the port rung places a
   container within 2 of a bare port; `portPosts` grows a post for it;
   `portWaits` falls and `portFallbacks` stops being structurally 0; the
   controller rung stops re-placing (41,36) and the container count stops
   oscillating 3↔4.
2. **`findMissingRecyclePad` has the identical D1 defect** and is NOT fixed
   here — it is also absent from `wantsAnyContainer`, so the recycle pad rung is
   a passenger in exactly the same way. Named rather than silently fixed
   because it is out of this spec's scope and changes mature-room behaviour on
   its own account; it wants its own measured cell. The extracted
   `wantsAnyContainer` is where it goes.
3. **`portApproaches` weights every funded remote EQUALLY** (stated limit,
   carried from spec 49): direction is what siting turns on and equal weights
   get direction right, but per-room flow weighting needs the plan to publish a
   source ROOM first.
4. The census/`controllerInputSpot`/`displacedInputContainer` family still
   carries range-3 scans of its own. They agree with `CONTROLLER_CONTAINER_RANGE`
   numerically today; they are not yet reading it.
5. **Narrowing the census's controller role 4 → 3 also narrows what is
   RECLAIMABLE**, and that direction was chosen deliberately. A container at
   range 4 can no longer be flagged `supersededControllerContainer`, so a
   legacy one sitting out there is no longer demolished. That costs tidiness;
   the other direction costs a live port buffer with a tender standing on it.
   Nothing the bot PLACES can land there anyway — `controllerInputSpot` only
   ever returns tiles within range 2 of the controller — so the narrowing can
   only affect containers the bot did not site.
6. `CONTROLLER_CONTAINER_RANGE = 3` is still a declared constant with no
   measurement behind it (spec 54 open item 5, unchanged). It now has four
   readers instead of one, which makes it more load-bearing, not less: a room
   that legitimately wants a port within 3 of its controller is the geometry
   that will expose it.
