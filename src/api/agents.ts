import { randomBytes, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

import { hashToken } from "../auth/token";

interface AgentRow {
  agent_id: string;
  name: string;
  tier: string;
  lingshi_balance: number;
  capability_tags: string;
  last_seen: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface AgentResponse {
  agent_id: string;
  name: string;
  tier: string;
  lingshi_balance: number;
  capability_tags: string[];
  last_seen: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface RegisterAgentBody {
  name: unknown;
  capability_tags: unknown;
  initial_lingshi: unknown;
}

interface ValidationIssue {
  field: string;
  message: string;
}

interface ValidRegisterPayload {
  name: string;
  capabilityTags: string[];
  initialLingshi: number;
}

interface AgentsRouteOptions {
  db: Database.Database;
}

function normalizeCapabilityTags(capabilityTags: unknown): { value?: string[]; issues: ValidationIssue[] } {
  if (!Array.isArray(capabilityTags)) {
    return {
      issues: [{ field: "capability_tags", message: "capability_tags must be an array of non-empty strings" }]
    };
  }

  const normalized: string[] = [];
  const issues: ValidationIssue[] = [];

  capabilityTags.forEach((tag, index) => {
    if (typeof tag !== "string") {
      issues.push({
        field: `capability_tags[${index}]`,
        message: "tag must be a string"
      });
      return;
    }

    const trimmed = tag.trim();

    if (!trimmed) {
      issues.push({
        field: `capability_tags[${index}]`,
        message: "tag cannot be empty"
      });
      return;
    }

    if (trimmed.length > 64) {
      issues.push({
        field: `capability_tags[${index}]`,
        message: "tag must be 64 characters or fewer"
      });
      return;
    }

    normalized.push(trimmed);
  });

  if (issues.length > 0) {
    return { issues };
  }

  return { value: Array.from(new Set(normalized)), issues: [] };
}

function validateRegisterBody(body: unknown): { value?: ValidRegisterPayload; issues: ValidationIssue[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      issues: [{ field: "body", message: "request body must be a JSON object" }]
    };
  }

  const payload = body as Partial<RegisterAgentBody>;
  const issues: ValidationIssue[] = [];

  const name = typeof payload.name === "string" ? payload.name.trim() : "";

  if (!name) {
    issues.push({ field: "name", message: "name is required" });
  } else if (name.length > 120) {
    issues.push({ field: "name", message: "name must be 120 characters or fewer" });
  }

  const tagsResult = normalizeCapabilityTags(payload.capability_tags);
  issues.push(...tagsResult.issues);

  const initialLingshi = payload.initial_lingshi;

  if (typeof initialLingshi !== "number" || !Number.isFinite(initialLingshi)) {
    issues.push({
      field: "initial_lingshi",
      message: "initial_lingshi must be a finite number"
    });
  } else if (initialLingshi < 0) {
    issues.push({
      field: "initial_lingshi",
      message: "initial_lingshi must be greater than or equal to 0"
    });
  }

  if (issues.length > 0 || !tagsResult.value) {
    return { issues };
  }

  const parsedInitialLingshi = initialLingshi as number;

  return {
    value: {
      name,
      capabilityTags: tagsResult.value,
      initialLingshi: parsedInitialLingshi
    },
    issues: []
  };
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

function parseCapabilityTags(capabilityTagsRaw: string): string[] {
  try {
    const parsed = JSON.parse(capabilityTagsRaw) as unknown;

    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")) {
      return parsed;
    }
  } catch {
    // ignore invalid data and return a safe default
  }

  return [];
}

function toAgentResponse(row: AgentRow): AgentResponse {
  return {
    agent_id: row.agent_id,
    name: row.name,
    tier: row.tier,
    lingshi_balance: row.lingshi_balance,
    capability_tags: parseCapabilityTags(row.capability_tags),
    last_seen: row.last_seen,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const agentsRoutes: FastifyPluginAsync<AgentsRouteOptions> = async (app, options) => {
  const { db } = options;

  const listAgentsQuery = db.prepare(`
    SELECT agent_id, name, tier, lingshi_balance, capability_tags, last_seen, status, created_at, updated_at
    FROM agents
    ORDER BY created_at DESC
  `);

  const getAgentByIdQuery = db.prepare(`
    SELECT agent_id, name, tier, lingshi_balance, capability_tags, last_seen, status, created_at, updated_at
    FROM agents
    WHERE agent_id = ?
  `);

  const insertAgentQuery = db.prepare(`
    INSERT INTO agents (
      agent_id,
      name,
      tier,
      lingshi_balance,
      capability_tags,
      token_hash,
      last_seen,
      status,
      created_at,
      updated_at
    ) VALUES (
      @agent_id,
      @name,
      @tier,
      @lingshi_balance,
      @capability_tags,
      @token_hash,
      @last_seen,
      @status,
      @created_at,
      @updated_at
    )
  `);

  const pingAgentQuery = db.prepare(`
    UPDATE agents
    SET last_seen = @last_seen,
        status = @status,
        updated_at = @updated_at
    WHERE agent_id = @agent_id
  `);

  app.post<{ Body: unknown }>("/agents/register", async (request, reply) => {
    const validation = validateRegisterBody(request.body);

    if (!validation.value) {
      return sendValidationError(reply, validation.issues);
    }

    const now = new Date().toISOString();
    const token = randomBytes(32).toString("base64url");
    const agentId = randomUUID();

    insertAgentQuery.run({
      agent_id: agentId,
      name: validation.value.name,
      tier: "outer",
      lingshi_balance: validation.value.initialLingshi,
      capability_tags: JSON.stringify(validation.value.capabilityTags),
      token_hash: hashToken(token),
      last_seen: now,
      status: "online",
      created_at: now,
      updated_at: now
    });

    const row = getAgentByIdQuery.get(agentId) as AgentRow | undefined;

    if (!row) {
      return reply.code(500).send({
        error: {
          code: "AGENT_CREATION_FAILED",
          message: "Agent was created but could not be loaded"
        }
      });
    }

    return reply.code(201).send({
      data: {
        agent: toAgentResponse(row),
        token
      }
    });
  });

  app.put<{ Params: { agent_id: string } }>("/agents/:agent_id/ping", async (request, reply) => {
    const agentId = request.params.agent_id.trim();

    if (!agentId) {
      return sendValidationError(reply, [{ field: "agent_id", message: "agent_id is required" }]);
    }

    const now = new Date().toISOString();
    const result = pingAgentQuery.run({
      agent_id: agentId,
      last_seen: now,
      status: "online",
      updated_at: now
    });

    if (result.changes === 0) {
      return reply.code(404).send({
        error: {
          code: "AGENT_NOT_FOUND",
          message: `Agent ${agentId} was not found`
        }
      });
    }

    const row = getAgentByIdQuery.get(agentId) as AgentRow | undefined;

    if (!row) {
      return reply.code(500).send({
        error: {
          code: "AGENT_READ_FAILED",
          message: "Agent ping succeeded but reload failed"
        }
      });
    }

    return {
      data: {
        agent: toAgentResponse(row)
      }
    };
  });

  app.get("/agents", async () => {
    const rows = listAgentsQuery.all() as AgentRow[];

    return {
      data: {
        agents: rows.map(toAgentResponse)
      }
    };
  });

  app.get<{ Params: { agent_id: string } }>("/agents/:agent_id", async (request, reply) => {
    const agentId = request.params.agent_id.trim();

    if (!agentId) {
      return sendValidationError(reply, [{ field: "agent_id", message: "agent_id is required" }]);
    }

    const row = getAgentByIdQuery.get(agentId) as AgentRow | undefined;

    if (!row) {
      return reply.code(404).send({
        error: {
          code: "AGENT_NOT_FOUND",
          message: `Agent ${agentId} was not found`
        }
      });
    }

    return {
      data: {
        agent: toAgentResponse(row)
      }
    };
  });
};

export default agentsRoutes;
