# Spec 49 — a deposit port PRICES its overflow, it does not refuse it

**Owner 2026-08-06:** *"The remote mines would still deliver to the link
container. However, if the link can't keep up to drain the container as fast as
all the remotes are filling it up, then we need another haul route between the
core and the link container to make up the gap between how fast the container is
filling and how fast the link can drain it. This should be priced into the
plan."*

And earlier, on the same mechanism: *"'ρ ≥ 1.0 — saturated…' then we need
additional hauling to cover the gap. No point in over throttling the link, it
just causes a lot of waste."*

## Leg A — the flat cap (SHIPPED 2026-08-06)

`depositPortHeadroom` computed the link's true fire rate and then threw it away
under a surviving `min(DEPOSIT_PORT_HEADROOM_CAP = 30, ...)`. Measured at
t72819265 the constant was binding on **both** live ports:

```
  port (46,11)  range 14   fires 57.14   own source 10  ->  physics 47.14
  port (43,38)  range 13   fires 61.54   own source 10  ->  physics 51.54
  plan routed        30.00 to each   (three remote routes apiece, the cap
                                      to the decimal)
```

DEP reported 8 sources (80 e/t) wanting in; the links ran at rho 0.70 / 0.65,
nowhere near saturated. **38.68 e/t of deposit flow refused by a constant**,
while five sources under-delivered 23.2 e/t and the colony ran spawn-bound at
0.91x the physical ceiling. The refused sources walk the long way at ~30 CARRY
parts per 10 e/t against ~11 via the port — when parts are the scarce resource
that is not a cost difference, it is a mined-vs-forgone one.

The constant survives in the one role it is right for: the fallback when
geometry is unknown (`DEPOSIT_PORT_UNKNOWN_RANGE_FALLBACK`), where there is no
fire rate to compute and guessing high would over-route into an unmeasured link.

The feeder's hand-copied twin went with it. `PER_LINK_SOURCE_DRAIN = 10 + 30`
carried a docblock asking the next editor to *"keep the 30 in sync with
flowAdapter.DEPOSIT_PORT_HEADROOM"* — a manual coupling that goes stale exactly
when it matters. `coreDrainRate` now asks the same primitive the planner asks,
per link, from that link's own range.

## Leg B — the overflow band (BUILT, THEN BACKED OUT — read this first)

**Status 2026-08-06: designed, implemented, reverted before commit. Blocked on
an EXECUTOR, not on the economics.** The two things that stopped it are below;
both were found by building it, and neither is visible from the design alone.

### Blocker 1 (fatal): the plan would price a route nobody drives

