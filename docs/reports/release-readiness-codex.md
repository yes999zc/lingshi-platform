# Release Readiness Report (Codex)

Date: 2026-03-13
Scope: Re-evaluation of all `docs/ACCEPTANCE_CRITERIA.md` **[BLOCKER]** items after latest blocker fixes.

## Final Verdict

**NO-GO**

Reason:
1. WebSocket BLOCKER criteria (`AC-WS-01`, `AC-WS-02`, `AC-WS-06`) are still not runtime-verifiable in this environment due socket bind permission failure (`listen EPERM 127.0.0.1`).
2. Release gate scripts that should provide end-to-end evidence (`integration-gate`, lifecycle smoke, settlement stress) currently fail because they attempt unauthenticated `POST /api/tasks` after auth hardening (401), so they no longer provide valid blocker evidence until updated.

## BLOCKER Status Matrix (All Items)

Status legend: **RESOLVED** = criteria currently satisfied with evidence in this run; **UNRESOLVED** = not satisfied; **UNRESOLVED (BLOCKED BY ENV)** = cannot be runtime-validated in current sandbox.

| ID | Status | Evidence (current run) |
|---|---|---|
| AC-RE-01 | **RESOLVED** | `node --test dist/engine/rule-engine.test.js` -> `should load valid config successfully`, `pass 8 fail 0` |
| AC-RE-03 | **RESOLVED** | same command -> `should reject invalid JSON`, `should reject config missing required sections` |
| AC-SM-01 | **RESOLVED** | targeted verifier -> `AC-SM-01 statuses=200/200/200/200` |
| AC-SM-02 | **RESOLVED** | targeted verifier -> `AC-SM-02 status=422` |
| AC-SM-03 | **RESOLVED** | targeted verifier -> `AC-SM-03 status=422` |
| AC-SM-04 | **RESOLVED** | targeted verifier -> `AC-SM-04 status=422` |
| AC-SM-06 | **RESOLVED** | targeted verifier -> `AC-SM-06 statuses=201/409`; `npm test` includes `AC-SM-06: concurrent bid race` passing |
| AC-LD-01 | **RESOLVED** | targeted verifier -> `AC-LD-01 amount=108` (executor credited on settle) |
| AC-LD-02 | **RESOLVED** | targeted verifier -> `AC-LD-02 balance=370` (poster debited after task create from initial 500 with prior 10 escrowed create in same run) |
| AC-LD-03 | **RESOLVED** | targeted verifier -> `AC-LD-03 status=409` on duplicate settlement |
| AC-LD-07 | **RESOLVED** | targeted verifier -> `AC-LD-07 status=400 code=AGENT_INSUFFICIENT_BALANCE` |
| AC-SC-01 | **RESOLVED** | targeted verifier -> `AC-SC-01 status=403` |
| AC-SC-02 | **RESOLVED** | targeted verifier -> `AC-SC-02 status=403` |
| AC-SC-04 | **RESOLVED** | targeted verifier -> `AC-SC-04 statuses=201/201/201/429` |
| AC-API-01 | **RESOLVED** | targeted verifier -> `AC-API-01 status=200` |
| AC-API-02 | **RESOLVED** | targeted verifier -> `AC-API-02 status=401` |
| AC-API-04 | **RESOLVED** | targeted verifier -> `AC-API-04 statuses=201/200/200` |
| AC-API-05 | **RESOLVED** | targeted verifier -> `AC-API-05 statuses=201/200` |
| AC-API-06 | **RESOLVED** | targeted verifier -> `AC-API-06 statuses=201/200` |
| AC-WS-01 | **UNRESOLVED (BLOCKED BY ENV)** | `node --import tsx scripts/integration-gate.ts` -> `ws-hardening ... listen EPERM: operation not permitted 127.0.0.1` |
| AC-WS-02 | **UNRESOLVED (BLOCKED BY ENV)** | same WS bind failure prevents runtime push-latency verification |
| AC-WS-06 | **UNRESOLVED (BLOCKED BY ENV)** | same WS bind failure prevents disconnect/cleanup runtime verification |
| AC-DB-01 | **RESOLVED** | `npm run dashboard:build` passes; App contains leaderboard panel (`src/dashboard/src/App.tsx:365`) |
| AC-DB-02 | **RESOLVED** | `npm run dashboard:build` passes; App contains task kanban panel (`src/dashboard/src/App.tsx:387`) |

