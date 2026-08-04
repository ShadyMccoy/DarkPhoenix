import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * THE RECYCLE-REASON RATCHET (owner 2026-08-03: "I wanna make sure those are
 * legit - what's actually the cause and does it hold up to scrutiny").
 *
 * Every site that sets `memory.recycling = true` must stamp
 * `memory.recycleReason` within the next few lines - the reason is what the
 * loss meter's tombstoneRecycledByReason attributes, so an unstamped site
 * silently degrades the account's answer back to one opaque bucket (the
 * "unstamped" bucket exists to catch exactly this, and this test keeps it
 * empty by construction). Same shape as the spawn-authority cop: a source
 * scan, so a new flag site fails HERE with a message instead of shipping
 * unattributed.
 */
describe("recycle-reason ratchet (every flag site stamps its WHY)", () => {
  it("every `recycling = true` in src/corps has a recycleReason stamp within 3 lines", () => {
    const dir = path.join(__dirname, "../../../src/corps");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("recycling = true")) return;
        const windowText = lines.slice(i, i + 4).join("\n");
        if (!windowText.includes("recycleReason")) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders, `flag sites missing a recycleReason stamp: ${offenders.join(", ")}`).to.deep.equal([]);
  });

  /**
   * Upgraders are ATTRITION-ONLY (owner 2026-08-03): the excess-shed cull is
   * retired - an over-target upgrader fleet shrinks by natural EOL. A
   * recycling flag reappearing in UpgradingCorp is the revocation class
   * coming back; it fails here with the doctrine attached.
   */
  it("UpgradingCorp sets NO recycling flag - upgraders die out, never culled", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/corps/UpgradingCorp.ts"), "utf8");
    expect(src.includes("recycling = true"), "upgraders are attrition-only").to.equal(false);
  });
});
