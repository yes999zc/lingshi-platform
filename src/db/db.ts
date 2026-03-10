import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "lingshi.sqlite");
const DEFAULT_SCHEMA_PATH = path.resolve(process.cwd(), "src", "db", "schema.sql");

export interface BootstrapDatabaseOptions {
  dbPath?: string;
  schemaPath?: string;
}

export function bootstrapDatabase(options: BootstrapDatabaseOptions = {}) {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  db.exec(schemaSql);

  return db;
}