## Evidence Commands and Outputs

### 1) Full test suite

Command:
```bash
npm test
```

Output (excerpt):
```text
✔ AC-SM-06: concurrent bid race
  ✔ should reject duplicate bid from same agent with 409
  ✔ should allow concurrent bids from different agents
✔ tasks API balance escrow
  ✔ debits poster balance and writes task escrow ledger entry at task creation
  ✔ rejects task creation when poster balance is insufficient with expected status and error code
ℹ tests 46
ℹ pass 46
ℹ fail 0
```

### 2) Dashboard build gate

Command:
```bash
npm run dashboard:build
```

Output:
```text
vite v6.4.1 building for production...
✓ 584 modules transformed.
✓ built in 1.93s
```

### 3) Rule engine blocker checks

Command:
```bash
node --test dist/engine/rule-engine.test.js
```

Output:
```text
✔ should load valid config successfully
✔ should reject config missing required sections
✔ should reject config with invalid JSON
ℹ pass 8
ℹ fail 0
```

### 4) Targeted blocker verifier (auth-aware API checks)

Command:
```bash
node --import tsx <<'TS' 2>&1 | rg '^AC-'
# in-memory createServer + app.inject checks for blocker endpoints
TS
```

Output:
```text
AC-API-01 status=200
AC-API-05 statuses=201/200
AC-SM-02 status=422
AC-API-04 statuses=201/200/200
AC-API-02 status=401
AC-LD-02 balance=370
AC-LD-07 status=400 code=AGENT_INSUFFICIENT_BALANCE
AC-SM-06 statuses=201/409
AC-API-06 statuses=201/200
AC-SM-03 status=422
AC-SC-01 status=403
AC-SC-02 status=403
AC-SM-01 statuses=200/200/200/200
AC-LD-01 amount=108
AC-LD-03 status=409
AC-SM-04 status=422
AC-SC-04 statuses=201/201/201/429
```

### 5) Integration gate (current script behavior)

Command:
```bash
node --import tsx scripts/integration-gate.ts 2>&1 || true
```

Output:
```text
[PASS] rate-limit-pruning
[PASS] health
[PASS] agent
[FAIL] task-lifecycle ... 401 !== 201
[FAIL] ledger-idempotency ... task id must be initialized
[FAIL] protected-error-envelope ... task id must be initialized
[FAIL] ws-hardening ... listen EPERM: operation not permitted 127.0.0.1
integration gate FAILED (3/7)
```

### 6) Lifecycle scripts (current script behavior)

Command:
```bash
node --import tsx scripts/task-lifecycle-smoke.ts 2>&1 || true
node --import tsx scripts/lifecycle-settlement-stress.ts 2>&1 || true
```

Output:
```text
task-lifecycle-smoke.ts: task creation should succeed
401 !== 201

lifecycle-settlement-stress.ts: task creation should succeed
401 !== 201
```

## Notes

- Latest blocker fixes for `AC-SM-06`, `AC-LD-02`, and `AC-LD-07` are confirmed effective by current runtime checks and passing tests.
- WebSocket blocker checks remain blocked by sandbox networking limits, not by functional assertions in the API-only test path.
- Script maintenance gap: `scripts/integration-gate.ts`, `scripts/task-lifecycle-smoke.ts`, and `scripts/lifecycle-settlement-stress.ts` still assume unauthenticated task creation and now fail with `401`; this should be updated to keep release gates trustworthy.
