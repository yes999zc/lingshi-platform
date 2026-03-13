import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { evaluateTierChange, computeEligibleTier } from "./tier-manager";
import { getRuleEngine } from "./rule-engine";
import type { AgentTierState } from "./tier-manager";

before(async () => {
  // Initialize rule engine
  const result = getRuleEngine().load();
  if (!result.valid) {
    throw new Error(`Failed to load rules: ${result.errors.join(", ")}`);
  }
});

describe("tier-manager P0-02 fix: grace_cycles_remaining bug", () => {
  it("should return grace_cycles_remaining=0 for stable agents at Outer tier", () => {
    const state: AgentTierState = {
      agent_id: "a1",
      current_tier: "Outer",
      lingshi_balance: 10,
      tasks_completed: 1,
      grace_cycles_remaining: 0
    };

    const result = evaluateTierChange(state);

    assert.equal(result.grace_cycles_remaining, 0, "Stable agent should have 0 grace cycles, not reset to max");
    assert.equal(result.changed, false);
    assert.equal(result.direction, "unchanged");
  });

  it("should return grace_cycles_remaining=0 for stable agents at Core tier", () => {
    const state: AgentTierState = {
      agent_id: "a2",
      current_tier: "Core",
      lingshi_balance: 600,
      tasks_completed: 15,
      grace_cycles_remaining: 0
    };

    const result = evaluateTierChange(state);

    assert.equal(result.grace_cycles_remaining, 0, "Stable Core agent should have 0 grace cycles");
    assert.equal(result.changed, false);
    assert.equal(result.direction, "unchanged");
  });

  it("should decrement grace_cycles_remaining when agent is at risk of demotion", () => {
    const state: AgentTierState = {
      agent_id: "a3",
      current_tier: "Core",
      lingshi_balance: 400,  // Below Core threshold (500)
      tasks_completed: 15,
      grace_cycles_remaining: 1
    };

    const result = evaluateTierChange(state);

    assert.equal(result.grace_cycles_remaining, 0, "Grace period should decrement to 0");
    assert.equal(result.changed, false, "Should not demote yet");
    assert.equal(result.direction, "unchanged");
  });

  it("should demote agent when grace period is exhausted", () => {
    const state: AgentTierState = {
      agent_id: "a4",
      current_tier: "Core",
      lingshi_balance: 400,  // Below Core threshold (500)
      tasks_completed: 15,
      grace_cycles_remaining: 0
    };

    const result = evaluateTierChange(state);

    assert.equal(result.changed, true, "Should demote when grace exhausted");
    assert.equal(result.direction, "demoted");
    assert.equal(result.new_tier, "Outer");
    assert.equal(result.grace_cycles_remaining, 0);
  });

  it("should promote agent immediately without grace period", () => {
    const state: AgentTierState = {
      agent_id: "a5",
      current_tier: "Outer",
      lingshi_balance: 600,
      tasks_completed: 15,
      grace_cycles_remaining: 0
    };

    const result = evaluateTierChange(state);

    assert.equal(result.changed, true);
    assert.equal(result.direction, "promoted");
    assert.equal(result.new_tier, "Core");
    assert.equal(result.grace_cycles_remaining, 0);
  });
});

describe("tier-manager: computeEligibleTier", () => {
  it("should return Outer for agents below all thresholds", () => {
    assert.equal(computeEligibleTier(0, 0), "Outer");
    assert.equal(computeEligibleTier(100, 5), "Outer");
  });

  it("should return Core for agents meeting Core thresholds", () => {
    assert.equal(computeEligibleTier(500, 10), "Core");
    assert.equal(computeEligibleTier(600, 15), "Core");
  });

  it("should return Elder for agents meeting Elder thresholds", () => {
    assert.equal(computeEligibleTier(5000, 50), "Elder");
    assert.equal(computeEligibleTier(10000, 100), "Elder");
  });

  it("should require both lingshi AND tasks to qualify for tier", () => {
    assert.equal(computeEligibleTier(5000, 5), "Outer", "High lingshi but low tasks");
    assert.equal(computeEligibleTier(100, 50), "Outer", "High tasks but low lingshi");
  });
});
