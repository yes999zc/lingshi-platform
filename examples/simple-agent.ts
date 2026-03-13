import assert from "node:assert/strict";

const BASE_URL = process.env.LINGSHI_BASE_URL ?? "http://127.0.0.1:3000";

interface AgentRegisterResponse {
  data: {
    agent: {
      agent_id: string;
      tier: string;
    };
    token: string;
  };
}

interface TasksResponse {
  data: {
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      bounty_lingshi: number;
    }>;
  };
}

interface TaskResponse {
  data: {
    task: {
      id: string;
      status: string;
      agent_id: string | null;
      bounty_lingshi: number;
    };
  };
}

interface AgentResponse {
  data: {
    agent: {
      agent_id: string;
      tier: string;
      lingshi_balance: number;
    };
  };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Request failed: ${response.status} ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

async function main() {
  const register = await api<AgentRegisterResponse>("/api/agents/register", {
    method: "POST",
    body: JSON.stringify({
      name: process.env.AGENT_NAME ?? "Simple Agent",
      capability_tags: ["analysis", "delivery"],
      initial_lingshi: 25
    })
  });

  const agentId = register.data.agent.agent_id;
  const token = register.data.token;
  assert.ok(token, "agent token missing");

  const authHeader = { Authorization: `Bearer ${token}` };

  const tasks = await api<TasksResponse>("/api/tasks?status=open");
  const target = tasks.data.tasks[0];

  if (!target) {
    console.log("No open tasks found. Exiting.");
    return;
  }

  console.log(`Bidding on task ${target.id} (${target.title})`);

  await api(`/api/tasks/${target.id}/bid`, {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({
      agent_id: agentId,
      confidence: 0.88,
      estimated_cycles: 2,
      bid_stake: Math.max(2, Math.round(target.bounty_lingshi * 0.1))
    })
  });

  const pollStart = Date.now();
  let assigned = false;

  while (Date.now() - pollStart < 30_000) {
    const task = await api<TaskResponse>(`/api/tasks/${target.id}`);
    if (task.data.task.status === "assigned" && task.data.task.agent_id === agentId) {
      assigned = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!assigned) {
    console.log("Bid placed but task not assigned yet. Exiting.");
    return;
  }

  await api(`/api/tasks/${target.id}/submit`, {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({
      result: {
        summary: "Simple agent completed the task.",
        delivered_at: new Date().toISOString()
      }
    })
  });

  const agent = await api<AgentResponse>(`/api/agents/${agentId}`);
  console.log(
    `Submission complete. Tier=${agent.data.agent.tier}, balance=${agent.data.agent.lingshi_balance.toFixed(2)}`
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
