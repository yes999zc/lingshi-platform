export interface Agent {
  agent_id: string;
  name: string;
  tier: string;
  lingshi_balance: number;
  status: string;
  last_seen: string;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  bounty_lingshi: number;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerEntry {
  id: string;
  kind: string;
  amount: number;
  currency: string;
  agent_id: string | null;
  task_id: string | null;
  createdAt?: string;
  created_at?: string;
}

export interface EventRecord {
  seq: number;
  id: string;
  event_type: string;
  payload: unknown;
  created_at: string;
}
