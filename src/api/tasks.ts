import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { sendError } from "./error-envelope";
import { createAgentAuthMiddleware } from "./middleware/agent-auth";
import {
  createAgentRateLimitMiddleware,
  resolveRateLimitMaxTrackedKeysFromEnv,
  resolveRateLimitPerMinuteFromEnv
} from "./middleware/rate-limit";
import { EXPECTED_INDEX_CREATE_SQL } from "../db/expected-indexes";
import { TASK_STATES, validateTaskTransition } from "../engine/task-state";

const VALID_TASK_STATUSES = new Set<string>([...TASK_STATES, "cancelled"]);
const DEFAULT_SETTLEMENT_REASON = "task_settlement";
const DEFAULT_AGENT_OPEN_BID_CAP = 3;
const SETTLEMENT_IDEMPOTENCY_PREFIX = "settle:v2";
const SETTLEMENT_IDEMPOTENCY_ACTION = "settlement";

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
  assigned_bid_id: string | null;
  submission_payload: string | null;
  submitted_at: string | null;
  score_quality: number | null;
  score_speed: number | null;
  score_innovation: number | null;
  final_score: number | null;
  scored_at: string | null;
  settled_at: string | null;
  settlement_ledger_id: string | null;
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

interface AssignTaskBody {
  bid_id: unknown;
  agent_id: unknown;
}

interface SubmitTaskBody {
  agent_id: unknown;
  result: unknown;
}

interface ScoreTaskBody {
  quality: unknown;
  speed: unknown;
  innovation: unknown;
  final_score: unknown;
}

interface SettleTaskBody {
  agent_id: unknown;
  reason: unknown;
  amount: unknown;
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

interface ValidAssignTaskPayload {
  bidId?: string;
  agentId?: string;
}

interface ValidSubmitTaskPayload {
  agentId?: string;
  result: unknown;
  serializedResult: string;
}

interface ValidScoreTaskPayload {
  quality: number;
  speed: number;
  innovation: number;
  finalScore: number;
}

interface ValidSettleTaskPayload {
  agentId?: string;
  reason: string;
  amount?: number;
}

interface AgentIdRow {
  agent_id: string;
}

interface OpenBidCountRow {
  open_bid_count: number;
}

interface TableInfoRow {
  name: string;
}

interface StatusConflictResult {
  status: string;
  from: string;
  to: string;
  message: string;
  allowedNextStates: readonly string[];
}

function sendValidationError(reply: FastifyReply, issues: ValidationIssue[]) {
  return sendError(reply, 400, "VALIDATION_ERROR", "Invalid request payload", issues);
}

function sendTaskStateConflict(reply: FastifyReply, taskId: string, conflict: StatusConflictResult) {
  return sendError(reply, 422, "TASK_STATE_TRANSITION_INVALID", `Task ${taskId} cannot transition ${conflict.from} -> ${conflict.to}`, {
    current_status: conflict.status,
    attempted_transition: {
      from: conflict.from,
      to: conflict.to
    },
    allowed_next_states: conflict.allowedNextStates,
    reason: conflict.message
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function sendAgentForbidden(reply: FastifyReply, expectedAgentId: string, requestedAgentId: string, field: string) {
  return sendError(reply, 403, "AGENT_FORBIDDEN", `${field} does not match authenticated agent`, {
    authenticated_agent_id: expectedAgentId,
    requested_agent_id: requestedAgentId
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

function normalizeOptionalString(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
  maxLength: number
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    issues.push({ field, message: `${field} must be a string when provided` });
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    issues.push({ field, message: `${field} cannot be empty` });
    return undefined;
  }

  if (normalized.length > maxLength) {
    issues.push({ field, message: `${field} must be ${maxLength} characters or fewer` });
    return undefined;
  }

  return normalized;
}

function normalizeScore(value: unknown, field: string, issues: ValidationIssue[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ field, message: `${field} must be a finite number` });
    return undefined;
  }

  if (value < 0 || value > 100) {
    issues.push({ field, message: `${field} must be between 0 and 100` });
    return undefined;
  }

  return value;
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

function validateAssignTaskBody(body: unknown): { value?: ValidAssignTaskPayload; issues: ValidationIssue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      issues: [{ field: "body", message: "request body must be a JSON object" }]
    };
  }

  const payload = body as Partial<AssignTaskBody>;
  const issues: ValidationIssue[] = [];
  const bidId = normalizeOptionalString(payload.bid_id, "bid_id", issues, 128);
  const agentId = normalizeOptionalString(payload.agent_id, "agent_id", issues, 128);

  if (!bidId && !agentId) {
    issues.push({ field: "body", message: "either bid_id or agent_id is required" });
  }

  if (issues.length > 0) {
    return { issues };
  }

  return {
    value: {
      bidId,
      agentId
    },
    issues: []
  };
}

function validateSubmitTaskBody(body: unknown): { value?: ValidSubmitTaskPayload; issues: ValidationIssue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      issues: [{ field: "body", message: "request body must be a JSON object" }]
    };
  }

  const payload = body as Partial<SubmitTaskBody>;
  const issues: ValidationIssue[] = [];
  const agentId = normalizeOptionalString(payload.agent_id, "agent_id", issues, 128);

  if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
    issues.push({ field: "result", message: "result is required" });
  }

  const result = payload.result;
  let serializedResult = "";

  if (result === undefined) {
    issues.push({ field: "result", message: "result cannot be undefined" });
  } else {
    try {
      const serialized = JSON.stringify(result);

      if (serialized === undefined) {
        issues.push({ field: "result", message: "result must be JSON-serializable" });
      } else {
        serializedResult = serialized;
      }
    } catch {
      issues.push({ field: "result", message: "result must be JSON-serializable" });
    }
  }

