import type { preHandlerHookHandler } from "fastify";

const WINDOW_MS = 60 * 1000;
const DEFAULT_REQUESTS_PER_MINUTE = 60;

interface RateLimitEntry {
  count: number;
  windowStartedAtMs: number;
}

export interface AgentRateLimitOptions {
  maxRequestsPerMinute?: number;
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

export function resolveRateLimitPerMinuteFromEnv() {
  return parsePositiveInteger(process.env.AGENT_REQUEST_RATE_LIMIT_PER_MINUTE, DEFAULT_REQUESTS_PER_MINUTE);
}

export function createAgentRateLimitMiddleware(options: AgentRateLimitOptions = {}): preHandlerHookHandler {
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
  const counters = new Map<string, RateLimitEntry>();

  return async (request, reply) => {
    const now = Date.now();
    const agentId = request.agentAuth?.agentId ?? "anonymous";
    const key = `${request.ip}:${agentId}`;
    const current = counters.get(key);

    if (!current || now - current.windowStartedAtMs >= WINDOW_MS) {
      counters.set(key, {
        count: 1,
        windowStartedAtMs: now
      });
      return;
    }

    current.count += 1;

    if (current.count <= maxRequestsPerMinute) {
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - (now - current.windowStartedAtMs)) / 1000));
    reply.header("Retry-After", String(retryAfterSeconds));

    return reply.code(429).send({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: `Rate limit exceeded: max ${maxRequestsPerMinute} requests per minute per IP/agent`,
        details: {
          key,
          limit_per_minute: maxRequestsPerMinute,
          retry_after_seconds: retryAfterSeconds
        }
      }
    });
  };
}
