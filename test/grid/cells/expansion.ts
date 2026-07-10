/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T5 expansion cells (spec 06): the claim-and-found arc, reduced to two core
 * moments. The TRIGGER (shouldExpand: GCL headroom + candidate + banked CAPEX)
 * is unit-tested pure logic, so both cells stage Memory.expansion directly and
 * assert the DELIVERY the economy owes the campaign:
 *
 *  1. claim moment - the claim corp fields one held-funded claimer, it walks
 *     into the target room, claims the controller, and the planning cadence
 *     places the founding spawn site at the campaign's spawnPos;
 *  2. founding moment - with the target room owned and its near-complete
 *     spawn site staged, the flow economy admits the site as the
 *     NEW_SPAWN_SITE_VALUE sink (no nodes analyzed there yet - the spec-06
 *     audit fallback), energy funnels cross-room, the spawn completes, and
 *     the campaign closes itself.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

/** Home room with an east exit slot at (49, 24..26). */
const homeEast = (build: (b: RoomBuilder) => RoomBuilder) => (roomName: string) => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(49, y, "plain");
  return build(b).toRoom();
};

/** East room with the matching west slot at (0, 24..26). */
const eastRoom = (build: (b: RoomBuilder) => RoomBuilder) => (roomName: string) => {
  const b = new RoomBuilder(roomName).border();
  for (let y = 24; y <= 26; y++) b.tile(0, y, "plain");
  return build(b).toRoom();
};

const EXT_8: Array<{ x: number; y: number }> = [
  { x: 23, y: 23 },
  { x: 23, y: 27 },
  { x: 27, y: 23 },
  { x: 27, y: 27 },
  { x: 22, y: 25 },
  { x: 28, y: 25 },
  { x: 24, y: 22 },
  { x: 26, y: 22 },
];

/** A staged home income pair so the campaign rides a living economy. */
const homeIncome = (srcX: number, srcY: number, spotX: number, spotY: number, tag: string) => [
  {
    name: `m-${tag}`,
    x: spotX,
    y: spotY,
    body: ["work", "work", "work", "work", "work", "move", "move", "move"],
    memory: { workType: "harvest", corpId: `staged-${tag}-m`, assignedSourceId: `$id(home,source,${srcX},${srcY})` },
  },
  {
    name: `h-${tag}`,
    x: 22,
    y: 30,
    body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
    memory: {
      workType: "haul",
      corpId: `staged-${tag}-h`,
      working: false,
      assignedSourceId: `$id(home,source,${srcX},${srcY})`,
    },
  },
];

/** The founding spawn's tile in the east room (open plain, off the slot). */
const SPAWN_POS = { x: 20, y: 25 };

/** Write the campaign into the bot's env Memory (re-read next tick). */
async function stageCampaign(ctx: { env: any; userId: string; room(h?: string): string; gameTime: number }): Promise<void> {
  const key = ctx.env.keys.MEMORY + ctx.userId;
  const raw = (await ctx.env.get(key)) || "{}";
  const mem = JSON.parse(raw);
  if (mem.expansion) return;
  const east = ctx.room("east");
  mem.expansion = {
    roomName: east,
    nodeId: "staged-campaign",
    spawnPos: { x: SPAWN_POS.x, y: SPAWN_POS.y, roomName: east },
    sinceTick: ctx.gameTime,
  };
  await ctx.env.set(key, JSON.stringify(mem));
}

