import {assert} from "chai";
import {helper, hookConsole} from "./helper";

describe("main", () => {
  // Scoped to THIS suite: root-level hooks would run around every test in
  // every loaded file (mocha hoists them to the root suite) and cross-corrupt
  // the shared server helper between files.
  before(() => hookConsole());
  beforeEach(async () => helper.beforeEach());
  afterEach(async () => helper.afterEach());

  it("runs a server and matches the game tick", async function () {
    for (let i = 1; i < 10; i += 1) {
      assert.equal(await helper.server.world.gameTime, i);
      await helper.server.tick();
    }
  });

  it("writes and reads to memory", async function () {
    await helper.player.console(`Memory.foo = 'bar'`);
    await helper.server.tick();
    const memory = JSON.parse(await helper.player.memory);
    assert.equal(memory.foo, 'bar');
  });
});
