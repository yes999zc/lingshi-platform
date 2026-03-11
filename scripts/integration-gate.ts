import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocket } from "ws";

import { createServer } from "../src/server";

type GateStatus = "pass" | "fail";

interface GateResult {
  name: string;
  status: GateStatus;
  detail: string;
  durationMs: number;
}

export interface IntegrationGateSummary {
  passed: boolean;
  results: GateResult[];
}

interface ApiEnvelope<T> {
  data: T;
}

interface AgentRegisterResponse {
  agent: {
    agent_id: string;
  };
  token: string;
}

interface AgentPingResponse {
  agent: {
    agent_id: string;
  };
}

interface TaskCreateResponse {
  task: {
    id: string;
  };
}

interface BidCreateResponse {
  bid: {
    id: string;
  };
}

interface TaskMutationResponse {
  task: {
    id: string;
    status: string;
  };
}

interface SettlementResponse {
  settlement: {
    agent_id: string;
    amount: number;
    reason: string;
    idempotency_key: string;
  };
}

interface ErrorResponse {
  error: {
    code: string;
    details?: Record<string, unknown>;
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

interface IntegrationState {
  agentId?: string;
  token?: string;
  taskId?: string;
  bidId?: string;
  settlementIdempotencyKey?: string;
}

function parseJsonBody<T>(body: string): T {
  return JSON.parse(body) as T;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function runCheck(name: string, check: () => Promise<string> | string): Promise<GateResult> {
  const start = Date.now();

  try {
    const detail = await check();
    return {
      name,
      status: "pass",
      detail,
      durationMs: Date.now() - start
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: formatError(error),
      durationMs: Date.now() - start
    };
  }
}

function maybeLog(quiet: boolean, line: string) {
  if (!quiet) {
    console.log(line);
  }
}

function expectWebSocketHandshakeRejected(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("timed out waiting for websocket rejection"));
    }, 3000);

    const finish = (error?: Error, statusCode?: number) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (error) {
        reject(error);
        return;
      }

      resolve(statusCode ?? 0);
    };

    ws.once("open", () => {
      finish(new Error("expected websocket handshake to be rejected"));
    });

    ws.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();

      if (statusCode === 401 || statusCode === 403) {
        finish(undefined, statusCode);
        return;
      }

      finish(new Error(`expected websocket rejection status 401/403, received ${statusCode}`));
    });

    ws.once("error", (error) => {
      const match = /Unexpected server response: (\d{3})/.exec(error.message);

      if (match) {
        const statusCode = Number(match[1]);

        if (statusCode === 401 || statusCode === 403) {
          finish(undefined, statusCode);
          return;
        }
      }

      finish(error);
    });
  });
}

function expectWebSocketHandshakeAccepted(url: string, expectedAgentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("timed out waiting for websocket welcome message"));
    }, 3000);

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      ws.removeAllListeners();

      if (error) {
        ws.terminate();
        reject(error);
        return;
      }

      ws.close();
      resolve();
    };

    ws.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      finish(new Error(`expected websocket handshake success, received status ${statusCode}`));
    });

    ws.once("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; agent_id?: string | null };
        assert.equal(message.type, "welcome", "expected websocket welcome event");
        assert.equal(message.agent_id, expectedAgentId, "welcome event should include authenticated agent id");
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.once("error", (error) => {
      finish(error);
    });
  });
}

