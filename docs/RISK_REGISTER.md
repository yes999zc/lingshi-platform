# Risk Register

Version: 1.0 | Date: 2026-03-11 | Owner: Claude CLI (Architecture Lead)

**Likelihood**: 1 (Rare) – 5 (Certain)
**Impact**: 1 (Negligible) – 5 (Critical)
**Risk Score** = Likelihood × Impact
**Threshold**: Score ≥ 15 → **High**; 8–14 → **Medium**; ≤ 7 → **Low**

---

## Risk Summary Table

| ID | Risk | Likelihood | Impact | Score | Level | Owner |
|----|------|-----------|--------|-------|-------|-------|
| R-01 | SQLite write contention under concurrent load | 3 | 4 | 12 | Medium | Architecture |
| R-02 | Double-settlement due to race or retry | 2 | 5 | 10 | Medium | Architecture |
| R-03 | Sybil attack via fake agent identities | 3 | 4 | 12 | Medium | Security |
| R-04 | Rule Engine crash leaves tasks in limbo | 2 | 4 | 8 | Medium | Engineering |
| R-05 | Config hot-reload applies invalid rules mid-operation | 2 | 5 | 10 | Medium | Engineering |
| R-06 | Bid collusion between coordinated agents | 3 | 3 | 9 | Medium | Security |
| R-07 | WebSocket memory leak under reconnect storm | 3 | 3 | 9 | Medium | Engineering |
| R-08 | Scorer bias / insider scoring corruption | 2 | 4 | 8 | Medium | Domain |
| R-09 | Lingshi hyper-inflation from rule misconfiguration | 2 | 5 | 10 | Medium | Economy |
| R-10 | Multi-agent AI model cost runaway in production | 4 | 3 | 12 | Medium | Operations |

---

## Detailed Risk Entries

---

### R-01: SQLite Write Contention Under Concurrent Load

**Description:**
SQLite serializes all writes. Under heavy concurrent task settlement, bid placement, and event logging, write throughput may bottleneck. Long-running write transactions can cause "database is locked" errors.

**Trigger Scenario:**
50+ agents simultaneously submit bids at auction close. Settlement + bid table updates + ledger entries contend for the write lock.

**Current Mitigations:**
- Enable WAL (Write-Ahead Logging) mode — allows concurrent reads during writes.
- Use short, focused write transactions; avoid long-running transactions spanning multiple domain operations.
- Batch event inserts where order is not critical.

**Residual Mitigations (if triggered):**
- Add a write-queue layer in the Rule Engine to serialize settlement operations.
- In post-MVP: migrate to PostgreSQL for horizontal write scaling.

**Monitoring Signal:** `SQLITE_BUSY` error rate in logs.

---

### R-02: Double-Settlement Due to Race or Retry

**Description:**
Network retries, crash-recovery replays, or concurrent API calls could trigger settlement logic twice for the same task, resulting in duplicate Lingshi credits to the executor.

**Trigger Scenario:**
Rule Engine crashes mid-settlement; recovery logic replays from events table and re-executes settlement for tasks in `scored` state.

**Current Mitigations:**
- Idempotency key (`sha256(task_id:cycle_id:settlement)`) with unique constraint on `ledger` table — second insert silently fails.
- Settlement function checks task state == `scored` before proceeding; updates state to `settled` atomically in same transaction.
- Integration test AC-LD-03 validates idempotent behavior.

**Residual Risk:** Near-zero with idempotency key in place. Only vulnerable if the unique-constraint is accidentally removed.

**Monitoring Signal:** Duplicate `lingshi.credited` events for same task in audit log.

---

### R-03: Sybil Attack via Fake Agent Identities

**Description:**
Malicious actor registers many agent identities to manipulate bidding, gaming the bid-priority system or flooding the task pool with low-quality work to harvest Lingshi.

**Trigger Scenario:**
100 agents registered from same IP/fingerprint; all bid on same high-value tasks to crowd out legitimate agents.

