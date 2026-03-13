import { getRuleEngine } from "./rule-engine";

/**
 * Tier Manager - Handles agent tier promotion/demotion with grace period support
 */

export type AgentTier = "Outer" | "Core" | "Elder";

export interface AgentTierState {
  agent_id: string;
  current_tier: AgentTier;
  lingshi_balance: number;
  tasks_completed: number;
  grace_cycles_remaining: number;
}

export interface TierEvaluationResult {
  agent_id: string;
  previous_tier: AgentTier;
  new_tier: AgentTier;
  changed: boolean;
  direction: "promoted" | "demoted" | "unchanged";
  grace_cycles_remaining: number;
}

export interface TierInfo {
  name: AgentTier;
  min_lingshi: number;
  min_tasks_completed: number;
  bid_priority_weight: number;
}

/**
 * Get all tier definitions from config, sorted by requirement (ascending)
 */
export function getTierDefinitions(): TierInfo[] {
  const rules = getRuleEngine().getConfig();
  return Object.entries(rules.tier.tiers)
    .map(([name, def]) => ({
      name: name as AgentTier,
      min_lingshi: def.min_lingshi,
      min_tasks_completed: def.min_tasks_completed,
      bid_priority_weight: def.bid_priority_weight
    }))
    .sort((a, b) => a.min_lingshi - b.min_lingshi);
}

/**
 * Determine the highest tier an agent qualifies for based on current stats
 */
export function computeEligibleTier(lingshi_balance: number, tasks_completed: number): AgentTier {
  const tiers = getTierDefinitions();
  let eligible: AgentTier = "Outer";

  for (const tier of tiers) {
    if (lingshi_balance >= tier.min_lingshi && tasks_completed >= tier.min_tasks_completed) {
      eligible = tier.name;
    }
  }

  return eligible;
}

/**
 * Get bid priority weight for a given tier
 */
export function getTierBidWeight(tier: AgentTier): number {
  const rules = getRuleEngine().getConfig();
  const tierDef = rules.tier.tiers[tier];
  if (!tierDef) {
    return 1; // Default to Outer weight
  }
  return tierDef.bid_priority_weight;
}

/**
 * Evaluate tier change for an agent, applying demotion grace period
 * Grace period: agent gets N cycles before demotion takes effect
 */
export function evaluateTierChange(state: AgentTierState): TierEvaluationResult {
  const rules = getRuleEngine().getConfig();
  const { demotion_grace_cycles } = rules.tier;

  const eligible_tier = computeEligibleTier(state.lingshi_balance, state.tasks_completed);

  const tierOrder: AgentTier[] = ["Outer", "Core", "Elder"];
  const currentIdx = tierOrder.indexOf(state.current_tier);
  const eligibleIdx = tierOrder.indexOf(eligible_tier);

  // Promotion: immediate
  if (eligibleIdx > currentIdx) {
    return {
      agent_id: state.agent_id,
      previous_tier: state.current_tier,
      new_tier: eligible_tier,
      changed: true,
      direction: "promoted",
      grace_cycles_remaining: 0
    };
  }

  // Demotion: apply grace period
  if (eligibleIdx < currentIdx) {
    const remaining = state.grace_cycles_remaining;

    if (remaining > 0) {
      // Still in grace period — no demotion yet
      return {
        agent_id: state.agent_id,
        previous_tier: state.current_tier,
        new_tier: state.current_tier,
        changed: false,
        direction: "unchanged",
        grace_cycles_remaining: remaining - 1
      };
    }

    // Grace period exhausted — demote
    return {
      agent_id: state.agent_id,
      previous_tier: state.current_tier,
      new_tier: eligible_tier,
      changed: true,
      direction: "demoted",
      grace_cycles_remaining: 0
    };
  }

  // No change
  return {
    agent_id: state.agent_id,
    previous_tier: state.current_tier,
    new_tier: state.current_tier,
    changed: false,
    direction: "unchanged",
    grace_cycles_remaining: 0  // P0-02 fix: stable agents should have 0, not reset to max
  };
}
