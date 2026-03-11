import { spawnSync } from "node:child_process";

type CheckStatus = "PASS" | "FAIL";

interface ReadinessCheck {
  name: string;
  command: string;
  args: string[];
}

interface ReadinessResult {
  name: string;
  status: CheckStatus;
  durationMs: number;
  detail: string;
}

const CHECKS: ReadinessCheck[] = [
  {
    name: "build",
    command: "npm",
    args: ["run", "build"]
  },
  {
    name: "integration",
    command: "npm",
    args: ["run", "test:integration"]
  },
  {
    name: "merge-gate",
    command: "npm",
    args: ["run", "test:merge-gate"]
  },
  {
    name: "perf-sanity:indexes",
    command: "npm",
    args: ["run", "check:indexes:strict"]
  }
];

function runCheck(check: ReadinessCheck): ReadinessResult {
  const start = Date.now();
  const result = spawnSync(check.command, check.args, {
    encoding: "utf8",
    stdio: "inherit"
  });
  const durationMs = Date.now() - start;

  if (result.status === 0) {
    return {
      name: check.name,
      status: "PASS",
      durationMs,
      detail: "ok"
    };
  }

  const statusCode = result.status ?? 1;
  const signal = result.signal ? `, signal=${result.signal}` : "";

  return {
    name: check.name,
    status: "FAIL",
    durationMs,
    detail: `exit=${statusCode}${signal}`
  };
}

function main() {
  const results: ReadinessResult[] = [];

  for (const check of CHECKS) {
    console.log(`\n[release-readiness] running ${check.name}...`);
    const result = runCheck(check);
    results.push(result);
    console.log(`[release-readiness] ${result.status} ${check.name} (${result.durationMs}ms) - ${result.detail}`);
  }

  console.log("\nrelease-readiness summary:");
  for (const result of results) {
    console.log(`- ${result.status} ${result.name} (${result.durationMs}ms)`);
  }

  const hasFailure = results.some((result) => result.status === "FAIL");
  if (hasFailure) {
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
