# Day1 Claude Quality Report — Lingshi Platform

**Date**: 2026-03-12
**Reviewer**: Claude CLI (Architecture Lead)
**Scope**: Rule Engine, Scoring, Tier-Settlement design; AB test governance
**Verdict**: ⚠️ NOT READY FOR DAY1 MILESTONE — 3 P0 blockers must be resolved first

---

## 1. Executive Summary

顶层设计已落地：Rule Engine 单例 + 配置热重载 + 分层结算 + 层级宽限期，架构方向正确。
但核心差异化价值（可审计性、防作弊、幂等结算）存在三处 P0 级实现漏洞，
且 AB 测试框架缺乏可量化的 pass/fail 判定，无法作为 Day1 验收依据。

**抓手**：本报告每条 issue 均附有可执行的复现路径和验证命令，不允许甩锅。

---

## 2. Risk-Ranked Issue List

### P0 — Blockers (Day1 milestone CANNOT close until resolved)

#### P0-01: Zero automated test coverage for all engine modules

**Evidence**: `find src/engine -name "*.test.ts" -o -name "*.spec.ts"` returns nothing.
No test files exist for `rule-engine.ts`, `scoring.ts`, `settlement-engine.ts`, `tier-manager.ts`.

**Impact**: Any regression in scoring formula, tier logic, or settlement math is invisible.
The acceptance criteria AC-LD-03 (idempotent settlement) and AC-SM-02/03/04 (state machine)
cannot be verified without a running server — no unit-level safety net.

**Reproduction**:
```bash
ls src/engine/*.test.ts 2>&1  # → No such file or directory
npm test 2>&1                  # → no test files found
```

**Required fix**: Unit tests for at minimum:
- `calculateFinalScore` boundary values (score=0, score=100, score=60 exactly)
- `computeEligibleTier` with all three tier thresholds
- `calculateSettlement` with platform_fee=3%, scorer_commission=5%
- `generateSettlementIdempotencyKey` determinism (same inputs → same hash)
- `validateScorerIsolation` all four rejection paths

**Pass criterion**: `npm test` exits 0 with ≥20 engine unit tests.

---

#### P0-02: Tier grace period logic resets counter on stable agents (tier-manager.ts:136-138)

**Evidence** (`src/engine/tier-manager.ts`, lines 130-139):
```typescript
// No change
return {
  ...
  grace_cycles_remaining: state.grace_cycles_remaining > 0
    ? state.grace_cycles_remaining
    : demotion_grace_cycles   // ← BUG: resets to max on every stable evaluation
};
```

**Impact**: An agent that has never been at risk of demotion will have
`grace_cycles_remaining = demotion_grace_cycles (=1)` injected into their state
on every stable evaluation. When they later drop below threshold, they get
an extra grace cycle they haven't earned. This inflates demotion resistance
and breaks AC-TR-02 (tier demotion correctness).

**Reproduction**:
```typescript
// Agent stable at Outer tier, grace_cycles_remaining = 0
const result = evaluateTierChange({
  agent_id: "a1", current_tier: "Outer",
  lingshi_balance: 10, tasks_completed: 1,
  grace_cycles_remaining: 0
});
// result.grace_cycles_remaining === 1  ← should be 0
```

**Required fix**: The "no change" branch should return `grace_cycles_remaining: 0`
(or preserve the existing value without inflating it). Grace cycles should only
be granted when a demotion is first detected.

**Pass criterion**: Stable agent with `grace_cycles_remaining=0` returns `grace_cycles_remaining=0`.

---

#### P0-03: Settlement idempotency key excludes agent_id — collision risk under retry

**Evidence** (`config/rules.json`, line 72):
```json
"idempotency_key_format": "{task_id}:{cycle_id}:settlement"
```
`settlement-engine.ts:36-41` substitutes only `task_id` and `cycle_id`.

**Impact**: If a task is re-settled in a different cycle (e.g., after a failed
settlement is retried with a new `cycle_id`), the key changes correctly.
However, if the same `task_id` + `cycle_id` pair is used for both the
executor payout AND the scorer commission in separate ledger entries,
both entries share the same idempotency key. The DB unique index
(`idx_ledger_idempotency_key`) will silently drop the second insert,
causing the scorer to receive no commission.

