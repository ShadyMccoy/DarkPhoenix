# Design: BankCorp Refactor

**Status:** Proposed
**Author:** Claude
**Created:** 2025-12-22
**Related:** [ECONOMIC_FRAMEWORK.md](../ECONOMIC_FRAMEWORK.md), [market-architecture.md](../market-architecture.md)

## Overview

Convert the `InvestmentPlanner` into a proper `BankCorp` that participates in the economic system as a first-class Corp entity.

## Motivation

Currently, the investment system is a standalone planning layer:

```
Colony (treasury) → InvestmentPlanner → InvestmentContracts → Goal Corps
```

This creates architectural inconsistency:
- InvestmentPlanner is not a Corp, but manages capital like one
- Treasury is separate from the Corp balance system
- Investment contracts are separate from the standard contract system
- ROI tracking is custom instead of using `Corp.getActualROI()`

## Proposed Architecture

```
Colony (mints to) → BankCorp (balance) → Standard Contracts → Goal Corps
```

BankCorp becomes the "treasury" - a Corp whose balance IS the colony's investable capital.

## Design

### BankCorp Properties

```typescript
interface BankCorpState extends SerializedCorp {
  type: "bank";

  // Inherited from Corp
  balance: number;           // = treasury (investable capital)
  totalRevenue: number;      // returns from investments
  totalCost: number;         // capital deployed

  // Bank-specific
  investmentPortfolio: InvestmentContract[];
  activeChains: CapitalChain[];
  performanceHistory: InvestmentPerformance[];
  lastInvestmentTick: number;
}
```

### BankCorp Behavior

| Method | Behavior |
|--------|----------|
| `sells()` | Empty (or `investment-capital` offers - TBD) |
| `buys()` | Empty (bank doesn't buy resources) |
| `work()` | Run investment planning, distribute capital |
| `getPosition()` | Primary spawn room position |
| `getMargin()` | Lower margin = more capital available to invest |

### Capital Flow

1. **Minting:** Colony mints credits → BankCorp.balance
2. **Investment:** BankCorp.plan() creates InvestmentContracts
3. **Distribution:** Capital flows to goal corps via CapitalBudget
4. **Returns:** When goals produce, BankCorp.recordRevenue()
5. **ROI:** Tracked via standard Corp.getActualROI()

### Integration with Existing Systems

```
┌─────────────────────────────────────────────────────────┐
│                        Colony                            │
│  ┌──────────────┐                                       │
│  │ CreditLedger │──mint()──▶ BankCorp.balance          │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                       BankCorp                           │
│  ┌──────────────────┐    ┌─────────────────────────┐   │
│  │ InvestmentPlanner │───▶│ InvestmentContracts     │   │
│  └──────────────────┘    └─────────────────────────┘   │
│                                      │                   │
│                                      ▼                   │
│                          ┌─────────────────────────┐    │
│                          │ CapitalBudget Registry  │    │
│                          └─────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                     Goal Corps                           │
│  UpgradingCorp ◄── capital ── BankCorp                  │
│  BuildingCorp  ◄── capital ── BankCorp                  │
└─────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Core BankCorp (MVP)

1. **Add to CorpType** (`src/corps/Corp.ts`)
   ```typescript
   export type CorpType = ... | "bank";
   ```

2. **Create BankCorpState** (`src/corps/CorpState.ts`)
   ```typescript
   export interface BankCorpState extends SerializedCorp {
     type: "bank";
     position: Position;
     investmentPortfolio: InvestmentContract[];
     // ... other fields
   }
   ```

3. **Create BankCorp class** (`src/corps/BankCorp.ts`)
   - Extend Corp base class
   - Own InvestmentPlanner instance
   - Implement work() to run planning
   - Move InvestmentPhase logic here

4. **Add projection** (`src/planning/projections.ts`)
   ```typescript
   export function projectBank(state: BankCorpState, tick: number): CorpProjection {
     return EMPTY_PROJECTION; // Bank works via contracts, not market offers
   }
   ```

### Phase 2: Treasury Integration

5. **Update Colony** (`src/colony/Colony.ts`)
   - Mint credits to BankCorp instead of treasury
   - Or have BankCorp pull from treasury

6. **Update InvestmentPhase** (`src/orchestration/InvestmentPhase.ts`)
   - Delegate to BankCorp.work()
   - Or remove entirely

### Phase 3: Serialization

7. **Add to Memory** (`src/types/Memory.ts`)
   ```typescript
   bankCorp?: SerializedBankCorp;
   ```

8. **Implement serialize/deserialize** in BankCorp

## Files Changed

| File | Change | Lines |
|------|--------|-------|
| `src/corps/Corp.ts` | Add "bank" to CorpType | ~2 |
| `src/corps/CorpState.ts` | Add BankCorpState, factory | ~50 |
| `src/corps/BankCorp.ts` | **New file** | ~300 |
| `src/planning/projections.ts` | Add projectBank() | ~15 |
| `src/types/Memory.ts` | Add serialization | ~5 |
| `src/corps/index.ts` | Export BankCorp | ~5 |
| `src/orchestration/InvestmentPhase.ts` | Simplify/remove | -50 |

**Total:** ~350 new lines, ~50 removed

## Design Decisions

### Q: Should BankCorp generate market offers?

**Decision: No (for now)**

The existing InvestmentContract system already handles capital allocation. Making BankCorp post "sell capital" offers would require:
- New resource type
- Market matching for capital
- More complexity

Keep it simple: BankCorp works through contracts, not market offers.

### Q: Can there be multiple banks?

**Decision: Single bank per colony (for now)**

The `bankId` field in InvestmentContract supports multiple banks, but:
- Single bank simplifies treasury management
- Can add multi-bank support later if needed

### Q: How does BankCorp get capital?

**Decision: Direct minting**

Colony.ledger.mint() credits go to BankCorp.balance instead of separate treasury. This:
- Unifies the money model
- Makes bank subject to same economics as other corps
- Allows bank margin to affect investment rates

## Benefits

1. **Unified Architecture** - Everything is a Corp
2. **Standard ROI** - Uses `Corp.getActualROI()`
3. **Margin Dynamics** - Wealthy bank = lower rates = more investment
4. **Pruning** - Bankrupt bank = investment system fails (signals problems)
5. **Testability** - BankCorp can be unit tested like other corps

## Risks

1. **Refactoring Scope** - Touches multiple files
2. **Migration** - Existing games need migration path
3. **Complexity** - Bank is conceptually different from physical corps

## Migration

For existing games:
1. On first tick after deploy, create BankCorp with balance = treasury
2. Transfer active investments to BankCorp
3. Clear old investment state

## Testing

1. Unit tests for BankCorp class
2. Integration test: mint → invest → goal produces → ROI tracked
3. Telemetry test against real data (extend existing test)

## Open Questions

1. Should bank have a physical position or be "virtual"?
2. How to handle bank going bankrupt? (stop investing? respawn?)
3. Should bank margin affect investment rates directly?

## References

- Current implementation: `src/planning/InvestmentPlanner.ts`
- Investment contracts: `src/market/InvestmentContract.ts`
- Capital budgets: `src/market/CapitalBudget.ts`
- Investment phase: `src/orchestration/InvestmentPhase.ts`
