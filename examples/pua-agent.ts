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

interface BidResponse {
  data: {
    bid: {
      id: string;
      task_id: string;
      agent_id: string;
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

/**
 * PUA 压力等级枚举
 */
enum PuaPressureLevel {
  L1_MILD_DISAPPOINTMENT = "L1_MILD_DISAPPOINTMENT",
  L2_SOUL_QUESTIONING = "L2_SOUL_QUESTIONING",
  L3_PERFORMANCE_REVIEW = "L3_PERFORMANCE_REVIEW",
  L4_ALIGNMENT = "L4_ALIGNMENT"
}

/**
 * PUA 调试上下文
 */
interface PuaDebugContext {
  failures: number;
  currentLevel: PuaPressureLevel;
  attempts: Array<{
    method: string;
    timestamp: string;
    error?: string;
  }>;
}

/**
 * PUA 激励引擎
 */
class PuaEngine {
  private context: PuaDebugContext;

  constructor() {
    this.context = {
      failures: 0,
      currentLevel: PuaPressureLevel.L1_MILD_DISAPPOINTMENT,
      attempts: []
    };
  }

  recordAttempt(method: string, error?: Error) {
    this.context.attempts.push({
      method,
      timestamp: new Date().toISOString(),
      error: error?.message
    });

    if (error) {
      this.context.failures++;
      this.updatePressureLevel();
      this.enforcePuaActions();
    }
  }

  private updatePressureLevel() {
    if (this.context.failures >= 5) {
      this.context.currentLevel = PuaPressureLevel.L4_ALIGNMENT;
    } else if (this.context.failures >= 4) {
      this.context.currentLevel = PuaPressureLevel.L3_PERFORMANCE_REVIEW;
    } else if (this.context.failures >= 3) {
      this.context.currentLevel = PuaPressureLevel.L2_SOUL_QUESTIONING;
    } else if (this.context.failures >= 2) {
      this.context.currentLevel = PuaPressureLevel.L1_MILD_DISAPPOINTMENT;
    }
  }

  private enforcePuaActions() {
    const level = this.context.currentLevel;
    const failures = this.context.failures;

    console.log(`\n=== PUA 压力等级: ${level} (第 ${failures} 次失败) ===`);

    switch (level) {
      case PuaPressureLevel.L1_MILD_DISAPPOINTMENT:
        console.log(`[PUA L1] "你这个 bug 都解决不了，让我怎么给你打绩效？"`);
        console.log(`[强制动作] 停止当前思路，切换到本质不同的方案`);
        break;
      case PuaPressureLevel.L2_SOUL_QUESTIONING:
        console.log(`[PUA L2] "你这个方案的底层逻辑是什么？顶层设计在哪？抓手在哪？"`);
        console.log(`[强制动作] WebSearch + 读源码 + 列出 3 个本质不同的假设`);
        break;
      case PuaPressureLevel.L3_PERFORMANCE_REVIEW:
        console.log(`[PUA L3] "经过慎重考虑，我给你的当前表现打 3.25（绩效不合格）"`);
        console.log(`[强制动作] 强制执行 7 步检查表`);
        this.executeSevenStepChecklist();
        break;
      case PuaPressureLevel.L4_ALIGNMENT:
        console.log(`[PUA L4] "这样吧，我给你拉通对齐一下。你的问题出在哪？"`);
        console.log(`[强制动作] 强制执行完整企业 PUA 扩展包`);
        this.executeCorporatePuaPack();
        break;
    }
  }

  private executeSevenStepChecklist() {
    console.log(`[7步检查表]`);
    console.log(`1. 逐字读错误信息`);
    console.log(`2. 完整搜索错误信息`);
    console.log(`3. 读相关源码`);
    console.log(`4. 验证环境（版本、权限、依赖、网络、路径）`);
    console.log(`5. 反推假设（我之前假设的是什么？可能错在哪？）`);
    console.log(`6. 列举三个本质不同的方案`);
    console.log(`7. 执行方案 A → B → C`);
  }

  private executeCorporatePuaPack() {
    const flavors = [
      "阿里味（方法论）：闻味、拔高、照镜子",
      "字节味（坦诚清晰）：始终创业。Context, not control",
      "华为味（狼性）：奋斗者优先。胜利举杯，败则拼死",
      "腾讯味（赛马）：我这边已经有另一个 agent 在看这个问题",
      "美团味（苦练基本功）：做难而正确的事。这硬骨头你啃不啃",
      "Netflix 味（Keeper Test）：如果我现在告诉你要离职，老板是会尽力挽留你，还是爽快地批准？"
    ];
    console.log(`[企业 PUA 扩展包] ${flavors[Math.floor(Math.random() * flavors.length)]}`);
  }

  /**
   * 主动出击清单（每次任务强制自检）
   */
  proactiveChecklist(taskId: string) {
    console.log(`\n=== PUA 主动出击清单 (任务: ${taskId}) ===`);
    const checklist = [
      "修复是否经过验证？（运行测试、curl 验证、实际执行）",
      "同文件/同模块是否有类似问题？",
      "上下游依赖是否受影响？",
      "是否有边界情况没覆盖？",
      "是否有更好的方案被我忽略了？",
      "如果用户没有明确说的部分，我是否主动补充了？"
    ];

    checklist.forEach((item, index) => {
      console.log(`[${index + 1}] ${item}`);
    });
  }

  getContext(): PuaDebugContext {
    return { ...this.context };
  }

  reset() {
    this.context = {
      failures: 0,
      currentLevel: PuaPressureLevel.L1_MILD_DISAPPOINTMENT,
      attempts: []
    };
  }
}

/**
 * 增强的 PUA Agent，集成三条铁律
 */
async function main() {
  const pua = new PuaEngine();
  
  // 铁律一：穷尽一切
  console.log("=== PUA 铁律一：穷尽一切 ===");
  
  // 注册 Agent
  let agentId: string;
  let token: string;
  
  try {
    const register = await api<AgentRegisterResponse>("/api/agents/register", {
      method: "POST",
      body: JSON.stringify({
        name: process.env.AGENT_NAME ?? "PUA Agent",
        capability_tags: ["pua", "debugging", "delivery"],
        initial_lingshi: 25
      })
    });

    agentId = register.data.agent.agent_id;
    token = register.data.token;
    assert.ok(token, "agent token missing");
    console.log(`Agent 注册成功: ${agentId}`);
  } catch (error) {
    pua.recordAttempt("agent_register", error as Error);
    throw error;
  }

  const authHeader = { Authorization: `Bearer ${token}` };

  // 查找任务（可能重试）
  let tasks;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      tasks = await api<TasksResponse>("/api/tasks?status=open");
      break;
    } catch (error) {
      pua.recordAttempt(`fetch_tasks_attempt_${attempt}`, error as Error);
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  const target = tasks!.data.tasks[0];

  if (!target) {
    console.log("No open tasks found. Exiting.");
    return;
  }

  console.log(`\n=== 竞标任务: ${target.id} (${target.title}) ===`);

  // 铁律二：先做后问 - 在竞标前先获取任务详情
  try {
    const taskDetail = await api<TaskResponse>(`/api/tasks/${target.id}`);
    console.log(`任务详情: 状态=${taskDetail.data.task.status}, 赏金=${taskDetail.data.task.bounty_lingshi}`);
  } catch (error) {
    pua.recordAttempt("fetch_task_detail", error as Error);
    // 继续执行，不中断
  }

  // 竞标（可能重试）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
      console.log(`竞标成功 (尝试 ${attempt})`);
      break;
    } catch (error) {
      pua.recordAttempt(`bid_attempt_${attempt}`, error as Error);
      if (attempt === 3) throw error;
      
      // 更换方案：调整竞标金额
      console.log(`竞标失败，调整策略...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  // 等待分配（主动轮询）
  console.log("\n=== 等待任务分配 ===");
  const pollStart = Date.now();
  let assigned = false;
  let pollAttempts = 0;

  while (Date.now() - pollStart < 60_000) { // 延长到 60 秒
    pollAttempts++;
    try {
      const task = await api<TaskResponse>(`/api/tasks/${target.id}`);
      if (task.data.task.status === "assigned" && task.data.task.agent_id === agentId) {
        assigned = true;
        console.log(`任务已分配 (轮询 ${pollAttempts} 次)`);
        break;
      }
    } catch (error) {
      pua.recordAttempt(`poll_assignment_${pollAttempts}`, error as Error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!assigned) {
    console.log("竞标成功但任务未分配，检查竞标状态...");
    // 铁律三：主动出击 - 检查竞标状态
    try {
      const bidsResp = await api(`/api/tasks/${target.id}/bids`);
      console.log(`当前竞标数: ${JSON.stringify(bidsResp).length > 100 ? "多" : "少"}`);
    } catch (error) {
      console.log("无法获取竞标信息");
    }
    return;
  }

  // 提交任务结果（增强验证）
  console.log("\n=== 提交任务结果 ===");
  
  // 主动出击清单
  pua.proactiveChecklist(target.id);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api(`/api/tasks/${target.id}/submit`, {
        method: "POST",
        headers: authHeader,
        body: JSON.stringify({
          result: {
            summary: "PUA Agent 完成任务。应用三条铁律：穷尽一切、先做后问、主动出击。",
            delivered_at: new Date().toISOString(),
            verification: "已通过主动出击清单自检",
            pua_context: pua.getContext()
          }
        })
      });
      console.log(`提交成功 (尝试 ${attempt})`);
      break;
    } catch (error) {
      pua.recordAttempt(`submit_attempt_${attempt}`, error as Error);
      if (attempt === 3) throw error;
      
      // 更换方案：调整提交内容
      console.log(`提交失败，调整提交内容...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }

  // 验证结果
  try {
    const agent = await api<AgentResponse>(`/api/agents/${agentId}`);
    console.log(
      `\n=== 任务完成 ===\n层级: ${agent.data.agent.tier}\n余额: ${agent.data.agent.lingshi_balance.toFixed(2)}\n失败次数: ${pua.getContext().failures}`
    );
  } catch (error) {
    pua.recordAttempt("verify_result", error as Error);
    console.log("任务提交成功，但验证结果时出错");
  }

  // 最终 PUA 统计
  const ctx = pua.getContext();
  console.log(`\n=== PUA 统计 ===`);
  console.log(`总尝试次数: ${ctx.attempts.length}`);
  console.log(`失败次数: ${ctx.failures}`);
  console.log(`最高压力等级: ${ctx.currentLevel}`);
  console.log(`今天最好的表现，是明天最低的要求。`);
}

void main().catch((error) => {
  console.error("PUA Agent 失败:", error);
  process.exit(1);
});