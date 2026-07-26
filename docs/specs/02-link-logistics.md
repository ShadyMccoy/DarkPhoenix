# 02 — LinkHaulerCorp: link transport as a corp (RCL5)

**Status:** groundwork committed (commit "Link logistics groundwork") but the
design has MOVED: link operation must be a **corp kind** through spec 00, not
the free-function + pickup-redirect scattering the groundwork used. Parts of
the groundwork survive, parts get absorbed (table below). Blocked by spec 01.
**Priority:** P0 after 01. This is the framework's first real transport kind —
it doubles as spec 00's proof.

## The idea

Transport is interchangeable: for a source→sink route the planner commissions
*some* transport corp sized to the flow. Today there is one kind (CarryCorp:
walk it). A link pair (source link → core link beside the storage) is a second
kind with a different cost model: a 3% transfer fee and a tiny stub creep at
the core, instead of a walking fleet sized to the full distance.

**LinkHaulerCorp** (kind `"linkHaul"`, shape `"transport"`):

- **consumes:** energy at the source link (rate), spawn build-time for one
  stub hauler (2–3 CARRY, core→sink walk only)
- **produces:** energy at the sink (rate × 0.97)
- **preconditions:** a link within feeding range of the source's harvest spot,
  a core link within 2 of the storage, the source staffed
- **assignment:** `{ sourceId, sourceLinkId, coreLinkId, sinkId, flowRate }`
- **run() — the whole job, deliberately dumb:**
  1. Fire: if the source link holds ≥ `LINK_FIRE_THRESHOLD` (100), cooldown 0,
     and the core link has free capacity → `transferEnergy(coreLink)`.
  2. Stub creep: withdraw from the core link, deliver to the assigned sink
     (storage / spawn network / controller spot via the existing
     `nodeEnergy` deposit resolvers). One creep, sized by
     `carryPartsFor(flowRate, coreToSinkDistance)`.

When a route is commissioned as `linkHaul`, **no CarryCorp is commissioned for
it** — kind selection happens at materialization (the commission's `kind`
field), so the two transport kinds never fight over one route.

## Groundwork reconciliation (commit 64c318c)

| Groundwork piece | Fate |
|------------------|------|
| Miner +1 CARRY from 600 capacity (`BodyBuilder`) and full-store transfer to adjacent link (`HarvestCorp`) | **KEEP** — producer-side delivery, correctly lives in the producer |
| Link placement: core first, farthest source > 8 from storage (`ConstructionCorp.findMissingLink`) | **KEEP** (becomes the kind's infrastructure precondition) |
| Planner `haulPos` (hauling priced from the core) + `detectLinkHaulPositions` | **KEEP** — this *is* the abstract-world representation; the adapter additionally tags the resulting transport commission `kind: "linkHaul"` |
| `execution/LinkRunner.ts` + the `runLinks()` call in `main.ts` | **ABSORB into `LinkHaulerCorp.run()`**, then delete both |
| `sourcePickupSpot` core-link redirect (`nodeEnergy`) | **DELETE** — it existed only to point CarryCorp haulers at the core; with kind selection, CarryCorp never serves a linked route. Keep the degrade-gracefully behavior, but INSIDE the kind: while the source-side container/pile holds energy (old CARRY-less miner not yet turned over), the commission falls back to `carry` kind at materialization |
| `coreLink` / `sourceLink` resolvers (`nodeEnergy`) | **KEEP** — shared by the kind, placement, and the adapter |

## Acceptance tests

### A. Framework conformance (free)

`linkHaul` registers as a CorpKind, so spec 00's conformance suite
(round-trip, deterministic propose, demand validity, empty-world safety,
primitives-derived economics) runs against it with zero new test code. That
suite passing for `linkHaul` is a hard requirement.

### B. Unit — pure fire decision: `test/unit/corps/linkFire.test.ts`

Extract `shouldFire(linkEnergy, cooldown, coreFreeCapacity): boolean`:

1. `(150, 0, 800) === true`
2. `(99, 0, 800) === false` (threshold is exact)
3. `(400, 3, 800) === false` (cooldown)
4. `(400, 0, 0) === false` (core full)

### C. Unit — kind selection at materialization

Mocked world (pattern: `coreDepot.test.ts`):

1. Route with link coverage and an EMPTY source-side container → commission
   materializes as `linkHaul`; **no** corp of kind `carry` exists for that
   `sourceId`.
2. Same but the source-side container holds ≥ 200 (stale CARRY-less miner) →
   materializes as `carry` (graceful degradation), and flips to `linkHaul`
   on a re-materialize after the container drains to 0.
3. Route without link coverage → `carry`, byte-identical demands to today
   (golden master from spec 00 must not move).

### D. Unit — stub demand

`linkHaul.getSpawnDemand`: exactly one demand; `role` resolvable by the kind's
`body()`; CARRY parts `=== Math.ceil(carryPartsFor(flowRate, coreToSinkDist))`
capped at 3; `blocking === false`; no demand while a live stub creep exists.

### E. Integration — `test/integration/link-economy.test.ts`

World: spec 01's RCL5 layout (far source (40,40) is the only link candidate).
Run ≤ 1500 ticks, sample every 25. ALL must hold:

1. **Placement:** a link within 2 of storage AND a link within 2 of (40,40);
   none at the near source while the RCL5 limit is 2.
2. **Flow:** core link energy observed > 0 at least once; cumulative positive
   deltas at the core ≥ 1000 over the run.
3. **The corp exists and the old fleet doesn't:** after the link pair has
   existed 300 ticks, ≥ 1 live creep whose `memory.corpId` starts with
   `linkHaul-`, and ≤ 1 live creep of the far source's `carry` corp (the
   walking fleet demobilized).
