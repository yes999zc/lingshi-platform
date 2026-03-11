import type { FastifyReply } from "fastify";

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: unknown;
  };
}

export function createErrorEnvelope(code: string, message: string, details: unknown = null): ApiErrorEnvelope {
  return {
    error: {
      code,
      message,
      details
    }
  };
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details: unknown = null
) {
  return reply.code(statusCode).send(createErrorEnvelope(code, message, details));
}
