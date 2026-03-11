import { checkMergeOrder, type MergeOrderStatus } from "./merge-order-check";
import { runIntegrationGate } from "./integration-gate";

type TableStatus = "PASS" | "WARN" | "FAIL";

interface GateTableRow {
  check: string;
  status: TableStatus;
  detail: string;
}

function toTableStatus(status: MergeOrderStatus | "pass" | "fail"): TableStatus {
  if (status === "warn") {
    return "WARN";
  }

  if (status === "fail") {
    return "FAIL";
  }

  return "PASS";
}

function countByStatus(rows: GateTableRow[], status: TableStatus) {
  return rows.filter((row) => row.status === status).length;
}

function renderTable(rows: GateTableRow[]) {
  const headers = {
    check: "Check",
    status: "Status",
    detail: "Detail"
  };

  const checkWidth = Math.max(headers.check.length, ...rows.map((row) => row.check.length));
  const statusWidth = Math.max(headers.status.length, ...rows.map((row) => row.status.length));
  const detailWidth = Math.max(headers.detail.length, ...rows.map((row) => row.detail.length));

  const separator = `+-${"-".repeat(checkWidth)}-+-${"-".repeat(statusWidth)}-+-${"-".repeat(detailWidth)}-+`;
  const formatRow = (check: string, status: string, detail: string) =>
    `| ${check.padEnd(checkWidth)} | ${status.padEnd(statusWidth)} | ${detail.padEnd(detailWidth)} |`;

  console.log(separator);
  console.log(formatRow(headers.check, headers.status, headers.detail));
  console.log(separator);

  for (const row of rows) {
    console.log(formatRow(row.check, row.status, row.detail));
  }

  console.log(separator);
}

async function main() {
  const rows: GateTableRow[] = [];
  let hasFailure = false;

  try {
    const integrationSummary = await runIntegrationGate({ quiet: true });

    for (const result of integrationSummary.results) {
      const status = toTableStatus(result.status);
      const detail = `${result.detail} (${result.durationMs}ms)`;
      rows.push({
        check: `integration:${result.name}`,
        status,
        detail
      });

      if (status === "FAIL") {
        hasFailure = true;
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    rows.push({
      check: "integration:init",
      status: "FAIL",
      detail
    });
    hasFailure = true;
  }

  const mergeOrderResult = checkMergeOrder();
  const mergeOrderStatus = toTableStatus(mergeOrderResult.status);
  rows.push({
    check: "merge-order",
    status: mergeOrderStatus,
    detail: mergeOrderResult.message
  });

  if (mergeOrderStatus === "FAIL") {
    hasFailure = true;
  }

  renderTable(rows);
  const passCount = countByStatus(rows, "PASS");
  const warnCount = countByStatus(rows, "WARN");
  const failCount = countByStatus(rows, "FAIL");
  console.log(`summary: ${passCount} pass, ${warnCount} warn, ${failCount} fail`);

  if (hasFailure) {
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