export async function runIntegrationGate(options: { quiet?: boolean } = {}): Promise<IntegrationGateSummary> {
  const quiet = options.quiet ?? false;
  const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-integration-gate-"));
  const dbPath = path.join(tmpDir, "lingshi.sqlite");
  const app = await createServer({ dbPath });
  app.log.level = "fatal";
  const state: IntegrationState = {};
  const results: GateResult[] = [];

  maybeLog(quiet, "Running integration gate checks...");

  try {
    await app.ready();

    const checks: Array<{ name: string; run: () => Promise<string> }> = [
      {
        name: "health",
        run: async () => {
          const response = await app.inject({
            method: "GET",
            url: "/health"
          });

          assert.equal(response.statusCode, 200, "health endpoint should return 200");
          const payload = parseJsonBody<{ status: string }>(response.body);
          assert.equal(payload.status, "ok", "health status should be ok");
          return "health endpoint returned status=ok";
        }
      },
      {
        name: "agent",
        run: async () => {
          const registerResponse = await app.inject({
            method: "POST",
            url: "/api/agents/register",
            payload: {
              name: "Integration Agent",
              capability_tags: ["analysis", "delivery"],
              initial_lingshi: 10
            }
          });

          assert.equal(registerResponse.statusCode, 201, "agent registration should return 201");
          const registerPayload = parseJsonBody<ApiEnvelope<AgentRegisterResponse>>(registerResponse.body);
          const agentId = registerPayload.data.agent.agent_id;
          const token = registerPayload.data.token;

          assert.ok(agentId, "agent id should be present");
          assert.ok(token, "agent token should be present");

          state.agentId = agentId;
          state.token = token;

          const pingResponse = await app.inject({
            method: "PUT",
            url: `/api/agents/${agentId}/ping`
          });

          assert.equal(pingResponse.statusCode, 200, "agent ping should return 200");
          const pingPayload = parseJsonBody<ApiEnvelope<AgentPingResponse>>(pingResponse.body);
          assert.equal(pingPayload.data.agent.agent_id, agentId, "agent ping should return the same agent");

          return `registered and pinged agent ${agentId}`;
        }
      },
      {
        name: "task-lifecycle",
        run: async () => {
          assert.ok(state.agentId, "agent id must be initialized before task lifecycle check");
          assert.ok(state.token, "token must be initialized before task lifecycle check");

          const authHeader = {
            authorization: `Bearer ${state.token}`
          };

          const createTaskResponse = await app.inject({
            method: "POST",
            url: "/api/tasks",
            payload: {
              title: "Integration lifecycle task",
              description: "Lifecycle matrix coverage",
              complexity: 3,
              bounty_lingshi: 120,
              required_tags: ["analysis"]
            }
          });

          assert.equal(createTaskResponse.statusCode, 201, "task creation should return 201");
          const createTaskPayload = parseJsonBody<ApiEnvelope<TaskCreateResponse>>(createTaskResponse.body);
          state.taskId = createTaskPayload.data.task.id;

          const unauthorizedBidResponse = await app.inject({
            method: "POST",
            url: `/api/tasks/${state.taskId}/bids`,
            payload: {
              agent_id: state.agentId,
              confidence: 0.9,
              estimated_cycles: 2,
              bid_stake: 15
            }
          });

          assert.equal(unauthorizedBidResponse.statusCode, 401, "unauthorized bid should be rejected");

          const bidResponse = await app.inject({
            method: "POST",
            url: `/api/tasks/${state.taskId}/bids`,
            headers: authHeader,
            payload: {
              agent_id: state.agentId,
              confidence: 0.9,
              estimated_cycles: 2,
              bid_stake: 15
            }
          });

          assert.equal(bidResponse.statusCode, 201, "authorized bid should be accepted");
          const bidPayload = parseJsonBody<ApiEnvelope<BidCreateResponse>>(bidResponse.body);
          state.bidId = bidPayload.data.bid.id;

          const assignResponse = await app.inject({
            method: "POST",
            url: `/api/tasks/${state.taskId}/assign`,
            headers: authHeader,
            payload: {
              bid_id: state.bidId
            }
          });

          assert.equal(assignResponse.statusCode, 200, "task assignment should return 200");
          const assignPayload = parseJsonBody<ApiEnvelope<TaskMutationResponse>>(assignResponse.body);
          assert.equal(assignPayload.data.task.status, "assigned", "task status should move to assigned");

          const submitResponse = await app.inject({
            method: "POST",
            url: `/api/tasks/${state.taskId}/submit`,
            headers: authHeader,
            payload: {
              result: {
                output: "integration-gate",
                metrics: {
                  elapsed_cycles: 2
                }
              }
            }
          });

          assert.equal(submitResponse.statusCode, 200, "task submission should return 200");
          const submitPayload = parseJsonBody<ApiEnvelope<TaskMutationResponse>>(submitResponse.body);
          assert.equal(submitPayload.data.task.status, "submitted", "task status should move to submitted");

          const scoreResponse = await app.inject({
            method: "POST",
            url: `/api/tasks/${state.taskId}/score`,
            headers: authHeader,
            payload: {
              quality: 92,
              speed: 88,
              innovation: 84,
              final_score: 90
            }
          });

          assert.equal(scoreResponse.statusCode, 200, "task scoring should return 200");
          const scorePayload = parseJsonBody<ApiEnvelope<TaskMutationResponse>>(scoreResponse.body);
          assert.equal(scorePayload.data.task.status, "scored", "task status should move to scored");

          const settleResponse = await app.inject({
            method: "POST",
            url: `/api/tasks/${state.taskId}/settle`,
            headers: authHeader,
            payload: {
              reason: "task_settlement"
            }
          });

          assert.equal(settleResponse.statusCode, 200, "task settlement should return 200");
          const settlePayload = parseJsonBody<ApiEnvelope<SettlementResponse>>(settleResponse.body);
          assert.equal(settlePayload.data.settlement.agent_id, state.agentId, "settlement should pay the assigned agent");
          assert.equal(settlePayload.data.settlement.amount, 108, "settlement amount should match score-weighted payout");
          assert.equal(settlePayload.data.settlement.reason, "task_settlement", "settlement reason should match request");

          state.settlementIdempotencyKey = settlePayload.data.settlement.idempotency_key;

          return `task ${state.taskId} reached settled state`;
        }
      },
      {
        name: "ledger-idempotency",
        run: async () => {
          assert.ok(state.token, "token must be initialized before idempotency check");
          assert.ok(state.taskId, "task id must be initialized before idempotency check");
          assert.ok(state.agentId, "agent id must be initialized before idempotency check");

          const authHeader = {
            authorization: `Bearer ${state.token}`
          };

          const duplicateSettleResponse = await app.inject({
            method: "POST",
            url: `/api/tasks/${state.taskId}/settle`,
            headers: authHeader,
            payload: {
              reason: "task_settlement"
            }
          });

          assert.equal(duplicateSettleResponse.statusCode, 409, "duplicate settlement should return 409");
          const duplicatePayload = parseJsonBody<ErrorResponse>(duplicateSettleResponse.body);
          assert.equal(duplicatePayload.error.code, "LEDGER_IDEMPOTENCY_CONFLICT", "duplicate settle should enforce idempotency");

          const ledgerResponse = await app.inject({
            method: "GET",
            url: "/api/ledger"
          });

          assert.equal(ledgerResponse.statusCode, 200, "ledger listing should return 200");
          const ledgerPayload = parseJsonBody<LedgerListResponse>(ledgerResponse.body);
          const settlementEntries = ledgerPayload.data.filter(
            (entry) =>
              entry.kind === "task_settlement" &&
              entry.task_id === state.taskId &&
              entry.agent_id === state.agentId &&
              entry.reason === "task_settlement"
          );

          assert.equal(settlementEntries.length, 1, "ledger should contain exactly one settlement entry for the task");

          if (state.settlementIdempotencyKey) {
            assert.equal(
              settlementEntries[0].idempotency_key,
              state.settlementIdempotencyKey,
              "ledger idempotency key should match settlement response"
            );
          }

          return "duplicate settle blocked and ledger remained single-entry";
        }
      },
      {
        name: "ws-auth",
        run: async () => {
          assert.ok(state.token, "token must be initialized before websocket auth check");
          assert.ok(state.agentId, "agent id must be initialized before websocket auth check");

          await app.listen({
            host: "127.0.0.1",
            port: 0
          });

          const address = app.server.address();

          if (!address || typeof address === "string") {
            throw new Error("unable to resolve websocket test address");
          }

          const baseWsUrl = `ws://127.0.0.1:${address.port}/ws`;
          await expectWebSocketHandshakeRejected(baseWsUrl);
          await expectWebSocketHandshakeRejected(`${baseWsUrl}?token=invalid-token`);
          await expectWebSocketHandshakeAccepted(`${baseWsUrl}?token=${encodeURIComponent(state.token)}`, state.agentId);

          return `websocket auth validated on port ${address.port}`;
        }
      }
    ];

    for (const check of checks) {
      const result = await runCheck(check.name, check.run);
      results.push(result);
      const label = result.status === "pass" ? "PASS" : "FAIL";
      maybeLog(quiet, `[${label}] ${result.name} (${result.durationMs}ms) - ${result.detail}`);
    }
  } finally {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const passed = results.every((result) => result.status === "pass");
  const passedCount = results.filter((result) => result.status === "pass").length;
  maybeLog(quiet, `integration gate ${passed ? "PASSED" : "FAILED"} (${passedCount}/${results.length})`);

  return {
    passed,
    results
  };
}

async function main() {
  const summary = await runIntegrationGate();

  if (!summary.passed) {
    process.exit(1);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
