import type Database from "better-sqlite3";

export interface EventRecord {
  seq: number;
  id: string;
  event_type: string;
  payload: unknown;
  source: string | null;
  created_at: string;
}

interface EventRow {
  seq: number;
  id: string;
  event_type: string;
  payload: string;
  source: string | null;
  created_at: string;
}

export interface EventRepository {
  insertEvent: (payload: {
    id: string;
    event_type: string;
    payload: unknown;
    source?: string | null;
    created_at: string;
  }) => EventRecord;
  listEventsSince: (sinceSeq: number, limit: number) => EventRecord[];
  listLatestEvents: (limit: number) => EventRecord[];
}

function parseEventRow(row: EventRow): EventRecord {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    parsed = row.payload;
  }

  return {
    seq: row.seq,
    id: row.id,
    event_type: row.event_type,
    payload: parsed,
    source: row.source,
    created_at: row.created_at
  };
}

export function createEventRepository(db: Database.Database): EventRepository {
  const insertEventQuery = db.prepare(`
    INSERT INTO events (
      id,
      event_type,
      payload,
      source,
      created_at
    ) VALUES (
      @id,
      @event_type,
      @payload,
      @source,
      @created_at
    )
  `);

  const getEventByIdQuery = db.prepare(`
    SELECT rowid AS seq, id, event_type, payload, source, created_at
    FROM events
    WHERE id = ?
  `);

  const listEventsSinceQuery = db.prepare(`
    SELECT rowid AS seq, id, event_type, payload, source, created_at
    FROM events
    WHERE rowid > @since
    ORDER BY rowid ASC
    LIMIT @limit
  `);

  const listLatestEventsQuery = db.prepare(`
    SELECT rowid AS seq, id, event_type, payload, source, created_at
    FROM events
    ORDER BY rowid DESC
    LIMIT @limit
  `);

  return {
    insertEvent(payload) {
      insertEventQuery.run({
        id: payload.id,
        event_type: payload.event_type,
        payload: JSON.stringify(payload.payload ?? null),
        source: payload.source ?? null,
        created_at: payload.created_at
      });

      const row = getEventByIdQuery.get(payload.id) as EventRow | undefined;
      if (!row) {
        return {
          seq: -1,
          id: payload.id,
          event_type: payload.event_type,
          payload: payload.payload ?? null,
          source: payload.source ?? null,
          created_at: payload.created_at
        };
      }

      return parseEventRow(row);
    },
    listEventsSince(sinceSeq, limit) {
      const rows = listEventsSinceQuery.all({ since: sinceSeq, limit }) as EventRow[];
      return rows.map(parseEventRow);
    },
    listLatestEvents(limit) {
      const rows = listLatestEventsQuery.all({ limit }) as EventRow[];
      return rows.map(parseEventRow);
    }
  };
}