export function buildExpansionT5Cells(): GridCell[] {
  // claim-moment closure
  let claimedAt: number | null = null;

  // founding-moment closure
  let stagedProgress: number | null = null;
  let progressClimbed = false;

  return [
    {
      // CLAIM MOMENT: campaign staged -> the claim kind commissions its corp,
      // the SpawnDirector held-funds the 650 claimer (value 80, below every
      // income corp), it walks east, claims, and the next planning pass
      // places the founding spawn site at the campaign's spawnPos.
      id: "exp-t5-claimer-claims-and-founds",
      tier: 5,
      avenue: "expansion",
      window: 500,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40).source(40, 25)),
        east: eastRoom((b) => b.controller(15, 25).source(35, 35)),
      },
      adjacency: { east: "E" },
      // users.gcl is POINTS, not level: 1e6 points = GCL 2 (a 2nd room is claimable).
      bot: { x: 25, y: 25, gcl: 1_000_000 },
      controller: { level: 3 },
      // 8 staged-full extensions + spawn 300 = 700 capacity: the indivisible
      // CLAIM+MOVE (650) is affordable once banked.
      structures: EXT_8.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      creeps: [...homeIncome(25, 40, 24, 39, "exc")],
      async onTick(ctx) {
        if (ctx.tick === 2) await stageCampaign(ctx);
      },
      assertions: [
        eventually("a claimer is fielded", (s) =>
          ["home", "east"].some((h) =>
            s.objects(h).some((o) => o.type === "creep" && typeof o.name === "string" && o.name.startsWith("claimer-"))
          )
        ),
        eventually("the east controller is claimed", (s) => {
          const ctrl = s.objects("east").find((o) => o.type === "controller");
          if (ctrl?.user === s.userId && claimedAt === null) claimedAt = s.tick;
          return claimedAt !== null;
        }),
        eventually("the founding spawn site is placed at the campaign pos", (s) =>
          s
            .objects("east")
            .some(
              (o) =>
                o.type === "constructionSite" &&
                o.structureType === "spawn" &&
                o.x === SPAWN_POS.x &&
                o.y === SPAWN_POS.y &&
                o.user === s.userId
            )
        ),
      ],
    },

    {
      // FOUNDING MOMENT: east already ours, its spawn site staged at 90% -
      // the site enters the flow as the NEW_SPAWN_SITE_VALUE sink (via the
      // no-nodes-yet anchor fallback), home energy funnels cross-room, the
      // spawn completes, and updateExpansionCampaign closes the campaign.
      id: "exp-t5-founding-funnels-to-completion",
      tier: 5,
      avenue: "expansion",
      // 1800 not 1400: solo the spawn stands ~t=790, but in the full-batch
      // world (11 bots sharing the server) the founding lane runs slower and
      // 1400 measured flake-tight. The batch already runs an 1800t world, so
      // the longer window costs no extra wall-clock.
      window: 1800,
      rooms: {
        home: homeEast((b) => b.controller(25, 10).source(25, 40).source(40, 25)),
        east: eastRoom((b) => b.controller(15, 25)),
      },
      adjacency: { east: "E" },
      // users.gcl is POINTS, not level: 1e6 points = GCL 2 (a 2nd room is claimable).
      bot: { x: 25, y: 25, gcl: 1_000_000 },
      controller: { level: 3 },
      structures: EXT_8.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      creeps: [...homeIncome(25, 40, 24, 39, "exf"), ...homeIncome(40, 25, 39, 24, "exf2")],
      async stage(ctx) {
        const east = ctx.room("east");
        // The east room is ALREADY OURS (the claim moment is cell 1).
        await ctx.db["rooms.objects"].update(
          { room: east, type: "controller" },
          { $set: { user: ctx.userId, level: 1, progress: 0, downgradeTime: ctx.gameTime + 20000 } }
        );
        // Founding spawn site at ~93%: the cell watches the LAST 1000 energy
        // land, not the whole 15k grind (core-moment doctrine; at the founding
        // lane's measured ~3 e/t the full 1500 finished at t=1388 of 1400 -
        // too flake-tight).
        await ctx.db["rooms.objects"].insert({
          type: "constructionSite",
          room: east,
          x: SPAWN_POS.x,
          y: SPAWN_POS.y,
          user: ctx.userId,
          structureType: "spawn",
          progress: 14000,
          progressTotal: 15000,
        });
      },
      async onTick(ctx) {
        if (ctx.tick === 2) await stageCampaign(ctx);
      },
      assertions: [
        eventually("energy funnels to the founding site (progress climbs)", (s) => {
          const site = s
            .objects("east")
            .find((o) => o.type === "constructionSite" && o.structureType === "spawn");
          if (site && stagedProgress === null) stagedProgress = site.progress ?? 0;
          if (site && stagedProgress !== null && (site.progress ?? 0) > stagedProgress) progressClimbed = true;
          return progressClimbed;
        }),
        eventually("the founding spawn stands", (s) =>
          s.objects("east").some((o) => o.type === "spawn" && o.user === s.userId)
        ),
        eventually("the campaign closes once the spawn stands", (s) => {
          const spawnUp = s.objects("east").some((o) => o.type === "spawn" && o.user === s.userId);
          return spawnUp && s.memory?.expansion === undefined;
        }),
        // The founding must not bankrupt the parent: its own spawn network
        // stays alive (the live spawn at value 100 outranks the site's 85).
        always(
          "the home economy keeps at least one creep alive",
          (s) => s.objects().some((o) => o.type === "creep"),
          20
        ),
      ],
    },
  ];
}
