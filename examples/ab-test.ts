import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

interface AgentResult {
  agentType: "simple" | "pua";
  runId: string;
  success: boolean;
  failures: number;
  attempts: number;
  durationMs: number;
  tier: string;
  balance: number;
  error?: string;
}

interface TestConfig {
  baseUrl: string;
  runsPerAgent: number;
  delayBetweenRunsMs: number;
}

class AbTestRunner {
  private config: TestConfig;
  private results: AgentResult[] = [];

  constructor(config: Partial<TestConfig> = {}) {
    this.config = {
      baseUrl: config.baseUrl ?? "http://127.0.0.1:3000",
      runsPerAgent: config.runsPerAgent ?? 3,
      delayBetweenRunsMs: config.delayBetweenRunsMs ?? 5000
    };
  }

  async run() {
    console.log(`=== PUA vs 普通 Agent AB 测试开始 ===`);
    console.log(`配置: ${this.config.runsPerAgent} 次/Agent, 间隔 ${this.config.delayBetweenRunsMs}ms`);
    console.log(`服务地址: ${this.config.baseUrl}`);
    console.log();

    // 检查服务健康
    if (!await this.checkHealth()) {
      console.error("服务不健康，请先启动灵石平台");
      return;
    }

    // 并行运行两种 Agent
    const simplePromises: Promise<AgentResult>[] = [];
    const puaPromises: Promise<AgentResult>[] = [];

    for (let i = 0; i < this.config.runsPerAgent; i++) {
      simplePromises.push(this.runAgent("simple", i));
      puaPromises.push(this.runAgent("pua", i));
      
      // 错开启动时间
      await this.delay(1000);
    }

    const simpleResults = await Promise.all(simplePromises);
    const puaResults = await Promise.all(puaPromises);

    this.results = [...simpleResults, ...puaResults];

    console.log(`\n=== 所有测试完成 ===`);
    this.printSummary();
  }

  private async runAgent(agentType: "simple" | "pua", runIndex: number): Promise<AgentResult> {
    const runId = randomUUID().substring(0, 8);
    const startTime = Date.now();
    
    console.log(`[${runId}] ${agentType.toUpperCase()} Agent 运行 #${runIndex + 1}...`);

    return new Promise((resolve) => {
      const script = agentType === "simple" ? "simple-agent.ts" : "pua-agent.ts";
      const env = { ...process.env, LINGSHI_BASE_URL: this.config.baseUrl };
      
      const child = spawn("npx", ["tsx", `examples/${script}`], {
        env,
        cwd: "/Users/bakeyzhang/.openclaw/workspace/projects/lingshi-platform",
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        const durationMs = Date.now() - startTime;
        const success = code === 0;
        
        // 从输出中解析数据
        const failures = this.extractFailures(stdout);
        const attempts = this.extractAttempts(stdout);
        const { tier, balance } = this.extractStats(stdout);

        const result: AgentResult = {
          agentType,
          runId,
          success,
          failures,
          attempts,
          durationMs,
          tier: tier || "unknown",
          balance: balance || 0,
          error: !success ? stderr.substring(0, 200) : undefined
        };

        console.log(`[${runId}] ${agentType.toUpperCase()} ${success ? "✅ 成功" : "❌ 失败"} ${durationMs}ms, 失败次数: ${failures}`);
        resolve(result);
      });
    });
  }

  private extractFailures(output: string): number {
    // 从 PUA Agent 输出中提取失败次数
    const puaMatch = output.match(/失败次数:\s*(\d+)/);
    if (puaMatch) return parseInt(puaMatch[1], 10);
    
    // 简单 Agent 可能没有失败统计，默认为 0
    return 0;
  }

  private extractAttempts(output: string): number {
    // 从 PUA Agent 输出中提取尝试次数
    const puaMatch = output.match(/总尝试次数:\s*(\d+)/);
    if (puaMatch) return parseInt(puaMatch[1], 10);
    
    // 简单 Agent 可能没有尝试统计，默认为 1
    return 1;
  }

