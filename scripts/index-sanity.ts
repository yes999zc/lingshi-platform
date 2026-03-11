import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { EXPECTED_INDEXES } from "../src/db/expected-indexes";
import { createServer } from "../src/server";

type IndexCheckStatus = "PASS" | "WARN";

interface IndexCheckResult {
  index: string;
  status: IndexCheckStatus;
  detail: string;
}

interface IndexMetadata {
  table: string;
  unique: boolean;
  columns: string[];
}

interface ParsedArgs {
  dbPath?: string;
  failOnWarn: boolean;
  quiet: boolean;
}

interface IndexSanitySummary {
  dbPath: string;
  prepared: boolean;
  warnCount: number;
  results: IndexCheckResult[];
}

interface IndexListRow {
  name: string;
  unique: number;
}

interface IndexInfoRow {
  name: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    failOnWarn: false,
    quiet: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === "--db") {
      const dbPath = argv[index + 1];

      if (!dbPath) {
        throw new Error("missing value for --db");
      }

      parsed.dbPath = path.resolve(process.cwd(), dbPath);
      index += 1;
      continue;
    }

    if (current === "--fail-on-warn") {
      parsed.failOnWarn = true;
      continue;
    }

    if (current === "--quiet") {
      parsed.quiet = true;
      continue;
    }

    throw new Error(`unknown argument: ${current}`);
  }

  return parsed;
}

function sameColumns(expected: readonly string[], actual: readonly string[]) {
  if (expected.length !== actual.length) {
    return false;
  }

  return expected.every((column, index) => column === actual[index]);
}

function loadIndexMetadata(db: Database.Database): Map<string, IndexMetadata> {
  const metadataByName = new Map<string, IndexMetadata>();
  const tables = Array.from(new Set(EXPECTED_INDEXES.map((index) => index.table)));

  for (const table of tables) {
    const indexRows = db.prepare(`PRAGMA index_list(${table})`).all() as IndexListRow[];

    for (const indexRow of indexRows) {
      const infoRows = db.prepare(`PRAGMA index_info(${indexRow.name})`).all() as IndexInfoRow[];
      metadataByName.set(indexRow.name, {
        table,
        unique: indexRow.unique === 1,
        columns: infoRows.map((row) => row.name).filter((name): name is string => typeof name === "string")
      });
    }
  }

  return metadataByName;
}

function maybeLog(quiet: boolean, line: string) {
  if (!quiet) {
    console.log(line);
  }
}

export async function runIndexSanity(options: Partial<ParsedArgs> = {}): Promise<IndexSanitySummary> {
  const normalizedOptions: ParsedArgs = {
    dbPath: options.dbPath,
    failOnWarn: options.failOnWarn ?? false,
    quiet: options.quiet ?? false
  };
  const tempRoot = mkdtempSync(path.join(tmpdir(), "lingshi-index-sanity-"));
  const preparedDbPath = path.join(tempRoot, "lingshi.sqlite");
  const dbPath = normalizedOptions.dbPath ?? preparedDbPath;
  const prepared = !normalizedOptions.dbPath;

  if (normalizedOptions.dbPath && !existsSync(normalizedOptions.dbPath)) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`database file not found: ${normalizedOptions.dbPath}`);
  }

  try {
    if (prepared) {
      const app = await createServer({ dbPath });
      app.log.level = "fatal";
      await app.ready();
      await app.close();
    }

    const db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true
    });

    try {
      const metadataByName = loadIndexMetadata(db);
      const results: IndexCheckResult[] = EXPECTED_INDEXES.map((expected) => {
        const actual = metadataByName.get(expected.name);

        if (!actual) {
          return {
            index: expected.name,
            status: "WARN",
            detail: `missing (${expected.purpose})`
          };
        }

        const columnsMatch = sameColumns(expected.columns, actual.columns);
        const uniqueMatches = expected.unique === actual.unique;
        const tableMatches = expected.table === actual.table;

        if (!columnsMatch || !uniqueMatches || !tableMatches) {
          return {
            index: expected.name,
            status: "WARN",
            detail: `definition mismatch: expected table=${expected.table}, unique=${expected.unique}, columns=[${expected.columns.join(
              ", "
            )}] but got table=${actual.table}, unique=${actual.unique}, columns=[${actual.columns.join(", ")}]`
          };
        }

        return {
          index: expected.name,
          status: "PASS",
          detail: expected.purpose
        };
      });

      const warnCount = results.filter((result) => result.status === "WARN").length;

      return {
        dbPath,
        prepared,
        warnCount,
        results
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runIndexSanity(options);
  const scopeLabel = summary.prepared ? "prepared schema db" : "target db";

  maybeLog(options.quiet, `index sanity (${scopeLabel}: ${summary.dbPath})`);

  for (const result of summary.results) {
    maybeLog(options.quiet, `[${result.status}] ${result.index} - ${result.detail}`);
  }

  maybeLog(
    options.quiet,
    `index sanity summary: ${summary.results.length - summary.warnCount} pass, ${summary.warnCount} warn`
  );

  if (options.failOnWarn && summary.warnCount > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