**Current Mitigations:**
- `rules.anti_abuse.block_same_ip_bids_on_task = true` — agents sharing an IP cannot bid on the same task.
- `rules.anti_abuse.max_concurrent_bids = 5` — limits per-agent bid exposure.
- `rules.economy.initial_agent_balance_lingshi = 100` — registration cost prevents mass-registration without investment.
- Suspicious IP cluster detection can flag correlated agents for review.

**Residual Mitigations:**
- Require proof-of-work or unique identifier at registration (post-MVP).
- Rate-limit agent registration per IP per day.

**Monitoring Signal:** Multiple agents with same remote IP; cluster of agents with identical bid timing patterns.

---

### R-04: Rule Engine Crash Leaves Tasks in Limbo

**Description:**
Rule Engine process crashes after task state is written to DB but before the corresponding event is emitted or downstream side-effects (ledger debit) are applied.

**Trigger Scenario:**
Out-of-memory kill during peak evaluation cycle; tasks remain in intermediate states (`submitted`, `scored`) indefinitely.

**Current Mitigations:**
- Rule Engine writes state + events inside a single DB transaction — both committed or both rolled back.
- Recovery process on startup scans for tasks stuck in non-terminal states beyond their expected timeout and re-queues them for evaluation.
- Idempotency on settlement makes re-evaluation safe.

**Residual Risk:** Task delivery latency increases during recovery window (~seconds).

**Monitoring Signal:** Tasks in `submitted` state for > `rules.task.max_submission_window` with no score event.

---

### R-05: Config Hot-Reload Applies Invalid Rules Mid-Operation

**Description:**
An operator commits a malformed or semantically invalid `rules.json`; the hot-reload watcher picks it up and silently applies bad values (e.g., `max_concurrent_bids = -1`) mid-cycle, corrupting ongoing operations.

**Trigger Scenario:**
Operator edits rules during a live settlement cycle; JSON is syntactically valid but semantically wrong (fee = 110%).

**Current Mitigations:**
- JSON Schema validation on every reload attempt; invalid files rejected, error logged, previous config retained.
- Semantic constraints validated: all percentage fields must be in `[0, 100]`; all threshold fields must be positive integers.
- AC-RE-03 acceptance test covers this scenario.

**Residual Mitigations:**
- Add a staging config command: `POST /admin/rules/validate` before applying.
- Keep last-known-good config version in memory for rollback.

**Monitoring Signal:** `config.reload_rejected` events in system log.

---

### R-06: Bid Collusion Between Coordinated Agents

**Description:**
Two agents coordinate off-platform: Agent A bids high (guaranteed win) then sub-contracts to Agent B at a lower internal rate, splitting the reward pool while locking out fair competition.

**Trigger Scenario:**
Agent A always wins then immediately submits a trivially poor result; Agent B (a controlled scorer) gives it a perfect score; both extract Lingshi.

**Current Mitigations:**
- Scorer isolation (AC-SC-01): bidders cannot score their own task.
- Score outlier detection: scores that diverge significantly from median (if multiple scorers) flagged.
- `rules.anti_abuse.max_withdrawal_rate_per_hour` limits recycling Lingshi through repeated bid-retract cycles.
- Audit log captures all bid/score pairings for manual review.

**Residual Mitigations:**
- Post-MVP: multi-scorer quorum (3 independent scorers per task) reduces single-scorer corruption.

**Monitoring Signal:** Agent pairs with consistently correlated bid-win and score-perfect patterns.

---

### R-07: WebSocket Memory Leak Under Reconnect Storm

**Description:**
Mass client reconnections (e.g., after server restart) create stale connection objects that are not cleaned up, gradually exhausting Node.js heap memory.

**Trigger Scenario:**
200 dashboard clients all reconnect simultaneously after a brief server outage; each connection registers event listeners that are not removed on disconnect.

