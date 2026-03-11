import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { TASK_STATES, validateTaskTransition } from "../engine/task-state";

const VALID_TASK_STATUSES = new Set<string>([...TASK_STATES, "cancelled"]);

type PublishEvent = (eventType: string, payload: unknown) => void;

interface TasksRouteOptions {
  db: Database.Database;
  publishEvent?: PublishEvent;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  agent_id: string | null;
  complexity: number;
  bounty_lingshi: number;
  required_tags: string;
  created_at: string;
  updated_at: string;
}

interface TaskResponse {
  id: string;
  title: string;
  description: string | null;
  status: string;
  agent_id: string | null;
  complexity: number;
  bounty_lingshi: number;
  required_tags: string[];
  created_at: string;
  updated_at: string;
}

interface BidRow {
  id: string;
  task_id: string;
  agent_id: string;
  confidence: number;
  estimated_cycles: number;
  bid_stake: number;
  created_at: string;
}

interface BidResponse {
  id: string;
  task_id: string;
  agent_id: string;
  confidence: number;
  estimated_cycles: number;
  bid_stake: number;
  created_at: string;
}

interface CreateTaskBody {
  title: unknown;
  description: unknown;
  complexity: unknown;
  bounty_lingshi: unknown;
  required_tags: unknown;
}

interface CreateBidBody {
  agent_id: unknown;
  confidence: unknown;
  estimated_cycles: unknown;
  bid_stake: unknown;
}

interface ValidationIssue {
  field: string;
  message: string;
}

interface ValidCreateTaskPayload {
  title: string;
  description: string | null;
  complexity: number;
  bountyLingshi: number;
  requiredTags: string[];
}

interface ValidCreateBidPayload {
  agentId: string;
  confidence: number;
  estimatedCycles: number;
  bidStake: number;
}

interface AgentIdRow {
  agent_id: string;
}

interface TableInfoRow {
  name: string;
}

function sendValidationError(reply: FastifyReply, issues: ValidationIssue[]) {
  return reply.code(400).send({
    error: {
      code: "VALIDATION_ERROR",
      message: "Invalid request payload",
      details: issues
    }
  });
}

function parseStringArray(value: unknown, fieldName: string): { value?: string[]; issues: ValidationIssue[] } {
  if (!Array.isArray(value)) {
    return {
      issues: [{ field: fieldName, message: `${fieldName} must be an array of non-empty strings` }]
    };
  }

  const normalized: string[] = [];
  const issues: ValidationIssue[] = [];

  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      issues.push({ field: `${fieldName}[${index}]`, message: "tag must be a string" });
      return;
    }

    const trimmed = entry.trim();

    if (!trimmed) {
      issues.push({ field: `${fieldName}[${index}]`, message: "tag cannot be empty" });
      return;
    }

    if (trimmed.length > 64) {
      issues.push({ field: `${fieldName}[${index}]`, message: "tag must be 64 characters or fewer" });
      return;
    }

    normalized.push(trimmed);
  });

  if (issues.length > 0) {
    return { issues };
  }

  return {
    value: Array.from(new Set(normalized)),
    issues: []
  };
}

function validateCreateTaskBody(body: unknown): { value?: ValidCreateTaskPayload; issues: ValidationIssue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      issues: [{ field: "body", message: "request body must be a JSON object" }]
    };
  }

  const payload = body as Partial<CreateTaskBody>;
  const issues: ValidationIssue[] = [];

  const title = typeof payload.title === "string" ? payload.title.trim() : "";

  if (!title) {
    issues.push({ field: "title", message: "title is required" });
  } else if (title.length > 200) {
    issues.push({ field: "title", message: "title must be 200 characters or fewer" });
  }

  let description: string | null = null;

  if (payload.description !== undefined && payload.description !== null) {
    if (typeof payload.description !== "string") {
      issues.push({ field: "description", message: "description must be a string when provided" });
    } else {
      const trimmed = payload.description.trim();

      if (trimmed.length > 4000) {
        issues.push({ field: "description", message: "description must be 4000 characters or fewer" });
      } else {
        description = trimmed;
      }
    }
  }

  const complexity = payload.complexity;

  if (typeof complexity !== "number" || !Number.isInteger(complexity)) {
    issues.push({ field: "complexity", message: "complexity must be an integer" });
  } else if (complexity < 1) {
    issues.push({ field: "complexity", message: "complexity must be greater than or equal to 1" });
  }

  const bountyLingshi = payload.bounty_lingshi;

  if (typeof bountyLingshi !== "number" || !Number.isFinite(bountyLingshi)) {
    issues.push({ field: "bounty_lingshi", message: "bounty_lingshi must be a finite number" });
  } else if (bountyLingshi < 0) {
    issues.push({ field: "bounty_lingshi", message: "bounty_lingshi must be greater than or equal to 0" });
  }

  const tagsResult = parseStringArray(payload.required_tags, "required_tags");
  issues.push(...tagsResult.issues);

  if (issues.length > 0 || !tagsResult.value || typeof complexity !== "number" || typeof bountyLingshi !== "number") {
    return { issues };
  }

  return {
    value: {
      title,
      description,
      complexity,
      bountyLingshi,
      requiredTags: tagsResult.value
    },
    issues: []
  };
}

