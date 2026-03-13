import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createServer } from "../server";

interface ApiEnvelope<T> {
  data: T;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown> | null;
  };
}

interface AgentRegisterResponse {
  agent: {
    agent_id: string;
    lingshi_balance: number;
  };
  token: string;
}

interface AgentDetailsResponse {
  agent: {
    lingshi_balance: number;
  };
}

interface TaskCreateResponse {
  task: {
    id: string;
  };
}

interface LedgerListResponse {
  data: Array<{
    task_id: string | null;
    agent_id: string | null;
    kind: string;
    reason: string | null;
    amount: number;
  }>;
}

function parseJsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function registerAgent(app: Awaited<ReturnType<typeof createServer>>, initialLingshi: number) {
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/register",
    payload: {
      name: "Poster",
      capability_tags: ["analysis"],
      initial_lingshi: initialLingshi
    }
  });

  assert.equal(response.statusCode, 201, "agent registration should succeed");
  const payload = parseJsonBody<ApiEnvelope<AgentRegisterResponse>>(response);

  return {
    agentId: payload.data.agent.agent_id,
    token: payload.data.token
  };
}

describe("tasks API balance escrow", () => {
  it("debits poster balance and writes task escrow ledger entry at task creation", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-task-escrow-test-"));
    const dbPath = path.join(tmpDir, "lingshi.sqlite");
    const app = await createServer({ dbPath });

    try {
      await app.ready();

      const poster = await registerAgent(app, 200);
      const authHeader = { authorization: `Bearer ${poster.token}` };

      const createTaskResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: authHeader,
        payload: {
          title: "Escrowed task",
          description: "Poster escrow verification",
          complexity: 2,
          bounty_lingshi: 120,
          required_tags: ["analysis"]
        }
      });

      assert.equal(createTaskResponse.statusCode, 201, "task creation should succeed");
      const createTaskPayload = parseJsonBody<ApiEnvelope<TaskCreateResponse>>(createTaskResponse);
      const taskId = createTaskPayload.data.task.id;

      const agentDetailsResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${poster.agentId}`
      });

      assert.equal(agentDetailsResponse.statusCode, 200, "agent lookup should succeed");
      const agentDetailsPayload = parseJsonBody<ApiEnvelope<AgentDetailsResponse>>(agentDetailsResponse);
      assert.equal(
        agentDetailsPayload.data.agent.lingshi_balance,
        80,
        "poster balance should be debited by task bounty for escrow"
      );

      const ledgerResponse = await app.inject({
        method: "GET",
        url: "/api/ledger"
      });

      assert.equal(ledgerResponse.statusCode, 200, "ledger listing should succeed");
      const ledgerPayload = parseJsonBody<LedgerListResponse>(ledgerResponse);
      const escrowEntry = ledgerPayload.data.find(
        (entry) =>
          entry.task_id === taskId &&
          entry.agent_id === poster.agentId &&
          entry.kind === "task_escrow" &&
          entry.reason === "task_escrow"
      );

      assert.ok(escrowEntry, "task escrow ledger entry should exist");
      assert.equal(escrowEntry.amount, -120, "task escrow ledger entry should debit full bounty amount");
    } finally {
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects task creation when poster balance is insufficient with expected status and error code", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-task-insufficient-test-"));
    const dbPath = path.join(tmpDir, "lingshi.sqlite");
    const app = await createServer({ dbPath });

    try {
      await app.ready();

      const poster = await registerAgent(app, 50);
      const authHeader = { authorization: `Bearer ${poster.token}` };

      const createTaskResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: authHeader,
        payload: {
          title: "Insufficient escrow task",
          description: "Should fail",
          complexity: 2,
          bounty_lingshi: 120,
          required_tags: ["analysis"]
        }
      });

      assert.equal(createTaskResponse.statusCode, 400, "insufficient poster balance should return 400");
      const errorPayload = parseJsonBody<ErrorEnvelope>(createTaskResponse);
      assert.equal(errorPayload.error.code, "AGENT_INSUFFICIENT_BALANCE", "error code should match");
      assert.equal(errorPayload.error.details?.required_amount, 120, "required_amount should equal task bounty");
      assert.equal(errorPayload.error.details?.balance, 50, "error details should include current balance");

      const listTasksResponse = await app.inject({
        method: "GET",
        url: "/api/tasks"
      });

      assert.equal(listTasksResponse.statusCode, 200, "task listing should succeed");
      const taskListPayload = parseJsonBody<ApiEnvelope<{ tasks: Array<{ id: string }> }>>(listTasksResponse);
      assert.equal(taskListPayload.data.tasks.length, 0, "failed task creation should not persist a task");

      const agentDetailsResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${poster.agentId}`
      });

      assert.equal(agentDetailsResponse.statusCode, 200, "agent lookup should succeed");
      const agentDetailsPayload = parseJsonBody<ApiEnvelope<AgentDetailsResponse>>(agentDetailsResponse);
      assert.equal(agentDetailsPayload.data.agent.lingshi_balance, 50, "failed task creation should not debit balance");
    } finally {
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
