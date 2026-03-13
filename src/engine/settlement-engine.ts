import { createHash } from "node:crypto";
import { getRuleEngine } from "./rule-engine";
import type { ScoreResult } from "./scoring";

/**
 * Settlement Engine - Calculates task rewards with idempotency guarantees
 */

export interface SettlementInput {
  task_id: string;
  cycle_id: string;
  base_reward: number;
  score_result: ScoreResult;
  time_bonus_pct?: number;
}

export interface SettlementBreakdown {
  base_reward: number;
  time_bonus: number;
  quality_multiplier: number;
  gross_reward: number;
  platform_fee: number;
  net_reward: number;
  scorer_commission: number;
  idempotency_key: string;          // executor key (backwards compat)
  executor_idempotency_key: string;
  scorer_idempotency_key: string;
}

/**
 * Generate idempotency key for settlement
 * Format: sha256(task_id:cycle_id:entry_type)
 * P0-03 fix: entry_type differentiates executor vs scorer ledger entries
 */
export function generateSettlementIdempotencyKey(
  task_id: string,
  cycle_id: string,
  entry_type: "executor" | "scorer"
): string {
  const rules = getRuleEngine().getConfig();
  const { idempotency_key_algo, idempotency_key_format } = rules.settlement;

  const raw = idempotency_key_format
    .replace("{task_id}", task_id)
    .replace("{cycle_id}", cycle_id)
    .replace("{entry_type}", entry_type);

  if (idempotency_key_algo === "sha256") {
    return createHash("sha256").update(raw).digest("hex");
  }

  throw new Error(`Unsupported idempotency algorithm: ${idempotency_key_algo}`);
}

/**
 * Calculate settlement breakdown with all fees and bonuses
 */
export function calculateSettlement(input: SettlementInput): SettlementBreakdown {
  const rules = getRuleEngine().getConfig();
  const { platform_fee_pct } = rules.economy;

  const base_reward = input.base_reward;
  const time_bonus_pct = input.time_bonus_pct ?? 0;
  const time_bonus = Math.round(base_reward * (time_bonus_pct / 100) * 100) / 100;

  const reward_before_quality = base_reward + time_bonus;
  const gross_reward = Math.round(reward_before_quality * input.score_result.quality_multiplier * 100) / 100;

  const platform_fee = Math.round(gross_reward * (platform_fee_pct / 100) * 100) / 100;
  const net_reward = Math.round((gross_reward - platform_fee) * 100) / 100;

  const scorer_commission = Math.round(gross_reward * (input.score_result.scorer_commission_pct / 100) * 100) / 100;

  const executor_idempotency_key = generateSettlementIdempotencyKey(input.task_id, input.cycle_id, "executor");
  const scorer_idempotency_key = generateSettlementIdempotencyKey(input.task_id, input.cycle_id, "scorer");

  return {
    base_reward,
    time_bonus,
    quality_multiplier: input.score_result.quality_multiplier,
    gross_reward,
    platform_fee,
    net_reward,
    scorer_commission,
    idempotency_key: executor_idempotency_key,
    executor_idempotency_key,
    scorer_idempotency_key
  };
}

/**
 * Validate settlement parameters
 */
export function validateSettlementInput(input: SettlementInput): { valid: boolean; error?: string } {
  if (input.base_reward <= 0) {
    return { valid: false, error: "Base reward must be positive" };
  }

  if (input.time_bonus_pct && (input.time_bonus_pct < 0 || input.time_bonus_pct > 100)) {
    return { valid: false, error: "Time bonus percentage must be between 0 and 100" };
  }

  if (!input.task_id || !input.cycle_id) {
    return { valid: false, error: "Task ID and cycle ID are required" };
  }

  return { valid: true };
}