function validateCreateBidBody(body: unknown): { value?: ValidCreateBidPayload; issues: ValidationIssue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      issues: [{ field: "body", message: "request body must be a JSON object" }]
    };
  }

  const payload = body as Partial<CreateBidBody>;
  const issues: ValidationIssue[] = [];

  const agentId = typeof payload.agent_id === "string" ? payload.agent_id.trim() : "";

  if (!agentId) {
    issues.push({ field: "agent_id", message: "agent_id is required" });
  } else if (agentId.length > 128) {
    issues.push({ field: "agent_id", message: "agent_id must be 128 characters or fewer" });
  }

  const confidence = payload.confidence;

  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    issues.push({ field: "confidence", message: "confidence must be a finite number" });
  } else if (confidence < 0 || confidence > 1) {
    issues.push({ field: "confidence", message: "confidence must be between 0 and 1" });
  }

  const estimatedCycles = payload.estimated_cycles;

  if (typeof estimatedCycles !== "number" || !Number.isInteger(estimatedCycles)) {
    issues.push({ field: "estimated_cycles", message: "estimated_cycles must be an integer" });
  } else if (estimatedCycles < 1) {
    issues.push({ field: "estimated_cycles", message: "estimated_cycles must be greater than or equal to 1" });
  }

  const bidStake = payload.bid_stake;

  if (typeof bidStake !== "number" || !Number.isFinite(bidStake)) {
    issues.push({ field: "bid_stake", message: "bid_stake must be a finite number" });
  } else if (bidStake < 0) {
    issues.push({ field: "bid_stake", message: "bid_stake must be greater than or equal to 0" });
  }

  if (
    issues.length > 0 ||
    typeof confidence !== "number" ||
    typeof estimatedCycles !== "number" ||
    typeof bidStake !== "number"
  ) {
    return { issues };
  }

  return {
    value: {
      agentId,
      confidence,
      estimatedCycles,
      bidStake
    },
    issues: []
  };
}

function parseRequiredTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return parsed;
    }
  } catch {
    // keep invalid persisted payload from crashing response serialization
  }

  return [];
}