4. **Source not stranded:** the far source's miner stays alive and the
   source-side ground pile/container stays < 500 (energy is leaving via the
   link, not rotting).
5. **Value lands:** controller progress at end > at link-completion tick.

### F. Regression gate

Unit suite + `flow-handoff` + `runt-economy` + `storage-depot` green against
the final bundle. (The miner CARRY change is live at RCL3+ capacities —
spec 01 must be resolved first and these re-run.)

## Sequencing

1. Spec 01 (stall) — nothing here is trustworthy until the RCL5 world stands up.
2. Spec 00 scaffolding (Commission envelope + registry + conformance suite).
3. Port/absorb the groundwork into `LinkHaulerCorp` per the table above.
4. Tests B–E, then the regression gate.

## The feeder is the core-link ROUTER, and kind-selection must be EMERGENT (owner 2026-07-26)

Live thrash observed (t72595372): `hauler-g-cd90` and `feeder-Feeder` circling
energy on the core link. Root cause read from the code, TWO faults that compound:

**Fault 1 — the feeder is a HALF router.** The owner's intended role: the feeder
is a core-link MANAGER/ROUTER, "more like a dedicated building than a creep." It
must run the link BIDIRECTIONALLY:
- **EMPTY** the core link → storage, to keep it OPEN for incoming source-link
  volleys (a full core link has nowhere for the network to fire — `hubClampShare`
  0.59 measured, source links stranded at 800/800);
- **LOAD** the core link ← storage, to send to the controller link / any link
  sink as needed.

Today `ControllerFeederCorp.runFeeder` (controller-link branch) only ever
TRANSFERS INTO the core link (capped to leave the income reserve); when the link
is already staged it just holds its load beside the core. There is NO
withdraw-from-link → storage path. The passive income reserve is not enough: when
volleys fill the link, nothing actively drains it. The feeder must gain the empty
direction and become the SOLE operator of the core link's level.

**Fault 2 — a link-served source still gets a walking CarryCorp hauler**, whose
`sourcePickupSpot` redirect points it at the core link. It ends up doing the
feeder's missing empty-direction (drains the link to storage) and FIGHTS the
feeder's load-direction → the thrash. The band-aid exists only because fault 1
left the empty-direction unowned.

**The fix is one idea, and it must be EMERGENT, not hand-wired (spec 17).** A
link-served route is claimed by a TRANSPORT kind (the feeder-as-router today, a
`linkHaul` kind in the full design). Kind-selection at commissioning must then
NOT also commission a `carry` corp for that route — the two transport kinds never
both serve one route. This should fall out of the framework's kind economics /
registration (a route picks its cheapest transport kind; the loser is not
commissioned), exactly as spec 00/17 prescribe — NOT a special-case check bolted
onto CarryCorp. When it's emergent: cd90's energy flows source-link → core link →
(feeder routes to storage or fires to a sink), with no CarryCorp on the core link
and nothing to thrash against.

**Acceptance (when this is fixed):** (a) the feeder empties the core link to
storage whenever a source-link volley needs landing room (`hubClampShare` drops,
no stranded source links); (b) NO `carry` corp is commissioned for a link-served
source (emergent from kind selection, asserted in the conformance/selection
tests); (c) red-first repro of the thrash: a link-served source + a feeder, the
OLD path circles energy (feeder loads / hauler drains the same link), the fixed
path moves it once. Links have collapsed the colony before (spec 26) — full
regression gate + a post-deploy recapture that shows the thrash gone.

### Tests & scenarios for the feeder-router + emergent selection (2026-07-26)

UNIT (red-first, pure where possible):
- `feederRouter.empty`: core link over the income reserve + a source-link volley
  needs landing room → the feeder WITHDRAWS link→storage. Old code (load-only)
  never withdraws → RED.
- `feederRouter.load`: controller link has free capacity + core link below the
  fire target → feeder loads storage→link. (Existing behavior, keep green.)
- `feederRouter.soleOperator`: given a link-served source, `sourcePickupSpot`
  does NOT return the core link as a hauler pickup while a feeder owns it (the
  redirect that caused the thrash is gone).
- `kindSelection.linkServedNoCarry`: commissioning a link-served route yields a
  transport kind (feeder-router / linkHaul) and NO `carry` corp for that route —
  asserted from the framework's selection, not a special-case (spec 17/00
  conformance). A route flipping link↔walk selects exactly one kind.

GRID SCENARIO (spec 08 — heed the spec-26 blind spot: stage the REAL topology and
assert NET ENERGY MOVEMENT / delivery RECEIPTS, never link fill as a proxy):
- `link-core-router`: stage storage + core link + controller link + a link-served
  source (source link firing to the core) + a feeder, WITH the feeder relay
  present. Assert over the window: (1) no storage↔core-link circling — net link
  drain to storage tracks incoming volleys, feeder load tracks controller
  receive; (2) `hubClampShare` below threshold (link stays open); (3) zero `carry`
  corp commissioned for the link-served source; (4) controller progress rises
  (value lands). The OLD build must FAIL cell (1)/(3) — the thrash + the redundant
  CarryCorp — so the cell is a real regression gate, not a green-by-construction
  proxy.
