# 54 — The link corp owns the link network

**Status: SHIPPED (core) 2026-08-08, LIVE-UNVERIFIED** (owner: *"real LinkCorp
that owns the whole link network — core, controller, and ports, with the
feeder's link duties moving into it"*, and *"the link+tender+container can all
be ruled by the link corp potentially"*).

## 1. The defect this started from

A deposit port (spec 26) is a home-room link that remote haulers turn around at
instead of walking to the storage hub. Spec 49 gave the port a BUFFER container
so a hauler meeting a full link drops and leaves instead of queueing —
`pickStorageDeposit` ranks `portBuffer` SECOND, ahead of `wait`.

**Nothing ever emptied that container.** Measured t72862894:

```
  port container (44,12)   2000 / 2000        completely full
  portFallbacks            0                  on all 8 port-routed routes
  portWaits                up to 602 ticks    (cd98)
```

Both of a hauler's escape hatches were shut — link full, buffer full — so it
waited. The owner had named the gap in advance (2026-08-06, quoted in
`detectLinkDepositPorts`): *"there's no miner, but we still want a tender."* The
adjacent-source requirement was dropped on the reasoning that *"the feeder is
the sole core-link operator and staffs it regardless"* — but the feeder operates
the CORE and CONTROLLER links, never a port link, and the only code in the tree
that transfers INTO a link is `HarvestCorp`. The gate went; the tender it
promised never arrived.

Live geometry says source-less ports are the NORMAL case, not the exception:
both ports sit 7 and 6 tiles from the nearest home source (edge links at range
17 and ~15.5 from the core), so neither has a miner that could tend it.

## 2. Why one corp, and not a port-tender corp

A standalone `PortTenderCorp` shipped first and lasted one commit. It worked,
and it was the wrong shape for two reasons:

**The framework said so.** Spec 39's ratchet: *"new corps integrate through the
plan, never a new demand site."* A new auxiliary kind has no way to honour that
(§5, open item 2), so it had to take a debt entry — defeating a cop rather than
satisfying it.

**The domain said so.** Link, tender and container are ONE machine: the
container is the mouth, the tender is the throat, the link is the pipe.
Splitting them across owners is how the drain went missing at all — the
container had a placement rung, the link had a price, and nothing owned the
thing between them.

**It is an ABSORB, not a duty move.** `runLinkRouter(creep, core, ctrlLink,
storage)` is called from inside the feeder CREEP's work loop — the feeder creep
IS the bidirectional link operator. Moving "the link duties" into a new corp
would have meant a second body at the core, on the heartbeat. So
`ControllerFeederCorp` BECAME `LinkCorp` and gained the ports: same end state,
one body instead of two.

## 3. What landed

- **`LinkCorp`** (was `ControllerFeederCorp`) owns core, controller and every
  deposit port. Two roles, one owner, ONE demand site: `getSpawnDemand()` is
  `feederDemands() + portDemands()`, which retires the debt entry the standalone
  corp had to take instead of defeating the ratchet.
- **Port work runs BEFORE the feeder's gates** in `work()`. A port tender never
  touches the core link, so the heartbeat can never be slowed by port work, and
  a room with no bank still drains its ports.
- **Two body shapes, because the roles do opposite things.** `feeder` walks
  storage → controller (balanced 1:1 shuttle); `porttender` PARKS between a
  buffer and its link and never carries a step, so it takes the CARRY-heavy
  tanker shape at `PORT_TENDER_CARRY`.
- **One price for the network it owns**: `feederSpawnLoad` + `portTenderSpawnLoad`
  per PORTED room, both composed into `infraSpawnLoad`/`infraSpawnEnergy`, so
  `SIGMA(auxiliary corps) === infraSpawnLoad` still reconciles (spec 39 phase 4's
  invariant, pinned to 1e-12).
- **`portPosts` is a LENS** in `corps/nodeEnergy`, read by all three sides — the
  corp's post, the adapter's price, the host's problem lens — so "which ports do
  we tend" and "what do we pay to tend them" cannot become two answers. It lives
  there and not in the corp because `economy/` may only import corps LENS
  modules; the purity cop caught the first placement, exactly as
  `guardTargetsFor` was moved to `utils/raidMeter` for the same reason.
- **The dead controller container is reclaimed** (§4).
- **Deposit-port rho is published** (flow segment v18) — see spec 49.

**THE KIND STRING IS FROZEN ON PURPOSE.** Class and file renamed; `kind:
"controllerFeeder"` and the `${roomName}-controllerFeeder` nodeId did NOT
change. CLAUDE.md's trap list: *"Corp id prefixes … A rename silently orphans
live creeps."* Live feeders carry that id in `memory.corpId`.
`extensionTenderKind` freezes a legacy nodeId for the identical reason. The
code's vocabulary moved; the wire format did not. **This is a deliberate
inconsistency and it is open item 3.**

## 4. The dead controller container (owner: *"the controller link should not have a container"*)

Not merely redundant — it was BLOCKING the second port. The superseded
controller container sits at (41,36), the deposit port link at (43,38):
chebyshev **2**, which is exactly the range `resolvePortBuffer` searches and
`hasContainerNear` tests. So one dead structure broke three things:

- the port-container rung asked "is a container within 2?", got YES from the
  dead one, and skipped that port — permanently;
- the delivery side bound the CONTROLLER's feed store as the port's buffer;
- the tender's lens correctly refused it (it will not pump the controller's
  supply back out through a link), so that port had no post.