  private extractStats(output: string): { tier: string; balance: number } {
    const tierMatch = output.match(/层级:\s*(\S+)/);
    const balanceMatch = output.match(/余额:\s*([\d.]+)/);
    
    return {
      tier: tierMatch ? tierMatch[1] : "unknown",
      balance: balanceMatch ? parseFloat(balanceMatch[1]) : 0
    };
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`);
      if (!response.ok) return false;
      const data = await response.json() as { status?: string };
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private printSummary() {
    const simpleResults = this.results.filter(r => r.agentType === "simple");
    const puaResults = this.results.filter(r => r.agentType === "pua");

    console.log(`\n=== 汇总统计 ===`);
    console.log(`普通 Agent: ${simpleResults.length} 次运行`);
    console.log(`PUA Agent: ${puaResults.length} 次运行`);

    if (simpleResults.length > 0 && puaResults.length > 0) {
      const simpleSuccessRate = simpleResults.filter(r => r.success).length / simpleResults.length;
      const puaSuccessRate = puaResults.filter(r => r.success).length / puaResults.length;
      
      const simpleAvgFailures = simpleResults.reduce((sum, r) => sum + r.failures, 0) / simpleResults.length;
      const puaAvgFailures = puaResults.reduce((sum, r) => sum + r.failures, 0) / puaResults.length;
      
      const simpleAvgDuration = simpleResults.reduce((sum, r) => sum + r.durationMs, 0) / simpleResults.length;
      const puaAvgDuration = puaResults.reduce((sum, r) => sum + r.durationMs, 0) / puaResults.length;

      console.log(`\n📊 成功率:`);
      console.log(`  普通 Agent: ${(simpleSuccessRate * 100).toFixed(1)}%`);
      console.log(`  PUA Agent: ${(puaSuccessRate * 100).toFixed(1)}%`);
      console.log(`  差异: ${((puaSuccessRate - simpleSuccessRate) * 100).toFixed(1)}%`);

      console.log(`\n📊 平均失败次数:`);
      console.log(`  普通 Agent: ${simpleAvgFailures.toFixed(2)}`);
      console.log(`  PUA Agent: ${puaAvgFailures.toFixed(2)}`);
      console.log(`  差异: ${(puaAvgFailures - simpleAvgFailures).toFixed(2)}`);

      console.log(`\n📊 平均执行时间:`);
      console.log(`  普通 Agent: ${simpleAvgDuration.toFixed(0)}ms`);
      console.log(`  PUA Agent: ${puaAvgDuration.toFixed(0)}ms`);
      console.log(`  差异: ${(puaAvgDuration - simpleAvgDuration).toFixed(0)}ms`);

      console.log(`\n📊 余额增长:`);
      const simpleAvgBalance = simpleResults.reduce((sum, r) => sum + r.balance, 0) / simpleResults.length;
      const puaAvgBalance = puaResults.reduce((sum, r) => sum + r.balance, 0) / puaResults.length;
      console.log(`  普通 Agent: ${simpleAvgBalance.toFixed(2)}`);
      console.log(`  PUA Agent: ${puaAvgBalance.toFixed(2)}`);
      console.log(`  差异: ${(puaAvgBalance - simpleAvgBalance).toFixed(2)}`);

      // PUA 指标
      const puaWithAttempts = puaResults.filter(r => r.attempts > 1);
      if (puaWithAttempts.length > 0) {
        const avgAttempts = puaWithAttempts.reduce((sum, r) => sum + r.attempts, 0) / puaWithAttempts.length;
        console.log(`\n🎯 PUA 特有指标:`);
        console.log(`  平均尝试次数: ${avgAttempts.toFixed(2)}`);
        console.log(`  重试利用率: ${(puaWithAttempts.length / puaResults.length * 100).toFixed(1)}%`);
      }
    }

    // 详细结果
    console.log(`\n=== 详细结果 ===`);
    for (const result of this.results) {
      const status = result.success ? "✅" : "❌";
      console.log(`${status} ${result.runId} ${result.agentType}: ${result.durationMs}ms, 失败:${result.failures}, 余额:${result.balance.toFixed(2)}`);
    }
  }
}

// 主函数
async function main() {
  const runner = new AbTestRunner({
    baseUrl: process.env.LINGSHI_BASE_URL || "http://127.0.0.1:3000",
    runsPerAgent: 3,
    delayBetweenRunsMs: 5000
  });

  await runner.run();
}

void main().catch(console.error);