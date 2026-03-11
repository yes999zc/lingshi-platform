import { execFileSync } from "node:child_process";

export const REQUIRED_PR_ORDER = [7, 8, 9, 12] as const;

export type MergeOrderStatus = "pass" | "warn" | "fail";

interface OrderViolation {
  expectedBefore: number;
  expectedAfter: number;
  expectedBeforeIndex: number;
  expectedAfterIndex: number;
}

export interface MergeOrderCheckResult {
  status: MergeOrderStatus;
  message: string;
  inspectedCommits: number;
  missingPrs: number[];
  violations: OrderViolation[];
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function hasPrReference(subject: string, prNumber: number): boolean {
  const escapedPr = String(prNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\D)#${escapedPr}(?:\\D|$)`);
  return pattern.test(subject);
}

function loadCommitSubjects(): string[] {
  const output = execFileSync("git", ["log", "--reverse", "--pretty=%s"], {
    encoding: "utf8"
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function checkMergeOrder(): MergeOrderCheckResult {
  const orderLabel = REQUIRED_PR_ORDER.map((pr) => `#${pr}`).join(" -> ");
  let subjects: string[];

  try {
    subjects = loadCommitSubjects();
  } catch (error) {
    return {
      status: "warn",
      message: `unable to inspect git history for merge order ${orderLabel}: ${formatError(error)}`,
      inspectedCommits: 0,
      missingPrs: [...REQUIRED_PR_ORDER],
      violations: []
    };
  }

  const firstSeenByPr = new Map<number, number>();

  for (const pr of REQUIRED_PR_ORDER) {
    firstSeenByPr.set(pr, -1);
  }

  subjects.forEach((subject, index) => {
    for (const pr of REQUIRED_PR_ORDER) {
      if (firstSeenByPr.get(pr) !== -1) {
        continue;
      }

      if (hasPrReference(subject, pr)) {
        firstSeenByPr.set(pr, index);
      }
    }
  });

  const missingPrs = REQUIRED_PR_ORDER.filter((pr) => (firstSeenByPr.get(pr) ?? -1) < 0);
  const violations: OrderViolation[] = [];

  for (let index = 0; index < REQUIRED_PR_ORDER.length - 1; index += 1) {
    const expectedBefore = REQUIRED_PR_ORDER[index];
    const expectedAfter = REQUIRED_PR_ORDER[index + 1];
    const expectedBeforeIndex = firstSeenByPr.get(expectedBefore) ?? -1;
    const expectedAfterIndex = firstSeenByPr.get(expectedAfter) ?? -1;

    if (expectedBeforeIndex >= 0 && expectedAfterIndex >= 0 && expectedBeforeIndex > expectedAfterIndex) {
      violations.push({
        expectedBefore,
        expectedAfter,
        expectedBeforeIndex,
        expectedAfterIndex
      });
    }
  }

  if (violations.length > 0) {
    const violationSummary = violations
      .map((violation) => `#${violation.expectedBefore} appears after #${violation.expectedAfter}`)
      .join("; ");

    return {
      status: "fail",
      message: `merge dependency order must be ${orderLabel}; ${violationSummary}`,
      inspectedCommits: subjects.length,
      missingPrs,
      violations
    };
  }

  if (missingPrs.length > 0) {
    return {
      status: "warn",
      message: `merge dependency order ${orderLabel} not fully verifiable; missing ${missingPrs
        .map((pr) => `#${pr}`)
        .join(", ")}`,
      inspectedCommits: subjects.length,
      missingPrs,
      violations: []
    };
  }

  return {
    status: "pass",
    message: `merge dependency order validated: ${orderLabel}`,
    inspectedCommits: subjects.length,
    missingPrs: [],
    violations: []
  };
}

function main() {
  const result = checkMergeOrder();
  console.log(`merge-order ${result.status.toUpperCase()}: ${result.message}`);

  if (result.status === "fail") {
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
