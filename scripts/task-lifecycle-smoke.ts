import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LightMyRequestResponse } from "light-my-request";

import { createServer } from "../src/server";

interface ApiEnvelope<T> {
  data: T;
}

interface AgentRegisterResponse {
  agent: {
    agent_id: string;
  };
  token: string;
}

interface TaskCreateResponse {
  task: {
    id: string;
  };
}

interface BidCreateResponse {
  bid: {
    id: string;
    agent_id: string;
  };
}

interface SettlementResponse {
  settlement: {
    agent_id: string;
    amount: number;
  };
}

interface LedgerListResponse {
  data: Array<{
    id: string;
    kind: string;
    task_id: string | null;
    agent_id: string | null;
    reason: string | null;
    idempotency_key: string | null;
    amount: number;
  }>;
}

function parseJsonBody<T>(response: LightMyRequestResponse): T {
  return JSON.parse(response.body) as T;
}

async function main() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-day4-smoke-"));
  const dbPath = path.join(tmpDir, "lingshi.sqlite");
  const app = await createServer({ dbPath });

  try {
    await app.ready();

    const registerAgentResponse = await app.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: {
        name: "Smoke Agent",
        capability_tags: ["analysis", "delivery"],
        initial_lingshi: 10
      }
    });

    assert.equal(registerAgentResponse.statusCode, 201, "agent registration should succeed");
    const registerAgentPayload = parseJsonBody<ApiEnvelope<AgentRegisterResponse>>(registerAgentResponse);
    const agentId = registerAgentPayload.data.agent.agent_id;

    const createTaskResponse = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Smoke task",
        description: "End-to-end lifecycle check",
        complexity: 3,
        bounty_lingshi: 120,
        required_tags: ["analysis"]
      }
    });

    assert.equal(createTaskResponse.statusCode, 201, "task creation should succeed");
    const createTaskPayload = parseJsonBody<ApiEnvelope<TaskCreateResponse>>(createTaskResponse);
    const taskId = createTaskPayload.data.task.id;

    const bidResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/bids`,
      payload: {
        agent_id: agentId,
        confidence: 0.9,
        estimated_cycles: 2,
        bid_stake: 25
      }
    });

    assert.equal(bidResponse.statusCode, 201, "bid should be accepted");
    const bidPayload = parseJsonBody<ApiEnvelope<BidCreateResponse>>(bidResponse);
    const bidId = bidPayload.data.bid.id;

    const assignResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assign`,
      payload: {
        bid_id: bidId
      }
    });

    assert.equal(assignResponse.statusCode, 200, "assignment should succeed");

    const submitResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/submit`,
      payload: {
        agent_id: agentId,
        result: {
          output: "done",
          metrics: {
            elapsed_cycles: 2
          }
        }
      }
    });

    assert.equal(submitResponse.statusCode, 200, "submission should succeed");

    const scoreResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/score`,
      payload: {
        quality: 92,
        speed: 88,
        innovation: 84,
        final_score: 90
      }
    });

    assert.equal(scoreResponse.statusCode, 200, "scoring should succeed");

    const settleResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/settle`,
      payload: {
        reason: "task_settlement"
      }
    });

    assert.equal(settleResponse.statusCode, 200, "settlement should succeed");
    const settlePayload = parseJsonBody<ApiEnvelope<SettlementResponse>>(settleResponse);
    assert.equal(settlePayload.data.settlement.agent_id, agentId, "settlement recipient should match assignee");
    assert.equal(settlePayload.data.settlement.amount, 108, "settlement payout should equal bounty * final_score");

    const duplicateSettleResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/settle`,
      payload: {
        reason: "task_settlement"
      }
    });

    assert.equal(duplicateSettleResponse.statusCode, 409, "duplicate settlement should be blocked");

    const ledgerResponse = await app.inject({
      method: "GET",
      url: "/api/ledger"
    });

    assert.equal(ledgerResponse.statusCode, 200, "ledger endpoint should succeed");
    const ledgerPayload = parseJsonBody<LedgerListResponse>(ledgerResponse);

    const settlementEntries = ledgerPayload.data.filter(
      (entry) =>
        entry.kind === "task_settlement" &&
        entry.task_id === taskId &&
        entry.agent_id === agentId &&
        entry.reason === "task_settlement"
    );

    assert.equal(settlementEntries.length, 1, "ledger should contain exactly one settlement entry");

    console.log("task lifecycle smoke checks passed");
  } finally {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
