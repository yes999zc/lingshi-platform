import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../server";

describe("AC-SM-06: concurrent bid race", () => {
  it("should reject duplicate bid from same agent with 409", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-bid-test-"));
    const dbPath = path.join(tmpDir, "lingshi.sqlite");
    const app = await createServer({ dbPath });
    app.log.level = "fatal";

    try {
      await app.ready();

      // Register agent
      const registerResponse = await app.inject({
        method: "POST",
        url: "/api/agents/register",
        payload: {
          name: "Test Agent",
          capability_tags: ["test"],
          initial_lingshi: 200
        }
      });

      assert.strictEqual(registerResponse.statusCode, 201, "agent registration should succeed");
      const registerPayload = JSON.parse(registerResponse.body) as {
        data: { agent: { agent_id: string }; token: string };
      };
      const agentId = registerPayload.data.agent.agent_id;
      const token = registerPayload.data.token;

      // Create task
      const createTaskResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: {
          authorization: `Bearer ${token}`
        },
        payload: {
          title: "Test Task",
          description: "Test concurrent bid",
          complexity: 1,
          bounty_lingshi: 100,
          required_tags: ["test"]
        }
      });

      assert.strictEqual(createTaskResponse.statusCode, 201, "task creation should succeed");
      const createTaskPayload = JSON.parse(createTaskResponse.body) as {
        data: { task: { id: string } };
      };
      const taskId = createTaskPayload.data.task.id;

      // Place first bid
      const firstBidResponse = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/bids`,
        headers: {
          authorization: `Bearer ${token}`
        },
        payload: {
          agent_id: agentId,
          confidence: 0.9,
          estimated_cycles: 5,
          bid_stake: 10
        }
      });

      assert.strictEqual(firstBidResponse.statusCode, 201, "first bid should succeed");

      // Place second bid (should fail with 409)
      const secondBidResponse = await app.inject({
        method: "POST",
        url: `/api/tasks/${taskId}/bids`,
        headers: {
          authorization: `Bearer ${token}`
        },
        payload: {
          agent_id: agentId,
          confidence: 0.95,
          estimated_cycles: 3,
          bid_stake: 15
        }
      });

      assert.strictEqual(secondBidResponse.statusCode, 409, "second bid should fail with 409");
      const secondBidPayload = JSON.parse(secondBidResponse.body) as {
        error: { code: string; message: string };
      };
      assert.strictEqual(secondBidPayload.error.code, "BID_ALREADY_EXISTS");
    } finally {
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should allow concurrent bids from different agents", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "lingshi-bid-test-"));
    const dbPath = path.join(tmpDir, "lingshi.sqlite");
    const app = await createServer({ dbPath });
    app.log.level = "fatal";

    try {
      await app.ready();

      // Register two agents
      const agent1Response = await app.inject({
        method: "POST",
        url: "/api/agents/register",
        payload: {
          name: "Agent 1",
          capability_tags: ["test"],
          initial_lingshi: 200
        }
      });

      const agent2Response = await app.inject({
        method: "POST",
        url: "/api/agents/register",
        payload: {
          name: "Agent 2",
          capability_tags: ["test"],
          initial_lingshi: 100
        }
      });

      assert.strictEqual(agent1Response.statusCode, 201);
      assert.strictEqual(agent2Response.statusCode, 201);

      const agent1Payload = JSON.parse(agent1Response.body) as {
        data: { agent: { agent_id: string }; token: string };
      };
      const agent2Payload = JSON.parse(agent2Response.body) as {
        data: { agent: { agent_id: string }; token: string };
      };

      const agent1Id = agent1Payload.data.agent.agent_id;
      const agent1Token = agent1Payload.data.token;
      const agent2Id = agent2Payload.data.agent.agent_id;
      const agent2Token = agent2Payload.data.token;

      // Create task
      const createTaskResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: {
          authorization: `Bearer ${agent1Token}`
        },
        payload: {
          title: "Test Task",
          description: "Test concurrent bid from different agents",
          complexity: 1,
          bounty_lingshi: 100,
          required_tags: ["test"]
        }
      });

      assert.strictEqual(createTaskResponse.statusCode, 201);
      const createTaskPayload = JSON.parse(createTaskResponse.body) as {
        data: { task: { id: string } };
      };
      const taskId = createTaskPayload.data.task.id;

      // Both agents bid concurrently
      const [bid1Response, bid2Response] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/tasks/${taskId}/bids`,
          headers: {
            authorization: `Bearer ${agent1Token}`
          },
          payload: {
            agent_id: agent1Id,
            confidence: 0.9,
            estimated_cycles: 5,
            bid_stake: 10
          }
        }),
        app.inject({
          method: "POST",
          url: `/api/tasks/${taskId}/bids`,
          headers: {
            authorization: `Bearer ${agent2Token}`
          },
          payload: {
            agent_id: agent2Id,
            confidence: 0.95,
            estimated_cycles: 3,
            bid_stake: 15
          }
        })
      ]);

      // Both bids should succeed (different agents)
      assert.strictEqual(bid1Response.statusCode, 201, "agent 1 bid should succeed");
      assert.strictEqual(bid2Response.statusCode, 201, "agent 2 bid should succeed");
    } finally {
      await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