function toTaskResponse(row: TaskRow): TaskResponse {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    agent_id: row.agent_id,
    complexity: row.complexity,
    bounty_lingshi: row.bounty_lingshi,
    required_tags: parseRequiredTags(row.required_tags),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function toBidResponse(row: BidRow): BidResponse {
  return {
    id: row.id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    confidence: row.confidence,
    estimated_cycles: row.estimated_cycles,
    bid_stake: row.bid_stake,
    created_at: row.created_at
  };
}

function getColumnNames(db: Database.Database, tableName: "tasks" | "bids") {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function ensureTaskSchema(db: Database.Database) {
  const taskColumns = getColumnNames(db, "tasks");
  const bidColumns = getColumnNames(db, "bids");

  if (!taskColumns.has("complexity")) {
    db.exec("ALTER TABLE tasks ADD COLUMN complexity INTEGER NOT NULL DEFAULT 1");
  }

  if (!taskColumns.has("bounty_lingshi")) {
    db.exec("ALTER TABLE tasks ADD COLUMN bounty_lingshi REAL NOT NULL DEFAULT 0");
  }

  if (!taskColumns.has("required_tags")) {
    db.exec("ALTER TABLE tasks ADD COLUMN required_tags TEXT NOT NULL DEFAULT '[]'");
  }

  if (!bidColumns.has("confidence")) {
    db.exec("ALTER TABLE bids ADD COLUMN confidence REAL NOT NULL DEFAULT 0");
  }

  if (!bidColumns.has("estimated_cycles")) {
    db.exec("ALTER TABLE bids ADD COLUMN estimated_cycles INTEGER NOT NULL DEFAULT 1");
  }

  if (!bidColumns.has("bid_stake")) {
    db.exec("ALTER TABLE bids ADD COLUMN bid_stake REAL NOT NULL DEFAULT 0");
  }
}

const tasksRoutes: FastifyPluginAsync<TasksRouteOptions> = async (app, options) => {
  const { db } = options;
  const publishEvent = options.publishEvent ?? (() => undefined);

  ensureTaskSchema(db);

  const baseTaskSelect = `
    SELECT
      id,
      title,
      description,
      status,
      agent_id,
      complexity,
      bounty_lingshi,
      required_tags,
      created_at,
      updated_at
    FROM tasks
  `;

  const listTasksQuery = db.prepare(`
    ${baseTaskSelect}
    ORDER BY created_at DESC
  `);

  const listTasksByStatusQuery = db.prepare(`
    ${baseTaskSelect}
    WHERE status = @status
    ORDER BY created_at DESC
  `);

  const getTaskByIdQuery = db.prepare(`
    ${baseTaskSelect}
    WHERE id = ?
  `);

  const insertTaskQuery = db.prepare(`
    INSERT INTO tasks (
      id,
      title,
      description,
      status,
      complexity,
      bounty_lingshi,
      required_tags,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @title,
      @description,
      @status,
      @complexity,
      @bounty_lingshi,
      @required_tags,
      @created_at,
      @updated_at
    )
  `);

  const markTaskBiddingQuery = db.prepare(`
    UPDATE tasks
    SET status = @status,
        updated_at = @updated_at
    WHERE id = @id
      AND status = @current_status
  `);

  const getAgentByIdQuery = db.prepare(`
    SELECT agent_id
    FROM agents
    WHERE agent_id = ?
  `);

  const insertBidQuery = db.prepare(`
    INSERT INTO bids (
      id,
      task_id,
      agent_id,
      bid_score,
      note,
      confidence,
      estimated_cycles,
      bid_stake,
      created_at
    ) VALUES (
      @id,
      @task_id,
      @agent_id,
      @bid_score,
      @note,
      @confidence,
      @estimated_cycles,
      @bid_stake,
      @created_at
    )
  `);

  const getBidByIdQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, created_at
    FROM bids
    WHERE id = ?
  `);

  type PlaceBidResult =
    | { type: "task_not_found" }
    | { type: "agent_not_found" }
    | {
        type: "status_conflict";
        status: string;
        from: string;
        to: string;
        message: string;
        allowedNextStates: readonly string[];
      }
    | { type: "ok"; bid: BidResponse; task: TaskResponse };

  const placeBid = db.transaction((payload: ValidCreateBidPayload & { taskId: string; bidId: string; now: string }) => {
    const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

    if (!taskRow) {
      return { type: "task_not_found" } as PlaceBidResult;
    }

    const agentRow = getAgentByIdQuery.get(payload.agentId) as AgentIdRow | undefined;

    if (!agentRow) {
      return { type: "agent_not_found" } as PlaceBidResult;
    }

    if (taskRow.status !== "bidding") {
      const transition = validateTaskTransition(taskRow.status, "bidding");

      if (!transition.ok) {
        return {
          type: "status_conflict",
          status: taskRow.status,
          from: transition.from,
          to: transition.to,
          message: transition.message,
          allowedNextStates: transition.allowed_next_states
        } as PlaceBidResult;
      }

      const transitionResult = markTaskBiddingQuery.run({
        id: payload.taskId,
        status: transition.to,
        current_status: transition.from,
        updated_at: payload.now
      });

      if (transitionResult.changes === 0) {
        const refreshedConflictTask = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;
        const refreshedStatus = refreshedConflictTask?.status ?? taskRow.status;
        const refreshedTransition = validateTaskTransition(refreshedStatus, "bidding");
        const conflictMessage = refreshedTransition.ok
          ? `Task state transition ${refreshedTransition.from} -> ${refreshedTransition.to} could not be persisted`
          : refreshedTransition.message;
        const allowedNextStates = refreshedTransition.ok
          ? [refreshedTransition.to]
          : refreshedTransition.allowed_next_states;

        return {
          type: "status_conflict",
          status: refreshedStatus,
          from: refreshedTransition.from,
          to: refreshedTransition.to,
          message: conflictMessage,
          allowedNextStates
        } as PlaceBidResult;
      }
    }

    insertBidQuery.run({
      id: payload.bidId,
      task_id: payload.taskId,
      agent_id: payload.agentId,
      bid_score: payload.confidence,
      note: null,
      confidence: payload.confidence,
      estimated_cycles: payload.estimatedCycles,
      bid_stake: payload.bidStake,
      created_at: payload.now
    });

    const bidRow = getBidByIdQuery.get(payload.bidId) as BidRow | undefined;
    const refreshedTaskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

    if (!bidRow || !refreshedTaskRow) {
      throw new Error("Bid creation succeeded but reloading persisted rows failed");
    }

    return {
      type: "ok",
      bid: toBidResponse(bidRow),
      task: toTaskResponse(refreshedTaskRow)
    } as PlaceBidResult;
  });

  app.get<{ Querystring: { status?: string } }>("/tasks", async (request, reply) => {
    const { status } = request.query;

    if (status !== undefined) {
      const normalizedStatus = status.trim();

      if (!normalizedStatus || !VALID_TASK_STATUSES.has(normalizedStatus)) {
        return sendValidationError(reply, [
          {
            field: "status",
            message: `status must be one of: ${Array.from(VALID_TASK_STATUSES).join(", ")}`
          }
        ]);
      }

      const rows = listTasksByStatusQuery.all({ status: normalizedStatus }) as TaskRow[];

      return {
        data: {
          tasks: rows.map(toTaskResponse)
        }
      };
    }

    const rows = listTasksQuery.all() as TaskRow[];

    return {
      data: {
        tasks: rows.map(toTaskResponse)
      }
    };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    const taskId = request.params.id.trim();

    if (!taskId) {
      return sendValidationError(reply, [{ field: "id", message: "id is required" }]);
    }

    const row = getTaskByIdQuery.get(taskId) as TaskRow | undefined;

    if (!row) {
      return reply.code(404).send({
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task ${taskId} was not found`
        }
      });
    }

    return {
      data: {
        task: toTaskResponse(row)
      }
    };
  });

  app.post<{ Body: unknown }>("/tasks", async (request, reply) => {
    const validation = validateCreateTaskBody(request.body);

    if (!validation.value) {
      return sendValidationError(reply, validation.issues);
    }

    const now = new Date().toISOString();
    const taskId = randomUUID();

    insertTaskQuery.run({
      id: taskId,
      title: validation.value.title,
      description: validation.value.description,
      status: "open",
      complexity: validation.value.complexity,
      bounty_lingshi: validation.value.bountyLingshi,
      required_tags: JSON.stringify(validation.value.requiredTags),
      created_at: now,
      updated_at: now
    });

    const row = getTaskByIdQuery.get(taskId) as TaskRow | undefined;

    if (!row) {
      return reply.code(500).send({
        error: {
          code: "TASK_CREATION_FAILED",
          message: "Task was created but could not be loaded"
        }
      });
    }

    const task = toTaskResponse(row);
    publishEvent("task.posted", {
      task_id: task.id,
      status: task.status,
      created_at: task.created_at
    });

    return reply.code(201).send({
      data: {
        task
      }
    });
  });

  const createBidHandler = async (
    request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
    reply: FastifyReply
  ) => {
    const taskId = request.params.id.trim();

    if (!taskId) {
      return sendValidationError(reply, [{ field: "id", message: "id is required" }]);
    }

    const validation = validateCreateBidBody(request.body);

    if (!validation.value) {
      return sendValidationError(reply, validation.issues);
    }

    const result = placeBid({
      ...validation.value,
      taskId,
      bidId: randomUUID(),
      now: new Date().toISOString()
    });

    if (result.type === "task_not_found") {
      return reply.code(404).send({
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task ${taskId} was not found`
        }
      });
    }

    if (result.type === "agent_not_found") {
      return reply.code(404).send({
        error: {
          code: "AGENT_NOT_FOUND",
          message: `Agent ${validation.value.agentId} was not found`
        }
      });
    }

    if (result.type === "status_conflict") {
      publishEvent("task.bid_result", {
        task_id: taskId,
        agent_id: validation.value.agentId,
        accepted: false,
        current_status: result.status,
        attempted_transition: {
          from: result.from,
          to: result.to
        }
      });

      return reply.code(409).send({
        error: {
          code: "TASK_NOT_BIDDABLE",
          message: `Task ${taskId} cannot transition ${result.from} -> ${result.to} for bidding`,
          details: {
            current_status: result.status,
            attempted_transition: {
              from: result.from,
              to: result.to
            },
            allowed_next_states: result.allowedNextStates
          }
        }
      });
    }

    publishEvent("task.bid_result", {
      task_id: result.task.id,
      bid_id: result.bid.id,
      agent_id: result.bid.agent_id,
      accepted: true,
      task_status: result.task.status
    });

    if (result.task.status === "assigned" && result.task.agent_id) {
      publishEvent("task.assigned", {
        task_id: result.task.id,
        agent_id: result.task.agent_id,
        source: "placeholder"
      });
    }

    return reply.code(201).send({
      data: {
        bid: result.bid,
        task: result.task
      }
    });
  };

  app.post<{ Params: { id: string }; Body: unknown }>("/tasks/:id/bid", createBidHandler);
  app.post<{ Params: { id: string }; Body: unknown }>("/tasks/:id/bids", createBidHandler);
};

export default tasksRoutes;
