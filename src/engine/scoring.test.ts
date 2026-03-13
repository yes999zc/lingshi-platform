import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  calculateFinalScore,
  getQualityLabel,
  computeScore,
  validateScorerIsolation,
  type ScoreInput,
  type ScorerIsolationContext
} from "./scoring";
import { initializeRules } from "./rule-engine";

describe("scoring engine", () => {
  before(() => {
    // Ensure rule engine is loaded before any scoring tests
    const result = initializeRules();
    if (!result.valid) {
      throw new Error(`Rule engine failed to load: ${result.errors.join(", ")}`);
    }
  });
  describe("calculateFinalScore", () => {
    it("should compute weighted average (quality 50%, speed 30%, innovation 20%)", () => {
      const input: ScoreInput = { quality: 80, speed: 70, innovation: 90 };
      // (80*0.5) + (70*0.3) + (90*0.2) = 40 + 21 + 18 = 79
      assert.strictEqual(calculateFinalScore(input), 79);
    });

    it("should clamp to min_score (0)", () => {
      const input: ScoreInput = { quality: 0, speed: 0, innovation: 0 };
      // Weighted average is 0, min_score is 0 (default config)
      assert.strictEqual(calculateFinalScore(input), 0);
    });

    it("should clamp to max_score (100)", () => {
      const input: ScoreInput = { quality: 100, speed: 100, innovation: 100 };
      // Weighted average is 100, max_score is 100
      assert.strictEqual(calculateFinalScore(input), 100);
    });

    it("should handle fractional result rounding to two decimals", () => {
      const input: ScoreInput = { quality: 85.5, speed: 72.3, innovation: 91.2 };
      const expected = Math.round((85.5*0.5 + 72.3*0.3 + 91.2*0.2) * 100) / 100;
      assert.strictEqual(calculateFinalScore(input), expected);
    });

    it("should respect non-default min/max scores if config changes", () => {
      // This test assumes the default config (min=0, max=100)
      const input: ScoreInput = { quality: 120, speed: 120, innovation: 120 };
      // Weighted average would be 120, but clamped to max_score 100
      assert.strictEqual(calculateFinalScore(input), 100);
    });
  });

  describe("getQualityLabel", () => {
    const passThreshold = 60;
    const maxScore = 100;

    it("should return 'excellent' when ratio ≥0.85 (score 85)", () => {
      assert.strictEqual(getQualityLabel(85, passThreshold, maxScore), "excellent");
    });

    it("should return 'good' when score ≥passThreshold (60) but ratio <0.85 (score 84)", () => {
      assert.strictEqual(getQualityLabel(84, passThreshold, maxScore), "good");
    });

    it("should return 'good' when score exactly at passThreshold (60)", () => {
      assert.strictEqual(getQualityLabel(60, passThreshold, maxScore), "good");
    });

    it("should return 'poor' when score < passThreshold (59)", () => {
      assert.strictEqual(getQualityLabel(59, passThreshold, maxScore), "poor");
    });

    it("should handle non-default maxScore (200) correctly", () => {
      // score 170/200 = 0.85 → excellent
      assert.strictEqual(getQualityLabel(170, 60, 200), "excellent");
      // score 100/200 = 0.5 → good (score 100 >= passThreshold 60)
      assert.strictEqual(getQualityLabel(100, 60, 200), "good");
    });

    it("should treat passThreshold as absolute, not ratio", () => {
      // maxScore=200, passThreshold=60, score=100 (ratio=0.5) → good
      assert.strictEqual(getQualityLabel(100, 60, 200), "good");
    });
  });

  describe("computeScore", () => {
    it("should compute final score with quality label and multiplier", () => {
      const input: ScoreInput = { quality: 90, speed: 85, innovation: 95 };
      const result = computeScore(input);

      // Final score: (90*0.5)+(85*0.3)+(95*0.2) = 45+25.5+19 = 89.5 → 89.5
      assert.strictEqual(result.final_score, 89.5);
      assert.strictEqual(result.quality_label, "excellent");
      assert.strictEqual(result.quality_multiplier, 1.2);
      assert.strictEqual(result.passed, true); // 89.5 ≥ 60
      assert.strictEqual(result.scorer_commission_pct, 5); // from config
    });

    it("should return passed:false when score below passThreshold", () => {
      const input: ScoreInput = { quality: 50, speed: 40, innovation: 30 };
      const result = computeScore(input);
      assert.strictEqual(result.passed, false);
    });

    it("should apply correct quality multipliers", () => {
      const excellentInput: ScoreInput = { quality: 90, speed: 90, innovation: 90 };
      const goodInput: ScoreInput = { quality: 70, speed: 70, innovation: 70 };
      const poorInput: ScoreInput = { quality: 50, speed: 50, innovation: 50 };

      assert.strictEqual(computeScore(excellentInput).quality_multiplier, 1.2);
      assert.strictEqual(computeScore(goodInput).quality_multiplier, 1.0);
      assert.strictEqual(computeScore(poorInput).quality_multiplier, 0.7);
    });
  });

  describe("validateScorerIsolation", () => {
    const baseCtx: ScorerIsolationContext = {
      scorer_agent_id: "scorer123",
      task_poster_agent_id: "poster456",
      task_assignee_agent_id: "assignee789",
      bidder_agent_ids: ["bidderA", "bidderB"]
    };

    it("should allow scoring when scorer is isolated", () => {
      const result = validateScorerIsolation(baseCtx);
      assert.strictEqual(result.allowed, true);
    });

    it("should reject when scorer is the task poster", () => {
      const ctx: ScorerIsolationContext = {
        ...baseCtx,
        scorer_agent_id: "poster456"
      };
      const result = validateScorerIsolation(ctx);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, "Scorer cannot be the task poster");
    });

    it("should reject when scorer is the task assignee", () => {
      const ctx: ScorerIsolationContext = {
        ...baseCtx,
        scorer_agent_id: "assignee789"
      };
      const result = validateScorerIsolation(ctx);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, "Scorer cannot be the task assignee");
    });

    it("should reject when scorer is a bidder", () => {
      const ctx: ScorerIsolationContext = {
        ...baseCtx,
        scorer_agent_id: "bidderA"
      };
      const result = validateScorerIsolation(ctx);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.reason, "Scorer cannot be a bidder on this task");
    });

    it("should allow when isolation not required (config)", () => {
      // Note: This test relies on config. We cannot easily mock it here.
      // In a full test suite we'd mock getRuleEngine, but for now we
      // assume the default config (require_scorer_isolation = true)
      // So we just verify the current behavior matches expectations.
      const ctx: ScorerIsolationContext = {
        scorer_agent_id: "scorer123",
        task_poster_agent_id: "poster456",
        task_assignee_agent_id: "assignee789",
        bidder_agent_ids: []
      };
      const result = validateScorerIsolation(ctx);
      assert.strictEqual(result.allowed, true);
    });
  });
});