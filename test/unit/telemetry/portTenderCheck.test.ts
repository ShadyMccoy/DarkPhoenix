import { expect } from "chai";
import { PORT_BUFFER_PINNED_SHARE, PortBufferSample, runWatchdogs } from "../../../src/telemetry/watchdogs";

/**
 * SPEC 57 - THE TENDER CHECK.
 *
 * Spec 54 started from a container standing at 2000/2000 for over 1,800 ticks
 * with both of a hauler's escape hatches shut. The energy was not lost to a
 * subtle pricing error; it was sitting in plain sight in a structure nobody
 * asked about. Five diagnoses that week ended at "I cannot tell from
 * telemetry".
 *
 * Why a RATE meter could never have caught it: `toHubRate`, `portDeposits`,
 * `portFallbacks` all read a jammed port and a quiet port the same way - as a
 * small number. A STOCK against its own capacity cannot be read that way, and
 * neither can "how many creeps are drained this thing".
 */
describe("the tender check (spec 57)", () => {
  const healthy = {
    tick: 10000,
    rcl: 7,
    lastSpawnTick: 9990,
    minDowngradeTicks: 100000,
    bucket: 10000,
    errRowsInWindow: 0
  };
  const kinds = (input: Parameters<typeof runWatchdogs>[0]): string[] => runWatchdogs(input).map(a => a.kind);
  const buffer = (over: Partial<PortBufferSample> = {}): PortBufferSample => ({
    where: "W43N23 44,12",
    energy: 0,
    capacity: 2000,
    tenders: 1,
    ...over
  });

  it("is silent on a healthy colony with no ports at all", () => {
    expect(kinds(healthy)).to.deep.equal([]);
  });

  it("is silent on a port whose buffer is cycling under a tender", () => {
    expect(kinds({ ...healthy, portBuffers: [buffer({ energy: 516, tenders: 1 })] })).to.deep.equal([]);
  });

  it("FIRES on a buffer holding energy with no tender - the t72862894 signature", () => {
    const alerts = runWatchdogs({ ...healthy, portBuffers: [buffer({ energy: 2000, tenders: 0 })] });
    expect(alerts.map(a => a.kind)).to.deep.equal(["port-untended"]);
    expect(alerts[0].message).to.contain("44,12");
    expect(alerts[0].message, "the alert must say what is wrong, not just that something is").to.contain("NO tender");
  });

  it("stays quiet about an EMPTY untended buffer - nothing is stranded there", () => {
    // A port whose container was just built and has taken no drops yet is not
    // an incident. Alarming on it would train the reader to ignore the alarm.
    expect(kinds({ ...healthy, portBuffers: [buffer({ energy: 0, tenders: 0 })] })).to.deep.equal([]);
  });

  it("FIRES on a buffer pinned full even WITH a tender - the drain is undersized", () => {
    const alerts = runWatchdogs({ ...healthy, portBuffers: [buffer({ energy: 2000, tenders: 1 })] });
    expect(alerts.map(a => a.kind)).to.deep.equal(["port-untended"]);
    expect(alerts[0].message).to.contain("2000/2000");
  });

  it("draws the pinned line at PORT_BUFFER_PINNED_SHARE of the buffer's OWN capacity", () => {
    const cap = 2000;
    const just = Math.ceil(cap * PORT_BUFFER_PINNED_SHARE);
    expect(kinds({ ...healthy, portBuffers: [buffer({ energy: just, capacity: cap })] })).to.deep.equal([
      "port-untended"
    ]);
    expect(kinds({ ...healthy, portBuffers: [buffer({ energy: just - 1, capacity: cap })] })).to.deep.equal([]);
  });

  it("does not judge fullness it cannot measure (capacity unknown)", () => {
    expect(kinds({ ...healthy, portBuffers: [buffer({ energy: 5000, capacity: 0, tenders: 2 })] })).to.deep.equal([]);
  });

  it("reports EVERY offending port, not just the first - two ports fail independently", () => {
    const alerts = runWatchdogs({
      ...healthy,
      portBuffers: [
        buffer({ where: "W43N23 44,12", energy: 2000, tenders: 0 }),
        buffer({ where: "W43N23 43,38", energy: 1900, tenders: 1 })
      ]
    });
    expect(alerts).to.have.length(2);
    expect(alerts[0].message).to.contain("44,12");
    expect(alerts[1].message).to.contain("43,38");
  });

  it("never displaces the existing rules - a stalled spawn still alarms alongside it", () => {
    const alerts = runWatchdogs({
      ...healthy,
      lastSpawnTick: 0,
      portBuffers: [buffer({ energy: 2000, tenders: 0 })]
    });
    expect(alerts.map(a => a.kind)).to.have.members(["no-spawn", "port-untended"]);
  });
});
