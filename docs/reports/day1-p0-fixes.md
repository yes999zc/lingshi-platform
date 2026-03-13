# Day1 P0 Fixes Report

**Date**: 2026-03-12
**Fixes**: P0-02 (tier grace bug), P0-03 (idempotency key collision)
**Status**: RESOLVED — `npm test` exits 0, 15/15 tests pass

---

## P0-02: Tier Grace Period Resets on Stable Agents

### Before (tier-manager.ts:130-139)

```typescript
// No change
return {
  agent_id: state.agent_id,
  previous_tier: state.current_tier,
  new_tier: state.current_tier,
  changed: false,
  direction: "unchanged",
  grace_cycles_remaining: state.grace_cycles_remaining > 0
    ? state.grace_cycles_remaining
    : demotion_grace_cycles   // BUG: resets to max on every stable evaluation
};
```

### After (tier-manager.ts:130-138)

```typescript
// No change
return {
  agent_id: state.agent_id,
  previous_tier: state.current_tier,
  new_tier: state.current_tier,
  changed: false,
  direction: "unchanged",
  grace_cycles_remaining: 0  // P0-02 fix: stable agents should have 0, not reset to max
};
```

### Verification

Stable agent with `grace_cycles_remaining=0` now correctly returns `grace_cycles_remaining=0`.
Previously it returned `demotion_grace_cycles` (=1), giving unearned grace cycles.

---

## P0-03: Settlement Idempotency Key Collision (executor vs scorer)

### Before

**config/rules.json:72**
```json
"idempotency_key_format": "{task_id}:{cycle_id}:settlement"
```

**settlement-engine.ts:32-45**
```typescript
export function generateSettlementIdempotencyKey(task_id: string, cycle_id: string): string {
  const raw = idempotency_key_format
    .replace("{task_id}", task_id)
    .replace("{cycle_id}", cycle_id);
  // Both executor and scorer entries produce the same key → DB drops second insert
  ...
}
```

### After

**config/rules.json:72**
```json
"idempotency_key_format": "{task_id}:{cycle_id}:{entry_type}"
```

**settlement-engine.ts:33-51**
```typescript
export function generateSettlementIdempotencyKey(
  task_id: string,
  cycle_id: string,
  entry_type: "executor" | "scorer"
): string {
  const raw = idempotency_key_format
    .replace("{task_id}", task_id)
    .replace("{cycle_id}", cycle_id)
    .replace("{entry_type}", entry_type);
  // executor key: sha256(task_id:cycle_id:executor)
  // scorer key:   sha256(task_id:cycle_id:scorer)
  ...
}
```

**SettlementBreakdown** now exposes:
- `executor_idempotency_key` — for executor payout ledger entry
- `scorer_idempotency_key` — for scorer commission ledger entry
- `idempotency_key` — alias for executor key (backwards compat)

---

## Test Output

```
▶ settlement-engine P0-03 fix: idempotency key collision
  ✔ should generate distinct keys for executor and scorer (0.516ms)
  ✔ should be deterministic — same inputs produce same key (0.091ms)
  ✔ should produce different keys for different task_ids (0.062ms)
  ✔ should produce different keys for different cycle_ids (0.069ms)
  ✔ calculateSettlement should expose both executor_idempotency_key and scorer_idempotency_key (0.137ms)
  ✔ calculateSettlement should compute correct fees with platform_fee=3% and scorer_commission=5% (0.069ms)
✔ settlement-engine P0-03 fix: idempotency key collision (1.304ms)

▶ tier-manager P0-02 fix: grace_cycles_remaining bug
  ✔ should return grace_cycles_remaining=0 for stable agents at Outer tier (0.530ms)
  ✔ should return grace_cycles_remaining=0 for stable agents at Core tier (0.098ms)
  ✔ should decrement grace_cycles_remaining when agent is at risk of demotion (0.070ms)
  ✔ should demote agent when grace period is exhausted (0.065ms)
  ✔ should promote agent immediately without grace period (0.058ms)
✔ tier-manager P0-02 fix: grace_cycles_remaining bug (1.244ms)

▶ tier-manager: computeEligibleTier
  ✔ should return Outer for agents below all thresholds (0.107ms)
  ✔ should return Core for agents meeting Core thresholds (0.067ms)
  ✔ should return Elder for agents meeting Elder thresholds (0.056ms)
  ✔ should require both lingshi AND tasks to qualify for tier (0.055ms)
✔ tier-manager: computeEligibleTier (0.401ms)

ℹ tests 15 | pass 15 | fail 0
```

---

## Files Changed

| File | Change |
|------|--------|
| `src/engine/tier-manager.ts` | Line 136-138: return `grace_cycles_remaining: 0` for stable agents |
| `config/rules.json` | `idempotency_key_format` updated to `{task_id}:{cycle_id}:{entry_type}` |
| `src/engine/settlement-engine.ts` | `generateSettlementIdempotencyKey` accepts `entry_type` param; `SettlementBreakdown` exposes both keys |
| `src/engine/tier-manager.test.ts` | New — 9 unit tests for P0-02 |
| `src/engine/settlement-engine.test.ts` | New — 6 unit tests for P0-03 |
| `package.json` | Added `"test": "tsx --test 'src/**/*.test.ts'"` script |
