# Release Unblock: Integration Gate Script Fix

**Date**: 2026-03-13
**Author**: Claude (Architecture Lead)
**Status**: ✅ RESOLVED

## Problem

The `scripts/integration-gate.ts` script was failing with 3/7 checks passing. The root cause was that task creation now requires authentication, but the integration script was not providing auth headers for the task creation call.

Additionally, the agent was registered with insufficient balance (10 lingshi) to post a task with 120 lingshi bounty.

## Changes Made

### 1. Added Authentication to Task Creation (Line 488-498)
```typescript
const createTaskResponse = await app.inject({
  method: "POST",
  url: "/api/tasks",
  headers: authHeader,  // ← Added this line
  payload: {
    title: "Integration lifecycle task",
    description: "Lifecycle matrix coverage",
    complexity: 3,
    bounty_lingshi: 120,
    required_tags: ["analysis"]
  }
});
```

### 2. Increased Agent Initial Balance (Line 420-428)
```typescript
const registerResponse = await app.inject({
  method: "POST",
  url: "/api/agents/register",
  payload: {
    name: "Integration Agent",
    capability_tags: ["analysis", "delivery"],
    initial_lingshi: 150  // ← Changed from 10 to 150
  }
});
```

## Verification

Command executed:
```bash
node --import tsx scripts/integration-gate.ts
```

### Results: ✅ ALL CHECKS PASSED (7/7)

```
Running integration gate checks...
[PASS] rate-limit-pruning (0ms) - bounded key tracking retained rate-limit behavior and envelope
[PASS] health (6ms) - health endpoint returned status=ok
[PASS] agent (4ms) - registered and pinged agent 73ac14a3-eaf9-4bb4-b878-b86e823c9ffb
[PASS] task-lifecycle (5ms) - task f58177ed-5194-4d61-8d22-bb99baa8b9e3 reached settled state
[PASS] ledger-idempotency (1ms) - duplicate settle blocked and ledger remained single-entry
[PASS] protected-error-envelope (0ms) - protected endpoint auth failures returned consistent error envelope
[PASS] ws-hardening (346ms) - websocket auth, cap, keepalive cleanup, and upgrade rate limiting validated on port 57801
integration gate PASSED (7/7)
```

## Impact

- Integration gate script now validates authenticated task creation flow
- All 7 integration checks pass successfully
- Release blocker removed
- Script execution time: ~362ms total

## Files Modified

- `scripts/integration-gate.ts` (2 changes)

## Next Steps

The integration gate is now unblocked and ready for release. All authentication and balance validation checks are working correctly.
