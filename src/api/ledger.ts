import type Database from "better-sqlite3";
import type { FastifyPluginAsync } from "fastify";

interface LedgerRouteOptions {
  db: Database.Database;
}

interface LedgerRow {
  id: string;
  entity_id: string;
  task_id: string | null;
  agent_id: string | null;
  reason: string | null;
  idempotency_key: string | null;
  entry_type: string;
  amount: number;
  currency: string;
  note: string | null;
  created_at: string;
}

const ledgerRoutes: FastifyPluginAsync<LedgerRouteOptions> = async (app, options) => {
  const { db } = options;

  const listLedgerEntriesQuery = db.prepare(`
    SELECT id, entity_id, task_id, agent_id, reason, idempotency_key, entry_type, amount, currency, note, created_at
    FROM ledger
    ORDER BY created_at DESC
  `);

  app.get("/ledger", async () => {
    const rows = listLedgerEntriesQuery.all() as LedgerRow[];

    return {
      data: rows.map((row) => ({
        id: row.id,
        kind: row.entry_type,
        amount: row.amount,
        currency: row.currency,
        createdAt: row.created_at,
        entity_id: row.entity_id,
        task_id: row.task_id,
        agent_id: row.agent_id,
        reason: row.reason,
        idempotency_key: row.idempotency_key,
        note: row.note
      }))
    };
  });
};

export default ledgerRoutes;