**Reproduction**:
```sql
-- After settlement, check ledger:
SELECT idempotency_key, entry_type, amount FROM ledger
WHERE task_id = '<task_id>';
-- If executor and scorer entries share the same key → scorer entry missing
```

**Required fix**: Differentiate keys per entry type:
`{task_id}:{cycle_id}:executor` and `{task_id}:{cycle_id}:scorer`
(update both `rules.json` format and `settlement-engine.ts` call sites).

**Pass criterion**: AC-LD-05 — scorer receives commission in a separate ledger entry
with a distinct idempotency key; both entries survive a double-settlement replay.

---

### P1 — High Priority (must fix before Day2 AB test run)

#### P1-01: AB test output parsing is regex-fragile; no structured pass/fail verdict

**Evidence** (`examples/ab-test.ts`, lines 121-146):
```typescript
const puaMatch = output.match(/失败次数:\s*(\d+)/);
const tierMatch = output.match(/层级:\s*(\S+)/);
```

**Impact**: `pua-agent.ts` prints `层级: ${agent.data.agent.tier}` and
`余额: ${agent.data.agent.lingshi_balance.toFixed(2)}` — but `simple-agent.ts`
prints `Tier=${...}, balance=${...}` (English, different format, line 131).
The regex `层级:` will never match simple-agent output → `tier` always `"unknown"`,
`balance` always `0` for simple agents. The summary comparison is meaningless.

**Reproduction**:
```bash
npx tsx examples/simple-agent.ts 2>&1 | grep "层级"
# → (no output) — regex mismatch confirmed
```

**Required fix**: Either (a) unify output format across both agents,
or (b) have agents write a structured JSON summary line that ab-test.ts parses.
Minimum: add `console.log(\`层级: ${tier}\`)` to simple-agent.ts.

**Pass criterion**: AB test summary shows non-zero balance and correct tier
for both simple and PUA agent runs.

---

#### P1-02: ab-test.ts hardcodes absolute path — breaks on any other machine

**Evidence** (`examples/ab-test.ts`, line 79):
```typescript
cwd: "/Users/bakeyzhang/.openclaw/workspace/projects/lingshi-platform",
```

**Impact**: Any CI runner or collaborator machine will fail with ENOENT.

**Required fix**: Replace with `path.resolve(__dirname, "..")` or `process.cwd()`.

**Pass criterion**: `npx tsx examples/ab-test.ts` runs successfully from any checkout path.

---

#### P1-03: Rule engine validation is structural-only — no value range checks

**Evidence** (`src/engine/rule-engine.ts`, lines 127-165):
`validateConfig` only checks that sections exist as objects. It does not validate:
- `platform_fee_pct` is in [0, 100]
- `pass_threshold` < `max_score`
- `bid_escrow_pct` > 0
- `demotion_grace_cycles` ≥ 0

**Impact**: A hot-reload with `platform_fee_pct: 150` would pass validation
and silently produce negative net rewards. AC-RE-03 (malformed config rejected)
is only partially satisfied.

**Reproduction**:
```bash
# Temporarily set platform_fee_pct to 150 in rules.json
# Rule engine accepts it → calculateSettlement returns negative net_reward
```

**Pass criterion**: `validateConfig` rejects `platform_fee_pct > 100` with a
descriptive error; hot-reload does not apply the bad value.

---

#### P1-04: `getQualityLabel` uses inconsistent threshold logic — boundary score 85 misclassified

**Evidence** (`src/engine/scoring.ts`, lines 45-50):
```typescript
const ratio = score / maxScore;
if (ratio >= 0.85) return "excellent";
if (score >= passThreshold) return "good";
return "poor";
```

With `max_score=100`, `pass_threshold=60`:
- Score 85 → ratio=0.85 → `excellent` ✓
- Score 84 → ratio=0.84 → `good` ✓
- Score 60 → `good` ✓
- Score 59 → `poor` ✓

The logic is correct for the current config, but the `excellent` branch uses
a ratio while `good` uses an absolute value. If `max_score` is changed to 200
(valid per schema), `pass_threshold=60` would still be absolute, but `excellent`
threshold becomes 170. An agent scoring 100/200 (50%) would be `good` while
the intent is likely `poor`. The mixed comparison is a latent bug.

