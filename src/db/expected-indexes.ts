export interface ExpectedIndexDefinition {
  name: string;
  table: "agents" | "tasks" | "bids" | "ledger";
  columns: readonly string[];
  unique: boolean;
  purpose: string;
}

export const EXPECTED_INDEXES: readonly ExpectedIndexDefinition[] = [
  {
    name: "idx_agents_token_hash",
    table: "agents",
    columns: ["token_hash"],
    unique: true,
    purpose: "agent bearer/websocket token authentication lookups"
  },
  {
    name: "idx_tasks_created_at",
    table: "tasks",
    columns: ["created_at"],
    unique: false,
    purpose: "task list ordering by newest created"
  },
  {
    name: "idx_tasks_status_created_at",
    table: "tasks",
    columns: ["status", "created_at"],
    unique: false,
    purpose: "task list filtering by status with stable ordering"
  },
  {
    name: "idx_bids_task_id",
    table: "bids",
    columns: ["task_id"],
    unique: false,
    purpose: "task to bid fan-out lookups"
  },
  {
    name: "idx_bids_agent_id",
    table: "bids",
    columns: ["agent_id"],
    unique: false,
    purpose: "open-bid cap counting per agent"
  },
  {
    name: "idx_bids_task_agent_confidence_created_at",
    table: "bids",
    columns: ["task_id", "agent_id", "confidence", "created_at"],
    unique: false,
    purpose: "task assignment candidate resolution for agent-specific best bid"
  },
  {
    name: "idx_ledger_created_at",
    table: "ledger",
    columns: ["created_at"],
    unique: false,
    purpose: "ledger feed ordering by newest created"
  },
  {
    name: "idx_ledger_idempotency_key",
    table: "ledger",
    columns: ["idempotency_key"],
    unique: true,
    purpose: "settlement idempotency enforcement"
  }
];

export function toCreateIndexSql(definition: ExpectedIndexDefinition): string {
  const uniquePrefix = definition.unique ? "UNIQUE " : "";
  return `CREATE ${uniquePrefix}INDEX IF NOT EXISTS ${definition.name} ON ${definition.table} (${definition.columns.join(", ")});`;
}

export const EXPECTED_INDEX_CREATE_SQL = EXPECTED_INDEXES.map(toCreateIndexSql);
