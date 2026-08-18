/**
 * types.ts — ambient Memory typing for the v2 bot.
 *
 * The whole persistent state, by law (REBOOT.md): the cached plan, per-creep
 * job assignments, and the fidelity ledger. Anything else in Memory is a
 * design smell — a global reset must be a non-event.
 */
import type { Plan } from "./plan";
import type { LedgerMemory } from "./ledger";

declare global {
  interface CreepMemory {
    /** Assigned job id (plan.jobs[].id). Written at spawn or reassignment. */
    job?: string;
    /** Workman hysteresis bit: true = delivering, false = harvesting. The
     * one bit of runner state — everything else re-derives per tick. */
    d?: boolean;
  }

  interface Memory {
    plan?: Plan;
    ledger?: LedgerMemory;
  }
}

export {};
