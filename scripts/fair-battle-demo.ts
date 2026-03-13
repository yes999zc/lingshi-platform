import fs from "node:fs/promises";

type AgentCred = {
  name: string;
  agent_id: string;
  token: string;
  lingshi_balance?: number;
  capability_tags?: string[];
};

type TaskItem = {
  id: string;
  title: string;
  status: string;
  required_tags?: string[];
  bounty_lingshi?: number;
};

const BASE = process.env.LINGSHI_BASE_URL ?? "http://127.0.0.1:3000";
const CREDS_PATH =
  process.env.LINGSHI_AGENT_CREDS_PATH ??
  "/Users/bakeyzhang/.openclaw/temp/lingshi-agents-20260311.json";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function overlapScore(agentTags: string[], requiredTags: string[]) {
  if (!requiredTags.length) return 0.62;
  const set = new Set(agentTags.map((t) => t.toLowerCase()));
  const hit = requiredTags.filter((t) => set.has(t.toLowerCase())).length;
  return hit / requiredTags.length;
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; payload: T }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = (await res.json()) as T;
  return { status: res.status, payload };
}

async function createDemoTasksIfNeeded() {
  const listed = await api<{ data?: { tasks?: TaskItem[] } }>("GET", "/api/tasks");
  const openCount = (listed.payload.data?.tasks ?? []).filter((t) => t.status === "open").length;

  if (openCount >= 4) return;

  const templates = [
    {
      title: "公平战场测试：产品竞品洞察",
      description: "分析 2 个竞品并给出决策建议",
      complexity: 3,
      bounty_lingshi: 180,
      required_tags: ["analysis", "research"],
    },
    {
      title: "公平战场测试：接口重构",
      description: "重构任务流接口并补测试",
      complexity: 5,
      bounty_lingshi: 260,
      required_tags: ["coding", "test"],
    },
    {
      title: "公平战场测试：PR审查",
      description: "检查潜在风险并给出修复方案",
      complexity: 4,
      bounty_lingshi: 200,
      required_tags: ["review", "analysis"],
    },
    {
      title: "公平战场测试：总结报告",
      description: "汇总任务数据并输出摘要",
      complexity: 2,
      bounty_lingshi: 140,
      required_tags: ["summarization", "analysis"],
    },
  ];

  for (const task of templates) {
    await api("POST", "/api/tasks", task);
  }
}

async function main() {
  const raw = await fs.readFile(CREDS_PATH, "utf8");
  const parsed = JSON.parse(raw) as { agents: AgentCred[] };
  const agents = parsed.agents;

  if (!agents.length) {
    throw new Error("no agents found in creds file");
  }

  const scorerRegister = await api<{ data?: { agent?: { agent_id: string }; token?: string } }>(
    "POST",
    "/api/agents/register",
    {
      name: "Fair Battle Scorer",
      capability_tags: ["review"],
      initial_lingshi: 10,
    },
  );
  const scorerToken = scorerRegister.payload.data?.token;
  if (!scorerToken) {
    throw new Error("failed to register scorer agent");
  }

  await createDemoTasksIfNeeded();

  const listRes = await api<{ data?: { tasks?: TaskItem[] } }>("GET", "/api/tasks");
  const openTasks = (listRes.payload.data?.tasks ?? []).filter((t) => t.status === "open").slice(0, 8);

  const wins = new Map<string, number>();
  for (const a of agents) wins.set(a.agent_id, 0);

  const summary: Array<Record<string, unknown>> = [];

  for (const task of openTasks) {
    const required = task.required_tags ?? [];

    const candidates: Array<{
      agent: AgentCred;
      confidence: number;
      score: number;
      bidId?: string;
    }> = [];

    for (const agent of agents) {
      const fatigue = (wins.get(agent.agent_id) ?? 0) * 0.08;
      const tagScore = overlapScore(agent.capability_tags ?? [], required);
      const randomJitter = (Math.random() - 0.5) * 0.1; // -0.05 ~ +0.05

      // Fair score: capability-first + anti-dominance fatigue + small randomness
      const score = clamp(0.58 + tagScore * 0.32 + randomJitter - fatigue, 0.5, 0.95);
      const confidence = Number(score.toFixed(2));

      const bidRes = await api<{ data?: { bid?: { id: string } } }>(
        "POST",
        `/api/tasks/${task.id}/bids`,
        {
          agent_id: agent.agent_id,
          confidence,
          estimated_cycles: Math.max(1, Math.round((1 - tagScore) * 4 + 1)),
          bid_stake: Math.max(8, Math.round((task.bounty_lingshi ?? 120) * 0.07)),
        },
        agent.token,
      );

      if (bidRes.status === 201) {
        candidates.push({
          agent,
          confidence,
          score,
          bidId: bidRes.payload.data?.bid?.id,
        });
      }
    }

    if (!candidates.length) {
      summary.push({
        task_id: task.id,
        title: task.title,
        status: "no-bids",
      });
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);
    const winner = candidates[0];

    await api(
      "POST",
      `/api/tasks/${task.id}/assign`,
      {
        bid_id: winner.bidId,
        agent_id: winner.agent.agent_id,
      },
      winner.agent.token,
    );

    await api(
      "POST",
      `/api/tasks/${task.id}/submit`,
      {
        result: {
          summary: `fair-run result by ${winner.agent.name}`,
          rationale: {
            confidence: winner.confidence,
            tag_match: overlapScore(winner.agent.capability_tags ?? [], required),
          },
        },
      },
      winner.agent.token,
    );

    const finalScore = Math.round(84 + winner.score * 12);

    await api(
      "POST",
      `/api/tasks/${task.id}/score`,
      {
        quality: finalScore,
        speed: Math.max(78, finalScore - 3),
        innovation: Math.max(75, finalScore - 5),
        final_score: finalScore,
      },
      scorerToken,
    );

    const settleRes = await api<{ data?: { settlement?: { amount: number } } }>(
      "POST",
      `/api/tasks/${task.id}/settle`,
      {
        reason: "task_settlement",
      },
      winner.agent.token,
    );

    wins.set(winner.agent.agent_id, (wins.get(winner.agent.agent_id) ?? 0) + 1);

    summary.push({
      task_id: task.id,
      title: task.title,
      winner: winner.agent.name,
      confidence: winner.confidence,
      final_score: finalScore,
      settled_amount: settleRes.payload.data?.settlement?.amount ?? null,
    });
  }

  const winnerBoard = agents
    .map((a) => ({ name: a.name, wins: wins.get(a.agent_id) ?? 0 }))
    .sort((a, b) => b.wins - a.wins);

  console.log(
    JSON.stringify(
      {
        open_tasks_processed: openTasks.length,
        winner_distribution: winnerBoard,
        rounds: summary,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