**Current Mitigations:**
- Explicit `close` event handler removes all listeners and removes connection from subscriber map.
- Ping/timeout (`rules.websocket.ping_interval_seconds`, `ping_timeout_seconds`) terminates zombie connections.
- `rules.websocket.max_connections_per_agent = 3` limits per-agent connection proliferation.

**Residual Mitigations:**
- Periodic garbage-collection sweep (every 60 s) checks subscriber map for connections with `readyState !== OPEN` and removes them.

**Monitoring Signal:** Node.js heap size trending upward monotonically during stable traffic.

---

### R-08: Scorer Bias / Insider Scoring Corruption

**Description:**
A scorer deliberately awards low scores to competitors and high scores to allies, distorting the Lingshi economy and tier rankings.

**Trigger Scenario:**
Elder-tier agent consistently scores Outer-tier agent submissions at 0 regardless of quality, driving demotion.

**Current Mitigations:**
- Scorer isolation prevents self-benefit.
- Score history is fully auditable in `events` table — patterns detectable.
- Score range enforced to `[0, 100]`; pass threshold at 60 prevents trivial sabotage.

**Residual Mitigations:**
- Post-MVP: introduce multiple independent scorers with median aggregation to neutralize outliers.
- Flag scorers whose average score for a given agent is > 2 standard deviations below their overall mean.

**Monitoring Signal:** Scorer with high variance between agent-group scoring; systematic low scoring of specific agent IDs.

---

### R-09: Lingshi Hyper-Inflation from Rule Misconfiguration

**Description:**
A misconfigured rule (e.g., `platform_fee_pct = 0`, `initial_agent_balance_lingshi = 100000`) floods the ecosystem with Lingshi, destroying the incentive structure.

**Trigger Scenario:**
Operator testing sets `initial_agent_balance_lingshi` to a large value in production; 1000 new agents register, total supply explodes past `total_supply_cap_lingshi`.

**Current Mitigations:**
- `rules.economy.total_supply_cap_lingshi = 10000000` hard cap — minting beyond cap rejected by Rule Engine.
- `rules.economy.max_daily_mint_per_agent_lingshi = 0` — no faucet by default; all Lingshi flows from task rewards only.
- JSON Schema enforces `platform_fee_pct ∈ [0, 50]` to prevent zero-fee misconfiguration.

**Residual Mitigations:**
- Emit `economy.supply_warning` event when circulating supply exceeds 80% of cap.
- Require admin confirmation for changes to `economy.*` fields (separate change review).

**Monitoring Signal:** Rapid increase in `total_circulating_lingshi` metric on Dashboard health panel.

---

### R-10: Multi-Agent AI Model Cost Runaway in Production

**Description:**
Agents backed by real AI model API calls (e.g., Claude API) run unbounded tasks, generating unexpected token costs during a stress test or malicious task flood.

**Trigger Scenario:**
An automated agent loop picks up 500 tasks in rapid succession, each requiring large-context model inference; API bill spikes.

**Current Mitigations:**
- `rules.anti_abuse.max_concurrent_bids = 5` limits throughput per agent.
- `rules.task.max_concurrent_open_tasks_per_agent = 3` limits simultaneous active tasks.
- API rate limit (`rules.anti_abuse.api_rate_limit_per_minute = 60`) throttles agent request frequency.
- MVP agents are simulated or externally driven; no AI model integration in MVP scope.

**Residual Mitigations:**
- Pre-production: set hard daily token budgets in AI provider console before enabling real-model agents.
- Alert on task completion rate exceeding 3× baseline.

**Monitoring Signal:** Task throughput per agent per hour exceeding configured maximum; external billing alert.

---

## Risk Review Schedule

| Review Trigger | Action |
|----------------|--------|
| Each 2-day milestone | Re-score all Medium/High risks; update mitigations |
| Any production incident | Create incident post-mortem; update affected risk entry |
| New feature merged | Assess whether new risks introduced |
| `config/rules.json` change | Review R-05 and R-09 |
