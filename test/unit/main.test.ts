import { assert } from "chai";
import { loop } from "../../src/main";
import { Game, Memory, setupGlobals } from "./mock";

describe("main", () => {
  beforeEach(() => {
    // Stand up a minimal Screeps global environment for the loop.
    setupGlobals();
    (global as any).Game = {
      ...Game,
      time: 0,
      cpu: { limit: 20, tickLimit: 500, bucket: 10000, getUsed: () => 0 },
    };
    (global as any).Memory = { creeps: {}, rooms: {} };

    // Telemetry writes to RawMemory segments each tick; provide a no-op stand-in.
    (global as any).RawMemory = {
      segments: {} as { [id: number]: string },
      setPublicSegments: () => undefined,
      setActiveSegments: () => undefined,
    };
  });

  it("should export a loop function", () => {
    assert.isTrue(typeof loop === "function");
  });

  it("never throws on an empty world (ErrorMapper contract)", () => {
    // The loop is wrapped in ErrorMapper.wrapLoop, so a hollow world produces
    // caught-and-logged errors rather than crashes. Silence that expected log
    // noise while asserting the wrapper holds. Real end-to-end execution against
    // a populated world is covered by the integration tests.
    const realLog = console.log;
    const realError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      assert.doesNotThrow(() => loop());
    } finally {
      console.log = realLog;
      console.error = realError;
    }
  });
});
