import type Database from "better-sqlite3";
import type { FastifyReply, preHandlerHookHandler } from "fastify";

import { hashToken } from "../../auth/token";
import { sendError } from "../error-envelope";

interface AuthenticatedAgentRow {
  agent_id: string;
}

declare module "fastify" {
  interface FastifyRequest {
    agentAuth?: {
      agentId: string;
    };
  }
}

function sendAuthError(reply: FastifyReply, code: string, message: string, details: unknown = null) {
  return sendError(reply, 401, code, message, details);
}

function readBearerTokenFromHeader(headerValue: string | undefined): { token?: string; error?: string } {
  if (!headerValue) {
    return { error: "missing_authorization_header" };
  }

  const trimmed = headerValue.trim();

  if (!trimmed) {
    return { error: "missing_authorization_header" };
  }

  const match = /^Bearer\s+(.+)$/i.exec(trimmed);

  if (!match) {
    return { error: "invalid_authorization_header_format" };
  }

  const token = match[1].trim();

  if (!token) {
    return { error: "invalid_authorization_header_format" };
  }

  return { token };
}

export function createAgentAuthMiddleware(db: Database.Database): preHandlerHookHandler {
  const findAgentByTokenHashQuery = db.prepare(`
    SELECT agent_id
    FROM agents
    WHERE token_hash = ?
  `);

  return async (request, reply) => {
    const parsedHeader = readBearerTokenFromHeader(request.headers.authorization);

    if (!parsedHeader.token) {
      if (parsedHeader.error === "missing_authorization_header") {
        return sendAuthError(reply, "AGENT_AUTH_REQUIRED", "Bearer token is required", {
          expected_scheme: "Bearer"
        });
      }

      return sendAuthError(reply, "AGENT_AUTH_INVALID", "Authorization header must use Bearer token format", {
        expected_format: "Authorization: Bearer <token>"
      });
    }

    const tokenHash = hashToken(parsedHeader.token);
    const agentRow = findAgentByTokenHashQuery.get(tokenHash) as AuthenticatedAgentRow | undefined;

    if (!agentRow) {
      return sendAuthError(reply, "AGENT_AUTH_INVALID", "Invalid bearer token", {
        reason: "token_not_recognized"
      });
    }

    request.agentAuth = {
      agentId: agentRow.agent_id
    };
  };
}
