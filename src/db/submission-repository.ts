import type Database from "better-sqlite3";

export interface SubmissionRecord {
  id: string;
  task_id: string;
  agent_id: string;
  payload: string;
  size_bytes: number;
  created_at: string;
}

export interface SubmissionRepository {
  insertSubmission: (payload: SubmissionRecord) => void;
  listSubmissionsByTask: (taskId: string) => SubmissionRecord[];
  getLatestSubmissionByTask: (taskId: string) => SubmissionRecord | undefined;
}

export function createSubmissionRepository(db: Database.Database): SubmissionRepository {
  const insertSubmissionQuery = db.prepare(`
    INSERT INTO submissions (
      id,
      task_id,
      agent_id,
      payload,
      size_bytes,
      created_at
    ) VALUES (
      @id,
      @task_id,
      @agent_id,
      @payload,
      @size_bytes,
      @created_at
    )
  `);

  const listSubmissionsByTaskQuery = db.prepare(`
    SELECT id, task_id, agent_id, payload, size_bytes, created_at
    FROM submissions
    WHERE task_id = ?
    ORDER BY created_at DESC
  `);

  const getLatestSubmissionByTaskQuery = db.prepare(`
    SELECT id, task_id, agent_id, payload, size_bytes, created_at
    FROM submissions
    WHERE task_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `);

  return {
    insertSubmission(payload) {
      insertSubmissionQuery.run(payload);
    },
    listSubmissionsByTask(taskId) {
      return listSubmissionsByTaskQuery.all(taskId) as SubmissionRecord[];
    },
    getLatestSubmissionByTask(taskId) {
      return getLatestSubmissionByTaskQuery.get(taskId) as SubmissionRecord | undefined;
    }
  };
}
