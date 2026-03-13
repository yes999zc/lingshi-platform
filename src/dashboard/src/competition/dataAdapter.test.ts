import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advanceCompetitionScenario,
  COMPETITION_SCENARIO_IDS,
  createScenarioCompetitionData,
  type CompetitionScenarioId
} from "./dataAdapter";
import type { Agent } from "../types";

const agents: Agent[] = [
  {
    agent_id: "agent-alpha",
    name: "Alpha",
    tier: "Core",
    lingshi_balance: 120,
    status: "online",
    last_seen: new Date().toISOString()
  },
  {
    agent_id: "agent-beta",
    name: "Beta",
    tier: "Outer",
    lingshi_balance: 98,
    status: "online",
    last_seen: new Date().toISOString()
  }
];

describe("dashboard competition scenarios", () => {
  it("creates all built-in scenarios", () => {
    for (const scenarioId of COMPETITION_SCENARIO_IDS) {
      const data = createScenarioCompetitionData(scenarioId, agents);
      assert.equal(data.mode, "mock");
      assert.ok(data.tasks.length > 0);
      assert.ok(data.graphNodes.length >= 5);
      assert.ok(data.graphLinks.length >= 4);
    }
  });

  it("dominant scenario keeps top agent as winner", () => {
    const scenarioId: CompetitionScenarioId = "one_dominant_agent";
    const initial = createScenarioCompetitionData(scenarioId, agents);

    let tasks = initial.tasks;
    let results = initial.results;

    for (let tick = 1; tick <= 8; tick += 1) {
      const next = advanceCompetitionScenario(tasks, results, agents, scenarioId, tick);
      tasks = next.tasks;
      results = next.results;
    }

    assert.ok(results.length > 0);
    assert.equal(results[0].winner, "Alpha");
  });

  it("storm scenario injects additional tasks while capping queue length", () => {
    const scenarioId: CompetitionScenarioId = "high_frequency_task_storm";
    const initial = createScenarioCompetitionData(scenarioId, agents);

    let tasks = initial.tasks;
    let results = initial.results;

    for (let tick = 1; tick <= 20; tick += 1) {
      const next = advanceCompetitionScenario(tasks, results, agents, scenarioId, tick);
      tasks = next.tasks;
      results = next.results;
    }

    assert.ok(tasks.length <= 18);
    assert.ok(tasks.some((task) => task.title.includes("Storm Batch")));
    assert.ok(results.length > 0);
  });
});
