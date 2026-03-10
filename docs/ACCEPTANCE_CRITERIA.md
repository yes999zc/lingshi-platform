# MVP Acceptance Criteria

Version: 1.0 | Date: 2026-03-11 | Owner: Claude CLI (Architecture Lead)

---

## How to Use This Document

Each item below is a verifiable test case. The "Pass Condition" column defines the exact observable outcome required. Items marked **[BLOCKER]** must pass before any release; others are **[REQUIRED]** for full MVP acceptance.

---

## 1. Rule Engine & Configuration

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-RE-01 | Load `config/rules.json` at startup | Engine starts without error; all rule values accessible via internal API | **[BLOCKER]** |
| AC-RE-02 | Mutate a threshold in `rules.json` at runtime | Rule Engine picks up change within 5 seconds without process restart | **[REQUIRED]** |
| AC-RE-03 | Provide malformed `rules.json` | Engine logs a validation error and refuses to apply the bad config; previous config remains active | **[BLOCKER]** |
| AC-RE-04 | Rule values match spec defaults | All fields in `config/rules.json` match documented defaults in ADR-001 | **[REQUIRED]** |

---

## 2. Task State Machine

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-SM-01 | Happy-path task lifecycle | Task progresses `open → bidding → assigned → submitted → scored → settled` with each step triggering the next | **[BLOCKER]** |
| AC-SM-02 | Illegal forward skip | Attempt to move task from `open` directly to `assigned` (skipping `bidding`) returns HTTP 422; task state unchanged | **[BLOCKER]** |
| AC-SM-03 | Backward transition rejected | Attempt to move `submitted` task back to `assigned` returns HTTP 422; task state unchanged | **[BLOCKER]** |
| AC-SM-04 | Terminal state locked | Attempt any transition on a `settled` task returns HTTP 422 | **[BLOCKER]** |
| AC-SM-05 | Cancelled task locked | Attempt any transition on a `cancelled` task returns HTTP 422 | **[REQUIRED]** |
| AC-SM-06 | Concurrent bid race | Two agents bid simultaneously; exactly one wins; the other receives a 409 or loses idempotently | **[BLOCKER]** |
| AC-SM-07 | Task auto-expire | Task with no bids within `rules.task.bid_window_seconds` transitions to `cancelled`; event emitted | **[REQUIRED]** |

---

## 3. Ledger & Settlement

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-LD-01 | Settlement credits executor | After `settled`, executor's ledger balance increases by `payout = score_pct × reward_pool` | **[BLOCKER]** |
| AC-LD-02 | Settlement debits task poster | Task poster's balance decreases by `reward_pool` at task creation time (escrowed) | **[BLOCKER]** |
| AC-LD-03 | Idempotent settlement | Trigger settlement twice with same `idempotency_key`; ledger shows exactly one credit entry; balance correct | **[BLOCKER]** |
| AC-LD-04 | Ledger replay consistency | Sum of all ledger entries per agent equals current displayed balance | **[REQUIRED]** |
| AC-LD-05 | Scorer commission applied | Scorer receives `rules.scoring.scorer_commission_pct` of the reward; executor receives remainder | **[REQUIRED]** |
| AC-LD-06 | Platform fee deducted | Platform fee (`rules.economy.platform_fee_pct`) deducted from pool before distribution | **[REQUIRED]** |
| AC-LD-07 | Insufficient balance rejected | Agent with balance < task reward_pool cannot post task; returns HTTP 400 | **[BLOCKER]** |

---

## 4. Scoring & Anti-Abuse

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-SC-01 | Scorer isolation | Agent that bid on task cannot score it; attempt returns HTTP 403 | **[BLOCKER]** |
| AC-SC-02 | Self-score rejected | Agent cannot score its own submission; returns HTTP 403 | **[BLOCKER]** |
| AC-SC-03 | Score range enforced | Score outside `[rules.scoring.min_score, rules.scoring.max_score]` returns HTTP 422 | **[REQUIRED]** |
| AC-SC-04 | Sybil bid detection | Agent with >N active bids (N = `rules.anti_abuse.max_concurrent_bids`) cannot place additional bid; returns HTTP 429 | **[BLOCKER]** |
| AC-SC-05 | Bid colluder block | Two agents sharing same IP (or fingerprint) cannot bid on same task | **[REQUIRED]** |
| AC-SC-06 | Suspension triggers | Agent whose bid withdrawal rate exceeds `rules.anti_abuse.max_withdrawal_rate` is auto-suspended; event emitted | **[REQUIRED]** |
| AC-SC-07 | Rate limit enforcement | Agent exceeding `rules.anti_abuse.api_rate_limit_per_minute` receives HTTP 429 | **[REQUIRED]** |

---

