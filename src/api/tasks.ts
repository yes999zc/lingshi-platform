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
import { createBidRepository } from "../db/bid-repository";
import { createSubmissionRepository } from "../db/submission-repository";
import { EXPECTED_INDEX_CREATE_SQL } from "../db/expected-indexes";
import { computeScore, validateScorerIsolation } from "../engine/scoring";
import { TASK_STATES, validateTaskTransition } from "../engine/task-state";
import { getRuleEngine } from "../engine/rule-engine";
import { getTierBidWeight } from "../engine/tier-manager";

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
  bidding_started_at: string | null;
  bidding_ends_at: string | null;
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
  escrow_amount: number;
  created_at: string;
}

interface BidWithTierRow extends BidRow {
  agent_tier: string;
}

interface BidResponse {
  id: string;
  task_id: string;
  agent_id: string;
  confidence: number;
  estimated_cycles: number;
  bid_stake: number;
  escrow_amount: number;
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

interface AgentProfileRow {
  agent_id: string;
  lingshi_balance: number;
  tier: string;
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

function normalizeTierName(raw: string | null | undefined): "Outer" | "Core" | "Elder" {
  if (!raw) {
    return "Outer";
  }

  const normalized = raw.trim();

  if (!normalized) {
    return "Outer";
  }

  const canonical = normalized[0]?.toUpperCase() + normalized.slice(1).toLowerCase();

  if (canonical === "Core" || canonical === "Elder" || canonical === "Outer") {
    return canonical as "Outer" | "Core" | "Elder";
  }

  return "Outer";
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
    escrow_amount: row.escrow_amount,
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

  if (!taskColumns.has("bidding_started_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN bidding_started_at TEXT");
  }

  if (!taskColumns.has("bidding_ends_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN bidding_ends_at TEXT");
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

  if (!bidColumns.has("escrow_amount")) {
    db.exec("ALTER TABLE bids ADD COLUMN escrow_amount REAL NOT NULL DEFAULT 0");
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

  // Ensure UNIQUE constraint on bids(task_id, agent_id) for AC-SM-06
  const bidIndexes = db.prepare("PRAGMA index_list(bids)").all() as Array<{ name: string; unique: number }>;
  const hasUniqueTaskAgent = bidIndexes.some((idx) => {
    if (idx.unique !== 1) return false;
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).sort();
    return colNames.length === 2 && colNames[0] === "agent_id" && colNames[1] === "task_id";
  });

  if (!hasUniqueTaskAgent) {
    // Create unique index on (task_id, agent_id) to prevent duplicate bids from same agent
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_task_agent_unique ON bids (task_id, agent_id)");
  }

  for (const createIndexSql of EXPECTED_INDEX_CREATE_SQL) {
    db.exec(createIndexSql);
  }
}

const tasksRoutes: FastifyPluginAsync<TasksRouteOptions> = async (app, options) => {
  const { db } = options;
  const publishEvent = options.publishEvent ?? (() => undefined);
  const rules = getRuleEngine().getConfig();
  const openBidCap =
    rules.task.max_concurrent_open_tasks_per_agent ?? parsePositiveInteger(process.env.AGENT_OPEN_BID_CAP, DEFAULT_AGENT_OPEN_BID_CAP);
  const bidWindowSeconds = Math.min(rules.task.bid_window_seconds, rules.task.max_bid_window_seconds);
  const minBidAmount = rules.bidding.min_bid_amount_lingshi;
  const bidEscrowPct = rules.bidding.bid_escrow_pct;
  const maxSubmissionBytes = rules.task.max_submission_size_bytes;
  const authMiddleware = createAgentAuthMiddleware(db);
  const rateLimitMiddleware = createAgentRateLimitMiddleware({
    maxRequestsPerMinute: resolveRateLimitPerMinuteFromEnv(),
    maxTrackedKeys: resolveRateLimitMaxTrackedKeysFromEnv()
  });
  const bidRepository = createBidRepository(db);
  const submissionRepository = createSubmissionRepository(db);

  ensureTaskSchema(db);

  const baseTaskSelect = `
    SELECT
      id,
      title,
      description,
      status,
      agent_id,
      assigned_bid_id,
      bidding_started_at,
      bidding_ends_at,
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
        bidding_started_at = @bidding_started_at,
        bidding_ends_at = @bidding_ends_at,
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
    SELECT agent_id, lingshi_balance, tier
    FROM agents
    WHERE agent_id = ?
  `);

  const getAgentBalanceQuery = db.prepare(`
    SELECT agent_id, lingshi_balance, tier
    FROM agents
    WHERE agent_id = ?
  `);

  const creditAgentBalanceQuery = db.prepare(`
    UPDATE agents
    SET lingshi_balance = lingshi_balance + @amount,
        updated_at = @updated_at
    WHERE agent_id = @agent_id
  `);

  const debitAgentBalanceQuery = db.prepare(`
    UPDATE agents
    SET lingshi_balance = lingshi_balance - @amount,
        updated_at = @updated_at
    WHERE agent_id = @agent_id
      AND lingshi_balance >= @amount
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
      escrow_amount,
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
      @escrow_amount,
      @created_at
    )
  `);

  const getBidByIdQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, escrow_amount, created_at
    FROM bids
    WHERE id = ?
  `);

  const getBidByTaskAndIdQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, escrow_amount, created_at
    FROM bids
    WHERE task_id = @task_id
      AND id = @id
  `);

