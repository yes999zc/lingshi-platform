import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebSocket } from "ws";

import { createAgentRateLimitMiddleware } from "../src/api/middleware/rate-limit";
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
    message: string;
    details: unknown;
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

interface MockReply {
  statusCode?: number;
  headers: Record<string, string>;
  payload?: unknown;
  header: (name: string, value: string) => MockReply;
  code: (statusCode: number) => MockReply;
  send: (payload: unknown) => MockReply;
}

function parseJsonBody<T>(body: string): T {
  return JSON.parse(body) as T;
}

function assertErrorEnvelope(payload: unknown, context: string): asserts payload is ErrorResponse {
  assert.equal(typeof payload, "object", `${context}: payload should be an object`);
  assert.notEqual(payload, null, `${context}: payload should not be null`);
  const candidate = payload as { error?: { code?: unknown; message?: unknown; details?: unknown } };
  assert.equal(typeof candidate.error, "object", `${context}: payload.error should be an object`);
  assert.notEqual(candidate.error, null, `${context}: payload.error should not be null`);
  assert.equal(typeof candidate.error?.code, "string", `${context}: payload.error.code should be a string`);
  assert.equal(typeof candidate.error?.message, "string", `${context}: payload.error.message should be a string`);
  assert.ok(
    Object.prototype.hasOwnProperty.call(candidate.error ?? {}, "details"),
    `${context}: payload.error.details should be present`
  );
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

function createMockReply(): MockReply {
  return {
    headers: {},
    header(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    code(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    }
  };
}

function expectWebSocketHandshakeRejected(url: string, acceptedStatuses: readonly number[] = [401, 403]): Promise<number> {
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

      if (acceptedStatuses.includes(statusCode)) {
        finish(undefined, statusCode);
        return;
      }

      finish(new Error(`expected websocket rejection status ${acceptedStatuses.join("/")}, received ${statusCode}`));
    });

    ws.once("error", (error) => {
      const match = /Unexpected server response: (\d{3})/.exec(error.message);

      if (match) {
        const statusCode = Number(match[1]);

        if (acceptedStatuses.includes(statusCode)) {
          finish(undefined, statusCode);
          return;
        }
      }

      finish(error);
    });
  });
}

function openWebSocketAndAwaitWelcome(
  url: string,
  expectedAgentId: string,
  options: ConstructorParameters<typeof WebSocket>[1] = {}
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
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
      ws.removeAllListeners("unexpected-response");
      ws.removeAllListeners("error");
      ws.removeAllListeners("message");

      if (error) {
        ws.terminate();
        reject(error);
        return;
      }

      resolve(ws);
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

function closeWebSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      resolve();
      return;
    }

    ws.once("close", () => resolve());
    ws.close();
  });
}

function waitForWebSocketClose(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for websocket close"));
    }, timeoutMs);

    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function expectWebSocketHandshakeAccepted(url: string, expectedAgentId: string): Promise<void> {
  const ws = await openWebSocketAndAwaitWelcome(url, expectedAgentId);
  await closeWebSocket(ws);
}

