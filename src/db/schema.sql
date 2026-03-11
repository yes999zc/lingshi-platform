CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'outer',
  lingshi_balance REAL NOT NULL DEFAULT 0,
  capability_tags TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'offline',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  agent_id TEXT,
  assigned_bid_id TEXT,
  submission_payload TEXT,
  submitted_at TEXT,
  score_quality REAL,
  score_speed REAL,
  score_innovation REAL,
  final_score REAL,
  scored_at TEXT,
  settled_at TEXT,
  settlement_ledger_id TEXT,
  complexity INTEGER NOT NULL DEFAULT 1,
  bounty_lingshi REAL NOT NULL DEFAULT 0,
  required_tags TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents (agent_id),
  FOREIGN KEY (assigned_bid_id) REFERENCES bids (id)
);

CREATE TABLE IF NOT EXISTS bids (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  bid_score REAL NOT NULL DEFAULT 0,
  note TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  estimated_cycles INTEGER NOT NULL DEFAULT 1,
  bid_stake REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks (id),
  FOREIGN KEY (agent_id) REFERENCES agents (agent_id)
);

CREATE TABLE IF NOT EXISTS coalitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'forming',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coalition_members (
  id TEXT PRIMARY KEY,
  coalition_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (coalition_id) REFERENCES coalitions (id),
  FOREIGN KEY (agent_id) REFERENCES agents (agent_id),
  UNIQUE (coalition_id, agent_id)
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  reason TEXT,
  idempotency_key TEXT,
  entry_type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'LSP',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks (id),
  FOREIGN KEY (agent_id) REFERENCES agents (agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency_key
  ON ledger (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_token_hash
  ON agents (token_hash);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at
  ON tasks (created_at);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at
  ON tasks (status, created_at);

CREATE INDEX IF NOT EXISTS idx_bids_task_id
  ON bids (task_id);

CREATE INDEX IF NOT EXISTS idx_bids_agent_id
  ON bids (agent_id);

CREATE INDEX IF NOT EXISTS idx_bids_task_agent_confidence_created_at
  ON bids (task_id, agent_id, confidence, created_at);

CREATE INDEX IF NOT EXISTS idx_ledger_created_at
  ON ledger (created_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
