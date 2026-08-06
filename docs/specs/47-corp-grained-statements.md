# 47 — Statements grained by CORP, and for every resource we spend

**Status: BACKLOG 2026-08-06** (owner: *"right now the statement is a little bit
convoluted. It's fanciful and looks deceiving. We got the mining, the cogs, the
direct costs and the overhead. These are aggregations of corps for the most
part. Each corp just fits in one of these categories w a budget... We should be
able to see all the resources actual like this if we wanted including minerals or
other resources. As well as spawn body capacities and types and cpu."*)

## 1. The diagnosis is right, and the defect is already in the code's own comments

The owner's model — **each corp falls in exactly one category, each category has
a budget, the statement is the roll-up** — is what the statement *looks* like. It
is not what it *is*.

The account aggregates by **ROLE** (`ACCOUNT_CLASS_OF_ROLE`,
scripts/waste-ledger.ts), because that is the only key the cumulative spawn
ledger carries (`Memory.spawnLedger.energyByRole`). Role is a lossy proxy for
corp, in three places we have already written down:

- **`tanker` is bought by two kinds.** `extensionTenderKind` (spawn-network
  refill → infra) and `construction` (crew haulage → really a build cost). The
  mapping's own comment concedes it: *"the role alone cannot separate them, so
  both land in infra and the line slightly OVER-states infra during a build
  campaign."*
- **`hauler` spans two very different businesses.** Source-route evacuation and
  standalone scavenge corps both accrue as `hauler`. The SOURCE P&L already has
  to disclaim it: *"Hauler is LOWER than the evacuation line by the standalone
  scavenge corps."*
- **`jack` has no class at all.** Bootstrap creeps print as a dangling
  `UNCLASSIFIED [jack]` line (−0.45 e/t at t72823437). The energy is counted (it
  falls into `other`, which rolls into overhead), but the statement shows a
  category that is not a category.

That is the "fanciful and deceiving" the owner is seeing: the statement presents
a corp-shaped model while computing a role-shaped one, and the two disagree
exactly where a build campaign or a scavenge fleet is running.

**The fix is small and the seam already exists.** `SpawningCorp` calls
`accrueSpawnSpend(role, bodyCost, body.length, {...})` with `buyerCorpId` in
scope — it already uses it for the `scavenge` sub-counter (methodology #10). Add
`energyByCorp` / `energyByKind` beside `energyByRole`, let each corp KIND declare
its account class (registration-only, per spec 17), and the roll-up becomes what
the owner described: corps → categories → budget vs actual, with no lossy
mapping in between and no unclassified line.

## 2. Timing: NOT during the handicap sweep

This changes the chart of accounts, so it bumps `METHODOLOGY` — and spec 41 is
explicit that **two reports are comparable only at the same stamp.**

The spec-45 sweep is running 21 fiscal months to compare income statements
across handicaps. Re-graining the account at month 12 makes months 1–11
incomparable to 12–21 and destroys the experiment's only axis.

**Land this at a sweep CYCLE boundary** (`Memory.spawnSweep.cycle` increments,
handicap wraps to 0), not mid-ramp. Cycle 0 stays at methodology #14; cycle 1
starts at #15 and is internally comparable. That is also a free A/B on the
re-graining itself: the same handicaps, measured both ways.

## 3. Scope — four statements, one grain

The owner asked for the same treatment across resources, spawn capacity and CPU.
All four are the same shape: **corps → categories → budget vs actual**, and the
colony already meters most of the inputs.

### A. Energy, grained by corp (the one above)

Replace the role→class map with corp-kind→class declarations. Keep every current
line item; only the ATTRIBUTION changes. Expected movements, to be predicted
before the change lands: infra falls by the construction crew's tanker spend,
construction rises by the same, evacuation splits into source-route vs scavenge,
and the UNCLASSIFIED line disappears into bootstrap.

### B. All resources, not just energy

Today the statement is energy-only. The colony already knows about minerals
(spec 22 prices mineral EV into node/room EV; `RoomIntel` carries
`mineralType`/`mineralDensity`/`mineralAmount`), but nothing meters extraction,
haulage or sale as a P&L.

Needs: a per-resource stock and flow meter (store deltas by resource across the
room set, the same differencing the energy account already does), and the same
corp roll-up over it. Minerals, then market credits, then boosts. The residual
discipline carries over unchanged — a named residual per resource.

### C. Spawn capacity: bodies and types as a balance sheet

`spawnSpend.partsByRole` and `core.bodyParts` already exist
(`{total: 670, byPart: {work: 122, move: 244, carry: 275, attack: 15, claim: 14}}`
at t72823437) — the data is there, the STATEMENT is not. What is missing is the
budget side: parts/tick planned per corp against parts/tick bought, per part
TYPE. P4 does this for the colony total; the owner wants it per category.

This is the sharpest of the four, because spawn build-time is the constraint the
whole spec-45 experiment is about: a category that over-buys CARRY is invisible
in an energy statement and obvious in a parts one.

### D. CPU as its own statement

Spec 20 built the ledger (`Memory.corpCpu`: per-corp, plus named infrastructure
buckets, reconciling to `wholeTick`). It is a reconciliation, not a statement,
and it is **absent from the captures entirely** — `core.corpCpu` read `null` at
t72823437, so no CPU line can be closed today. First step is publishing it into
the core segment; the roll-up follows for free once it is there.

## 4. Acceptance

Per category, per statement: **budget, actual, variance, and a named residual**
— the same discipline spec 42 sets for energy. A statement joins the standing
report set (spec 41) only when it balances by construction and its residual is
published, never as an extra table of actuals.

## 5. Related

- Spec 42 (the energy controller budget) — this is its attribution half: 42 asks
  every joule to have a named home, 47 asks that home to be a CORP.
- Spec 17 (ontology layers) — account class becomes a kind declaration, so a new
  corp kind classifies itself by registration, like everything else.
- Spec 41 (fiscal periods) — the methodology stamp is the gate; see §2.
- Spec 45 (handicap sweep) — the experiment this must not land in the middle of.
