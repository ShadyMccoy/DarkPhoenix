import { expect } from "chai";
import "../../../src/types/Memory"; // load CreepMemory/Memory augmentation
import { pickSinkByAllocation } from "../../../src/corps/CarryCorp";

describe("pickSinkByAllocation", () => {
  it("delivers to the spawn when there is no controller route", () => {
    const assignments = [{ toId: "spawn-abc", flowRate: 5 }];
    expect(pickSinkByAllocation(assignments, {})).to.equal("spawn");
  });

  it("delivers to the controller when that is the only route", () => {
    const assignments = [{ toId: "controller-abc", flowRate: 5 }];
    expect(pickSinkByAllocation(assignments, {})).to.equal("controller");
  });

  it("prefers whichever sink is furthest behind its allocated share", () => {
    const assignments = [
      { toId: "spawn-abc", flowRate: 3 },
      { toId: "controller-abc", flowRate: 1 },
    ];
    // Controller has had more than its 1:3 share -> spawn is furthest behind.
    expect(pickSinkByAllocation(assignments, { spawn: 0, controller: 1 })).to.equal("spawn");
    // Spawn has had its full share but controller none -> controller is behind.
    expect(pickSinkByAllocation(assignments, { spawn: 3, controller: 0 })).to.equal("controller");
  });

  it("routes to construction when it has allocated flow", () => {
    const assignments = [
      { toId: "spawn-abc", flowRate: 1 },
      { toId: "construction-xyz", flowRate: 2 },
    ];
    // Construction (0/2) is further behind than spawn (0/1) once spawn is served.
    expect(pickSinkByAllocation(assignments, { spawn: 1, construction: 0 })).to.equal("construction");
  });

  it("converges to the allocation ratio over many loads (3:1 spawn:controller)", () => {
    const assignments = [
      { toId: "spawn-abc", flowRate: 3 },
      { toId: "controller-abc", flowRate: 1 },
    ];
    const delivered: { [k: string]: number } = {};
    for (let i = 0; i < 400; i++) {
      const pick = pickSinkByAllocation(assignments, delivered);
      delivered[pick] = (delivered[pick] ?? 0) + 1;
    }
    const ratio = (delivered.spawn ?? 0) / (delivered.controller ?? 1);
    // Should be close to 3:1.
    expect(ratio).to.be.greaterThan(2.5);
    expect(ratio).to.be.lessThan(3.5);
  });

  it("sums multiple routes to the same sink class", () => {
    const assignments = [
      { toId: "controller-a", flowRate: 2 },
      { toId: "controller-b", flowRate: 2 },
    ];
    expect(pickSinkByAllocation(assignments, { controller: 0 })).to.equal("controller");
  });
});
