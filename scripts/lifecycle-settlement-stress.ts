import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
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
    idempotency_key: string;
    amount: number;
  };
}

interface ErrorResponse {
  error: {
    code: string;
    details?: Record<string, unknown> | null;
  };
}

interface LedgerResponse {
  data: Array<{
    task_id: string | null;
    reason: string | null;
    idempotency_key: string | null;
    kind: string;
  }>;
}

interface AgentDetailsResponse {
  data: {
    agent: {
      lingshi_balance: number;
    };
  };
}

interface AgentIdentity {
  agentId: string;
  token: string;
}

function parseJsonBody<T>(response: LightMyRequestResponse): T {
  return JSON.parse(response.body) as T;
}

async function registerAgent(app: Awaited<ReturnType<typeof createServer>>, name: string): Promise<AgentIdentity> {
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/register",
    payload: {
      name,
      capability_tags: ["stress", "concurrency"],
      initial_lingshi: 10
    }
  });

  assert.equal(response.statusCode, 201, "agent registration should succeed");
  const payload = parseJsonBody<ApiEnvelope<AgentRegisterResponse>>(response);

  return {
    agentId: payload.data.agent.agent_id,
    token: payload.data.token
  };
}

async function main() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-stress-"));
  const dbPath = path.join(tmpDir, "lingshi.sqlite");
  const app = await createServer({ dbPath });
  app.log.level = "fatal";

  try {
    await app.ready();

    const agents = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => registerAgent(app, `Stress Agent ${index + 1}`))
    );
    const scorer = await registerAgent(app, "Stress Scorer");

    const createTaskResponse = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Stress task",
        description: "Parallel bid and settle race coverage",
        complexity: 3,
        bounty_lingshi: 100,
        required_tags: ["stress"]
      }
    });

    assert.equal(createTaskResponse.statusCode, 201, "task creation should succeed");
    const createTaskPayload = parseJsonBody<ApiEnvelope<TaskCreateResponse>>(createTaskResponse);
    const taskId = createTaskPayload.data.task.id;

    const bidResponses = await Promise.all(
      agents.map((agent, index) =>
        app.inject({
          method: "POST",
          url: `/api/tasks/${taskId}/bids`,
          headers: {
            authorization: `Bearer ${agent.token}`
          },
          payload: {
            agent_id: agent.agentId,
            confidence: 0.95 - index * 0.01,
            estimated_cycles: 2 + index,
            bid_stake: 1 + index
          }
        })
      )
    );

    const acceptedBidResponses = bidResponses.filter((response) => response.statusCode === 201);
    assert.equal(
      acceptedBidResponses.length,
      agents.length,
      `all parallel bids should be accepted, received ${acceptedBidResponses.length}/${agents.length}`
    );

    const firstBidPayload = parseJsonBody<ApiEnvelope<BidCreateResponse>>(acceptedBidResponses[0]);
    const winningBidId = firstBidPayload.data.bid.id;
    const winningAgentId = firstBidPayload.data.bid.agent_id;
    const winningAgent = agents.find((agent) => agent.agentId === winningAgentId);

    if (!winningAgent) {
      throw new Error("winning bid agent should be in registered agent list");
    }

    const assignResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assign`,
      headers: {
        authorization: `Bearer ${winningAgent.token}`
      },
      payload: {
        bid_id: winningBidId
      }
    });
    assert.equal(assignResponse.statusCode, 200, "assignment should succeed");

    const submitResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/submit`,
      headers: {
        authorization: `Bearer ${winningAgent.token}`
      },
      payload: {
        result: {
          stress_run: true
        }
      }
    });
    assert.equal(submitResponse.statusCode, 200, "submission should succeed");

    const scoreResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/score`,
      headers: {
        authorization: `Bearer ${scorer.token}`
      },
      payload: {
        quality: 100,
        speed: 100,
        innovation: 100,
        final_score: 100
      }
    });
    assert.equal(scoreResponse.statusCode, 200, "scoring should succeed");

    const settleReason = "stress_settlement";
    const settleAttempts = 24;
    const settleResponses = await Promise.all(
      Array.from({ length: settleAttempts }, () =>
        app.inject({
          method: "POST",
          url: `/api/tasks/${taskId}/settle`,
          headers: {
            authorization: `Bearer ${winningAgent.token}`
          },
          payload: {
            reason: settleReason
          }
        })
      )
    );

    const settleSuccessResponses = settleResponses.filter((response) => response.statusCode === 200);
    assert.equal(settleSuccessResponses.length, 1, "exactly one parallel settlement should succeed");

    const settleConflictResponses = settleResponses.filter((response) => response.statusCode === 409);
    assert.equal(
      settleSuccessResponses.length + settleConflictResponses.length,
      settleResponses.length,
      "all remaining parallel settlement attempts should return conflict"
    );

    for (const response of settleConflictResponses) {
      const payload = parseJsonBody<ErrorResponse>(response);
      assert.equal(payload.error.code, "LEDGER_IDEMPOTENCY_CONFLICT", "parallel settle conflict should be idempotency conflict");
    }

    const successPayload = parseJsonBody<ApiEnvelope<SettlementResponse>>(settleSuccessResponses[0]);
    assert.equal(successPayload.data.settlement.amount, 100, "settlement should pay expected bounty");
    const idempotencyKey = successPayload.data.settlement.idempotency_key;
    assert.match(
      idempotencyKey,
      /^settle:v2:[a-f0-9]{64}$/,
      "settlement idempotency key should use v2 hashed format"
    );

    const duplicateDifferentReasonResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/settle`,
      headers: {
        authorization: `Bearer ${winningAgent.token}`
      },
      payload: {
        reason: "stress_settlement_alt_reason"
      }
    });
    assert.equal(
      duplicateDifferentReasonResponse.statusCode,
      409,
      "duplicate settlement in same cycle should be blocked even with different reason"
    );
    const duplicateDifferentReasonPayload = parseJsonBody<ErrorResponse>(duplicateDifferentReasonResponse);
    assert.equal(
      duplicateDifferentReasonPayload.error.code,
      "LEDGER_IDEMPOTENCY_CONFLICT",
      "cross-reason duplicate settle should still be idempotency conflict"
    );

    const ledgerResponse = await app.inject({
      method: "GET",
      url: "/api/ledger"
    });
    assert.equal(ledgerResponse.statusCode, 200, "ledger listing should succeed");
    const ledgerPayload = parseJsonBody<LedgerResponse>(ledgerResponse);
    const matchingSettlements = ledgerPayload.data.filter(
      (entry) =>
        entry.kind === "task_settlement" &&
        entry.task_id === taskId &&
        entry.reason === settleReason &&
        entry.idempotency_key === idempotencyKey
    );
    assert.equal(matchingSettlements.length, 1, "ledger should contain a single settlement entry for idempotency key");

    const agentResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${winningAgent.agentId}`
    });
    assert.equal(agentResponse.statusCode, 200, "agent details should succeed");
    const agentPayload = parseJsonBody<AgentDetailsResponse>(agentResponse);
    assert.equal(agentPayload.data.agent.lingshi_balance, 110, "winner balance should be credited exactly once");

    const legacyTaskCreateResponse = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Legacy idempotency compatibility task",
        description: "Ensure v2 settle flow still detects legacy key duplicates",
        complexity: 2,
        bounty_lingshi: 50,
        required_tags: ["stress", "legacy"]
      }
    });
    assert.equal(legacyTaskCreateResponse.statusCode, 201, "legacy compatibility task creation should succeed");
    const legacyTaskPayload = parseJsonBody<ApiEnvelope<TaskCreateResponse>>(legacyTaskCreateResponse);
    const legacyTaskId = legacyTaskPayload.data.task.id;

    const legacyBidResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${legacyTaskId}/bids`,
      headers: {
        authorization: `Bearer ${winningAgent.token}`
      },
      payload: {
        agent_id: winningAgent.agentId,
        confidence: 0.99,
        estimated_cycles: 1,
        bid_stake: 5
      }
    });
    assert.equal(legacyBidResponse.statusCode, 201, "legacy compatibility bid should succeed");
    const legacyBidPayload = parseJsonBody<ApiEnvelope<BidCreateResponse>>(legacyBidResponse);
    const legacyBidId = legacyBidPayload.data.bid.id;

    const legacyAssignResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${legacyTaskId}/assign`,
      headers: {
        authorization: `Bearer ${winningAgent.token}`
      },
      payload: {
        bid_id: legacyBidId
      }
    });
    assert.equal(legacyAssignResponse.statusCode, 200, "legacy compatibility assignment should succeed");

    const legacySubmitResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${legacyTaskId}/submit`,
      headers: {
        authorization: `Bearer ${winningAgent.token}`
      },
      payload: {
        result: {
          legacy_path: true
        }
      }
    });
    assert.equal(legacySubmitResponse.statusCode, 200, "legacy compatibility submit should succeed");

    const legacyScoreResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${legacyTaskId}/score`,
      headers: {
        authorization: `Bearer ${scorer.token}`
      },
      payload: {
        quality: 80,
        speed: 80,
        innovation: 80,
        final_score: 80
      }
    });
    assert.equal(legacyScoreResponse.statusCode, 200, "legacy compatibility score should succeed");

    const legacyReason = "legacy_settlement";
    const legacyIdempotencyKey = `${legacyTaskId}:${legacyReason}:${winningAgent.agentId}`;
    const legacyLedgerId = randomUUID();
    const insertedAt = new Date().toISOString();
    const legacyDb = new Database(dbPath);

    try {
      legacyDb
        .prepare(
          `
            INSERT INTO ledger (
              id,
              entity_id,
              task_id,
              agent_id,
              reason,
              idempotency_key,
              entry_type,
              amount,
              currency,
              note,
              created_at
            ) VALUES (
              @id,
              @entity_id,
              @task_id,
              @agent_id,
              @reason,
              @idempotency_key,
              @entry_type,
              @amount,
              @currency,
              @note,
              @created_at
            )
          `
        )
        .run({
          id: legacyLedgerId,
          entity_id: winningAgent.agentId,
          task_id: legacyTaskId,
          agent_id: winningAgent.agentId,
          reason: legacyReason,
          idempotency_key: legacyIdempotencyKey,
          entry_type: "task_settlement",
          amount: 40,
          currency: "LSP",
          note: JSON.stringify({
            task_id: legacyTaskId,
            reason: legacyReason,
            injected_for: "legacy_idempotency_compat"
          }),
          created_at: insertedAt
        });
    } finally {
      legacyDb.close();
    }

    const legacyDuplicateSettleResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${legacyTaskId}/settle`,
      headers: {
        authorization: `Bearer ${winningAgent.token}`
      },
      payload: {
        reason: legacyReason
      }
    });
    assert.equal(
      legacyDuplicateSettleResponse.statusCode,
      409,
      "legacy key should still block duplicate settlement attempts"
    );
    const legacyDuplicatePayload = parseJsonBody<ErrorResponse>(legacyDuplicateSettleResponse);
    assert.equal(
      legacyDuplicatePayload.error.code,
      "LEDGER_IDEMPOTENCY_CONFLICT",
      "legacy duplicate settle should map to idempotency conflict"
    );
    const legacyDuplicateDetails = legacyDuplicatePayload.error.details as { idempotency_key?: unknown } | undefined;
    assert.equal(
      legacyDuplicateDetails?.idempotency_key,
      legacyIdempotencyKey,
      "legacy duplicate conflict should report the existing legacy idempotency key"
    );

    const legacyLedgerResponse = await app.inject({
      method: "GET",
      url: "/api/ledger"
    });
    assert.equal(legacyLedgerResponse.statusCode, 200, "legacy ledger listing should succeed");
    const legacyLedgerPayload = parseJsonBody<LedgerResponse>(legacyLedgerResponse);
    const legacyTaskSettlementEntries = legacyLedgerPayload.data.filter(
      (entry) =>
        entry.kind === "task_settlement" &&
        entry.task_id === legacyTaskId &&
        entry.reason === legacyReason &&
        entry.idempotency_key === legacyIdempotencyKey
    );
    assert.equal(
      legacyTaskSettlementEntries.length,
      1,
      "legacy idempotency scenario should keep a single matching settlement ledger entry"
    );

    console.log(
      `stress PASS: ${agents.length} parallel bids accepted, ${settleSuccessResponses.length}/${settleAttempts} parallel settles applied, v2/legacy idempotency checks confirmed`
    );
  } finally {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
