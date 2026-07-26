/**
 * probe-mockup.js - 30-second smoke check that the screeps mockup actually
 * EXECUTES user scripts in this environment.
 *
 * Why not just run a grid cell? Because the failure mode this guards against
 * is INVISIBLE there: when @screeps/driver's runtime.bundle.js is missing
 * (see scripts/setup-test-env.sh), every user script dies at load and
 * screeps-server-mockup's console parser drops the `error` field of the
 * console event - bots silently "do nothing" and every cell just times out.
 * This probe subscribes to the RAW console channel, so that error (and any
 * other script-load failure) is printed instead of swallowed.
 *
 * Usage: node scripts/probe-mockup.js    (exit 0 = scripts run; 1 = broken)
 */
/* eslint-disable */
const { ScreepsServer } = require("screeps-server-mockup");
const path = require("path");
const fs = require("fs");

(async () => {
  const serverPath = path.resolve(__dirname, "..", "server", "probe-31000");
  fs.rmSync(serverPath, { recursive: true, force: true });
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port: 31000, path: serverPath, logdir: path.join(serverPath, "logs") });
  let ok = false;
  try {
    await server.world.reset();
    await server.world.stubWorld();
    const bot = await server.world.addBot({
      username: "probe",
      room: "W0N1",
      x: 25,
      y: 25,
      modules: { main: "module.exports.loop = function () { console.log('TICK ' + Game.time); };" },
    });
    const lines = [];
    bot.on("console", (logs) => {
      for (const l of logs || []) lines.push(l);
    });
    // RAW channel: the mockup's own parser drops the `error` field.
    const { pubsub } = server.common.storage;
    await pubsub.subscribe(`user:${bot.id}/console`, (event) => {
      try {
        const parsed = JSON.parse(event);
        if (parsed.error) console.error("SCRIPT ERROR (hidden by the mockup):\n" + parsed.error);
      } catch {
        /* ignore */
      }
    });
    await server.start();
    for (let i = 0; i < 5; i++) await server.tick();
    ok = lines.length > 0;
    console.log(ok ? `OK - bot script executed (${lines.length} console lines)` : "BROKEN - bot script never ran (see error above; run scripts/setup-test-env.sh)");
  } catch (e) {
    console.error("PROBE ERROR:", e);
  } finally {
    await server.stop();
    fs.rmSync(serverPath, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  }
})();