**Required fix**: Normalize both thresholds to ratios, or document the
intentional asymmetry in a comment.

**Pass criterion**: Unit test confirms correct label at score=85, 84, 60, 59
with both default and non-default `max_score` values.

---

### P2 — Medium Priority (Day2 backlog)

#### P2-01: No audit log for hot-reload config changes

`rule-engine.ts:watch()` silently applies new config. No log entry records
what changed, who triggered it, or what the previous values were.
Breaks auditability requirement implied by ADR-001.

**Fix**: Log `JSON.stringify(diff(oldConfig, newConfig))` on each reload.

---

#### P2-02: `pua-agent.ts` sends `pua_context` (internal debug state) in submission payload

**Evidence** (`examples/pua-agent.ts`, line 359):
```typescript
pua_context: pua.getContext()
```

This embeds the full attempt history (including error messages) into the
task submission. The server stores this in `submissions.payload`. In a
production scenario this leaks internal retry state to the scorer.

**Fix**: Strip `pua_context` from the submission body, or move it to a
separate debug endpoint.

---

#### P2-03: `computeEligibleTier` sorts tiers by `min_lingshi` only — ignores `min_tasks_completed`

**Evidence** (`src/engine/tier-manager.ts`, lines 51-62):
An agent with 600 lingshi but 0 tasks completed would be evaluated as
`Core`-eligible because the loop iterates in lingshi-ascending order and
both conditions must pass. The logic is actually correct (both conditions
checked at line 56), but the sort key is only `min_lingshi`. If a future
tier has higher `min_tasks_completed` but lower `min_lingshi` than an
existing tier, the sort order would produce wrong results.

**Fix**: Sort by `min_lingshi` then `min_tasks_completed` as a tiebreaker,
and add a comment explaining the sort invariant.

---

#### P2-04: `ledger` table has no `UNIQUE` constraint on `(task_id, entry_type)`

The idempotency key index prevents duplicate keys, but if two settlement
calls use different `cycle_id` values for the same task (e.g., a bug in
the caller), both will succeed and the agent will be double-paid.
The DB has no guard against this.

**Fix**: Add `UNIQUE(task_id, entry_type)` to the ledger table, or enforce
at the application layer before insert.

---

## 3. AB Test Governance — Day1 Readiness

### Current State

| Check | Status | Blocker? |
|-------|--------|----------|
| `simple-agent.ts` exists | ✅ | — |
| `pua-agent.ts` exists | ✅ | — |
| `ab-test.ts` spawns both agents | ✅ | — |
| Output format compatible between agents | ❌ P1-01 | Yes |
| Hardcoded path removed | ❌ P1-02 | Yes |
| Structured pass/fail verdict | ❌ | Yes |
| Server must be running externally | ⚠️ | Documented |

### Pass/Fail Criteria for Day1 AB Test

The AB test is considered **PASSED** when ALL of the following hold:

1. Both simple and PUA agents complete with exit code 0
2. PUA agent `failures` metric is parseable and ≥ 0
3. Both agents report non-zero `balance` in summary
4. Both agents report a valid tier (`Outer`, `Core`, or `Elder`)
5. Summary diff shows `puaSuccessRate ≥ simpleSuccessRate` (PUA resilience hypothesis)
6. No unhandled promise rejections in either agent's stderr

### Current Verdict: **FAIL** (P1-01 and P1-02 unresolved)

---

## 4. Day1 Milestone Pass/Fail Criteria

| Criterion | Current | Required |
|-----------|---------|----------|
| P0 issues resolved | 0/3 | 3/3 |
| Engine unit tests | 0 | ≥20 |
| AB test runs end-to-end | ❌ | ✅ |
| `npm test` exits 0 | ❌ (no tests) | ✅ |
| Settlement idempotency verified | ❌ (no test) | ✅ |
| Tier grace period bug fixed | ❌ | ✅ |

**Day1 milestone is BLOCKED. Minimum unblock path: fix P0-01, P0-02, P0-03.**

---

## 5. Day2 Test Sequence Recommendation

Execute in this order to maximize signal and minimize wasted runs:

1. **Fix P0-02 (tier grace bug) + P0-03 (idempotency key)** — pure logic fixes, no infra needed
2. **Write engine unit tests (P0-01)** — cover all boundary cases listed above; run `npm test`
3. **Fix P1-01 (ab-test output format) + P1-02 (hardcoded path)** — unblocks AB test
4. **Start server, run `npx tsx examples/ab-test.ts`** — validate AB test end-to-end
5. **Fix P1-03 (rule validation ranges)** — add value-range checks to `validateConfig`
6. **Run integration smoke test** (`scripts/task-lifecycle-smoke.ts`) — confirm full lifecycle
7. **Verify AC-LD-03** (idempotent settlement) via direct API call with duplicate idempotency key
8. **Verify AC-SC-04** (Sybil bid detection) — currently "Pending API integration"

**Day2 exit gate**: All P0 and P1 issues resolved; `npm test` exits 0; AB test produces
valid structured output with both agents completing successfully.

---

## 6. Architecture Observations (Non-blocking)

- **Positive**: Singleton rule engine with hot-reload guard is the right pattern.
  Config validation before apply prevents bad state propagation.
- **Positive**: Ledger unique index on `idempotency_key` is the correct DB-level guard.
- **Positive**: `validateScorerIsolation` covers all three conflict vectors (poster, assignee, bidder).
- **Gap**: No `tasks_completed` counter in the `agents` table schema — tier evaluation
  reads this from `AgentTierState` but there's no DB column to persist it.
  Verify this is populated correctly before Day2 tier tests.
- **Gap**: `coalitions` table exists in schema but has no corresponding engine module.
  Either implement or remove to avoid schema drift.

---

## 7. Verification Commands (Copy-Paste Ready)

```bash
# Verify P0-01 (test coverage)
find src/engine -name "*.test.ts" -o -name "*.spec.ts"
npm test

# Verify P0-02 (tier grace bug) — requires unit test
# See required fix in P0-02 section

# Verify P0-03 (idempotency key collision)
# After settlement, run:
sqlite3 data/lingshi.db "SELECT idempotency_key, entry_type, amount FROM ledger WHERE task_id = '<task_id>';"
# Expect: two distinct keys for executor and scorer entries

# Verify P1-01 (AB test output format)
npx tsx examples/simple-agent.ts 2>&1 | grep "层级"
npx tsx examples/pua-agent.ts 2>&1 | grep "层级"
# Both should produce matching output

# Verify P1-02 (hardcoded path)
cd /tmp && git clone <repo> && cd lingshi-platform && npx tsx examples/ab-test.ts
# Should run without ENOENT

# Verify P1-03 (rule validation)
# Temporarily set platform_fee_pct to 150 in config/rules.json
# Rule engine should reject with validation error

# Day1 gate check
npm test && npm run lint && npx tsx examples/ab-test.ts
# All three must exit 0
```

---

## 8. Accountability Matrix

| Issue | Owner | Deadline | Verification |
|-------|-------|----------|--------------|
| P0-01 | Backend dev | Day1 EOD | `npm test` exits 0 |
| P0-02 | Backend dev | Day1 EOD | Unit test passes |
| P0-03 | Backend dev | Day1 EOD | SQL query shows distinct keys |
| P1-01 | Example maintainer | Day2 AM | AB test summary valid |
| P1-02 | Example maintainer | Day2 AM | Runs from any path |
| P1-03 | Backend dev | Day2 PM | Validation rejects bad values |
| P1-04 | Backend dev | Day2 PM | Unit test covers edge cases |

**Claude CLI (Architecture Lead) commits to**: Review all fixes within 2 hours of PR submission.
No vague "LGTM" — each PR review will include explicit pass/fail verdict per criterion above.

---

## 9. Final Verdict

**Day1 milestone: ⚠️ NOT READY**

Minimum unblock path (4-6 hours estimated):
1. Write 20 engine unit tests (P0-01) — 3 hours
2. Fix tier grace bug (P0-02) — 30 minutes
3. Fix idempotency key format (P0-03) — 1 hour
4. Fix AB test output format (P1-01) — 30 minutes
5. Fix hardcoded path (P1-02) — 15 minutes
6. Run full test suite + AB test — 30 minutes

**Day2 milestone can proceed** once all P0 issues are resolved and `npm test` exits 0.

---

**Report generated**: 2026-03-12
**Next review**: After P0 fixes submitted (expected Day1 EOD)
