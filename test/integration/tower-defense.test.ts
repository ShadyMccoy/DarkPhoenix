/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain, setRoomLevel, enableMods, FREE_ECONOMY_MOD } from "./loadLayout";

/**
 * Tower defense v1 (spec 07): a pre-placed tower with 500 energy deletes an
 * injected invader before it reaches the colony, with no friendly losses.
 *
 * The invader is a real user-"2" creep, so the ENGINE's own raid AI drives it
 * (processor/intents/creeps/invaders) - it walks at the colony and the tower
 * must actually win the fight; a despawn is ruled out by giving it 1500 TTL
 * and asserting death within 200 ticks.
 */
describe("tower defense at RCL 4", () => {
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  it("kills an injected invader with tower fire and no friendly losses", async function () {
    this.timeout(1200000);

    // The proven walled two-chamber room (storage-depot layout).
    const terrain = Array.from({ length: 50 }, (_v, y) =>
      ".".repeat(25) + (y >= 23 && y <= 27 ? "." : "#") + ".".repeat(24)
    );

    const extensions: Array<{ x: number; y: number }> = [];
    for (let x = 8; x <= 17; x += 1) extensions.push({ x, y: 21 }, { x, y: 22 });

    await helper.beforeEach(async (world) => {
      await loadLayout(world, {
        room: "W0N0",
        terrain,
        objects: [
          { type: "controller", x: 38, y: 25 },
          { type: "source", x: 10, y: 10 },
          { type: "source", x: 40, y: 40 },
          {
            type: "container",
            x: 13,
            y: 25,
            attributes: {
              store: { energy: 0 },
              storeCapacityResource: { energy: 2000 },
              hits: 250000,
              hitsMax: 250000
            }
          }
        ]
      });
      await padNeighborTerrain(world, ["W0N0"]);
      await helper.addBot({ room: "W0N0", x: 12, y: 25 });
      await setRoomLevel(world, "W0N0", 4, extensions);
      enableMods(helper.serverPath, [FREE_ECONOMY_MOD]);

      const { db } = await world.load();
      // The fight must be real: addBot arms a 20000-tick safeMode.
      await db["rooms.objects"].update({ room: "W0N0", type: "controller" }, { $set: { safeMode: null } });

      // The tower, pre-placed and half-charged (OWNED schema: user +
      // storeCapacityResource - the staged-storage trap).
      await db["rooms.objects"].insert({
        type: "tower",
        room: "W0N0",
        x: 11,
        y: 25,
        user: helper.player.id,
        store: { energy: 500 },
        storeCapacityResource: { energy: 1000 },
        hits: 3000,
        hitsMax: 3000,
        notifyWhenAttacked: false
      });

      // The Invader NPC user. The raider itself is injected mid-run: the
      // engine's invader AI only hunts CREEPS, and an invader that finds an
      // owned room with no creeps and a reachable spawn SUICIDES on the spot
      // (findAttack.js:84-89) - raids arrive at working colonies.
      const users = db["users"];
      if (!(await users.findOne({ _id: "2" }))) {
        await users.insert({ _id: "2", username: "Invader", cpu: 0, gcl: 0, active: 0 });
      }
    });

    const friendlyCount = async (): Promise<number> => {
      const objs = await helper.server.world.roomObjects("W0N0");
      return objs.filter((o: any) => o.type === "creep" && o.user !== "2").length;
    };

    // Warm up: let the colony field its first creeps (the invader AI needs
    // creeps to hunt or it suicides instantly - see beforeEach note).
    let warmed = 0;
    for (let t = 1; t <= 150; t += 1) {
      await helper.server.tick();
      if ((await friendlyCount()) >= 2) {
        warmed = t;
        break;
      }
    }
    assert.isAbove(warmed, 0, "the colony should field creeps during warmup");

    // Inject the raider: 10xATTACK/10xMOVE at the room edge, 1500 TTL - it
    // cannot time out inside the 200-tick window; only the tower removes it.
    {
      const { db } = await helper.server.world.load();
      const gameTime = await helper.server.world.gameTime;
      await db["rooms.objects"].insert({
        type: "creep",
        name: "invader_test_1",
        room: "W0N0",
        x: 1,
        y: 25,
        user: "2",
        body: [
          ...Array.from({ length: 10 }, () => ({ type: "attack", hits: 100 })),
          ...Array.from({ length: 10 }, () => ({ type: "move", hits: 100 }))
        ],
        store: {},
        storeCapacity: 0,
        hits: 2000,
        hitsMax: 2000,
        fatigue: 0,
        ageTime: gameTime + 1500,
        spawning: false,
        notifyWhenAttacked: false
      });
    }

    const startFriendlies = await friendlyCount();

    let invaderGoneAt: number | null = null;
    for (let t = 1; t <= 200; t += 1) {
      await helper.server.tick();
      const objs = await helper.server.world.roomObjects("W0N0");
      const invader = objs.find((o: any) => o.type === "creep" && o.user === "2");
      if (!invader) {
        invaderGoneAt = t;
        break;
      }
    }

    assert.isNotNull(invaderGoneAt, "the invader should die to tower fire within 200 ticks");

    const objs = await helper.server.world.roomObjects("W0N0");
    const tower: any = objs.find((o: any) => o.type === "tower");
    assert.isDefined(tower, "the tower survives");
    assert.isBelow(tower.store.energy, 500, "the tower actually fired (the kill was not a despawn)");

    const endFriendlies = await friendlyCount();
    assert.isAtLeast(endFriendlies, startFriendlies, "no friendly creep died in the window");
  });
});
