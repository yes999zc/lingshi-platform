# Day 2 Integration Blocker Closure Report

**Date:** 2026-03-13
**Author:** Claude (Architecture Lead)
**Blocker:** `lifecycle-settlement-stress.ts` assertion failure — `109.95 !== 110`

---

## Root Cause

The `settleTask` transaction in `src/api/tasks.ts` credited the winning agent with the bounty payout
but never returned the bid escrow that was deducted when the agent placed their winning bid.

**Escrow flow before fix:**
1. Agent places bid with `bid_stake: 1`, `bid_escrow_pct: 5%` → 0.05 LSP deducted from balance
2. Task assigned → losing bidders' escrows refunded (winning bid explicitly skipped at line 1557–1559)
3. Task settled → bounty credited, **winning bid escrow never returned**

**Balance trace (stress test, winning agent):**
| Event | Delta | Balance |
|---|---|---|
| Register (`initial_lingshi: 10`) | +10 | 10.00 |
| Bid escrow (`bid_stake=1, 5%`) | −0.05 | 9.95 |
| Settlement (bounty=100, score=100) | +100 | 109.95 |
| **Expected** | | **110.00** |

The 0.05 LSP gap is exactly the unreturned escrow.

---

## Fix

**File:** `src/api/tasks.ts` — inside `settleTask` transaction

Added two steps after the bounty credit:
1. Look up the winning bid via `taskRow.assigned_bid_id`
2. If `escrow_amount > 0`, credit it back and insert a `bid_refund` ledger entry

```typescript
// Refund winning bid escrow on successful settlement
if (winningBid && winningBid.escrow_amount > 0) {
  creditAgentBalanceQuery.run({ amount: winningBid.escrow_amount, ... });
  insertLedgerEntryQuery.run({ ..., entry_type: "bid_refund", reason: "bid_escrow_refund", ... });
}
```

No test assertions were changed. The fix corrects the code to match the intended contract.

---

## Evidence

### Before fix

```
AssertionError [ERR_ASSERTION]: winner balance should be credited exactly once
  109.95 !== 110
```

### After fix

```
stress PASS: 8 parallel bids accepted, 1/24 parallel settles applied, v2/legacy idempotency checks confirmed
```

### Full suite results

| Script | Result |
|---|---|
| `scripts/task-lifecycle-smoke.ts` | PASS |
| `scripts/integration-gate.ts` | PASS (7/7) |
| `scripts/lifecycle-settlement-stress.ts` | PASS |
