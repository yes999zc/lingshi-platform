# Release Unblock: Integration Gate Script Fix (Codex)

**Date**: 2026-03-13  
**Command**: `node --import tsx scripts/integration-gate.ts`  
**Result**: ✅ `integration gate PASSED (7/7)`

## Root Cause

`ws-hardening` assumed it could bind a real TCP port (`app.listen({ host: "127.0.0.1", port: 0 })`). In this execution environment, socket bind is blocked (`listen EPERM`), so the check failed at runtime before websocket auth semantics were exercised.

This was an **environment/runtime coupling issue**, not an API auth regression.

## Before/After Snippets

### Before (hard dependency on real network bind)

```ts
await app.listen({
  host: "127.0.0.1",
  port: 0
});

const baseWsUrl = `ws://127.0.0.1:${address.port}/ws`;
await expectWebSocketHandshakeRejected(baseWsUrl, [401]);
```

### After (minimal fallback when bind is denied)

```ts
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
} catch (error) {
  if (error instanceof Error && /listen\s+(EPERM|EACCES)/.test(error.message)) {
    return runWsHardeningWithoutListen(app.server, state.token, state.agentId);
  }
  throw error;
}
```

Fallback path uses in-memory upgrade simulation to validate:
- missing token -> `401`
- invalid token burst -> `401/403`
- valid token upgrade + `connected` event
- per-agent connection cap -> `403`
- heartbeat cleanup (no pong)
- upgrade rate-limit burst includes `429`

## Failing Reason Taxonomy

1. **Runtime environment constraint**
- Symptom: `listen EPERM: operation not permitted`
- Scope: `ws-hardening` only
- Layer: OS/sandbox permissions

2. **Test harness transport coupling**
- Symptom: integration check depended on external socket capability
- Scope: script orchestration, not business auth logic
- Layer: test method choice (network-bound vs in-memory)

3. **Auth semantics status**
- Current protected endpoint and websocket auth semantics are consistent with expectations once transport dependency is handled.

## Comparative Analysis vs Likely Claude Approach

Based on the existing Claude report (`docs/reports/release-unblock-integration-scripts-claude.md`), likely Claude fix focus:
- add missing auth headers to protected calls
- adjust economic preconditions (agent balance)
- keep real `listen` websocket validation path

Codex fix focus in this run:
- preserve current auth/economic semantics
- remove environment-specific flake by adding a permission-aware fallback for websocket hardening checks

Practical difference:
- Claude-style fix addresses **semantic/API drift** failures.
- This Codex fix addresses **execution-environment** failures while still asserting websocket auth/cap/rate-limit behavior.

## Verification Output

Observed run after fix:

```text
[PASS] rate-limit-pruning
[PASS] health
[PASS] agent
[PASS] task-lifecycle
[PASS] ledger-idempotency
[PASS] protected-error-envelope
[PASS] ws-hardening - websocket hardening validated via in-memory upgrade simulation (no listen permissions)
integration gate PASSED (7/7)
```

## Final Recommendation

Keep both paths:
1. Real network websocket hardening path (preferred in unrestricted CI/dev).
2. In-memory fallback for restricted sandboxes (`EPERM`/`EACCES`).

This preserves auth-coverage intent and removes false negatives caused by host networking restrictions.
