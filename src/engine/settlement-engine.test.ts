import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { generateSettlementIdempotencyKey, calculateSettlement } from "./settlement-engine";
import { getRuleEngine } from "./rule-engine";
import type { SettlementInput } from "./settlement-engine";

before(async () => {
  const result = getRuleEngine().load();
  if (!result.valid) {
    throw new Error(`Failed to load rules: ${result.errors.join(", ")}`);
  }
});

describe("settlement-engine P0-03 fix: idempotency key collision", () => {
  it("should generate distinct keys for executor and scorer", () => {
    const executorKey = generateSettlementIdempotencyKey("task-1", "cycle-1", "executor");
    const scorerKey = generateSettlementIdempotencyKey("task-1", "cycle-1", "scorer");

    assert.notEqual(executorKey, scorerKey, "executor and scorer must have distinct idempotency keys");
  });

  it("should be deterministic — same inputs produce same key", () => {
    const key1 = generateSettlementIdempotencyKey("task-abc", "cycle-xyz", "executor");
    const key2 = generateSettlementIdempotencyKey("task-abc", "cycle-xyz", "executor");

    assert.equal(key1, key2, "Idempotency key must be deterministic");
  });

  it("should produce different keys for different task_ids", () => {
    const key1 = generateSettlementIdempotencyKey("task-1", "cycle-1", "executor");
    const key2 = generateSettlementIdempotencyKey("task-2", "cycle-1", "executor");

    assert.notEqual(key1, key2);
  });

  it("should produce different keys for different cycle_ids", () => {
    const key1 = generateSettlementIdempotencyKey("task-1", "cycle-1", "executor");
    const key2 = generateSettlementIdempotencyKey("task-1", "cycle-2", "executor");

    assert.notEqual(key1, key2);
  });

  it("calculateSettlement should expose both executor_idempotency_key and scorer_idempotency_key", () => {
    const input: SettlementInput = {
      task_id: "task-settle-1",
      cycle_id: "cycle-settle-1",
      base_reward: 100,
      score_result: {
        final_score: 80,
        quality_label: "good",
        quality_multiplier: 1.0,
        scorer_commission_pct: 5,
        passed: true
      }
    };

    const result = calculateSettlement(input);

    assert.ok(result.executor_idempotency_key, "executor_idempotency_key must be present");
    assert.ok(result.scorer_idempotency_key, "scorer_idempotency_key must be present");
    assert.notEqual(
      result.executor_idempotency_key,
      result.scorer_idempotency_key,
      "executor and scorer keys must differ"
    );
    assert.equal(result.idempotency_key, result.executor_idempotency_key, "idempotency_key alias must match executor key");
  });

  it("calculateSettlement should compute correct fees with platform_fee=3% and scorer_commission=5%", () => {
    const input: SettlementInput = {
      task_id: "task-fee-1",
      cycle_id: "cycle-fee-1",
      base_reward: 100,
      score_result: {
        final_score: 80,
        quality_label: "good",
        quality_multiplier: 1.0,
        scorer_commission_pct: 5,
        passed: true
      }
    };

    const result = calculateSettlement(input);

    assert.equal(result.gross_reward, 100);
    assert.equal(result.platform_fee, 3);    // 3% of 100
    assert.equal(result.net_reward, 97);     // 100 - 3
    assert.equal(result.scorer_commission, 5); // 5% of 100
  });
});