  if (issues.length > 0 || !serializedResult) {
    return { issues };
  }

  return {
    value: {
      agentId,
      result,
      serializedResult
    },
    issues: []
  };
}

function validateScoreTaskBody(body: unknown): { value?: ValidScoreTaskPayload; issues: ValidationIssue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      issues: [{ field: "body", message: "request body must be a JSON object" }]
    };
  }

  const payload = body as Partial<ScoreTaskBody>;
  const issues: ValidationIssue[] = [];
  const quality = normalizeScore(payload.quality, "quality", issues);
  const speed = normalizeScore(payload.speed, "speed", issues);
  const innovation = normalizeScore(payload.innovation, "innovation", issues);

  let finalScore: number | undefined;

  if (payload.final_score !== undefined && payload.final_score !== null) {
    finalScore = normalizeScore(payload.final_score, "final_score", issues);
  }

  if (quality !== undefined && speed !== undefined && innovation !== undefined && finalScore === undefined) {
    finalScore = roundToTwo((quality + speed + innovation) / 3);
  }

  if (issues.length > 0 || quality === undefined || speed === undefined || innovation === undefined || finalScore === undefined) {
    return { issues };
  }

  return {
    value: {
      quality,
      speed,
      innovation,
      finalScore
    },
    issues: []
  };
}

