# 59 — The container caps at 2000 and everything after that rots

**Status: DIAGNOSED 2026-08-09 (t72873814), NOT FIXED.** This is the waste
ledger's TOP LINE (L1, pile decay **23.62 e/t against a budget of 0.00**,
**94.49×**) localised to a mechanism for the first time. It supersedes "the
piles" as a description of the problem.

## 1. The measurement that made it visible

Core **v36** shipped `sourceDropped` — the field that splits a source mouth's
buffer into the part held in a CONTAINER (which keeps) and the part on the
GROUND (which decays at `ceil(amount/1000)` per tick). It had been declared
since v19 and never emitted (spec 14, methodology note #8), so no capture in
this project's history could answer the question below. The first one that
could:

```
  source   buffer  DROPPED  container            source   buffer  DROPPED  container
  cd98       6561     4561     2000  <- CAP      d01f       2628      628     2000  <- CAP
  cee0       4348     2938     1410              cd8e       2122      122     2000  <- CAP
  cd8d       4316     2316     2000  <- CAP      cee2       1450        0     1450
  cedc       3614     1614     2000  <- CAP      cbd8       1288        0     1288
  cd94       3128     1918     1210              cbd5        205        0      205
  -------------------------------------------------------------------------------
  TOTAL     29668    14105    15563     ->  48% of the mouth stock is ON THE GROUND
```

Summing `ceil(amount/1000)` over those piles gives ~18 e/t against the ledger's
measured 23.62 — consistent (the ledger averages a window in which the piles
were larger).

## 2. What it says, and what it retires

**Five of the seven rotting sources hold exactly 2000 — the container cap — and
the entire overflow is on the ground.** The containers are built, they are in
the right place, and they are FULL.

That retires a reading this project has carried for several cycles. "Ground pile
decay" invited a placement story: *the container is missing, or badly sited, or
the miner drops beside it.* For five of seven sources that story is simply
false. The buffer exists, works, and tops out; ground rot is what happens to
**everything mined after 2000**, and a container cannot be the answer to a
problem the container is already at capacity for.

So the question changes shape, and this is the whole point of the spec:

> **NOT** "why do piles form" — a full container explains that completely.
> **BUT** "why does nothing drain a full container."

## 3. The three answers already on file

Every one of them is a demand-side failure — nothing is ASKING for the carry.
The spawn's own idle attribution says so: at t72872936 it idled 13% of the
window with **63% of that idle classed `empty` = no demand**, while 33,657e
stood at the mouths.

**A — the mature dead-band** ([spec 55](55-spawn-fields-the-plan.md), P0).
`exit: "deadband"` stamped live on 8 of 10 piled sources. The corp computes it
needs 20-38 CARRY, holds 1-2 creeps, and the dead-band declines the marginal
hauler. Fenced: the ask gate and the recycle POUNCE share `worthABody`, so a
one-sided loosening re-opens the t72773737 treadmill on d01f — one of the very
sources starving here. Acceptance is an F2==0 cell that does not exist.

**B — the construction-routed sources** ([spec 49](49-deposit-port-overflow-haul.md)
Blocker 1, realised). cd98 and cee0 are routed to CONSTRUCTION sinks, so
`haulCarryNeeded` filters their routes out entirely (*"the tankers own this
energy, pile or no pile"*) and stamps `carryNeeded: 0` and `1` respectively. The
tankers that are supposed to own it are sized `tankerDist: 10` against supply
routes at d=20 and d=36, so they never come. Those two sources took **82% of the
colony's pile growth** in the t72872936 window.

**C — the seam under both** ([spec 39](39-plan-owns-the-fleet.md)). The
COMMISSION for cee0 declares 35 parts; the corp's own demand lens asks for one
CARRY; nothing reconciles them, because the SpawnDirector does not read
`commission.fleet`. **If the director bought what the commission declares, cee0
would be staffed.** This is the structural fix and it closes A's symptom and B's
mechanism together.

## 4. The two sources that do NOT fit, and are not diagnosed

**cee0 (container 1,410, ground 2,938) and cd94 (1,210 / 1,918) hold ground
piles while their container is BELOW cap.** The cap story cannot explain those.
Two candidate mechanisms, neither measured:

- the miner is dropping beside the container rather than into it (a harvest-spot
  vs container-tile geometry question), or
- haulers drain the container (one `withdraw`) and leave the pile (which needs a
  separate `pickup`), so the container empties and the ground does not.

The second would be a *pickup-priority* defect and is the more interesting of
the two, because it would mean the recovery path actively prefers the resource
that is not rotting. **Not asserted** — it needs the carry pickup stamps, and
the ledger's own E6 verdict (*"read the carry pickup stamps"*) says where to
look. Naming a cause from the stock alone would be a hypothesis dressed as a
finding.

## 5. Acceptance

No fix is proposed here; this spec exists so the mechanism is not re-derived.
Whatever closes it must show, on a live capture:

- `sourceDropped` totalling near **zero** at sources whose container is at cap —
  the container may sit full, but nothing should stand on the ground beside it;
- `E6` deferred count falling (the pile gate stops throttling the miners:
  forgone mining was 1.20-4.59 e/t across the three cycles measured);
- `L1` pile decay approaching its 0.00 budget, which is the only number that
  actually matters;
- and — the anti-regression pin — `X5` churn NOT rising, because the cheap way
  to buy carry is the treadmill spec 55 §5 forbids.

## 6. Related

- **Spec 14**, cycles t72871684 / t72872936 / post-deploy t72873814 — the three
  captures this was built from, including the two corrections they forced.
- **Spec 44** (standing scavenger) — the recovery fleet went 1 → 5 scavengers in
  the same window and the piles fell 33,657 → 29,668. That is the CURE working
  on the symptom; this spec is about the illness. Owner 2026-08-08 was explicit
  that scavenging *"is for things close to the core not perennial source
  piles"*.
- **Spec 15** — L1 is the row; the TOP LINE picker's mis-ranking of it is filed
  there separately.
