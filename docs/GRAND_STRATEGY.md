# Grand Strategy — the value-per-intent thesis

**Status:** strategic doctrine / north star for the objective function. This is
*where the planner's objective points*, not a description of what the bot does
today. The current bot does not GCL-sink-cycle, does not run the RCL8 sprint,
and does not yet price intents — that last is
[spec 29](specs/29-cpu-as-costed-resource.md), still a stub. Read this as the
argument for why spec 29 is the keystone of the late game, and as the doctrine
behind [spec 06](specs/06-expansion.md) (expansion),
[spec 21](specs/21-conquest.md) (peace-as-strategy), and
[spec 28](specs/28-source-keeper-mining.md) (SK mining).

Mechanics cited here that were surprising or disputed were **verified against
`@screeps/engine` master**; the rest are standard game constants. When a number
here disagrees with the engine, the engine wins — fix the doc.

## The thesis in one line

> Every in-game resource — energy, spawn time, GCL, even military force — is
> convertible into the others through **minerals and logistics**. The one thing
> that is *not* convertible, that you cannot manufacture in-game, is **CPU**. So
> at the limit the whole game is a single optimization: **maximize value per
> intent**, subject to a hard intent budget.

Everything below is a corollary.

## 1. The intent budget is the empire's real size limit

- CPU cap (MMO, full subscription): **300 / tick**. Intent cost: **0.2 CPU**.
- Hard ceiling: **1,500 intents/tick** — *if* 100% of CPU went to intents.
- It doesn't. Pathfinding (`PathFinder.search`, 0.1–1+ CPU/call) and your own JS
  logic take a large cut. **Usable is ~600–900 intents/tick.**
- ~40 intents/room of naive activity → **~17 rooms** before intents run out.
  The GCL-40s–50s plateau falls straight out of that arithmetic. You run out of
  *intents to spend* before energy, GCL, or spawns bind.

**Corollary:** the planner's objective is not value/energy or value/room — it is
**value/intent**. Every corp should be costable by the intents its creeps issue
(harvest ≈ 1/source, haul ≈ 2/trip minus links, upgrade ≈ 1/static WORK), and the
objective maximizes value against the ~700/tick budget. That is spec 29 with
teeth.

## 2. Boosts are intent-reducers — and two of them are free resource multipliers

Boosts split into two classes:

- **Work-conversion boosts (`upgradeController` GH-line, `build` LH-line):**
  genuinely multiply **energy → output at no extra energy cost.** Verified in the
  engine: `upgradeController` deducts energy on the *unboosted* WORK count
  (`buildEffect`) but credits controller progress on the *boosted* amount
  (`boostedEffect`). So `XGH2O` (×2) yields **2 progress per 1 energy** — the
  boost is free progress. (`GH` 1.5 / `GH2O` 1.8 / `XGH2O` 2.)
- **Part-effect boosts (carry, harvest, attack, heal, move, tough, dismantle):**
  multiply a part's effect → **fewer / smaller creeps** for the same work → fewer
  intents. Carry `XKH2O` (×4) → a quarter of the haulers. Harvest `XUHO2` (×7) →
  ~1 WORK drains a source that needed 5.

Both classes buy intent budget. The mineral is therefore the currency that buys
**empire scale via CPU** — and SK rooms (spec 28) are the mineral source. That is
the deep reason to hold SK-core-adjacent rooms: not the extra energy, the
**intent efficiency the minerals buy.**

## 3. The one wall boosts cannot lift: the RCL8 15/tick cap

- `CONTROLLER_MAX_UPGRADE_PER_TICK = 15`, applied *after* boosts. Below RCL8
  there is **no** cap — the entire 1→8 climb is uncapped.
- The only thing that lifts it is `PWR_OPERATE_CONTROLLER` (power creeps) — out of
  scope by owner preference.
- So passive GCL income = `15 × RCL8 rooms`, and room count ≤ GCL level →
  ~1 level/month around GCL 30. **This is the terminal throttle** *if you park
  rooms at 8.*

**But you needn't park them.** GCL control points are credited on *every* upgrade,
cumulatively, forever — re-claiming a controller and re-pumping 1→8 pays out
another ~12.7M. A **bare sink controller** carries no local infrastructure
(energy + boosted upgraders are imported), so unclaim/re-claim costs nothing to
rebuild. Trade a few marginal rooms' slots for a rotating pool of sub-8 sinks
pumped at ~1,000/tick (≈65× the parked 15/tick). GCL income then bounds on
**deliverable surplus energy** (≈ surplus / 2, thanks to the free upgrade boost)
— i.e. on logistics and intents, *not* the cap. Same conclusion: intents all the
way down.

Climb cost for reference (`CONTROLLER_LEVELS`, RCL1→8): **12,735,200** energy of
progress, of which **7→8 alone is 7,290,000 (57%)**. The low levels are a
rounding error; "time to RCL8" is "time to grind 7→8."

## 4. The concentration engine — one capability, two payloads

The distributed empire can **aggregate throughput onto a single room**: pre-stage
energy or creeps across many rooms, deliver concentrated, and beat the target's
per-room throughput cap. That is the general primitive; the payload is a choice.

