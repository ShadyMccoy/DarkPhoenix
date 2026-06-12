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
