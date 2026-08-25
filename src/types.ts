import type { Plan } from "./plan";
import type { LedgerMemory } from "./ledger";

declare global {
  interface CreepMemory {
    job?: string;
    d?: boolean;
  }

  interface Memory {
    plan?: Plan;
    ledger?: LedgerMemory;
  }
}

export {};
