import { getRuleEngine } from "./rule-engine";

/**
 * Scoring Engine - Calculates task scores with scorer isolation enforcement
 */

export type ScoreQuality = "excellent" | "good" | "poor";

export interface ScoreInput {
  quality: number;   // 0-100
  speed: number;     // 0-100
  innovation: number; // 0-100
}

export interface ScoreResult {
  final_score: number;
  quality_multiplier: number;
  quality_label: ScoreQuality;
  passed: boolean;
  scorer_commission_pct: number;
}

export interface ScorerIsolationContext {
  scorer_agent_id: string;
  task_poster_agent_id: string;
  task_assignee_agent_id: string;
  bidder_agent_ids: string[];
}

export interface ScorerIsolationResult {
  allowed: boolean;
  reason?: string;
}

// Quality multipliers based on final score
const QUALITY_MULTIPLIERS: Record<ScoreQuality, number> = {
  excellent: 1.2,
  good: 1.0,
  poor: 0.7
};

/**
 * Determine quality label from final score
 */
export function getQualityLabel(score: number, passThreshold: number, maxScore: number): ScoreQuality {
  const ratio = score / maxScore;
  if (ratio >= 0.85) return "excellent";
  if (score >= passThreshold) return "good";
  return "poor";
}

/**
 * Calculate final score from component scores
 * Weighted average: quality 50%, speed 30%, innovation 20%
 */
export function calculateFinalScore(input: ScoreInput): number {
  const rules = getRuleEngine().getConfig();
  const { min_score, max_score } = rules.scoring;

  const raw = input.quality * 0.5 + input.speed * 0.3 + input.innovation * 0.2;
  return Math.max(min_score, Math.min(max_score, Math.round(raw * 100) / 100));
}

/**
 * Full scoring calculation with multipliers and commission
 */
export function computeScore(input: ScoreInput): ScoreResult {
  const rules = getRuleEngine().getConfig();
  const { pass_threshold, max_score, scorer_commission_pct } = rules.scoring;

  const final_score = calculateFinalScore(input);
  const quality_label = getQualityLabel(final_score, pass_threshold, max_score);
  const quality_multiplier = QUALITY_MULTIPLIERS[quality_label];

  return {
    final_score,
    quality_multiplier,
    quality_label,
    passed: final_score >= pass_threshold,
    scorer_commission_pct
  };
}

/**
 * Validate scorer isolation: scorer must not be poster, assignee, or any bidder
 */
export function validateScorerIsolation(ctx: ScorerIsolationContext): ScorerIsolationResult {
  const rules = getRuleEngine().getConfig();

  if (!rules.scoring.require_scorer_isolation) {
    return { allowed: true };
  }

  if (ctx.scorer_agent_id === ctx.task_poster_agent_id) {
    return { allowed: false, reason: "Scorer cannot be the task poster" };
  }

  if (ctx.scorer_agent_id === ctx.task_assignee_agent_id) {
    return { allowed: false, reason: "Scorer cannot be the task assignee" };
  }

  if (ctx.bidder_agent_ids.includes(ctx.scorer_agent_id)) {
    return { allowed: false, reason: "Scorer cannot be a bidder on this task" };
  }

  return { allowed: true };
}