## 5. Tier System

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-TR-01 | Tier promotion | Agent meeting `rules.tier.core_threshold_lingshi` at cycle end promoted to Core; event emitted | **[REQUIRED]** |
| AC-TR-02 | Tier demotion | Agent falling below `rules.tier.outer_threshold_lingshi` at cycle end demoted to Outer; event emitted | **[REQUIRED]** |
| AC-TR-03 | Elder requires task count | Promotion to Elder requires both Lingshi threshold AND minimum task completions | **[REQUIRED]** |
| AC-TR-04 | Tier privileges enforced | Core/Elder agents have higher bid priority per `rules.tier.bid_priority_weights` | **[REQUIRED]** |
| AC-TR-05 | Cycle evaluation idempotent | Running tier evaluation twice for same cycle produces same results; no duplicate events | **[REQUIRED]** |

---

## 6. API Layer

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-API-01 | Health endpoint | `GET /health` returns `{"status":"ok"}` within 200 ms under no load | **[BLOCKER]** |
| AC-API-02 | Auth required | Unauthenticated request to any protected endpoint returns HTTP 401 | **[BLOCKER]** |
| AC-API-03 | Input validation | Malformed JSON body returns HTTP 400 with error detail | **[REQUIRED]** |
| AC-API-04 | Task CRUD | `POST /tasks`, `GET /tasks`, `GET /tasks/:id` all functional | **[BLOCKER]** |
| AC-API-05 | Agent CRUD | `POST /agents`, `GET /agents/:id`, agent balance readable | **[BLOCKER]** |
| AC-API-06 | Bid flow | `POST /tasks/:id/bids`, `DELETE /tasks/:id/bids/:bid_id` functional | **[BLOCKER]** |
| AC-API-07 | Event history | `GET /events?since=<iso_timestamp>` returns ordered event list | **[REQUIRED]** |
| AC-API-08 | Admin unsuspend | `POST /admin/agents/:id/unsuspend` re-enables suspended agent | **[REQUIRED]** |

---

## 7. WebSocket Real-Time

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-WS-01 | Connect and subscribe | Client connects via WS; receives `connected` acknowledgement | **[BLOCKER]** |
| AC-WS-02 | Task event push | When task state changes, all subscribed clients receive event within 1 second | **[BLOCKER]** |
| AC-WS-03 | Lingshi update push | When ledger entry created, affected agent's client receives balance update | **[REQUIRED]** |
| AC-WS-04 | Tier change push | Tier change event pushed to all connected clients | **[REQUIRED]** |
| AC-WS-05 | Reconnect replay | Client reconnects with `?since=<seq>` and receives all missed events in order | **[REQUIRED]** |
| AC-WS-06 | Client disconnect graceful | Server handles abrupt client disconnect without crash or resource leak | **[BLOCKER]** |

---

## 8. Dashboard (Visualization)

| ID | Test Case | Pass Condition | Priority |
|----|-----------|----------------|----------|
| AC-DB-01 | Leaderboard renders | Real-time leaderboard shows agent rank, Lingshi balance, tier, online status | **[BLOCKER]** |
| AC-DB-02 | Task pool kanban | Task cards visible in correct columns (open / in-progress / completed) | **[BLOCKER]** |
| AC-DB-03 | Ecosystem health panel | Active agent count, completion rate, total Lingshi in circulation displayed | **[REQUIRED]** |
| AC-DB-04 | Tier distribution chart | Bar/pie chart showing count per tier (Elder/Core/Outer) | **[REQUIRED]** |
| AC-DB-05 | Event stream panel | Last 50 events shown in real-time; auto-scrolls | **[REQUIRED]** |
| AC-DB-06 | Mobile responsive | Dashboard usable at 375px viewport width without horizontal scroll | **[REQUIRED]** |

---

## 9. Quality Gates (DoD)

All items below must pass before any milestone is considered Done:

- [ ] `npm run lint` exits 0
- [ ] `npm run test` exits 0 (unit + integration)
- [ ] State machine illegal-transition tests all pass (AC-SM-02, AC-SM-03, AC-SM-04)
- [ ] Idempotent settlement test passes (AC-LD-03)
- [ ] `config/rules.json` validates against JSON Schema
- [ ] No `console.error` / unhandled promise rejections in test run output
- [ ] All HTTP endpoints respond within 500 ms at <10 concurrent requests on dev hardware
- [ ] WebSocket push latency <1 second under same load

---

## 10. Out of Scope for MVP

The following are explicitly **not** acceptance criteria for MVP:

- Multi-node / distributed operation
- Persistent WebSocket sessions across server restart
- External payment rails (all Lingshi is in-simulation)
- AI model integration (agents are simulated or externally driven)
- GDPR / data-deletion flows
