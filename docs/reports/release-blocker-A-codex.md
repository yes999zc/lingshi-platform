# Release Blocker Sprint A Report (Codex)

Date: 2026-03-13

## Scope
Implemented and verified:
1. AC-LD-02: debit/escrow poster balance at task creation.
2. AC-LD-07: reject task creation when balance is insufficient with correct error code/status.
3. Tests proving both behaviors.
4. `npm test` execution.

## Code Changes
- `src/api/tasks.ts`
  - Added transactional `createTask` flow that:
    - Resolves poster from authenticated bearer token.
    - Debits poster balance by `bounty_lingshi` (escrow) before task insert.
    - Inserts ledger debit entry (`entry_type=task_escrow`, `reason=task_escrow`, negative amount).
    - Rejects insufficient balance with HTTP `400` + `AGENT_INSUFFICIENT_BALANCE`.
  - Updated `POST /api/tasks` to require auth (`preHandler: [auth, rateLimit]`) and use the transactional flow.
  - Included `poster_agent_id` and `escrow_amount` in `task.created` event payload for observability.
  - Kept bid creation response typing stable by explicitly using success variant before publish/response.

- `src/api/tasks.test.ts` (new)
  - Added test: poster balance is debited and `task_escrow` ledger entry is written at task creation.
  - Added test: insufficient balance returns HTTP `400` + `AGENT_INSUFFICIENT_BALANCE`, with no persisted task and unchanged balance.

- `src/api/concurrent-bid.test.ts`
  - Updated agent registrations to include `initial_lingshi` so existing concurrent-bid tests remain valid under current agent validation and new task-create economics.

## Verification Evidence
Command run:

```bash
npm test
```

Observed relevant passing evidence:
- `✔ debits poster balance and writes task escrow ledger entry at task creation`
- `✔ rejects task creation when poster balance is insufficient with expected status and error code`
- Final summary: `pass 46`, `fail 0`

Additional assertion-level evidence from `src/api/tasks.test.ts`:
- Successful post case:
  - Poster balance expected `200 -> 80` for bounty `120`.
  - Ledger contains `kind=task_escrow`, `reason=task_escrow`, `amount=-120` for created task.
- Insufficient post case:
  - Response status `400`.
  - Error code `AGENT_INSUFFICIENT_BALANCE`.
  - Error details include `required_amount=120`, `balance=50`.
  - Task list remains empty and poster balance remains `50`.

## Changed Files (for this sprint task)
- `src/api/tasks.ts`
- `src/api/tasks.test.ts`
- `src/api/concurrent-bid.test.ts`
- `docs/reports/release-blocker-A-codex.md`