And the table was 4/5 with a free slot the whole time, so `reclaimableContainer`
never fired: it gated on `census.full`. Its docblock argued that reclaiming
without a full table is *"pure loss — tidiness"*. That premise was the bug: a
dead container INSIDE a port's buffer range is a blocker, not untidiness.
`full` is lifted for that case and only that case.

**The spill is accepted** (owner: *"I don't care about draining it first"*).
Destroying a container drops its contents and a ground pile decays at
`ceil(amount/1000)` per tick — the live one holds 1,900e. That is a ONE-OFF
bounded by the container cap; the block costs a whole port its buffer every tick
it stands. `energyLost` still reports it, so the trade is visible, never silent.

## 5. Open items

1. ~~**LIVE-UNVERIFIED — the whole thing.**~~ **CAPTURED t72865978, and the
   first gauge answered NO.** "A `porttender` creep exists at all" — none, ever.
   `portDemands` built its SpawnDemand through an `as SpawnDemand` cast with
   neither `minCost` nor `desiredCost`, so every `>=` in the funding walk
   compared against `undefined`, the demand was recorded gate `"impossible"`
   (the RCL-can-never-build verdict), and it sat at the HEAD of both spawn
   queues for 1804+ ticks — including at bank 5600, the room's full capacity.
   The plan meanwhile routed 40 e/t through each port and charged
   `portTenderSpawnLoad()` for the body. Fixed + class closed at the collection
   seam; full write-up and the post-deploy predictions are in
   [spec 14, cycle t72865978](14-telemetry-observability.md).

   **CHAIN CONFIRMED WORKING on ONE post, t72869702.** The port container at
   (44,12) came off 2000/2000 and now cycles (0e at t72868738 -> 516e at
   t72869702), so haulers deposit and the tender drains. Both creeps live
   together across generations — the corp's body reads 20C/12M = 32 parts at
   t72868738 and 14C/10M = 24 at t72869702, i.e. feeder + port tender in both.
   Heartbeat unharmed: controller delivery flat at 39.0 e/t, `coreEmptyShare`
   0.46 -> 0.30, bucket 9,800. **A regression on the heartbeat outranks every
   gain here** (CLAUDE.md: the tender is a heartbeat). Still unread: `portWaits`
   / `portFallbacks` (needs item 7's meter), and the second post has never
   existed (item 4).
2. **The auxiliary spawn seam — the framework gap this exposed.** Spec 39's cop
   forbids new `getSpawnDemand` sites, but the SpawnDirector does not read
   `commission.fleet` and every auxiliary commission declares none (the
   conformance suite asserts exactly that). Phase 4 migrated their BUDGET, not
   their spawning, so an auxiliary kind can join the debt list or field no
   creeps. Closing it retires five debt entries at once. **This is spec 39's
   item, surfaced here.**
3. **The vocabulary split.** `LinkCorp` reports under `kind: "controllerFeeder"`
   and the statement's `infra` line. Correct today (creep-id continuity), wrong
   as a permanent state — code and wire disagree, which is the drift this
   codebase is otherwise strict about. Needs a kind-rename migration that
   re-homes live `memory.corpId`, or an explicit decision to keep the legacy id
   forever and say so in one place.
4. **Port (43,38) has no buffer of its own** and will not until the dead
   controller container retires and the placement rung runs. Until then the link
   corp has ONE post, not two. The chain is: dead container reclaims → rung sees
   the port as bare → places a real buffer → the tender gets its second post.

   **MEASURED t72869702, and it went BACKWARDS: construction BUILT the blocking
   container during the observation window.** Containers went 3 → 4 and sites
   1 → 0 between t72868738 and t72869702, and the new one is at **(41,36)** —
   which the census immediately flags:

   ```
   supersededControllerContainer: { pos: (41,36), role: "controller", energy: 0 }
   ```

   So the colony spent a build (5,000 energy of site) placing the exact container
   this spec shipped a reclaim path to REMOVE, and it is the one thing blocking
   the second post. `portPosts` excludes it by the controller-range guard (item
   5), correctly — but the placement rung does not know that, so the two
   subsystems disagree about whether that tile should hold a container and
   construction is currently winning.

   **This is the item to fix first**, and it is a placement-side fix, not a link
   corp one: whatever rung placed (41,36) must read the same
   `supersededControllerContainer` / `controllerLink` lens the census does, so a
   room with a controller LINK never sites a controller container. Until then the
   reclaim and the rung will fight, and each round costs a builder purchase.
5. **The controller-range guard in `portPosts` becomes moot** once (4) resolves —
   it exists to stop the tender draining the controller's feed store into a
   link. Keep it (defence in depth, and other rooms will have other geometry),
   but its `CONTROLLER_CONTAINER_RANGE = 3` is a declared constant with no
   measurement behind it. If a future room legitimately wants a port within 3 of
   its controller, that number is the thing that will be wrong.
6. **Multi-tender ports are untested.** `runPortPosts` round-robins tenders over
   posts (`posts[i % posts.length]`), which is right for one-tender-per-port but
   has never been exercised with two posts, and `portDemands()` buys at most one
   body per call. Fine at today's one-post geometry; unproven at two.
7. **No duty meter on the port role.** The feeder half carries
   `dutyTransfers`/`dutyAlive`; the port half carries nothing, so "is the tender
   actually working or parked beside a full link" is not a read. The standalone
   corp had this and it was dropped in the absorb. Cheap to restore and it is
   the gauge item (1) will want.

8. **NEITHER HOME SOURCE HAS A CONTAINER** (measured t72869702, and possibly the
   more interesting finding). The census classifies a container as `"source"`
   when it sits within range 1 of a source. **W43N23 has zero of them:**

   ```
   (41,22)  other       1363e
   (36,27)  coreDepot    169e
   (44,12)  port         516e
   (41,36)  controller     0e   <- superseded, see item 4
   ```

   The source buffers agree — `dbcd90: 114`, `dbcd92: 0` — near-empty because
   there is nothing there to hold energy. Both home sources are link-served (the
   SOURCE P&L prices them with a `link` cost and no hauler; `flow.haulers` shows
   them at distance 1), so the link takes the harvest directly.

   The question this raises, and it is the L1 pile story one layer in: **what
   happens to harvest the source link cannot absorb that tick?** A link holds 800
   and fires on a cooldown; a 10 e/t source with no container to buffer into has
   only the ground. The home sources are the two lowest-buffered in the colony,
   which is consistent with either "the link keeps up" or "it spills and decays"
   — and nothing currently distinguishes them. Needs a read before a fix: per-source
   dropped energy is exactly the `sourceDropped` field that is ABSENT from every
   capture (see spec 14 t72869702), so this is blocked on that meter.

9. **The census and the lens disagree about `hasContainer`.** `classifyContainers`
   sets `hasContainer: room.containers.some(c => cheb(c.pos, l) <= 2)` with no
   controller-range exclusion, while `portPosts` applies the
   `CONTROLLER_CONTAINER_RANGE` guard. So the census reports port (43,38) as
   buffered (`hasContainer: true` from t72869702) while the tender cannot use it
   and holds no post there. Any dashboard or future gate reading the census will
   draw the wrong conclusion — the same decision-symmetry rule this codebase
   applies everywhere else (one lens, both sides). Cheap fix: the census calls
   `portPosts`, or shares its filter.

10. **An orphan container holds 1,363e** at (41,22), classified `"other"` — not
    within 1 of a source, not within 2 of storage, not within 4 of the
    controller, not within 2 of any port link. Real energy in a container nothing
    claims. Either it serves something the ladder does not model, or it is a
    leftover the reclaim rung should collect. Unidentified; listed so it is not
    lost.

## 6. Related

- **Spec 26** (links as hub ports) — the deposit port itself.
- **Spec 49** (deposit-port overflow haul) — carries the rho measurement that
  falsified the saturation hypothesis (rho 0.85 / 0.78, MARGINAL not deficient),
  which is what redirected the fix from "route less" to "buffer and drain it".
  Its leg B is blocked on the same executor gap as open item 2.
- **Spec 39** (the plan owns the fleet) — open item 2 is 39's, and closing it
  retires this spec's debt entry along with four others.
- **Spec 45** (arrivals-first link sequencing) — the OTHER half of the port
  story: sequencing between core, controller and port links. This spec gives
  those links one owner, which is the precondition for sequencing them at all.
- **Spec 51** (corp-grained statements) — the link corp declares one budget for
  the network it owns, keeping `SIGMA(auxiliary corps)` reconciled.
