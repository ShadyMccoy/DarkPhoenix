import { expect } from "chai";
import { runTerminals } from "../../../src/execution/TerminalRunner";
import {
  TERMINAL_MIN_SEND,
  terminalDeliveredFraction,
  terminalStageTarget,
  TERMINAL_STAGE_TICKS
} from "../../../src/economy/primitives";

/**
 * THE TERMINAL EXECUTOR (spec 58 phase 3). The plan gates and prices the
 * cross-hub edge; the runner only FOLLOWS Memory.terminalTransfers. These pin
 * the follow rules: send only what the stock can afford WITH its own fee
 * (amount + fee <= stock, via terminalDeliveredFraction), never past the
 * destination terminal's free space, never under the engine minimum, one send
 * per cooldown, and a clean no-op when no transfers are published - the state
 * of every live world until terminals exist.
 */
describe("execution/TerminalRunner", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;
  let sends: Array<{ from: string; amount: number; to: string }>;

  const terminalAt = (roomName: string, energy: number, opts: { cooldown?: number; free?: number } = {}) => ({
    my: true,
    cooldown: opts.cooldown ?? 0,
    store: {
      energy,
      [`${"energy"}`]: energy,
      getFreeCapacity: () => opts.free ?? 300_000 - energy
    },
    send: (_res: string, amount: number, to: string) => {
      sends.push({ from: roomName, amount, to });
      return 0; // OK
    }
  });

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    sends = [];
    g.Game = {
      time: 0,
      rooms: {},
      map: { getRoomLinearDistance: (_a: string, _b: string, _continuous?: boolean) => 1 }
    };
    g.Memory = {};
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  it("no published transfers -> no sends, no reads (every live world today)", () => {
    g.Game.rooms = { W0N0: { terminal: terminalAt("W0N0", 50_000) } };
    runTerminals();
    expect(sends).to.have.length(0);
  });

  it("sends the largest amount whose OWN FEE still fits the stock, to the planned destination", () => {
    g.Memory.terminalTransfers = { W0N0: [{ to: "W1N0", rate: 20 }] };
    g.Game.rooms = {
      W0N0: { terminal: terminalAt("W0N0", 10_000) },
      W1N0: { terminal: terminalAt("W1N0", 0) }
    };
    runTerminals();
    expect(sends).to.have.length(1);
    const expected = Math.floor(10_000 * terminalDeliveredFraction(1));
    expect(sends[0]).to.deep.equal({ from: "W0N0", amount: expected, to: "W1N0" });
    // the invariant behind the formula: amount + fee never exceeds the stock
    expect(expected * (1 + (1 - terminalDeliveredFraction(1)) / terminalDeliveredFraction(1))).to.be.at.most(
      10_000 + 1
    );
  });

  it("caps at the DESTINATION terminal's free space (both hubs are ours - a live read)", () => {
    g.Memory.terminalTransfers = { W0N0: [{ to: "W1N0", rate: 20 }] };
    g.Game.rooms = {
      W0N0: { terminal: terminalAt("W0N0", 50_000) },
      W1N0: { terminal: terminalAt("W1N0", 0, { free: 700 }) }
    };
    runTerminals();
    expect(sends).to.have.length(1);
    expect(sends[0].amount).to.equal(700);
  });

  it("respects the cooldown and the engine minimum", () => {
    g.Memory.terminalTransfers = { W0N0: [{ to: "W1N0", rate: 20 }], W2N0: [{ to: "W1N0", rate: 20 }] };
    g.Game.rooms = {
      W0N0: { terminal: terminalAt("W0N0", 50_000, { cooldown: 5 }) }, // cooling: no send
      W2N0: { terminal: terminalAt("W2N0", TERMINAL_MIN_SEND - 10) }, // under minimum: no send
      W1N0: { terminal: terminalAt("W1N0", 0) }
    };
    runTerminals();
    expect(sends).to.have.length(0);
  });

  it("one send per terminal per tick, largest-rate route first", () => {
    g.Memory.terminalTransfers = {
      W0N0: [
        { to: "W1N0", rate: 5 },
        { to: "W2N0", rate: 25 }
      ]
    };
    g.Game.rooms = {
      W0N0: { terminal: terminalAt("W0N0", 20_000) },
      W1N0: { terminal: terminalAt("W1N0", 0) },
      W2N0: { terminal: terminalAt("W2N0", 0) }
    };
    runTerminals();
    expect(sends).to.have.length(1);
    expect(sends[0].to, "the bigger route goes first").to.equal("W2N0");
  });

  it("a full destination falls through to the next route instead of wedging the sender", () => {
    g.Memory.terminalTransfers = {
      W0N0: [
        { to: "W2N0", rate: 25 }, // preferred but FULL
        { to: "W1N0", rate: 5 }
      ]
    };
    g.Game.rooms = {
      W0N0: { terminal: terminalAt("W0N0", 20_000) },
      W1N0: { terminal: terminalAt("W1N0", 0) },
      W2N0: { terminal: terminalAt("W2N0", 0, { free: 0 }) }
    };
    runTerminals();
    expect(sends).to.have.length(1);
    expect(sends[0].to).to.equal("W1N0");
  });

  it("uses the CONTINUOUS distance form (the calcTransactionCost contract)", () => {
    let sawContinuous: boolean | undefined;
    g.Game.map = {
      getRoomLinearDistance: (_a: string, _b: string, continuous?: boolean) => {
        sawContinuous = continuous;
        return 1;
      }
    };
    g.Memory.terminalTransfers = { W0N0: [{ to: "W1N0", rate: 20 }] };
    g.Game.rooms = {
      W0N0: { terminal: terminalAt("W0N0", 10_000) },
      W1N0: { terminal: terminalAt("W1N0", 0) }
    };
    runTerminals();
    expect(sawContinuous, "the wrap-around form is the engine's fee distance").to.equal(true);
  });
});

describe("economy/primitives - terminalStageTarget (the hub post's ONE direction law)", () => {
  it("stages one solve cadence of planned outbound flow", () => {
    expect(terminalStageTarget(20)).to.equal(20 * TERMINAL_STAGE_TICKS);
  });
  it("floors at one engine-minimum send so a tiny rate still stages something sendable", () => {
    expect(terminalStageTarget(0.5)).to.equal(TERMINAL_MIN_SEND);
  });
  it("no outbound plan -> target 0: a pure destination hub drains everything (leg 3)", () => {
    expect(terminalStageTarget(0)).to.equal(0);
    expect(terminalStageTarget(-3)).to.equal(0);
  });
});