The pooled port→hub route has to be attributed to some `sourceId`. The only
honest candidate is the port's `drainSourceId` — the owning link-served source
— because inventing an id shape for a link-container pickup would orphan live
creeps on the next rename (CLAUDE.md's corp-id-prefix trap).

But a port's owning source is link-served **by definition**, and link-served
sources are deliberately excluded from execution on both sides:

- `commissionsFromPlan` gives them `routes = []` (*"the link network is its
  vector"*),
- `publishRoster` skips them, naming the spec-26 deposit-drain leg explicitly
  as the reason.

So the overflow route would be **charged against the parts ledger and never
commissioned or fielded**. That is a plan the runtime does not follow — the
precise failure this spec exists to prevent, reintroduced by its own
implementation. F1 would have measured it as unbudgeted-in-reverse and the
diagnosis would have cost more than the route saves.

There is no existing id shape meaning *"pick up at a link container"*.
`depositPos` is the DELIVERY side only. That gap is `PortRelayCorp`, blocked on
spec 39's spawn-authority ratchet — the same blocker already on file for edge
links.

### Blocker 2 (softer): the economics are a TIE, and only a tie

By the triangle inequality `dDirect <= dPort + dOverflow` in **any** metric, so
a split route is never strictly cheaper in tiles and a strict cost test is dead
code by construction. Two terms appear to tip it; neither may be leaned on:

- **`effectiveLife(d) = CREEP_LIFETIME - d`** makes two short routes look
  cheaper than one long one. It models the commute from SPAWN TO POST, and a
  remote hauler's commute is its source's distance either way — shortening the
  delivery leg does not shorten it. Building the admission rule on this is
  building on a modelling artifact.
- **The in-room leg is trunk ROAD** (1.5 parts/CARRY against the remote leg's
  2). Real physics, but `DepositPort` carries no pavement data and asserting it
  would be inventing a fact.

The implemented rule was therefore `dPort + dOverflow <= dDirect` — admit on the
TIE — justified by fidelity rather than savings: where the port is on the way,
the runtime *will* drop at the container because that is the nearest deposit its
hauler passes, so the plan should price the leg that moves it onward. That
argument still stands. It just needs blocker 1 solved first.

### And it is inert on today's geometry anyway

After Leg A the two live ports carry 47.14 / 51.54 e/t of link band against
~40 e/t of routed deposit flow each. There is no gap to haul. Leg B changes
nothing live until routing grows past the fire rate or an edge link is built —
which is exactly why deferring it costs nothing now.

## Leg B — the design (for when the executor exists)

Leg A raises the ceiling to the link's physics. Leg B is what the owner
actually asked for: **flow ABOVE the fire rate is admitted and priced, not
refused.**

### Why the naive arithmetic says no, and why it is wrong

A first pass at this priced a port→core shuttle as if it *replaced* the route:
pay the remote leg, then the in-room leg, then a second fixed per-trip term, for
the whole flow. That is not the proposal. In the owner's version the remote leg
is **sunk** — the hauler is going to the port either way — and only the gap
between inflow and the fire rate pays a second leg.

With remote→port `p`, port→hub `r`, direct remote→hub `D`:

- triangle inequality gives `D <= p + r`
- for a port sitting on the approach, `D ≈ p + r`

So on raw distance the split is a **tie**, not a loss. The tie breaks three ways
in the port's favour, and each is measurable in-tree:

1. **Pavement.** The in-room leg is trunk road: a 2:1 body at 1.5 parts/CARRY
   against the remote leg's 1:1 at 2. The blended-`physD` model currently
   applies the SOURCE's pavement to the whole blended distance, which
   understates the port by 25% on the in-room portion.
2. **Pooling.** One route sized to the aggregate gap replaces N fractional
   routes, each of which rounds up to a whole creep. P2 already flags 5
   micro-routes (<3 CARRY planned) in the live plan.
3. **Trip tails.** `effectiveLife` on a short in-room route amortizes far
   better than on an 80-tile remote one. X4 measures 0.72 e/t lost to trip
   tails today.

And the case that decides it: **energy already in the container has no direct
alternative.** Once a remote hauler has dropped its load at the port, the choice
is haul it the last `r` tiles or let it rot. That is the owner's scenario
verbatim, and it is not a routing comparison at all.

### Design

`portRemaining` becomes the **link band** — what the port can fire. Beyond it:

- a source may still route to the port, paying only its own `dPort` leg;
- the excess accumulates against the port as **overflow**;
- ONE pooled hauler route per port, `port -> storage`, is emitted for the
  accumulated overflow at `dist(port.pos, storageSink.pos)`, on the in-room
  trunk's pavement;
- the inner loop charges each source's overflow share of that pooled route
  through `chargePerUnit`, so the parts ledger cannot under-charge and the
  port cannot over-attract;
- the existing stage-4 core→storage drain prices only the LINK-carried band —
  the overflow never transits the core link and pays no 3% tax.

Self-limiting by construction: overflow routes via the port only while
`dPort + rOverflow < d`. Where the port sits on the approach that is a wash and
the solver keeps the source on its direct leg — which is the correct answer,
not a failure of the mechanism.

### Acceptance (tests, not vibes)

1. A port whose inflow is below its fire rate emits **no** overflow route —
   byte-identical to Leg A's plan.
2. A port routed above its fire rate emits exactly ONE overflow hauler,
   `flowRate` equal to the gap, `distance` equal to port→hub.
3. The overflow hauler's parts are charged against `partsRemaining` in the same
   fill that admitted the flow, not after it.
4. The stage-4 core drain prices the link band only — total drain parts do not
   double-count the overflow.
5. A port whose `dPort + rOverflow >= d` attracts NO overflow, however much
   link band is exhausted (the triangle case).
6. **A grid cell stages an over-provisioned port and asserts the route
   appears.** CLAUDE.md's sim blind-spot rule: a receipts-gated path that never
   executes in the trio can pass its gate for the wrong reason.

### Why this is the enabler for edge links

An edge link is a link placed at the room boundary purely to receive remote
hauls — no adjacent source, `dPort` tiny for the remotes it serves, and its
whole in-room leg is paved trunk. That geometry is where `p + r < D` genuinely
holds and where the overflow band pays outright rather than on second-order
terms. Leg B is the pricing edge links need to exist; without it the plan
refuses them the moment they fill faster than they fire.

## Measured t72862894 — rho is MARGINAL, and the buffer that would fix it is never built

The deposit-port rho stamp (flow segment v18) landed and read:

```
  link 4a83   40.0 e/t over 4 routes   rho 0.85 of 47.1
  link 8f08   40.0 e/t over 4 routes   rho 0.78 of 51.5
```

**This FALSIFIES the saturation hypothesis** the stamp was shipped to test
(predicted rho >= 0.85 on both, i.e. a rate deficit no buffer can fix). Neither
port is rate-deficient. They sit in exactly the band
`depositPortHeadroom`'s own docblock calls *marginal* — and at rho 0.85 an
M/M/1 queue waits ~5.7x its service time, so heavy queueing is EXPECTED there
without any rate deficit at all.

That matters because spec 47's rule cuts the other way in this band: **a buffer
fixes burstiness, never a rate deficit.** rho < 1 means a buffer is the right
instrument.

**And the buffer is already implemented — on the read side only.**
`pickStorageDeposit` ranks `portBuffer` SECOND, ahead of waiting, with the
ordering argued in its own comment ("the link outranks its own buffer... the
buffer is the SECOND choice - ahead of waiting, never ahead of the link
itself"). `CarryCorp.resolvePortBuffer` looks for a container within range 2 of
the port link. **Nothing places that container.** No site in ConstructionCorp or
the base layout targets a port link's neighbourhood.

So the branch can never fire, and the measured consequence is exactly what the
stamps show: `portFallbacks: 0` on all eight port-routed routes with
`portWaits` up to 602 — the hauler's only two outcomes are deposit or wait,
because the third one has no container to land in.

The corroborating FAIL is H3 at the same capture: `mining-W43N24-harvest-cd8e`
buffered 3268 -> 3542 GROWING with zero drain creeps at both captures, on the
route served by link 4a83 (the rho 0.85 one). Its plan sizes 12 CARRY against
the PORT leg (23 tiles, RT 46, 600/46 = 13 e/t — ample) and the queue is what
eats the margin.

Next: place a container beside each deposit port link. The consumption side
needs no change.

**The drain landed as spec 54** (2026-08-08): the port's buffer is emptied into
its link by the LINK CORP, which now owns core, controller and ports together.
The rho reading above is what redirected the fix - at 0.78-0.85 the ports are
MARGINAL, not rate-deficient, so a buffer is the right instrument and it only
ever needed something to empty it.

## Blocker 1 realised live, in the direction this spec did not anticipate (t72871684)

Leg B was backed out because *"the plan would price a route nobody drives"* — a
pooled port→hub overflow route with no id shape to commission it. That reasoning
was right, and the same defect is **already shipped elsewhere in the plan**, not
as an overflow leg but as a CONSTRUCTION SUPPLY line:

```
  cd98 -> construction-6a77baf91   flow 10.00 e/t   carry  9.07   d=20
  cee0 -> construction-6a77bf172   flow  9.88 e/t   carry 17.65   d=36
  TOTAL                                  19.88 e/t   carry 26.72   <- the APPROPRIATIONS
                                                                      construction BUDGET,
                                                                      to the decimal
```

Delivered: **6.54 e/t**. The mining corps decline the energy correctly —
`haulCarryNeeded` filters `construction-` routes out with *"the tankers own this
energy, pile or no pile"* — so cee0 stamps `carryNeeded: 1`, `exit: "staffed"`
beside **4,275e staged** and a miner pile-gated 84% of the window. The tankers
that are supposed to own it are sized for a **10-tile** haul (`tankerDist: 10`)
against supply routes at d=36 and d=20, and the construction corp in cee0's own
room is a single 4-part runt consuming 0.

So 26.72 CARRY of supply line is charged to the parts ledger and no corp drives
it — F1 measures it as unbudgeted-in-reverse, exactly as this spec predicted the
overflow leg would be. **The blocker is not hypothetical and it is not confined
to Leg B**: it is the same missing ownership, already live, already costing 23%
of the colony's standing piles. Whatever closes it (spec 39's spawn-authority
ratchet, a relay corp, or giving the construction tankers the plan's routes
instead of a self-chosen dedicated source) closes Leg B with it.

Write-up: spec 14, cycle t72871684, Mechanism B.