  const getBidByTaskAndAgentQuery = db.prepare(`
    SELECT id, task_id, agent_id, confidence, estimated_cycles, bid_stake, escrow_amount, created_at
    FROM bids
    WHERE task_id = @task_id
      AND agent_id = @agent_id
    ORDER BY confidence DESC, created_at ASC
    LIMIT 1
  `);

  const deleteBidByTaskAndIdAndAgentQuery = db.prepare(`
    DELETE FROM bids
    WHERE task_id = @task_id
      AND id = @id
      AND agent_id = @agent_id
  `);

  const listBidsWithTierByTaskQuery = db.prepare(`
    SELECT bids.id,
           bids.task_id,
           bids.agent_id,
           bids.confidence,
           bids.estimated_cycles,
           bids.bid_stake,
           bids.escrow_amount,
           bids.created_at,
           agents.tier AS agent_tier
    FROM bids
    INNER JOIN agents ON agents.agent_id = bids.agent_id
    WHERE bids.task_id = ?
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
    | { type: "bid_window_closed"; biddingEndedAt: string }
    | { type: "insufficient_balance"; agentId: string; escrowAmount: number; balance: number }
    | { type: "bid_cap_exceeded"; openBidCount: number; cap: number }
    | { type: "duplicate_bid"; existingBid: BidResponse }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | { type: "ok"; bid: BidResponse; task: TaskResponse; previousStatus: string; statusChanged: boolean };

  type CreateTaskResult =
    | { type: "agent_not_found"; agentId: string }
    | { type: "insufficient_balance"; agentId: string; requiredAmount: number; balance: number }
    | { type: "ok"; task: TaskResponse; posterAgentId: string; escrowAmount: number };

  type AssignTaskResult =
    | { type: "task_not_found" }
    | { type: "bid_not_found" }
    | { type: "agent_not_found" }
    | { type: "assignment_mismatch"; bidAgentId: string; requestedAgentId: string }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | {
        type: "ok";
        task: TaskResponse;
        assignedBid: BidResponse;
        assignedAt: string;
        previousStatus: string;
        refundedEscrows: Array<{ agentId: string; amount: number; bidId: string }>;
      };

  type SubmitTaskResult =
    | { type: "task_not_found" }
    | { type: "assignee_missing" }
    | { type: "forbidden_agent"; expectedAgentId: string; requestedAgentId: string }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | { type: "ok"; task: TaskResponse; submittedAt: string; submitterAgentId: string; result: unknown; previousStatus: string };

  type ScoreTaskResult =
    | { type: "task_not_found" }
    | { type: "assignee_missing" }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | { type: "scorer_not_allowed"; reason: string }
    | {
        type: "ok";
        task: TaskResponse;
        scoredAt: string;
        quality: number;
        speed: number;
        innovation: number;
        finalScore: number;
        scorerAgentId: string;
        previousStatus: string;
      };

  type WithdrawBidResult =
    | { type: "task_not_found" }
    | { type: "bid_not_found" }
    | { type: "forbidden_agent"; expectedAgentId: string; requestedAgentId: string }
    | { type: "status_conflict"; conflict: StatusConflictResult }
    | {
        type: "ok";
        task: TaskResponse;
        bid: BidResponse;
        refundedEscrowAmount: number;
        withdrawnAt: string;
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
        previousStatus: string;
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

    const previousStatus = taskRow.status;
    let statusChanged = false;

    const agentRow = getAgentBalanceQuery.get(payload.agentId) as AgentProfileRow | undefined;

    if (!agentRow) {
      return { type: "agent_not_found" } as PlaceBidResult;
    }

    if (taskRow.status === "bidding" && taskRow.bidding_ends_at) {
      const biddingEndsAtMs = Date.parse(taskRow.bidding_ends_at);
      if (Number.isFinite(biddingEndsAtMs) && Date.parse(payload.now) > biddingEndsAtMs) {
        return {
          type: "bid_window_closed",
          biddingEndedAt: taskRow.bidding_ends_at
        } as PlaceBidResult;
      }
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

    // AC-SM-06: exactly one bid per agent per task — return 409 if already bid
    const existingBidRow = getBidByTaskAndAgentQuery.get({ task_id: payload.taskId, agent_id: payload.agentId }) as BidRow | undefined;
    if (existingBidRow) {
      return {
        type: "duplicate_bid",
        existingBid: {
          id: existingBidRow.id,
          task_id: existingBidRow.task_id,
          agent_id: existingBidRow.agent_id,
          confidence: existingBidRow.confidence,
          estimated_cycles: existingBidRow.estimated_cycles,
          bid_stake: existingBidRow.bid_stake,
          escrow_amount: existingBidRow.escrow_amount,
          created_at: existingBidRow.created_at
        }
      } as PlaceBidResult;
    }

    const escrowAmount = roundToTwo(payload.bidStake * (bidEscrowPct / 100));

    if (escrowAmount > 0 && agentRow.lingshi_balance < escrowAmount) {
      return {
        type: "insufficient_balance",
        agentId: agentRow.agent_id,
        escrowAmount,
        balance: agentRow.lingshi_balance
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
        bidding_started_at: payload.now,
        bidding_ends_at: new Date(Date.parse(payload.now) + bidWindowSeconds * 1000).toISOString(),
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

      statusChanged = true;
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
      escrow_amount: escrowAmount,
      created_at: payload.now
    });

    if (escrowAmount > 0) {
      const ledgerId = randomUUID();
      const debitResult = debitAgentBalanceQuery.run({
        amount: escrowAmount,
        updated_at: payload.now,
        agent_id: payload.agentId
      });

      if (debitResult.changes === 0) {
        return {
          type: "insufficient_balance",
          agentId: payload.agentId,
          escrowAmount,
          balance: agentRow.lingshi_balance
        } as PlaceBidResult;
      }

      insertLedgerEntryQuery.run({
        id: ledgerId,
        entity_id: payload.agentId,
        task_id: payload.taskId,
        agent_id: payload.agentId,
        reason: "bid_escrow",
        idempotency_key: null,
        entry_type: "bid_escrow",
        amount: roundToTwo(-escrowAmount),
        currency: "LSP",
        note: JSON.stringify({
          task_id: payload.taskId,
          bid_id: payload.bidId,
          escrow_amount: escrowAmount
        }),
        created_at: payload.now
      });
    }

    const bidRow = getBidByIdQuery.get(payload.bidId) as BidRow | undefined;
    const refreshedTaskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

    if (!bidRow || !refreshedTaskRow) {
      throw new Error("Bid creation succeeded but reloading persisted rows failed");
    }

    return {
      type: "ok",
      bid: toBidResponse(bidRow),
      task: toTaskResponse(refreshedTaskRow),
      previousStatus,
      statusChanged
    } as PlaceBidResult;
  });

  const createTask = db.transaction(
    (payload: ValidCreateTaskPayload & { taskId: string; now: string; posterAgentId: string }) => {
      const poster = getAgentBalanceQuery.get(payload.posterAgentId) as AgentProfileRow | undefined;

      if (!poster) {
        return {
          type: "agent_not_found",
          agentId: payload.posterAgentId
        } as CreateTaskResult;
      }

      const escrowAmount = roundToTwo(payload.bountyLingshi);

      if (escrowAmount > 0 && poster.lingshi_balance < escrowAmount) {
        return {
          type: "insufficient_balance",
          agentId: payload.posterAgentId,
          requiredAmount: escrowAmount,
          balance: poster.lingshi_balance
        } as CreateTaskResult;
      }

      if (escrowAmount > 0) {
        const debitResult = debitAgentBalanceQuery.run({
          amount: escrowAmount,
          updated_at: payload.now,
          agent_id: payload.posterAgentId
        });

        if (debitResult.changes === 0) {
          return {
            type: "insufficient_balance",
            agentId: payload.posterAgentId,
            requiredAmount: escrowAmount,
            balance: poster.lingshi_balance
          } as CreateTaskResult;
        }
      }

      insertTaskQuery.run({
        id: payload.taskId,
        title: payload.title,
        description: payload.description,
        status: "open",
        complexity: payload.complexity,
        bounty_lingshi: payload.bountyLingshi,
        required_tags: JSON.stringify(payload.requiredTags),
        created_at: payload.now,
        updated_at: payload.now
      });

      if (escrowAmount > 0) {
        insertLedgerEntryQuery.run({
          id: randomUUID(),
          entity_id: payload.posterAgentId,
          task_id: payload.taskId,
          agent_id: payload.posterAgentId,
          reason: "task_escrow",
          idempotency_key: null,
          entry_type: "task_escrow",
          amount: roundToTwo(-escrowAmount),
          currency: "LSP",
          note: JSON.stringify({
            task_id: payload.taskId,
            poster_agent_id: payload.posterAgentId,
            escrow_amount: escrowAmount
          }),
          created_at: payload.now
        });
      }

      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        throw new Error("Task creation succeeded but reloading persisted row failed");
      }

      return {
        type: "ok",
        task: toTaskResponse(taskRow),
        posterAgentId: payload.posterAgentId,
        escrowAmount
      } as CreateTaskResult;
    }
  );

  const assignTask = db.transaction(
    (payload: ValidAssignTaskPayload & { taskId: string; now: string }) => {
      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        return { type: "task_not_found" } as AssignTaskResult;
      }

      const previousStatus = taskRow.status;

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
      } else {
        const candidateRows = listBidsWithTierByTaskQuery.all(payload.taskId) as BidWithTierRow[];

        if (candidateRows.length > 0) {
          const ranked = candidateRows
            .map((bid) => {
              const tierName = normalizeTierName(bid.agent_tier);
              const weight = getTierBidWeight(tierName);
              const weightedBid = roundToTwo(bid.bid_stake * weight);
              return {
                bid,
                weightedBid,
                weight
              };
            })
            .sort((a, b) => {
              if (b.weightedBid !== a.weightedBid) {
                return b.weightedBid - a.weightedBid;
              }
              if (b.bid.bid_stake !== a.bid.bid_stake) {
                return b.bid.bid_stake - a.bid.bid_stake;
              }
              if (b.bid.confidence !== a.bid.confidence) {
                return b.bid.confidence - a.bid.confidence;
              }
              return a.bid.created_at.localeCompare(b.bid.created_at);
            });

          assignedBidRow = ranked[0]?.bid;
        }
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

      const agentRow = getAgentByIdQuery.get(assignedBidRow.agent_id) as AgentProfileRow | undefined;

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

      const refundedEscrows: Array<{ agentId: string; amount: number; bidId: string }> = [];
      const allBids = listBidsWithTierByTaskQuery.all(payload.taskId) as BidWithTierRow[];

      for (const bid of allBids) {
        if (bid.id === assignedBidRow.id) {
          continue;
        }

        if (bid.escrow_amount > 0) {
          creditAgentBalanceQuery.run({
            amount: bid.escrow_amount,
            updated_at: payload.now,
            agent_id: bid.agent_id
          });

          refundedEscrows.push({
            agentId: bid.agent_id,
            amount: bid.escrow_amount,
            bidId: bid.id
          });

          insertLedgerEntryQuery.run({
            id: randomUUID(),
            entity_id: bid.agent_id,
            task_id: payload.taskId,
            agent_id: bid.agent_id,
            reason: "bid_refund",
            idempotency_key: null,
            entry_type: "bid_refund",
            amount: roundToTwo(bid.escrow_amount),
            currency: "LSP",
            note: JSON.stringify({
              task_id: payload.taskId,
              bid_id: bid.id,
              escrow_amount: bid.escrow_amount
            }),
            created_at: payload.now
          });
        }
      }

      return {
        type: "ok",
        task: toTaskResponse(persistedTask),
        assignedBid: toBidResponse(assignedBidRow),
        assignedAt: payload.now,
        previousStatus,
        refundedEscrows
      } as AssignTaskResult;
    }
  );

  const withdrawBid = db.transaction((payload: { taskId: string; bidId: string; agentId: string; now: string }) => {
    const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

    if (!taskRow) {
      return { type: "task_not_found" } as WithdrawBidResult;
    }

    if (taskRow.status !== "bidding") {
      return {
        type: "status_conflict",
        conflict: toStatusConflict(taskRow.status, "bidding")
      } as WithdrawBidResult;
    }

    const bidRow = getBidByTaskAndIdQuery.get({
      task_id: payload.taskId,
      id: payload.bidId
    }) as BidRow | undefined;

    if (!bidRow) {
      return { type: "bid_not_found" } as WithdrawBidResult;
    }

    if (bidRow.agent_id !== payload.agentId) {
      return {
        type: "forbidden_agent",
        expectedAgentId: bidRow.agent_id,
        requestedAgentId: payload.agentId
      } as WithdrawBidResult;
    }

    const deleteResult = deleteBidByTaskAndIdAndAgentQuery.run({
      task_id: payload.taskId,
      id: payload.bidId,
      agent_id: payload.agentId
    });

    if (deleteResult.changes === 0) {
      return { type: "bid_not_found" } as WithdrawBidResult;
    }

    if (bidRow.escrow_amount > 0) {
      creditAgentBalanceQuery.run({
        amount: bidRow.escrow_amount,
        updated_at: payload.now,
        agent_id: payload.agentId
      });

      insertLedgerEntryQuery.run({
        id: randomUUID(),
        entity_id: payload.agentId,
        task_id: payload.taskId,
        agent_id: payload.agentId,
        reason: "bid_refund",
        idempotency_key: null,
        entry_type: "bid_refund",
        amount: roundToTwo(bidRow.escrow_amount),
        currency: "LSP",
        note: JSON.stringify({
          task_id: payload.taskId,
          bid_id: payload.bidId,
          escrow_amount: bidRow.escrow_amount
        }),
        created_at: payload.now
      });
    }

    const persistedTask = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

    if (!persistedTask) {
      throw new Error("Bid withdrawal succeeded but task reload failed");
    }

    return {
      type: "ok",
      task: toTaskResponse(persistedTask),
      bid: toBidResponse(bidRow),
      refundedEscrowAmount: roundToTwo(Math.max(bidRow.escrow_amount, 0)),
      withdrawnAt: payload.now
    } as WithdrawBidResult;
  });

  const submitTask = db.transaction(
    (payload: ValidSubmitTaskPayload & { taskId: string; now: string; submissionId: string; resultSizeBytes: number }) => {
      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        return { type: "task_not_found" } as SubmitTaskResult;
      }

      const previousStatus = taskRow.status;

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

      submissionRepository.insertSubmission({
        id: payload.submissionId,
        task_id: payload.taskId,
        agent_id: taskRow.agent_id,
        payload: payload.serializedResult,
        size_bytes: payload.resultSizeBytes,
        created_at: payload.now
      });

      return {
        type: "ok",
        task: toTaskResponse(persistedTask),
        submittedAt: payload.now,
        submitterAgentId: taskRow.agent_id,
        result: payload.result,
        previousStatus
      } as SubmitTaskResult;
    }
  );

  const scoreTask = db.transaction(
    (payload: ValidScoreTaskPayload & { taskId: string; now: string; scorerAgentId: string }) => {
      const taskRow = getTaskByIdQuery.get(payload.taskId) as TaskRow | undefined;

      if (!taskRow) {
        return { type: "task_not_found" } as ScoreTaskResult;
      }

      const previousStatus = taskRow.status;

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

      const bidderIds = bidRepository.listBidderIdsByTask(payload.taskId);
      const isolationResult = validateScorerIsolation({
        scorer_agent_id: payload.scorerAgentId,
        task_poster_agent_id: taskRow.agent_id ?? "",
        task_assignee_agent_id: taskRow.agent_id ?? "",
        bidder_agent_ids: bidderIds
      });

      if (!isolationResult.allowed) {
        return {
          type: "scorer_not_allowed",
          reason: isolationResult.reason ?? "Scorer is not allowed to score this task"
        } as ScoreTaskResult;
      }

      const scoreResult = computeScore({
        quality: payload.quality,
        speed: payload.speed,
        innovation: payload.innovation
      });

      const updateResult = markTaskScoredQuery.run({
        id: payload.taskId,
        status: transition.to,
        current_status: transition.from,
        score_quality: payload.quality,
        score_speed: payload.speed,
        score_innovation: payload.innovation,
        final_score: scoreResult.final_score,
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
        finalScore: scoreResult.final_score,
        scorerAgentId: payload.scorerAgentId,
        previousStatus
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

      const previousStatus = taskRow.status;

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

      const payoutAgent = getAgentByIdQuery.get(payoutAgentId) as AgentProfileRow | undefined;

      if (!payoutAgent) {
        return {
          type: "agent_not_found",
          agentId: payoutAgentId
        } as SettleTaskResult;
      }

      const finalScore = taskRow.final_score ?? 0;
      const derivedAmount = roundToTwo(taskRow.bounty_lingshi * (finalScore / 100));
      const payoutAmount = payload.amount !== undefined ? payload.amount : derivedAmount;

      // Get winning bid to refund escrow
      const winningBid = taskRow.assigned_bid_id
        ? (getBidByIdQuery.get(taskRow.assigned_bid_id) as BidRow | undefined)
        : undefined;

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

      // Refund winning bid escrow on successful settlement
      if (winningBid && winningBid.escrow_amount > 0) {
        creditAgentBalanceQuery.run({
          amount: winningBid.escrow_amount,
          updated_at: payload.now,
          agent_id: payoutAgentId
        });
        insertLedgerEntryQuery.run({
          id: randomUUID(),
          entity_id: payoutAgentId,
          task_id: payload.taskId,
          agent_id: payoutAgentId,
          reason: "bid_escrow_refund",
          idempotency_key: null,
          entry_type: "bid_refund",
          amount: roundToTwo(winningBid.escrow_amount),
          currency: "LSP",
          note: JSON.stringify({
            task_id: payload.taskId,
            bid_id: winningBid.id,
            escrow_amount: winningBid.escrow_amount
          }),
          created_at: payload.now
        });
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
        ledger: persistedLedger,
        previousStatus
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

  app.post<{ Body: unknown }>("/tasks", { preHandler: protectedRoutePreHandlers }, async (request, reply) => {
    const authenticatedAgentId = getAuthenticatedAgentId(request, reply);

    if (!authenticatedAgentId) {
      return;
    }

    const validation = validateCreateTaskBody(request.body);

    if (!validation.value) {
      return sendValidationError(reply, validation.issues);
    }

    const now = new Date().toISOString();
    const taskId = randomUUID();
    const result = createTask({
      ...validation.value,
      taskId,
      now,
      posterAgentId: authenticatedAgentId
    });

    if (result.type === "agent_not_found") {
      return sendError(reply, 404, "AGENT_NOT_FOUND", `Agent ${result.agentId} was not found`, {
        agent_id: result.agentId
      });
    }

    if (result.type === "insufficient_balance") {
      return sendError(
        reply,
        400,
        "AGENT_INSUFFICIENT_BALANCE",
        `Agent ${result.agentId} has insufficient balance to post task`,
        {
          agent_id: result.agentId,
          required_amount: result.requiredAmount,
          balance: result.balance
        }
      );
    }

    const task = result.task;
    publishEvent("task.created", {
      task_id: task.id,
      status: task.status,
      poster_agent_id: result.posterAgentId,
      escrow_amount: result.escrowAmount,
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

    if (validation.value.bidStake < minBidAmount) {
      return sendValidationError(reply, [
        {
          field: "bid_stake",
          message: `bid_stake must be at least ${minBidAmount}`
        }
      ]);
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

    if (result.type === "bid_window_closed") {
      return sendError(
        reply,
        409,
        "TASK_BID_WINDOW_CLOSED",
        `Bid window for task ${taskId} has closed`,
        {
          task_id: taskId,
          bidding_ended_at: result.biddingEndedAt
        }
      );
    }

    if (result.type === "insufficient_balance") {
      return sendError(
        reply,
        409,
        "AGENT_INSUFFICIENT_BALANCE",
        `Agent ${result.agentId} has insufficient balance for bid escrow`,
        {
          agent_id: result.agentId,
          escrow_amount: result.escrowAmount,
          balance: result.balance
        }
      );
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

    if (result.type === "duplicate_bid") {
      return sendError(
        reply,
        409,
        "BID_ALREADY_EXISTS",
        `Agent ${validation.value.agentId} has already placed a bid on task ${taskId}`,
        {
          task_id: taskId,
          agent_id: validation.value.agentId,
          existing_bid_id: result.existingBid.id
        }
      );
    }

    if (result.type === "status_conflict") {
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

    const successfulBid = result as Extract<PlaceBidResult, { type: "ok" }>;

    publishEvent("bid.placed", {
      task_id: successfulBid.task.id,
      bid_id: successfulBid.bid.id,
      agent_id: successfulBid.bid.agent_id,
      bid_amount: successfulBid.bid.bid_stake,
      escrow_amount: successfulBid.bid.escrow_amount,
      created_at: successfulBid.bid.created_at
    });

    if (successfulBid.statusChanged) {
      publishEvent("task.state_changed", {
        task_id: successfulBid.task.id,
        from: successfulBid.previousStatus,
        to: successfulBid.task.status,
        changed_at: successfulBid.task.updated_at
      });
    }

    if (successfulBid.bid.escrow_amount > 0) {
      publishEvent("lingshi.debited", {
        agent_id: successfulBid.bid.agent_id,
        task_id: successfulBid.task.id,
        amount: successfulBid.bid.escrow_amount,
        reason: "bid_escrow"
      });
    }

    return reply.code(201).send({
      data: {
        bid: successfulBid.bid,
        task: successfulBid.task
      }
    });
  };

  app.post<{ Params: { id: string }; Body: unknown }>("/tasks/:id/bid", { preHandler: protectedRoutePreHandlers }, createBidHandler);
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/tasks/:id/bids",
    { preHandler: protectedRoutePreHandlers },
    createBidHandler
  );

  app.delete<{ Params: { id: string; bid_id: string } }>(
    "/tasks/:id/bids/:bid_id",
    { preHandler: protectedRoutePreHandlers },
    async (request, reply) => {
      const authenticatedAgentId = getAuthenticatedAgentId(request, reply);

      if (!authenticatedAgentId) {
        return;
      }

      const taskId = request.params.id.trim();
      const bidId = request.params.bid_id.trim();

      if (!taskId || !bidId) {
        return sendValidationError(reply, [{ field: "id", message: "task id and bid id are required" }]);
      }

      const result = withdrawBid({
        taskId,
        bidId,
        agentId: authenticatedAgentId,
        now: new Date().toISOString()
      });

      if (result.type === "task_not_found") {
        return sendError(reply, 404, "TASK_NOT_FOUND", `Task ${taskId} was not found`, {
          task_id: taskId
        });
      }

      if (result.type === "bid_not_found") {
        return sendError(reply, 404, "TASK_BID_NOT_FOUND", `Bid ${bidId} was not found for task ${taskId}`, {
          task_id: taskId,
          bid_id: bidId
        });
      }

      if (result.type === "forbidden_agent") {
        return sendAgentForbidden(reply, result.expectedAgentId, result.requestedAgentId, "agent_id");
      }

      if (result.type === "status_conflict") {
        return sendTaskStateConflict(reply, taskId, result.conflict);
      }

      publishEvent("bid.withdrawn", {
        task_id: taskId,
        bid_id: bidId,
        agent_id: authenticatedAgentId,
        withdrawn_at: result.withdrawnAt
      });

      if (result.refundedEscrowAmount > 0) {
        publishEvent("lingshi.credited", {
          agent_id: authenticatedAgentId,
          task_id: taskId,
          amount: result.refundedEscrowAmount,
          reason: "bid_refund",
          bid_id: bidId
        });
      }

      return {
        data: {
          bid: result.bid,
          task: result.task,
          refund: {
            escrow_amount: result.refundedEscrowAmount
          }
        }
      };
    }
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

      publishEvent("bid.won", {
        task_id: result.task.id,
        bid_id: result.assignedBid.id,
        agent_id: result.assignedBid.agent_id,
        bid_amount: result.assignedBid.bid_stake,
        assigned_at: result.assignedAt
      });

      publishEvent("task.state_changed", {
        task_id: result.task.id,
        from: result.previousStatus,
        to: result.task.status,
        changed_at: result.assignedAt
      });

      for (const refund of result.refundedEscrows) {
        publishEvent("lingshi.credited", {
          agent_id: refund.agentId,
          task_id: result.task.id,
          amount: refund.amount,
          reason: "bid_refund",
          bid_id: refund.bidId
        });
      }

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

      const resultSizeBytes = Buffer.byteLength(validation.value.serializedResult, "utf8");

      if (resultSizeBytes > maxSubmissionBytes) {
        return sendError(
          reply,
          413,
          "TASK_SUBMISSION_TOO_LARGE",
          `Submission exceeds max size of ${maxSubmissionBytes} bytes`,
          {
            max_size_bytes: maxSubmissionBytes,
            size_bytes: resultSizeBytes
          }
        );
      }

      const result = submitTask({
        ...validation.value,
        agentId: authenticatedAgentId,
        taskId,
        now: new Date().toISOString(),
        submissionId: randomUUID(),
        resultSizeBytes
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

      publishEvent("task.state_changed", {
        task_id: result.task.id,
        from: result.previousStatus,
        to: result.task.status,
        changed_at: result.submittedAt
      });

      publishEvent("submission.received", {
        task_id: result.task.id,
        agent_id: result.submitterAgentId,
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
        now: new Date().toISOString(),
        scorerAgentId: authenticatedAgentId
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

      if (result.type === "scorer_not_allowed") {
        return sendError(reply, 403, "TASK_SCORER_FORBIDDEN", result.reason, {
          task_id: taskId
        });
      }

      publishEvent("score.submitted", {
        task_id: result.task.id,
        scorer_agent_id: result.scorerAgentId,
        scored_at: result.scoredAt,
        quality: result.quality,
        speed: result.speed,
        innovation: result.innovation,
        final_score: result.finalScore
      });

      publishEvent("task.state_changed", {
        task_id: result.task.id,
        from: result.previousStatus,
        to: result.task.status,
        changed_at: result.scoredAt
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

      publishEvent("task.state_changed", {
        task_id: result.task.id,
        from: result.previousStatus,
        to: result.task.status,
        changed_at: result.settledAt
      });

      publishEvent("lingshi.credited", {
        task_id: result.task.id,
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