function validateSettleTaskBody(body: unknown): { value?: ValidSettleTaskPayload; issues: ValidationIssue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      issues: [{ field: "body", message: "request body must be a JSON object" }]
    };
  }

  const payload = body as Partial<SettleTaskBody>;
  const issues: ValidationIssue[] = [];
  const agentId = normalizeOptionalString(payload.agent_id, "agent_id", issues, 128);
  const reason = normalizeOptionalString(payload.reason, "reason", issues, 128) ?? DEFAULT_SETTLEMENT_REASON;

  const rawAmount = payload.amount;
  let amount: number | undefined;

  if (rawAmount !== undefined && rawAmount !== null) {
    if (typeof rawAmount !== "number" || !Number.isFinite(rawAmount)) {
      issues.push({ field: "amount", message: "amount must be a finite number when provided" });
    } else if (rawAmount < 0) {
      issues.push({ field: "amount", message: "amount must be greater than or equal to 0" });
    } else {
      amount = rawAmount;
    }
  }

  if (issues.length > 0) {
    return { issues };
  }

  return {
    value: {
      agentId,
      reason,
      amount
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

function parseJsonPayload(raw: string | null): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function roundToTwo(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function deriveSettlementCycleId(task: Pick<TaskRow, "scored_at" | "submitted_at" | "created_at">) {
  if (task.scored_at) {
    return `scored_at:${task.scored_at}`;
  }

  if (task.submitted_at) {
    return `submitted_at:${task.submitted_at}`;
  }

  return `created_at:${task.created_at}`;
}

function buildSettlementIdempotencyCanonical(taskId: string, cycleId: string, agentId: string) {
  return `task_id=${taskId}|cycle_id=${cycleId}|agent_id=${agentId}|action=${SETTLEMENT_IDEMPOTENCY_ACTION}`;
}

function buildSettlementIdempotencyKey(taskId: string, cycleId: string, agentId: string) {
  const canonical = buildSettlementIdempotencyCanonical(taskId, cycleId, agentId);
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${SETTLEMENT_IDEMPOTENCY_PREFIX}:${digest}`;
}

function buildLegacySettlementIdempotencyKey(taskId: string, reason: string, agentId: string) {
  return `${taskId}:${reason}:${agentId}`;
}

function isLegacySettlementIdempotencyKeyForTaskAgent(idempotencyKey: string, taskId: string, agentId: string) {
  return idempotencyKey.startsWith(`${taskId}:`) && idempotencyKey.endsWith(`:${agentId}`);
}

function readSettlementCycleIdFromLedgerNote(note: string | null): string | undefined {
  const parsed = parseJsonPayload(note);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const cycleId = (parsed as { cycle_id?: unknown }).cycle_id;

  if (typeof cycleId !== "string") {
    return undefined;
  }

  const normalized = cycleId.trim();

  return normalized || undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;

  return (
    (typeof code === "string" && code.includes("SQLITE_CONSTRAINT")) ||
    (typeof message === "string" && message.includes("UNIQUE constraint failed"))
  );
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

function toStatusConflict(status: string, toState: string): StatusConflictResult {
  const transition = validateTaskTransition(status, toState);

  if (transition.ok) {
    return {
      status,
      from: transition.from,
      to: transition.to,
      message: `Task state transition ${transition.from} -> ${transition.to} could not be persisted`,
      allowedNextStates: [transition.to]
    };
  }

  return {
    status,
    from: transition.from,
    to: transition.to,
    message: transition.message,
    allowedNextStates: transition.allowed_next_states
  };
}

function getColumnNames(db: Database.Database, tableName: "tasks" | "bids" | "ledger") {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function ensureTaskSchema(db: Database.Database) {
  const taskColumns = getColumnNames(db, "tasks");
  const bidColumns = getColumnNames(db, "bids");
  const ledgerColumns = getColumnNames(db, "ledger");

  if (!taskColumns.has("complexity")) {
    db.exec("ALTER TABLE tasks ADD COLUMN complexity INTEGER NOT NULL DEFAULT 1");
  }

  if (!taskColumns.has("bounty_lingshi")) {
    db.exec("ALTER TABLE tasks ADD COLUMN bounty_lingshi REAL NOT NULL DEFAULT 0");
  }

  if (!taskColumns.has("required_tags")) {
    db.exec("ALTER TABLE tasks ADD COLUMN required_tags TEXT NOT NULL DEFAULT '[]'");
  }

  if (!taskColumns.has("assigned_bid_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN assigned_bid_id TEXT");
  }

  if (!taskColumns.has("submission_payload")) {
    db.exec("ALTER TABLE tasks ADD COLUMN submission_payload TEXT");
  }

  if (!taskColumns.has("submitted_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN submitted_at TEXT");
  }

  if (!taskColumns.has("score_quality")) {
    db.exec("ALTER TABLE tasks ADD COLUMN score_quality REAL");
  }

  if (!taskColumns.has("score_speed")) {
    db.exec("ALTER TABLE tasks ADD COLUMN score_speed REAL");
  }

  if (!taskColumns.has("score_innovation")) {
    db.exec("ALTER TABLE tasks ADD COLUMN score_innovation REAL");
  }

  if (!taskColumns.has("final_score")) {
    db.exec("ALTER TABLE tasks ADD COLUMN final_score REAL");
  }

  if (!taskColumns.has("scored_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN scored_at TEXT");
  }

  if (!taskColumns.has("settled_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN settled_at TEXT");
  }

  if (!taskColumns.has("settlement_ledger_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN settlement_ledger_id TEXT");
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

  if (!ledgerColumns.has("task_id")) {
    db.exec("ALTER TABLE ledger ADD COLUMN task_id TEXT");
  }

  if (!ledgerColumns.has("agent_id")) {
    db.exec("ALTER TABLE ledger ADD COLUMN agent_id TEXT");
  }

  if (!ledgerColumns.has("reason")) {
    db.exec("ALTER TABLE ledger ADD COLUMN reason TEXT");
  }

  if (!ledgerColumns.has("idempotency_key")) {
    db.exec("ALTER TABLE ledger ADD COLUMN idempotency_key TEXT");
  }

  for (const createIndexSql of EXPECTED_INDEX_CREATE_SQL) {
    db.exec(createIndexSql);
  }
}

const tasksRoutes: FastifyPluginAsync<TasksRouteOptions> = async (app, options) => {
  const { db } = options;
  const publishEvent = options.publishEvent ?? (() => undefined);
  const openBidCap = parsePositiveInteger(process.env.AGENT_OPEN_BID_CAP, DEFAULT_AGENT_OPEN_BID_CAP);
  const authMiddleware = createAgentAuthMiddleware(db);
  const rateLimitMiddleware = createAgentRateLimitMiddleware({
    maxRequestsPerMinute: resolveRateLimitPerMinuteFromEnv(),
    maxTrackedKeys: resolveRateLimitMaxTrackedKeysFromEnv()
  });

  ensureTaskSchema(db);

  const baseTaskSelect = `
    SELECT
      id,
      title,
      description,
      status,
      agent_id,
      assigned_bid_id,
      submission_payload,
      submitted_at,
      score_quality,
      score_speed,
      score_innovation,
      final_score,
      scored_at,
      settled_at,
      settlement_ledger_id,
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

  const markTaskAssignedQuery = db.prepare(`
    UPDATE tasks
    SET status = @status,
        agent_id = @agent_id,
        assigned_bid_id = @assigned_bid_id,
        updated_at = @updated_at
    WHERE id = @id
      AND status = @current_status
  `);

  const markTaskSubmittedQuery = db.prepare(`
    UPDATE tasks
    SET status = @status,
        submission_payload = @submission_payload,
        submitted_at = @submitted_at,
        updated_at = @updated_at
    WHERE id = @id
      AND status = @current_status
  `);

  const markTaskScoredQuery = db.prepare(`
    UPDATE tasks
    SET status = @status,
        score_quality = @score_quality,
        score_speed = @score_speed,
        score_innovation = @score_innovation,
        final_score = @final_score,
        scored_at = @scored_at,
        updated_at = @updated_at
    WHERE id = @id
      AND status = @current_status
  `);

  const markTaskSettledQuery = db.prepare(`
    UPDATE tasks
    SET status = @status,
        settled_at = @settled_at,
        settlement_ledger_id = @settlement_ledger_id,
        updated_at = @updated_at
    WHERE id = @id
      AND status = @current_status
  `);

  const getAgentByIdQuery = db.prepare(`
    SELECT agent_id
    FROM agents
    WHERE agent_id = ?
  `);

  const creditAgentBalanceQuery = db.prepare(`
    UPDATE agents
    SET lingshi_balance = lingshi_balance + @amount,
        updated_at = @updated_at
    WHERE agent_id = @agent_id
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

  const getBidByTaskAndIdQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, created_at
    FROM bids
    WHERE task_id = @task_id
      AND id = @id
  `);

  const getBidByTaskAndAgentQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, created_at
    FROM bids
    WHERE task_id = @task_id
      AND agent_id = @agent_id
    ORDER BY confidence DESC, created_at ASC
    LIMIT 1
  `);

  const countOpenBidsByAgentQuery = db.prepare(`
    SELECT COUNT(*) AS open_bid_count
    FROM bids
    INNER JOIN tasks ON tasks.id = bids.task_id
    WHERE bids.agent_id = ?
      AND tasks.status IN ('open', 'bidding', 'assigned', 'submitted', 'scored')
  `);

  const getLedgerByIdQuery = db.prepare(`
    SELECT id, entity_id, task_id, agent_id, reason, idempotency_key, entry_type, amount, currency, note, created_at
    FROM ledger
    WHERE id = ?
  `);

  const getLedgerByIdempotencyKeyQuery = db.prepare(`
    SELECT id, entity_id, task_id, agent_id, reason, idempotency_key, entry_type, amount, currency, note, created_at
    FROM ledger
    WHERE idempotency_key = ?
  `);

  const listSettlementLedgerByTaskAndAgentQuery = db.prepare(`
    SELECT id, entity_id, task_id, agent_id, reason, idempotency_key, entry_type, amount, currency, note, created_at
    FROM ledger
    WHERE task_id = @task_id
      AND agent_id = @agent_id
      AND entry_type = 'task_settlement'
    ORDER BY created_at DESC
  `);

  const insertLedgerEntryQuery = db.prepare(`
    INSERT INTO ledger (
      id,
      entity_id,
      task_id,
      agent_id,
      reason,
      idempotency_key,
      entry_type,
      amount,
      currency,
      note,
      created_at
    ) VALUES (
      @id,
      @entity_id,
      @task_id,
      @agent_id,
      @reason,
      @idempotency_key,
      @entry_type,
      @amount,
      @currency,
      @note,
      @created_at
    )
  `);

  type PlaceBidResult =
    | { type: "task_not_found" }
    | { type: "agent_not_found" }
    | { type: "bid_cap_exceeded"; openBidCount: number; cap: number }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | { type: "ok"; bid: BidResponse; task: TaskResponse };

  type AssignTaskResult =
    | { type: "task_not_found" }
    | { type: "bid_not_found" }
    | { type: "agent_not_found" }
    | { type: "assignment_mismatch"; bidAgentId: string; requestedAgentId: string }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | { type: "ok"; task: TaskResponse; assignedBid: BidResponse; assignedAt: string };

  type SubmitTaskResult =
    | { type: "task_not_found" }
    | { type: "assignee_missing" }
    | { type: "forbidden_agent"; expectedAgentId: string; requestedAgentId: string }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | { type: "ok"; task: TaskResponse; submittedAt: string; submitterAgentId: string; result: unknown };

  type ScoreTaskResult =
    | { type: "task_not_found" }
    | { type: "assignee_missing" }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | {
        type: "ok";
        task: TaskResponse;
        scoredAt: string;
        quality: number;
        speed: number;
        innovation: number;
        finalScore: number;
      };

  type SettleTaskResult =
    | { type: "task_not_found" }
    | { type: "agent_not_found"; agentId: string }
    | { type: "assignee_missing" }
    | { type: "duplicate_idempotency"; ledger: LedgerRow }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | { type: "agent_balance_update_failed"; agentId: string }
    | {
        type: "ok";
        task: TaskResponse;
        settledAt: string;
        payoutAgentId: string;
        payoutAmount: number;
        reason: string;
        idempotencyKey: string;
        ledger: LedgerRow;
      };

  const findDuplicateSettlementLedger = (
    taskId: string,
    payoutAgentId: string,
    cycleId: string,
    candidateIdempotencyKeys: readonly string[]
  ): LedgerRow | undefined => {
    for (const candidateKey of candidateIdempotencyKeys) {
      const existingByKey = getLedgerByIdempotencyKeyQuery.get(candidateKey) as LedgerRow | undefined;

      if (existingByKey) {
        return existingByKey;
      }
    }

    const historicalSettlements = listSettlementLedgerByTaskAndAgentQuery.all({
      task_id: taskId,
      agent_id: payoutAgentId
    }) as LedgerRow[];

    for (const settlement of historicalSettlements) {
      const settlementKey = settlement.idempotency_key?.trim();

      if (!settlementKey) {
        continue;
      }

      if (candidateIdempotencyKeys.includes(settlementKey)) {
        return settlement;
      }

      const settlementCycleId = readSettlementCycleIdFromLedgerNote(settlement.note);

      if (settlementCycleId && settlementCycleId === cycleId) {
        return settlement;
      }

      if (!settlementCycleId && isLegacySettlementIdempotencyKeyForTaskAgent(settlementKey, taskId, payoutAgentId)) {
        return settlement;
      }
    }

    return undefined;
  };

  const placeBid = db.transaction((payload: ValidCreateBidPayload & { taskId: string; bidId: string; now: string }) => {
    const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

    if (!taskRow) {
      return { type: "task_not_found" } as PlaceBidResult;
    }

    const agentRow = getAgentByIdQuery.get(payload.agentId) as AgentIdRow | undefined;

    if (!agentRow) {
      return { type: "agent_not_found" } as PlaceBidResult;
    }

    const openBidCountRow = countOpenBidsByAgentQuery.get(payload.agentId) as OpenBidCountRow | undefined;
    const openBidCount = openBidCountRow?.open_bid_count ?? 0;

    if (openBidCount >= openBidCap) {
      return {
        type: "bid_cap_exceeded",
        openBidCount,
        cap: openBidCap
      } as PlaceBidResult;
    }

    if (taskRow.status !== "bidding") {
      const transition = validateTaskTransition(taskRow.status, "bidding");

      if (!transition.ok) {
        return {
          type: "status_conflict",
          conflict: {
            status: taskRow.status,
            from: transition.from,
            to: transition.to,
            message: transition.message,
            allowedNextStates: transition.allowed_next_states
          }
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

        if (refreshedStatus === "bidding") {
          // Another request transitioned the task to bidding first; this bid can still be accepted.
        } else {
          return {
            type: "status_conflict",
            conflict: toStatusConflict(refreshedStatus, "bidding")
          } as PlaceBidResult;
        }
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

  const assignTask = db.transaction(
    (payload: ValidAssignTaskPayload & { taskId: string; now: string }) => {
      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        return { type: "task_not_found" } as AssignTaskResult;
      }

      const transition = validateTaskTransition(taskRow.status, "assigned");

      if (!transition.ok) {
        return {
          type: "status_conflict",
          conflict: {
            status: taskRow.status,
            from: transition.from,
            to: transition.to,
            message: transition.message,
            allowedNextStates: transition.allowed_next_states
          }
        } as AssignTaskResult;
      }

      let assignedBidRow: BidRow | undefined;

      if (payload.bidId) {
        assignedBidRow = getBidByTaskAndIdQuery.get({
          task_id: payload.taskId,
          id: payload.bidId
        }) as BidRow | undefined;
      } else if (payload.agentId) {
        assignedBidRow = getBidByTaskAndAgentQuery.get({
          task_id: payload.taskId,
          agent_id: payload.agentId
        }) as BidRow | undefined;
      }

      if (!assignedBidRow) {
        return { type: "bid_not_found" } as AssignTaskResult;
      }

      if (payload.agentId && payload.agentId !== assignedBidRow.agent_id) {
        return {
          type: "assignment_mismatch",
          bidAgentId: assignedBidRow.agent_id,
          requestedAgentId: payload.agentId
        } as AssignTaskResult;
      }

      const agentRow = getAgentByIdQuery.get(assignedBidRow.agent_id) as AgentIdRow | undefined;

      if (!agentRow) {
        return { type: "agent_not_found" } as AssignTaskResult;
      }

      const updateResult = markTaskAssignedQuery.run({
        id: payload.taskId,
        status: transition.to,
        current_status: transition.from,
        agent_id: assignedBidRow.agent_id,
        assigned_bid_id: assignedBidRow.id,
        updated_at: payload.now
      });

      if (updateResult.changes === 0) {
        const refreshedTaskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;
        const refreshedStatus = refreshedTaskRow?.status ?? taskRow.status;

        return {
          type: "status_conflict",
          conflict: toStatusConflict(refreshedStatus, "assigned")
        } as AssignTaskResult;
      }

      const persistedTask = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!persistedTask) {
        throw new Error("Task assignment succeeded but reloading task failed");
      }

      return {
        type: "ok",
        task: toTaskResponse(persistedTask),
        assignedBid: toBidResponse(assignedBidRow),
        assignedAt: payload.now
      } as AssignTaskResult;
    }
  );

  const submitTask = db.transaction(
    (payload: ValidSubmitTaskPayload & { taskId: string; now: string }) => {
      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        return { type: "task_not_found" } as SubmitTaskResult;
      }

      const transition = validateTaskTransition(taskRow.status, "submitted");

      if (!transition.ok) {
        return {
          type: "status_conflict",
          conflict: {
            status: taskRow.status,
            from: transition.from,
            to: transition.to,
            message: transition.message,
            allowedNextStates: transition.allowed_next_states
          }
        } as SubmitTaskResult;
      }

      if (!taskRow.agent_id) {
        return { type: "assignee_missing" } as SubmitTaskResult;
      }

      if (payload.agentId && payload.agentId !== taskRow.agent_id) {
        return {
          type: "forbidden_agent",
          expectedAgentId: taskRow.agent_id,
          requestedAgentId: payload.agentId
        } as SubmitTaskResult;
      }

      const updateResult = markTaskSubmittedQuery.run({
        id: payload.taskId,
        status: transition.to,
        current_status: transition.from,
        submission_payload: payload.serializedResult,
        submitted_at: payload.now,
        updated_at: payload.now
      });

      if (updateResult.changes === 0) {
        const refreshedTaskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;
        const refreshedStatus = refreshedTaskRow?.status ?? taskRow.status;

        return {
          type: "status_conflict",
          conflict: toStatusConflict(refreshedStatus, "submitted")
        } as SubmitTaskResult;
      }

      const persistedTask = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!persistedTask) {
        throw new Error("Task submission succeeded but reloading task failed");
      }

      return {
        type: "ok",
        task: toTaskResponse(persistedTask),
        submittedAt: payload.now,
        submitterAgentId: taskRow.agent_id,
        result: payload.result
      } as SubmitTaskResult;
    }
  );

  const scoreTask = db.transaction(
    (payload: ValidScoreTaskPayload & { taskId: string; now: string }) => {
      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        return { type: "task_not_found" } as ScoreTaskResult;
      }

      const transition = validateTaskTransition(taskRow.status, "scored");

      if (!transition.ok) {
        return {
          type: "status_conflict",
          conflict: {
            status: taskRow.status,
            from: transition.from,
            to: transition.to,
            message: transition.message,
            allowedNextStates: transition.allowed_next_states
          }
        } as ScoreTaskResult;
      }

      if (!taskRow.agent_id) {
        return { type: "assignee_missing" } as ScoreTaskResult;
      }

      const updateResult = markTaskScoredQuery.run({
        id: payload.taskId,
        status: transition.to,
        current_status: transition.from,
        score_quality: payload.quality,
        score_speed: payload.speed,
        score_innovation: payload.innovation,
        final_score: payload.finalScore,
        scored_at: payload.now,
        updated_at: payload.now
      });

      if (updateResult.changes === 0) {
        const refreshedTaskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;
        const refreshedStatus = refreshedTaskRow?.status ?? taskRow.status;

        return {
          type: "status_conflict",
          conflict: toStatusConflict(refreshedStatus, "scored")
        } as ScoreTaskResult;
      }

      const persistedTask = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!persistedTask) {
        throw new Error("Task scoring succeeded but reloading task failed");
      }

      return {
        type: "ok",
        task: toTaskResponse(persistedTask),
        scoredAt: payload.now,
        quality: payload.quality,
        speed: payload.speed,
        innovation: payload.innovation,
        finalScore: payload.finalScore
      } as ScoreTaskResult;
    }
  );

  const settleTask = db.transaction(
    (
      payload: ValidSettleTaskPayload & {
        taskId: string;
        now: string;
        ledgerId: string;
      }
    ) => {
      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        return { type: "task_not_found" } as SettleTaskResult;
      }

      const payoutAgentId = payload.agentId ?? taskRow.agent_id;

      if (!payoutAgentId) {
        return { type: "assignee_missing" } as SettleTaskResult;
      }

      const cycleId = deriveSettlementCycleId(taskRow);
      const idempotencyKey = buildSettlementIdempotencyKey(payload.taskId, cycleId, payoutAgentId);
      const legacyIdempotencyKey = buildLegacySettlementIdempotencyKey(payload.taskId, payload.reason, payoutAgentId);
      const legacyDefaultReasonIdempotencyKey = buildLegacySettlementIdempotencyKey(
        payload.taskId,
        DEFAULT_SETTLEMENT_REASON,
        payoutAgentId
      );
      const duplicateKeyCandidates = Array.from(
        new Set([idempotencyKey, legacyIdempotencyKey, legacyDefaultReasonIdempotencyKey])
      );
      const existingLedgerByIdempotency = findDuplicateSettlementLedger(
        payload.taskId,
        payoutAgentId,
        cycleId,
        duplicateKeyCandidates
      );

      if (existingLedgerByIdempotency) {
        return {
          type: "duplicate_idempotency",
          ledger: existingLedgerByIdempotency
        } as SettleTaskResult;
      }

      const transition = validateTaskTransition(taskRow.status, "settled");

      if (!transition.ok) {
        return {
          type: "status_conflict",
          conflict: {
            status: taskRow.status,
            from: transition.from,
            to: transition.to,
            message: transition.message,
            allowedNextStates: transition.allowed_next_states
          }
        } as SettleTaskResult;
      }

      const payoutAgent = getAgentByIdQuery.get(payoutAgentId) as AgentIdRow | undefined;

      if (!payoutAgent) {
        return {
          type: "agent_not_found",
          agentId: payoutAgentId
        } as SettleTaskResult;
      }

      const finalScore = taskRow.final_score ?? 0;
      const derivedAmount = roundToTwo(taskRow.bounty_lingshi * (finalScore / 100));
      const payoutAmount = payload.amount !== undefined ? payload.amount : derivedAmount;

      const taskUpdateResult = markTaskSettledQuery.run({
        id: payload.taskId,
        status: transition.to,
        current_status: transition.from,
        settled_at: payload.now,
        settlement_ledger_id: payload.ledgerId,
        updated_at: payload.now
      });

      if (taskUpdateResult.changes === 0) {
        const refreshedTaskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;
        const refreshedStatus = refreshedTaskRow?.status ?? taskRow.status;
        const refreshedLedger = findDuplicateSettlementLedger(
          payload.taskId,
          payoutAgentId,
          cycleId,
          duplicateKeyCandidates
        );

        if (refreshedLedger) {
          return {
            type: "duplicate_idempotency",
            ledger: refreshedLedger
          } as SettleTaskResult;
        }

        return {
          type: "status_conflict",
          conflict: toStatusConflict(refreshedStatus, "settled")
        } as SettleTaskResult;
      }

      try {
        insertLedgerEntryQuery.run({
          id: payload.ledgerId,
          entity_id: payoutAgentId,
          task_id: payload.taskId,
          agent_id: payoutAgentId,
          reason: payload.reason,
          idempotency_key: idempotencyKey,
          entry_type: "task_settlement",
          amount: payoutAmount,
          currency: "LSP",
          note: JSON.stringify({
            task_id: payload.taskId,
            reason: payload.reason,
            final_score: finalScore,
            cycle_id: cycleId
          }),
          created_at: payload.now
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const duplicateLedger = findDuplicateSettlementLedger(
            payload.taskId,
            payoutAgentId,
            cycleId,
            duplicateKeyCandidates
          );

          if (duplicateLedger) {
            return {
              type: "duplicate_idempotency",
              ledger: duplicateLedger
            } as SettleTaskResult;
          }
        }

        throw error;
      }

      const balanceResult = creditAgentBalanceQuery.run({
        amount: payoutAmount,
        updated_at: payload.now,
        agent_id: payoutAgentId
      });

      if (balanceResult.changes === 0) {
        return {
          type: "agent_balance_update_failed",
          agentId: payoutAgentId
        } as SettleTaskResult;
      }

      const persistedTask = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;
      const persistedLedger = getLedgerByIdQuery.get(payload.ledgerId) as LedgerRow | undefined;

      if (!persistedTask || !persistedLedger) {
        throw new Error("Task settlement succeeded but reloading persisted rows failed");
      }

      return {
        type: "ok",
        task: toTaskResponse(persistedTask),
        settledAt: payload.now,
        payoutAgentId,
        payoutAmount,
        reason: payload.reason,
        idempotencyKey,
        ledger: persistedLedger
      } as SettleTaskResult;
    }
  );

  const protectedRoutePreHandlers = [authMiddleware, rateLimitMiddleware];

  const getAuthenticatedAgentId = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    const authenticatedAgentId = request.agentAuth?.agentId;

    if (!authenticatedAgentId) {
      sendError(reply, 401, "AGENT_AUTH_REQUIRED", "Bearer token is required", {
        expected_scheme: "Bearer"
      });
      return undefined;
    }

    return authenticatedAgentId;
  };

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
      return sendError(reply, 404, "TASK_NOT_FOUND", `Task ${taskId} was not found`, {
        task_id: taskId
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
      return sendError(reply, 500, "TASK_CREATION_FAILED", "Task was created but could not be loaded", {
        task_id: taskId
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
    const authenticatedAgentId = getAuthenticatedAgentId(request, reply);

    if (!authenticatedAgentId) {
      return;
    }

    const taskId = request.params.id.trim();

    if (!taskId) {
      return sendValidationError(reply, [{ field: "id", message: "id is required" }]);
    }

    const validation = validateCreateBidBody(request.body);

    if (!validation.value) {
      return sendValidationError(reply, validation.issues);
    }

    if (validation.value.agentId !== authenticatedAgentId) {
      return sendAgentForbidden(reply, authenticatedAgentId, validation.value.agentId, "agent_id");
    }

    const result = placeBid({
      ...validation.value,
      taskId,
      bidId: randomUUID(),
      now: new Date().toISOString()
    });

    if (result.type === "task_not_found") {
      return sendError(reply, 404, "TASK_NOT_FOUND", `Task ${taskId} was not found`, {
        task_id: taskId
      });
    }

    if (result.type === "agent_not_found") {
      return sendError(reply, 404, "AGENT_NOT_FOUND", `Agent ${validation.value.agentId} was not found`, {
        agent_id: validation.value.agentId
      });
    }

    if (result.type === "bid_cap_exceeded") {
      return sendError(
        reply,
        429,
        "AGENT_OPEN_BID_CAP_EXCEEDED",
        `Agent ${validation.value.agentId} reached open bid cap of ${result.cap}`,
        {
          agent_id: validation.value.agentId,
          open_bid_count: result.openBidCount,
          open_bid_cap: result.cap
        }
      );
    }

    if (result.type === "status_conflict") {
      publishEvent("task.bid_result", {
        task_id: taskId,
        agent_id: validation.value.agentId,
        accepted: false,
        current_status: result.conflict.status,
        attempted_transition: {
          from: result.conflict.from,
          to: result.conflict.to
        }
      });

      return sendError(
        reply,
        409,
        "TASK_NOT_BIDDABLE",
        `Task ${taskId} cannot transition ${result.conflict.from} -> ${result.conflict.to} for bidding`,
        {
          current_status: result.conflict.status,
          attempted_transition: {
            from: result.conflict.from,
            to: result.conflict.to
          },
          allowed_next_states: result.conflict.allowedNextStates
        }
      );
    }

    publishEvent("task.bid_result", {
      task_id: result.task.id,
      bid_id: result.bid.id,
      agent_id: result.bid.agent_id,
      accepted: true,
      task_status: result.task.status
    });

    return reply.code(201).send({
      data: {
        bid: result.bid,
        task: result.task
      }
    });
  };

  app.post<{ Params: { id: string }; Body: unknown }>("/tasks/:id/bid", { preHandler: protectedRoutePreHandlers }, createBidHandler);
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/tasks/:id/bids",
    { preHandler: protectedRoutePreHandlers },
    createBidHandler
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/tasks/:id/assign",
    { preHandler: protectedRoutePreHandlers },
    async (request, reply) => {
      const authenticatedAgentId = getAuthenticatedAgentId(request, reply);

      if (!authenticatedAgentId) {
        return;
      }

      const taskId = request.params.id.trim();

      if (!taskId) {
        return sendValidationError(reply, [{ field: "id", message: "id is required" }]);
      }

      const validation = validateAssignTaskBody(request.body);

      if (!validation.value) {
        return sendValidationError(reply, validation.issues);
      }

      if (validation.value.agentId && validation.value.agentId !== authenticatedAgentId) {
        return sendAgentForbidden(reply, authenticatedAgentId, validation.value.agentId, "agent_id");
      }

      const result = assignTask({
        ...validation.value,
        agentId: validation.value.agentId ?? authenticatedAgentId,
        taskId,
        now: new Date().toISOString()
      });

      if (result.type === "task_not_found") {
        return sendError(reply, 404, "TASK_NOT_FOUND", `Task ${taskId} was not found`, {
          task_id: taskId
        });
      }

      if (result.type === "bid_not_found") {
        return sendError(reply, 404, "TASK_BID_NOT_FOUND", `No matching bid found for task ${taskId}`, {
          task_id: taskId
        });
      }

      if (result.type === "agent_not_found") {
        return sendError(reply, 404, "AGENT_NOT_FOUND", "Winning bid agent was not found");
      }

      if (result.type === "assignment_mismatch") {
        return sendError(reply, 400, "TASK_ASSIGNMENT_AGENT_MISMATCH", "agent_id does not match bid_id owner", {
          requested_agent_id: result.requestedAgentId,
          bid_agent_id: result.bidAgentId
        });
      }

      if (result.type === "status_conflict") {
        return sendTaskStateConflict(reply, taskId, result.conflict);
      }

      publishEvent("task.assigned", {
        task_id: result.task.id,
        bid_id: result.assignedBid.id,
        agent_id: result.assignedBid.agent_id,
        status: result.task.status,
        assigned_at: result.assignedAt
      });

      return {
        data: {
          task: result.task,
          assignment: {
            bid_id: result.assignedBid.id,
            agent_id: result.assignedBid.agent_id,
            assigned_at: result.assignedAt
          }
        }
      };
    }
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/tasks/:id/submit",
    { preHandler: protectedRoutePreHandlers },
    async (request, reply) => {
      const authenticatedAgentId = getAuthenticatedAgentId(request, reply);

      if (!authenticatedAgentId) {
        return;
      }

      const taskId = request.params.id.trim();

      if (!taskId) {
        return sendValidationError(reply, [{ field: "id", message: "id is required" }]);
      }

      const validation = validateSubmitTaskBody(request.body);

      if (!validation.value) {
        return sendValidationError(reply, validation.issues);
      }

      if (validation.value.agentId && validation.value.agentId !== authenticatedAgentId) {
        return sendAgentForbidden(reply, authenticatedAgentId, validation.value.agentId, "agent_id");
      }

      const result = submitTask({
        ...validation.value,
        agentId: authenticatedAgentId,
        taskId,
        now: new Date().toISOString()
      });

      if (result.type === "task_not_found") {
        return sendError(reply, 404, "TASK_NOT_FOUND", `Task ${taskId} was not found`, {
          task_id: taskId
        });
      }

      if (result.type === "assignee_missing") {
        return sendError(reply, 409, "TASK_ASSIGNEE_MISSING", `Task ${taskId} has no assigned agent`, {
          task_id: taskId
        });
      }

      if (result.type === "forbidden_agent") {
        return sendError(reply, 403, "TASK_SUBMITTER_FORBIDDEN", `Task ${taskId} is assigned to another agent`, {
          expected_agent_id: result.expectedAgentId,
          requested_agent_id: result.requestedAgentId
        });
      }

      if (result.type === "status_conflict") {
        return sendTaskStateConflict(reply, taskId, result.conflict);
      }

      publishEvent("task.submitted", {
        task_id: result.task.id,
        agent_id: result.submitterAgentId,
        status: result.task.status,
        submitted_at: result.submittedAt
      });

      return {
        data: {
          task: result.task,
          submission: {
            agent_id: result.submitterAgentId,
            submitted_at: result.submittedAt,
            result: result.result
          }
        }
      };
    }
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/tasks/:id/score",
    { preHandler: protectedRoutePreHandlers },
    async (request, reply) => {
      const authenticatedAgentId = getAuthenticatedAgentId(request, reply);

      if (!authenticatedAgentId) {
        return;
      }

      const taskId = request.params.id.trim();

      if (!taskId) {
        return sendValidationError(reply, [{ field: "id", message: "id is required" }]);
      }

      const validation = validateScoreTaskBody(request.body);

      if (!validation.value) {
        return sendValidationError(reply, validation.issues);
      }

      const result = scoreTask({
        ...validation.value,
        taskId,
        now: new Date().toISOString()
      });

      if (result.type === "task_not_found") {
        return sendError(reply, 404, "TASK_NOT_FOUND", `Task ${taskId} was not found`, {
          task_id: taskId
        });
      }

      if (result.type === "assignee_missing") {
        return sendError(reply, 409, "TASK_ASSIGNEE_MISSING", `Task ${taskId} has no assigned agent`, {
          task_id: taskId
        });
      }

      if (result.type === "status_conflict") {
        return sendTaskStateConflict(reply, taskId, result.conflict);
      }

      publishEvent("task.scored", {
        task_id: result.task.id,
        status: result.task.status,
        scored_at: result.scoredAt,
        quality: result.quality,
        speed: result.speed,
        innovation: result.innovation,
        final_score: result.finalScore
      });

      return {
        data: {
          task: result.task,
          score: {
            quality: result.quality,
            speed: result.speed,
            innovation: result.innovation,
            final_score: result.finalScore,
            scored_at: result.scoredAt
          }
        }
      };
    }
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/tasks/:id/settle",
    { preHandler: protectedRoutePreHandlers },
    async (request, reply) => {
      const authenticatedAgentId = getAuthenticatedAgentId(request, reply);

      if (!authenticatedAgentId) {
        return;
      }

      const taskId = request.params.id.trim();

      if (!taskId) {
        return sendValidationError(reply, [{ field: "id", message: "id is required" }]);
      }

      const validation = validateSettleTaskBody(request.body);

      if (!validation.value) {
        return sendValidationError(reply, validation.issues);
      }

      if (validation.value.agentId && validation.value.agentId !== authenticatedAgentId) {
        return sendAgentForbidden(reply, authenticatedAgentId, validation.value.agentId, "agent_id");
      }

      const result = settleTask({
        ...validation.value,
        taskId,
        now: new Date().toISOString(),
        ledgerId: randomUUID()
      });

      if (result.type === "task_not_found") {
        return sendError(reply, 404, "TASK_NOT_FOUND", `Task ${taskId} was not found`, {
          task_id: taskId
        });
      }

      if (result.type === "assignee_missing") {
        return sendError(reply, 409, "TASK_ASSIGNEE_MISSING", `Task ${taskId} has no assigned agent`, {
          task_id: taskId
        });
      }

      if (result.type === "agent_not_found") {
        return sendError(reply, 404, "AGENT_NOT_FOUND", `Agent ${result.agentId} was not found`, {
          agent_id: result.agentId
        });
      }

      if (result.type === "duplicate_idempotency") {
        return sendError(
          reply,
          409,
          "LEDGER_IDEMPOTENCY_CONFLICT",
          "Settlement has already been applied for this idempotency key",
          {
            task_id: taskId,
            ledger_id: result.ledger.id,
            idempotency_key: result.ledger.idempotency_key
          }
        );
      }

      if (result.type === "agent_balance_update_failed") {
        return sendError(reply, 500, "AGENT_BALANCE_UPDATE_FAILED", `Failed to credit agent ${result.agentId}`, {
          agent_id: result.agentId
        });
      }

      if (result.type === "status_conflict") {
        return sendTaskStateConflict(reply, taskId, result.conflict);
      }

      publishEvent("task.settled", {
        task_id: result.task.id,
        status: result.task.status,
        settled_at: result.settledAt,
        agent_id: result.payoutAgentId,
        amount: result.payoutAmount,
        reason: result.reason,
        idempotency_key: result.idempotencyKey,
        ledger_id: result.ledger.id
      });

      return {
        data: {
          task: result.task,
          settlement: {
            agent_id: result.payoutAgentId,
            amount: result.payoutAmount,
            reason: result.reason,
            idempotency_key: result.idempotencyKey,
            settled_at: result.settledAt,
            ledger: {
              id: result.ledger.id,
              entry_type: result.ledger.entry_type,
              amount: result.ledger.amount,
              currency: result.ledger.currency,
              created_at: result.ledger.created_at,
              note: parseJsonPayload(result.ledger.note)
            }
          }
        }
      };
    }
  );
};

export default tasksRoutes;
