import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LightMyRequestResponse } from "light-my-request";
import { WebSocket } from "ws";

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

function expectWebSocketHandshakeRejected(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;

      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    ws.once("open", () => {
      ws.close();
      finish(new Error("expected websocket handshake to be rejected"));
    });

    ws.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode;
      response.resume();
      ws.terminate();

      if (statusCode === 401 || statusCode === 403) {
        finish();
        return;
      }

      finish(new Error(`expected websocket rejection status 401/403, received ${statusCode ?? "unknown"}`));
    });

    ws.once("error", (error) => {
      const message = error.message;

      if (message.includes("Unexpected server response: 401") || message.includes("Unexpected server response: 403")) {
        finish();
        return;
      }

      finish(error);
    });
  });
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
    const bearerToken = registerAgentPayload.data.token;
    const authHeader = {
      authorization: `Bearer ${bearerToken}`
    };

    const scorerResponse = await app.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: {
        name: "Smoke Scorer",
        capability_tags: ["review"],
        initial_lingshi: 10
      }
    });

    assert.equal(scorerResponse.statusCode, 201, "scorer registration should succeed");
    const scorerPayload = parseJsonBody<ApiEnvelope<AgentRegisterResponse>>(scorerResponse);
    const scorerToken = scorerPayload.data.token;
    const scorerAuthHeader = {
      authorization: `Bearer ${scorerToken}`
    };

    const taskPosterResponse = await app.inject({
      method: "POST",
      url: "/api/agents/register",
      payload: {
        name: "Smoke Task Poster",
        capability_tags: ["poster"],
        initial_lingshi: 200
      }
    });

    assert.equal(taskPosterResponse.statusCode, 201, "task poster registration should succeed");
    const taskPosterPayload = parseJsonBody<ApiEnvelope<AgentRegisterResponse>>(taskPosterResponse);
    const taskPosterToken = taskPosterPayload.data.token;
    const taskPosterAuthHeader = {
      authorization: `Bearer ${taskPosterToken}`
    };

    const createTaskResponse = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: taskPosterAuthHeader,
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

    const unauthorizedBidResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/bids`,
      payload: {
        agent_id: agentId,
        confidence: 0.9,
        estimated_cycles: 2,
        bid_stake: 25
      }
    });

    assert.equal(unauthorizedBidResponse.statusCode, 401, "unauthorized bid should be rejected");

    const bidResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/bids`,
      headers: authHeader,
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

    const createAuxTask = async (index: number) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          title: `Aux task ${index}`,
          description: "Open bid cap coverage",
          complexity: 1,
          bounty_lingshi: 10,
          required_tags: ["analysis"]
        }
      });

      assert.equal(response.statusCode, 201, `aux task ${index} creation should succeed`);
      const payload = parseJsonBody<ApiEnvelope<TaskCreateResponse>>(response);
      return payload.data.task.id;
    };

    const auxTaskId1 = await createAuxTask(1);
    const auxTaskId2 = await createAuxTask(2);
    const auxTaskId3 = await createAuxTask(3);

    const auxBidResponse1 = await app.inject({
      method: "POST",
      url: `/api/tasks/${auxTaskId1}/bids`,
      headers: authHeader,
      payload: {
        agent_id: agentId,
        confidence: 0.8,
        estimated_cycles: 2,
        bid_stake: 5
      }
    });

    assert.equal(auxBidResponse1.statusCode, 201, "second open bid should succeed");

    const auxBidResponse2 = await app.inject({
      method: "POST",
      url: `/api/tasks/${auxTaskId2}/bids`,
      headers: authHeader,
      payload: {
        agent_id: agentId,
        confidence: 0.75,
        estimated_cycles: 3,
        bid_stake: 4
      }
    });

    assert.equal(auxBidResponse2.statusCode, 201, "third open bid should succeed");

    const cappedBidResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${auxTaskId3}/bids`,
      headers: authHeader,
      payload: {
        agent_id: agentId,
        confidence: 0.7,
        estimated_cycles: 3,
        bid_stake: 3
      }
    });

    assert.equal(cappedBidResponse.statusCode, 429, "open bid cap should block fourth open bid");

    const assignResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assign`,
      headers: authHeader,
      payload: {
        bid_id: bidId
      }
    });

    assert.equal(assignResponse.statusCode, 200, "assignment should succeed");

    const submitResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/submit`,
      headers: authHeader,
      payload: {
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
      headers: scorerAuthHeader,
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
      headers: authHeader,
      payload: {
        reason: "task_settlement"
      }
    });

    assert.equal(settleResponse.statusCode, 200, "settlement should succeed");
    const settlePayload = parseJsonBody<ApiEnvelope<SettlementResponse>>(settleResponse);
    assert.equal(settlePayload.data.settlement.agent_id, agentId, "settlement recipient should match assignee");
    assert.equal(settlePayload.data.settlement.amount, 107.04, "settlement payout should equal bounty * final_score");

    const duplicateSettleResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/settle`,
      headers: authHeader,
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

    await app.listen({
      host: "127.0.0.1",
      port: 0
    });

    const address = app.server.address();

    if (!address || typeof address === "string") {
      throw new Error("unable to resolve websocket test address");
    }

    await expectWebSocketHandshakeRejected(`ws://127.0.0.1:${address.port}/ws`);

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
