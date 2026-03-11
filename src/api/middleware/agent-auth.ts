import type Database from "better-sqlite3";
import type { preHandlerHookHandler } from "fastify";

import { hashToken } from "../../auth/token";

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

function sendAuthError(reply: Parameters<preHandlerHookHandler>[1], code: string, message: string) {
  return reply.code(401).send({
    error: {
      code,
      message
    }
  });
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
        return sendAuthError(reply, "AGENT_AUTH_REQUIRED", "Bearer token is required");
      }

      return sendAuthError(reply, "AGENT_AUTH_INVALID", "Authorization header must use Bearer token format");
    }

    const tokenHash = hashToken(parsedHeader.token);
    const agentRow = findAgentByTokenHashQuery.get(tokenHash) as AuthenticatedAgentRow | undefined;

    if (!agentRow) {
      return sendAuthError(reply, "AGENT_AUTH_INVALID", "Invalid bearer token");
    }

    request.agentAuth = {
      agentId: agentRow.agent_id
    };
  };
}
