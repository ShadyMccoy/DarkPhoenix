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

## 4b. The next window falsified the reading I would have made — and named a THIRD mechanism (t72874433)

619 ticks later, the same table. The piles are draining hard (buffer 29,668 →
23,183, ground 14,105 → 9,564, +10.48 e/t of drawdown in the account) — and one
row cannot be read at all:

```
  source          buffer   DROPPED  container            source     buffer  DROPPED  container
  cd8d  t72873814   4316      2316     2000 (CAP)        cee0  t72873814  4348   2938   1410
  cd8d  t72874433   2588      2588        0              cee0  t72874433    20      0     20
```

**cd8d's container went from the cap to ZERO while its ground pile GREW** (2,316
→ 2,588). Section 4 offered two mechanisms for a below-cap container; this is a
third reading and none of the three is implied by the stock:

1. **haulers withdrew the container and left the pile.** `sourcePickupSpot` is
   pile-first EXCEPT while the container is full — so a container-first run
   should stop after ONE withdraw re-opens capacity. It cannot drain 2,000
   without the pile-first branch taking over. This mechanism predicts the
   opposite of what was measured, which is what makes the reading interesting.
2. **the container DIED and dumped its load on the ground.** A container in an
   unowned room decays five times as fast as an owned one; 2,000 (container) +
   2,316 (ground) = 4,316, and the mouth then stood at 2,588 after drain and
   decay. Arithmetically consistent — and *nothing in any capture carries a
   remote container's hits*, which is also the inventory the account's
   depreciation memo prices its 5.64 e/t accrual without.
3. **there was never a container there** and `sourceBuffers - sourceDropped` was
   reading a neighbouring structure at range 1.

**Container energy of zero reads identically under all three.** Three different
bugs, three different fixes, one number. So this cycle shipped the stamp rather
than a story (spec 14: *"if the cause is invisible, the fix is FIRST a stamp"*).

**Core v37 — `sourceMouth`**, keyed like `sourceBuffers`, publishing the three
facts the stock cannot imply:

| field | says |
|---|---|
| `n` | containers standing within range 1 — **emitted as 0**, because *"this source has no container"* is a positive claim and an absent key cannot make it |
| `free` | summed free capacity — 0 IS the cap, stated instead of asking the reader to recognise 2000 |
| `hp` | the WEAKEST container's hits fraction — a mouth is only as sound as the container that fails first |

One pure lens (`sourceMouthContainers` in `corps/nodeEnergy`, beside
`sourceBufferStock`), so the census reports what the mouth actually is.

It also settles two open items elsewhere, both currently held as inferences from
a zero: spec 54's *"neither home source has a container"* (cd90/cd92 should
report `n: 0`), and the same spec's per-source half of the depreciation memo.

**What it does NOT do: move the top line.** Nothing here drains anything.

## 4c. SETTLED t72875067 — the container DIED. This is a decay loop, not a hauling defect.

The census reported and cd8d is decided. Three independent facts agree, and the
stock is none of them:

```
  tick        core v   buffer  dropped  container   sourceMouth               W43N24 site
  72873814      36       4316     2316       2000   (not emitted)             none
  72874433      36       2588     2588          0   (not emitted)             {n:1, rem:2427, done:2573}
  72875067      37       3581     1581       2000   {n:1, free:0, hp:0.92}    none
```

1. **A construction site appears in W43N24 in exactly the window the container
   reads 0** — 2,573 of **5,000 done**, the container build cost — and is gone
   by the next capture. None before, none after.
2. The rebuilt container reads **`hp: 0.92`, the healthiest of all ten remote
   mouths** (the rest run 0.44–0.84). At 50 hits/tick in an unowned room that is
   a container ~400 ticks old: built inside that window.
3. `free: 0` — it refilled to the cap in ~600 ticks and is already back where it
   started.

**The mechanism is a loop:**

> fills to cap → nothing drains it → decays unrepaired → **dies and dumps its
> whole load on the ground, where it rots** → construction spends **5,000e**
> rebuilding it → refills to cap in ~600 ticks → repeat.

This RETIRES §4's candidate 2 (haulers drain the container and leave the pile) —
the more interesting hypothesis, and the wrong one. The energy did not move; the
container stopped existing. §4's candidate 1 (miner drops beside the container)
is untouched by this and still open for cee0/cd94.

**The whole colony is on the same slide**, and `hp` prices it for the first
time — ticks to death at 50 hits/tick, unrepaired:

```
  cd8e 0.44 (~2,200)   cee2 0.60 (~3,000)   cd98 0.62 (~3,100)   cbd8 0.66 (~3,300)
  cbd5 0.72 (~3,600)   d01f 0.73   cee0 0.73   cd94 0.73 (~3,650)
  cedc 0.84 (~4,200)   cd8d 0.92 (~4,600, the rebuild)
```

Meanwhile the account's DEPRECIATION MEMO reads **"KEEPING UP — hits are being
held"** (repair 7.54 e/t against a 5.73 e/t accrual). That aggregate was true
colony-wide while one of the structures it covers decayed to death — the repair
is going somewhere, and it is not the remote source mouths. The memo's own next
sentence already names the stake: *"it is paid at full rebuild price when a
structure expires (a container is 5000 energy)."*

**What this changes about the spec.** §2 asked *"why does nothing drain a full
container"* and listed three DEMAND-side answers. Those remain the reason the
container sits at cap. But the ROT is now shown to have a second, independent
producer that no amount of hauling fixes: a container that dies puts its entire
2,000e on the ground in one tick. Any fix that only addresses demand leaves this
loop running, and the loop's cost is not just the rot — it is **5,000e of
construction per lap**, which the account books as `construction (built)` and
therefore reads as investment rather than as replacement of a wasted asset.

Two things this does NOT establish, stated so they are not assumed: whether the
same loop has already run at the other mouths (no `hp` history exists before
v37 — the first slope reading lands next cycle), and why remote-mouth repair is
not happening when colony repair is above its accrual. The second is the
actionable question and it belongs to whoever picks this up — likely spec 16
(construction as projects) rather than this spec.

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