- **Payload = energy + boosted upgraders → RCL8 sprint.** With the free upgrade
  boost and imported energy, the 12.7M climb becomes a *delivery-bandwidth*
  problem, not a time problem. Bounded finally by **controller geometry**: ≤48
  tiles within range 3, and how much energy you can cram through them. A well-fed
  sprint reaches RCL8 in well under a day; the tile floor is a few hours. Energy
  is pre-bankable across storages, so the sprint is a *logistics burst off banked
  reserves*, not a production problem.
- **Payload = boosted fighters → conquest.** The defender is spawn-throughput-
  limited (~1 part / 3 ticks / spawn; ~500 standing parts sustained per spawn);
  you pre-stage across many rooms and arrive with a force they cannot match or
  replace in real time. Force concentration / defeat-in-detail — it works because
  rooms are throughput-limited nodes.

The engine's highest use is almost always the *first* payload. §5 is why.

## 5. Peace is the CPU-optimal policy, not a temperament

The doctrine behind spec 21, derived rather than asserted.

- **War is a triple intent-drain:** combat creeps issue intents for zero growth
  (~3/creep/tick); a room under attack loses its economic intents; minerals and
  spawn go to military instead of growth.
- **PvP is negative-sum in the conserved currency:** the opponent shares the same
  300 CPU. Both stall growth; the non-combatant keeps ~700 intents on growth and
  out-compounds. Sustained *uncoordinated* aggression is self-eliminating —
  aggressors don't grow and get out-scaled.
- **Offense is intent-expensive, defense intent-cheap:** a tower is ~1 intent for
  massive damage; a siege is dozens of intents for a long time. A defended room is
  unprofitable to attack → mutual peace is the equilibrium and "be the room nobody
  profits from attacking" is a *theorem*, not a hope.
- **Abundance dissolves the conquest exception:** ~50,000 rooms exist; even the
  premium class (SK-core-adjacent) is abundant at map scale (1 core/sector ×
  thousands of sectors). No single room is irreplaceable, so the free alternative
  always beats fighting — and cheap sprint-founding (§4) drives the counterfactual
  so low that conquest almost never pencils out.
- **The exception (spec 21) survives only as:** a specific *already-owned*,
  irreplaceable room held by a *measurably weak* owner with no free alternative —
  and even then concentration (§4) is how you fight *efficiently*, short and
  overwhelming rather than a grinding siege. Rare by construction.

**Doctrine that falls out:** near-zero standing offense; a trickle on cheap
deterrent defence (towers + latent boost capacity, no perpetual rampart premium);
mandatory PvE (SK guardians, invader cores) budgeted; the entire remaining intent
budget on growth. Under a hard intent cap, peace is the *greedy* move.

## 6. The offensive branches all dead-end on deliberate rules

Every creative breach of a fortified room hits a hard rule written to preserve the
defender's front-door advantage. Verified mechanics:

| Idea | Why it fails |
|---|---|
| Out-heal towers, dismantle the ramparts | Boosted `DISMANTLE` = 200 hits/WORK/tick **equals** boosted `REPAIR` (200) — a 1:1 WORK race the defender wins from cover while your dismantlers eat tower fire. Max RCL8 rampart = **300M** hits. |
| Nuke a hole | `NUKE_LAND_TIME = 50,000` (fully telegraphed ~2–3 days); `NUKE_DAMAGE` 10M center / 5M range-2 — one nuke does **not** crack a 300M rampart; `NUKER_COOLDOWN = 100,000`; cost 300k energy + 5k ghodium. Denies safe mode only ~200 ticks (`CONTROLLER_NUKE_BLOCKED_UPGRADE`). |
| Out-wait safe mode | Safe mode is **one room at a time** across the whole empire (`SAFE_MODE_DURATION` 20,000; `COOLDOWN` 50,000; `COST` 1,000 ghodium). The counter is *breadth* — attack the whole cluster, they shield one — but a rational defender then *evacuates* the rest. |
| Tunnel through the natural walls | Verified `createConstructionSite`: `ERR_NOT_OWNER` when the controller is `level > 0 && !my`, **or reserved by another player**. You cannot lay so much as a road in territory an enemy owns *or reserves*. Natural terrain walls are immutable — not even nukes remove terrain. |

The only attack surface on a base is the rampart-covered gaps, and that surface
favours the defender. The engine closes *each* flank with a distinct hard rule —
turtle integrity is load-bearing, which is *why* §5 holds.

## The through-line

From "what RCL do we need for keeper mining?" (RCL7-ish, gated on affording the
garrison — spec 28) the strategy resolves to a single machine:

> Convert abundant surplus (energy, minerals) into GCL and defensive position as
> fast as **intents** allow; grow relentlessly into a map that is mostly empty;
> never spend the conserved intent budget on offense that a free room makes
> pointless. Hold SK clusters because their minerals buy the boosts that buy back
> intents. Price CPU (spec 29) and every one of these behaviours falls out of the
> objective rather than being hand-coded.