export async function runIntegrationGate(options: { quiet?: boolean } = {}): Promise<IntegrationGateSummary> {
  const quiet = options.quiet ?? false;
  const wsEnvOverrides: Record<string, string> = {
    WS_UPGRADE_RATE_LIMIT_PER_MINUTE: "30",
    WS_MAX_CONNECTIONS_PER_AGENT: "2",
    WS_HEARTBEAT_INTERVAL_MS: "120",
    WS_HEARTBEAT_TIMEOUT_MS: "200"
  };
  const previousWsEnv: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(wsEnvOverrides)) {
    previousWsEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-integration-gate-"));
  const dbPath = path.join(tmpDir, "lingshi.sqlite");
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  const state: IntegrationState = {};
  const results: GateResult[] = [];

  maybeLog(quiet, "Running integration gate checks...");

  try {
    app = await createServer({ dbPath });
    app.log.level = "fatal";
    await app.ready();

    const checks: Array<{ name: string; run: () => Promise<string> }> = [
      {
        name: "rate-limit-pruning",
        run: async () => {
          const middleware = createAgentRateLimitMiddleware({
            maxRequestsPerMinute: 1,
            maxTrackedKeys: 3
          });

          const callMiddleware = async (ip: string, agentId: string) => {
            const reply = createMockReply();
            await middleware(
              {
                ip,
                agentAuth: {
                  agentId
                }
              } as any,
              reply as any
            );
            return reply;
          };

          await callMiddleware("10.0.0.1", "agent-a");
          await callMiddleware("10.0.0.2", "agent-b");
          await callMiddleware("10.0.0.3", "agent-c");
          await callMiddleware("10.0.0.4", "agent-d");

          const firstReplayAfterEviction = await callMiddleware("10.0.0.1", "agent-a");
          assert.equal(
            firstReplayAfterEviction.statusCode,
            undefined,
            "oldest entry should be pruned/evicted when max tracked keys is exceeded"
          );

          const immediateSecondReplay = await callMiddleware("10.0.0.1", "agent-a");
          assert.equal(immediateSecondReplay.statusCode, 429, "rate limit should still apply after key re-tracking");
          assertErrorEnvelope(immediateSecondReplay.payload, "rate-limit-pruning envelope");
          assert.equal(
            (immediateSecondReplay.payload as ErrorResponse).error.code,
            "RATE_LIMIT_EXCEEDED",
            "rate-limit-pruning should keep existing error envelope code"
          );

          return "bounded key tracking retained rate-limit behavior and envelope";
        }
      },
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
          assert.match(
            settlePayload.data.settlement.idempotency_key,
            /^settle:v2:[a-f0-9]{64}$/,
            "settlement idempotency key should use hashed v2 format"
          );

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
              reason: "task_settlement_retry"
            }
          });

          assert.equal(duplicateSettleResponse.statusCode, 409, "duplicate settlement should return 409");
          const duplicatePayload = parseJsonBody<ErrorResponse>(duplicateSettleResponse.body);
          assert.equal(duplicatePayload.error.code, "LEDGER_IDEMPOTENCY_CONFLICT", "duplicate settle should enforce idempotency");

          if (state.settlementIdempotencyKey) {
            const details = duplicatePayload.error.details as { idempotency_key?: unknown } | undefined;
            assert.equal(
              details?.idempotency_key,
              state.settlementIdempotencyKey,
              "duplicate settlement should reference existing v2 idempotency key"
            );
          }

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
        name: "protected-error-envelope",
        run: async () => {
          assert.ok(state.taskId, "task id must be initialized before protected envelope check");

          const protectedRequests: Array<{ url: string; payload: Record<string, unknown> }> = [
            {
              url: `/api/tasks/${state.taskId}/bids`,
              payload: {
                agent_id: "missing-auth-agent",
                confidence: 0.1,
                estimated_cycles: 1,
                bid_stake: 0
              }
            },
            {
              url: `/api/tasks/${state.taskId}/assign`,
              payload: {
                bid_id: "missing-auth-bid"
              }
            },
            {
              url: `/api/tasks/${state.taskId}/submit`,
              payload: {
                result: { ok: true }
              }
            },
            {
              url: `/api/tasks/${state.taskId}/score`,
              payload: {
                quality: 10,
                speed: 10,
                innovation: 10
              }
            },
            {
              url: `/api/tasks/${state.taskId}/settle`,
              payload: {
                reason: "missing_auth"
              }
            }
          ];

          for (const request of protectedRequests) {
            const response = await app.inject({
              method: "POST",
              url: request.url,
              payload: request.payload
            });

            assert.equal(response.statusCode, 401, `${request.url} should reject missing auth with 401`);
            const payload = parseJsonBody<unknown>(response.body);
            assertErrorEnvelope(payload, `${request.url} missing auth`);
            assert.equal((payload as ErrorResponse).error.code, "AGENT_AUTH_REQUIRED");
          }

          const invalidHeaderResponse = await app.inject({
            method: "POST",
            url: protectedRequests[0].url,
            headers: {
              authorization: "Token not-bearer"
            },
            payload: protectedRequests[0].payload
          });

          assert.equal(invalidHeaderResponse.statusCode, 401, "invalid auth header format should return 401");
          const invalidHeaderPayload = parseJsonBody<unknown>(invalidHeaderResponse.body);
          assertErrorEnvelope(invalidHeaderPayload, "invalid auth header");
          assert.equal((invalidHeaderPayload as ErrorResponse).error.code, "AGENT_AUTH_INVALID");

          return "protected endpoint auth failures returned consistent error envelope";
        }
      },
      {
        name: "ws-hardening",
        run: async () => {
          assert.ok(state.token, "token must be initialized before websocket hardening check");
          assert.ok(state.agentId, "agent id must be initialized before websocket hardening check");

          await app.listen({
            host: "127.0.0.1",
            port: 0
          });

          const address = app.server.address();

          if (!address || typeof address === "string") {
            throw new Error("unable to resolve websocket test address");
          }

          const baseWsUrl = `ws://127.0.0.1:${address.port}/ws`;
          await expectWebSocketHandshakeRejected(baseWsUrl, [401]);
          const rejectedStatuses = await Promise.all(
            Array.from({ length: 8 }, (_unused, index) =>
              expectWebSocketHandshakeRejected(`${baseWsUrl}?token=invalid-token-${index}`, [401, 403])
            )
          );
          assert.equal(rejectedStatuses.length, 8, "invalid token burst should reject all websocket upgrades");
          assert.ok(
            rejectedStatuses.every((statusCode) => statusCode === 401 || statusCode === 403),
            "invalid token burst should only return unauthorized/forbidden statuses"
          );
          const authedWsUrl = `${baseWsUrl}?token=${encodeURIComponent(state.token)}`;

          await expectWebSocketHandshakeAccepted(authedWsUrl, state.agentId);
          await expectWebSocketHandshakeAccepted(authedWsUrl, state.agentId);

          const connectionA = await openWebSocketAndAwaitWelcome(authedWsUrl, state.agentId);
          const connectionB = await openWebSocketAndAwaitWelcome(authedWsUrl, state.agentId);
          const connectionCapStatus = await expectWebSocketHandshakeRejected(authedWsUrl, [403]);
          assert.equal(connectionCapStatus, 403, "third concurrent websocket for same agent should be rejected by cap");
          await Promise.all([closeWebSocket(connectionA), closeWebSocket(connectionB)]);

          const zombieSocket = await openWebSocketAndAwaitWelcome(authedWsUrl, state.agentId, { autoPong: false } as any);
          await waitForWebSocketClose(zombieSocket, 3000);

          const rateLimitedStatuses = await Promise.all(
            Array.from({ length: 20 }, (_unused, index) =>
              expectWebSocketHandshakeRejected(`${baseWsUrl}?token=invalid-rate-limit-${index}`, [401, 403, 429])
            )
          );
          assert.ok(
            rateLimitedStatuses.some((statusCode) => statusCode === 429),
            "upgrade burst should trigger websocket upgrade rate limiting"
          );

          return `websocket auth, cap, keepalive cleanup, and upgrade rate limiting validated on port ${address.port}`;
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
    if (app) {
      await app.close();
    }
    rmSync(tmpDir, { recursive: true, force: true });

    for (const [key, previousValue] of Object.entries(previousWsEnv)) {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
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
